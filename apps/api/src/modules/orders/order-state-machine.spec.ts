import { ORDER_STATUSES, type OrderStatus } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  decideTransition,
  isAtOrBeyond,
  mayEverMoveTo,
  nextStatuses,
  TRANSITION_RULES,
  WORKFLOW_ROLES,
  type TransitionInput,
  type WorkflowRole,
} from './order-state-machine.js';

// Hand-written from docs/domain/order-lifecycle.md §3 and §5, NOT derived from the rule table.
// Key = "FROM>TO"; value = the roles that may perform that move. Every other (from, to) pair is
// illegal for every role. Only the manager cancels (owner rule 2026-10-22); admin performs no move at all.
const EXPECTED_ROLES: Readonly<Record<string, readonly WorkflowRole[]>> = {
  'SUBMITTED>MANAGER_APPROVED': ['MANAGER'],
  'SUBMITTED>REJECTED': ['MANAGER'],
  'SUBMITTED>CANCELLED': ['MANAGER'],
  'MANAGER_APPROVED>ACCOUNTING_CLEARED': ['ACCOUNTANT'],
  'MANAGER_APPROVED>REJECTED': ['ACCOUNTANT'],
  'MANAGER_APPROVED>CANCELLED': ['MANAGER'],
  'ACCOUNTING_CLEARED>RELEASED': ['WAREHOUSE_MANAGER'],
  'ACCOUNTING_CLEARED>CANCELLED': ['MANAGER'],
  'RELEASED>DELIVERED': ['DRIVER'],
  'DELIVERED>RECEIVED': ['SHOP_OWNER', 'SELLER'],
};

/** Input that satisfies every requirement of the move, so only the role decides. */
function completeInput(from: OrderStatus, to: OrderStatus, role: WorkflowRole): TransitionInput {
  return {
    from,
    to,
    roles: [role],
    reason: 'because',
    ...(from === 'ACCOUNTING_CLEARED' && to === 'RELEASED' ? { driverUserId: 'driver-1' } : {}),
    ...(from === 'SUBMITTED' && to === 'MANAGER_APPROVED' ? { paymentMethod: 'CASH' } : {}),
  };
}

describe('order state machine: every (from, to, role) combination', () => {
  it('covers the whole cross product', () => {
    expect(ORDER_STATUSES).toHaveLength(8);
    expect(WORKFLOW_ROLES).toHaveLength(8);
  });

  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      for (const role of WORKFLOW_ROLES) {
        const key = `${from}>${to}`;
        const allowedRoles = EXPECTED_ROLES[key];
        const expected =
          allowedRoles === undefined
            ? 'ILLEGAL_TRANSITION'
            : allowedRoles.includes(role)
              ? 'ALLOWED'
              : 'ROLE_NOT_ALLOWED';
        it(`${key} as ${role} -> ${expected}`, () => {
          expect(decideTransition(completeInput(from, to, role)).outcome).toBe(expected);
        });
      }
    }
  }

  it('lets admin perform no move at all', () => {
    const performed = ORDER_STATUSES.flatMap((from) =>
      ORDER_STATUSES.filter(
        (to) => decideTransition(completeInput(from, to, 'ADMIN')).outcome === 'ALLOWED',
      ).map((to) => `${from}>${to}`),
    );
    expect(performed).toEqual([]);
  });

  it('has no move out of a terminal status and none backwards', () => {
    for (const terminal of ['RECEIVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(nextStatuses(terminal)).toEqual([]);
    }
    const forward = [
      'SUBMITTED',
      'MANAGER_APPROVED',
      'ACCOUNTING_CLEARED',
      'RELEASED',
      'DELIVERED',
      'RECEIVED',
    ];
    for (const rule of TRANSITION_RULES) {
      const a = forward.indexOf(rule.from);
      const b = forward.indexOf(rule.to);
      if (b !== -1) expect(b, `${rule.from}>${rule.to}`).toBeGreaterThan(a);
    }
  });

  it('has exactly the ten moves of the transition table', () => {
    expect(TRANSITION_RULES.map((r) => `${r.from}>${r.to}`).sort()).toEqual(
      Object.keys(EXPECTED_ROLES).sort(),
    );
  });
});

describe('required input', () => {
  const REASON_MOVES = [
    ['SUBMITTED', 'REJECTED', 'MANAGER'],
    ['SUBMITTED', 'CANCELLED', 'MANAGER'],
    ['MANAGER_APPROVED', 'REJECTED', 'ACCOUNTANT'],
    ['MANAGER_APPROVED', 'CANCELLED', 'MANAGER'],
    ['ACCOUNTING_CLEARED', 'CANCELLED', 'MANAGER'],
  ] as const;

  it.each(REASON_MOVES)('%s > %s as %s needs a reason', (from, to, role) => {
    for (const reason of [undefined, null, '', '   \n']) {
      expect(decideTransition({ from, to, roles: [role], reason })).toEqual({
        outcome: 'INPUT_INVALID',
        issues: [{ path: 'reason', message: 'A reason is required' }],
      });
    }
  });

  it.each([
    ['SUBMITTED', 'MANAGER_APPROVED', 'MANAGER'],
    ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'ACCOUNTANT'],
    ['RELEASED', 'DELIVERED', 'DRIVER'],
    ['DELIVERED', 'RECEIVED', 'SELLER'],
  ] as const)('%s > %s as %s does not need a reason', (from, to, role) => {
    expect(decideTransition(completeInput(from, to, role)).outcome).toBe('ALLOWED');
  });

  it('manager approval needs a payment method ([C] 2026-10-24)', () => {
    for (const paymentMethod of [undefined, null]) {
      expect(
        decideTransition({
          from: 'SUBMITTED',
          to: 'MANAGER_APPROVED',
          roles: ['MANAGER'],
          paymentMethod,
        }),
      ).toEqual({
        outcome: 'INPUT_INVALID',
        issues: [{ path: 'paymentMethod', message: 'A payment method is required to approve' }],
      });
    }
    for (const paymentMethod of ['CASH', 'OFFICIAL'] as const) {
      const decision = decideTransition({
        from: 'SUBMITTED',
        to: 'MANAGER_APPROVED',
        roles: ['MANAGER'],
        paymentMethod,
      });
      expect(decision).toMatchObject({ outcome: 'ALLOWED', paymentMethod });
    }
  });

  it('every other move refuses a payment method and reports none', () => {
    for (const [key, roles] of Object.entries(EXPECTED_ROLES)) {
      if (key === 'SUBMITTED>MANAGER_APPROVED') continue;
      const [from, to] = key.split('>') as [OrderStatus, OrderStatus];
      const role = roles[0] as WorkflowRole;
      const input = completeInput(from, to, role);
      expect(decideTransition({ ...input, paymentMethod: 'OFFICIAL' }).outcome, key).toBe(
        'INPUT_INVALID',
      );
      expect(decideTransition(input), key).toMatchObject({
        outcome: 'ALLOWED',
        paymentMethod: null,
      });
    }
  });

  it('trims the reason', () => {
    const decision = decideTransition({
      from: 'SUBMITTED',
      to: 'REJECTED',
      roles: ['MANAGER'],
      reason: '  out of stock ',
    });
    expect(decision).toMatchObject({ outcome: 'ALLOWED', reason: 'out of stock' });
  });

  it('release needs a driver, other moves refuse one', () => {
    const release = {
      from: 'ACCOUNTING_CLEARED',
      to: 'RELEASED',
      roles: ['WAREHOUSE_MANAGER'],
    } as const;
    expect(decideTransition(release)).toEqual({
      outcome: 'INPUT_INVALID',
      issues: [{ path: 'driverUserId', message: 'A driver is required to release the order' }],
    });
    expect(decideTransition({ ...release, driverUserId: ' ' }).outcome).toBe('INPUT_INVALID');
    expect(decideTransition({ ...release, driverUserId: 'd1' })).toMatchObject({
      outcome: 'ALLOWED',
      driverUserId: 'd1',
    });
    expect(
      decideTransition({
        from: 'RELEASED',
        to: 'DELIVERED',
        roles: ['DRIVER'],
        driverUserId: 'd1',
      }).outcome,
    ).toBe('INPUT_INVALID');
  });

  it('the role is checked before the input', () => {
    expect(
      decideTransition({ from: 'SUBMITTED', to: 'CANCELLED', roles: ['DRIVER'] }).outcome,
    ).toBe('ROLE_NOT_ALLOWED');
  });
});

describe('manager skips accounting while approving', () => {
  const skip: TransitionInput = {
    from: 'SUBMITTED',
    to: 'MANAGER_APPROVED',
    roles: ['MANAGER'],
    skipAccounting: true,
    paymentMethod: 'CASH',
  };

  it('produces two steps with the accounting skip recorded explicitly', () => {
    const decision = decideTransition(skip);
    expect(decision).toMatchObject({ outcome: 'ALLOWED', actingRole: 'MANAGER' });
    if (decision.outcome !== 'ALLOWED') return;
    expect(decision.steps).toEqual([
      { from: 'SUBMITTED', to: 'MANAGER_APPROVED', eventType: 'STATUS_CHANGED' },
      { from: 'MANAGER_APPROVED', to: 'ACCOUNTING_CLEARED', eventType: 'ACCOUNTING_SKIPPED' },
    ]);
  });

  it('tells the accountant about a new order AND the warehouse at once', () => {
    const decision = decideTransition(skip);
    if (decision.outcome !== 'ALLOWED') throw new Error('expected ALLOWED');
    // [C] 2026-11-09: the customer hears about the approval, never about the clearance.
    expect(decision.effects).toEqual([
      { target: 'ACCOUNTANTS', type: 'ORDER_MANAGER_APPROVED' },
      { target: 'CUSTOMER', type: 'ORDER_MANAGER_APPROVED' },
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_ACCOUNTING_CLEARED' },
    ]);
  });

  it('is a single step when not ticked', () => {
    const decision = decideTransition({ ...skip, skipAccounting: false });
    if (decision.outcome !== 'ALLOWED') throw new Error('expected ALLOWED');
    expect(decision.steps).toHaveLength(1);
    expect(decision.effects).toEqual([
      { target: 'ACCOUNTANTS', type: 'ORDER_MANAGER_APPROVED' },
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_READY_TO_PREPARE' },
      { target: 'CUSTOMER', type: 'ORDER_MANAGER_APPROVED' },
    ]);
  });

  it('tells the warehouse once when ticked: ready, never also "prepare"', () => {
    const decision = decideTransition(skip);
    if (decision.outcome !== 'ALLOWED') throw new Error('expected ALLOWED');
    expect(decision.effects.filter((e) => e.target === 'WAREHOUSE_MANAGERS')).toEqual([
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_ACCOUNTING_CLEARED' },
    ]);
  });

  it('is only possible for the manager approving a submitted order', () => {
    for (const role of WORKFLOW_ROLES.filter((r) => r !== 'MANAGER')) {
      expect(decideTransition({ ...skip, roles: [role] }).outcome, role).toBe('ROLE_NOT_ALLOWED');
    }
    expect(
      decideTransition({
        from: 'MANAGER_APPROVED',
        to: 'ACCOUNTING_CLEARED',
        roles: ['ACCOUNTANT'],
        skipAccounting: true,
      }).outcome,
    ).toBe('INPUT_INVALID');
    expect(
      decideTransition({ ...skip, to: 'REJECTED', reason: 'no', skipAccounting: true }).outcome,
    ).toBe('INPUT_INVALID');
  });
});

describe('side effects (lifecycle §3)', () => {
  function effects(
    from: OrderStatus,
    to: OrderStatus,
    role: WorkflowRole,
    extra: Partial<TransitionInput> = {},
  ): unknown {
    const approval = from === 'SUBMITTED' && to === 'MANAGER_APPROVED';
    const decision = decideTransition({
      from,
      to,
      roles: [role],
      reason: 'x',
      ...(approval ? { paymentMethod: 'CASH' as const } : {}),
      ...extra,
    });
    if (decision.outcome !== 'ALLOWED') throw new Error(`${from}>${to} ${decision.outcome}`);
    return decision.effects.map((e) => `${e.target}:${e.type}`);
  }

  it('matches the table', () => {
    expect(effects('SUBMITTED', 'MANAGER_APPROVED', 'MANAGER')).toEqual([
      'ACCOUNTANTS:ORDER_MANAGER_APPROVED',
      'WAREHOUSE_MANAGERS:ORDER_READY_TO_PREPARE',
      'CUSTOMER:ORDER_MANAGER_APPROVED',
    ]);
    expect(effects('SUBMITTED', 'REJECTED', 'MANAGER')).toEqual(['CUSTOMER:ORDER_REJECTED']);
    // [C] 2026-11-09: clearance, release and delivery are silent for the customer side.
    expect(effects('MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'ACCOUNTANT')).toEqual([
      'WAREHOUSE_MANAGERS:ORDER_ACCOUNTING_CLEARED',
    ]);
    expect(effects('MANAGER_APPROVED', 'REJECTED', 'ACCOUNTANT')).toEqual([
      'MANAGERS:ORDER_REJECTED',
      'WAREHOUSE_MANAGERS:ORDER_REJECTED',
      'CUSTOMER:ORDER_REJECTED',
    ]);
    // the accountants and the warehouse were told about the approval, so they hear about the cancellation
    expect(effects('MANAGER_APPROVED', 'CANCELLED', 'MANAGER')).toEqual([
      'ACCOUNTANTS:ORDER_CANCELLED',
      'WAREHOUSE_MANAGERS:ORDER_CANCELLED',
      'CUSTOMER:ORDER_CANCELLED',
      'PLACER:ORDER_CANCELLED',
    ]);
    expect(
      effects('ACCOUNTING_CLEARED', 'RELEASED', 'WAREHOUSE_MANAGER', { driverUserId: 'd' }),
    ).toEqual(['DRIVER:ORDER_RELEASED']);
    expect(effects('ACCOUNTING_CLEARED', 'CANCELLED', 'MANAGER')).toEqual([
      'WAREHOUSE_MANAGERS:ORDER_CANCELLED',
      'CUSTOMER:ORDER_CANCELLED',
      'PLACER:ORDER_CANCELLED',
    ]);
    expect(effects('RELEASED', 'DELIVERED', 'DRIVER')).toEqual([]);
    expect(effects('DELIVERED', 'RECEIVED', 'SHOP_OWNER')).toEqual(['MANAGERS:ORDER_RECEIVED']);
  });

  it('keeps the customer side out of the transition table: only the customer notification table adds it', () => {
    for (const rule of TRANSITION_RULES) {
      const customerSide = rule.effects.filter((effect) =>
        ['CUSTOMER', 'PLACER'].includes(effect.target),
      );
      expect(customerSide, `${rule.from}>${rule.to}`).toEqual([]);
    }
  });

  it('cancelling a submitted order tells the organization chat and the placer', () => {
    expect(effects('SUBMITTED', 'CANCELLED', 'MANAGER')).toEqual([
      'CUSTOMER:ORDER_CANCELLED',
      'PLACER:ORDER_CANCELLED',
    ]);
  });
});

describe('several roles', () => {
  it('uses the first of the actor roles the move allows', () => {
    expect(
      decideTransition({
        from: 'MANAGER_APPROVED',
        to: 'ACCOUNTING_CLEARED',
        roles: ['MANAGER', 'ACCOUNTANT'],
      }),
    ).toMatchObject({ outcome: 'ALLOWED', actingRole: 'ACCOUNTANT' });
  });

  it('denies an actor without any role', () => {
    expect(decideTransition({ from: 'SUBMITTED', to: 'MANAGER_APPROVED', roles: [] }).outcome).toBe(
      'ROLE_NOT_ALLOWED',
    );
  });
});

describe('isAtOrBeyond (who lost a race)', () => {
  it('is true for the same status and for every status reachable from the target', () => {
    expect(isAtOrBeyond('MANAGER_APPROVED', 'MANAGER_APPROVED')).toBe(true);
    expect(isAtOrBeyond('ACCOUNTING_CLEARED', 'MANAGER_APPROVED')).toBe(true);
    expect(isAtOrBeyond('RECEIVED', 'MANAGER_APPROVED')).toBe(true);
    expect(isAtOrBeyond('REJECTED', 'MANAGER_APPROVED')).toBe(true); // approved, then rejected
    expect(isAtOrBeyond('CANCELLED', 'CANCELLED')).toBe(true);
  });

  it('is false when the order is on another branch, behind, or the target is SUBMITTED', () => {
    expect(isAtOrBeyond('SUBMITTED', 'MANAGER_APPROVED')).toBe(false);
    expect(isAtOrBeyond('RELEASED', 'CANCELLED')).toBe(false);
    expect(isAtOrBeyond('RECEIVED', 'REJECTED')).toBe(false);
    expect(isAtOrBeyond('CANCELLED', 'RELEASED')).toBe(false);
    expect(isAtOrBeyond('CANCELLED', 'SUBMITTED')).toBe(false); // nothing leads to SUBMITTED
  });
});

describe('mayEverMoveTo', () => {
  it('is true only for roles that appear in some move to that status', () => {
    expect(mayEverMoveTo(['MANAGER'], 'MANAGER_APPROVED')).toBe(true);
    expect(mayEverMoveTo(['ACCOUNTANT'], 'MANAGER_APPROVED')).toBe(false);
    expect(mayEverMoveTo(['DRIVER', 'MANAGER'], 'REJECTED')).toBe(true);
    expect(mayEverMoveTo([], 'REJECTED')).toBe(false);
    expect(mayEverMoveTo(['ADMIN'], 'SUBMITTED')).toBe(false);
  });
});
