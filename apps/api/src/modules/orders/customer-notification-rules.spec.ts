import type { OrderStatus } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_SIDE_NOTIFICATIONS,
  customerSideTargets,
  customerSideTargetsOfMove,
  type OrderOccurrence,
} from './customer-notification-rules.js';
import {
  buildItemsEditedNotifications,
  buildPaymentPlanChangedByCustomerNotifications,
  buildPaymentPlanChangedNotifications,
  buildSubmittedNotifications,
  buildTransitionNotifications,
  type NotificationContext,
  type OutboxRowInput,
} from './order-notifications.js';
import {
  decideTransition,
  TRANSITION_RULES,
  type TransitionInput,
  type WorkflowRole,
} from './order-state-machine.js';

// Hand-written from the owner's rule of 2026-11-09 (lifecycle §6.3), NOT derived from the table:
// the customer side hears from the bot when the manager approves, when the order is refused
// (rejected or cancelled) and when the manager changes its lines or its payment plan. Nothing else.
// 'GROUP' = the organization chat, 'PLACER' = the private chat of the person who placed the order.
const EXPECTED: Readonly<Record<OrderOccurrence, readonly ('GROUP' | 'PLACER')[]>> = {
  ORDER_SUBMITTED: [],
  'SUBMITTED>MANAGER_APPROVED': ['GROUP'],
  'SUBMITTED>REJECTED': ['GROUP'],
  'SUBMITTED>CANCELLED': ['GROUP', 'PLACER'],
  'MANAGER_APPROVED>ACCOUNTING_CLEARED': [],
  'MANAGER_APPROVED>REJECTED': ['GROUP'],
  'MANAGER_APPROVED>CANCELLED': ['GROUP', 'PLACER'],
  'ACCOUNTING_CLEARED>RELEASED': [],
  'ACCOUNTING_CLEARED>CANCELLED': ['GROUP', 'PLACER'],
  'RELEASED>DELIVERED': [],
  'DELIVERED>RECEIVED': [],
  ITEMS_EDITED_BY_MANAGER: ['GROUP'],
  PAYMENT_PLAN_CHANGED_BY_MANAGER: ['GROUP'],
  PAYMENT_PLAN_CHANGED_BY_CUSTOMER: [],
};

const context: NotificationContext = {
  orderId: 'o1',
  orderNumber: 'IO-10001',
  organizationId: 'org1',
  placedByUserId: 'placer',
  actorUserId: 'actor',
  actorRole: 'MANAGER',
  totalAmount: '4500.00',
  currency: 'UZS',
  reason: 'because',
  driverUserId: null,
  accountingSkipped: false,
};

/** Who on the customer side a set of outbox rows reaches, in the vocabulary of EXPECTED. */
function customerSide(rows: readonly OutboxRowInput[]): string[] {
  return rows.flatMap((row) => {
    if (row.recipientKind === 'ORGANIZATION_CHAT') return ['GROUP'];
    return row.recipientKind === 'USER' && row.recipientUserId === 'placer' ? ['PLACER'] : [];
  });
}

function moveRows(key: string, extra: Partial<TransitionInput> = {}): OutboxRowInput[] {
  const [from, to] = key.split('>') as [OrderStatus, OrderStatus];
  const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
  if (!rule) throw new Error(`No rule ${key}`);
  const decision = decideTransition({
    from,
    to,
    roles: [rule.roles[0] as WorkflowRole],
    reason: 'because',
    ...(rule.driverRequired ? { driverUserId: 'driver-1' } : {}),
    ...(rule.paymentMethodRequired ? { paymentMethod: 'CASH' as const } : {}),
    ...extra,
  });
  if (decision.outcome !== 'ALLOWED') throw new Error(`${key}: ${decision.outcome}`);
  return buildTransitionNotifications(decision.effects, {
    ...context,
    actorRole: decision.actingRole,
    driverUserId: decision.driverUserId,
  });
}

const change = { oldTotal: '4500.00', newTotal: '3000.00', newRowVersion: 2 };
const planChange = { ...change, oldPlan: 'FULL', newPlan: 'DEFERRED' } as const;

/** The rows each occurrence really writes, through the same builders the service calls. */
const ROWS_OF: Readonly<Record<OrderOccurrence, () => OutboxRowInput[]>> = {
  ORDER_SUBMITTED: () => buildSubmittedNotifications({ ...context, actorRole: 'SELLER' }),
  'SUBMITTED>MANAGER_APPROVED': () => moveRows('SUBMITTED>MANAGER_APPROVED'),
  'SUBMITTED>REJECTED': () => moveRows('SUBMITTED>REJECTED'),
  'SUBMITTED>CANCELLED': () => moveRows('SUBMITTED>CANCELLED'),
  'MANAGER_APPROVED>ACCOUNTING_CLEARED': () => moveRows('MANAGER_APPROVED>ACCOUNTING_CLEARED'),
  'MANAGER_APPROVED>REJECTED': () => moveRows('MANAGER_APPROVED>REJECTED'),
  'MANAGER_APPROVED>CANCELLED': () => moveRows('MANAGER_APPROVED>CANCELLED'),
  'ACCOUNTING_CLEARED>RELEASED': () => moveRows('ACCOUNTING_CLEARED>RELEASED'),
  'ACCOUNTING_CLEARED>CANCELLED': () => moveRows('ACCOUNTING_CLEARED>CANCELLED'),
  'RELEASED>DELIVERED': () => moveRows('RELEASED>DELIVERED'),
  'DELIVERED>RECEIVED': () => moveRows('DELIVERED>RECEIVED'),
  ITEMS_EDITED_BY_MANAGER: () => buildItemsEditedNotifications(context, change),
  PAYMENT_PLAN_CHANGED_BY_MANAGER: () => buildPaymentPlanChangedNotifications(context, planChange),
  PAYMENT_PLAN_CHANGED_BY_CUSTOMER: () =>
    buildPaymentPlanChangedByCustomerNotifications({ ...context, actorRole: 'SELLER' }, planChange),
};

describe('which order events tell the customer side ([C] owner 2026-11-09)', () => {
  it('lists exactly the expected occurrences', () => {
    expect(Object.keys(CUSTOMER_SIDE_NOTIFICATIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('has an entry for every move of the transition table, and no move that does not exist', () => {
    const moves = TRANSITION_RULES.map((rule) => `${rule.from}>${rule.to}`).sort();
    const listed = Object.keys(CUSTOMER_SIDE_NOTIFICATIONS)
      .filter((key) => key.includes('>'))
      .sort();
    expect(listed).toEqual(moves);
  });

  describe.each(Object.keys(EXPECTED) as OrderOccurrence[])('%s', (occurrence) => {
    const expected = EXPECTED[occurrence];
    const notified = expected.length > 0;

    it(`the table says: ${notified ? expected.join(' + ') : 'not notified'}`, () => {
      const targets = customerSideTargets(occurrence).map((target) =>
        target === 'CUSTOMER' ? 'GROUP' : target,
      );
      expect(targets).toEqual(expected);
    });

    it(`the outbox rows it writes reach ${notified ? expected.join(' + ') : 'nobody on the customer side'}`, () => {
      expect(customerSide(ROWS_OF[occurrence]())).toEqual(expected);
    });
  });

  it('a skipped accounting step tells the group once: the approval, not the clearance', () => {
    const rows = moveRows('SUBMITTED>MANAGER_APPROVED', { skipAccounting: true });
    expect(
      rows.filter((row) => row.recipientKind === 'ORGANIZATION_CHAT').map((row) => row.type),
    ).toEqual(['ORDER_MANAGER_APPROVED']);
  });

  it('a refusal carries the reason as written, to the group and to the placer', () => {
    for (const key of ['SUBMITTED>REJECTED', 'MANAGER_APPROVED>REJECTED', 'SUBMITTED>CANCELLED']) {
      const rows = moveRows(key).filter(
        (row) => row.recipientKind === 'ORGANIZATION_CHAT' || row.recipientUserId === 'placer',
      );
      expect(rows.length, key).toBeGreaterThan(0);
      expect(
        rows.every((row) => row.payload.reason === 'because'),
        key,
      ).toBe(true);
    }
  });

  it('a move that is not in the table is silent, never an error', () => {
    expect(customerSideTargetsOfMove('RECEIVED', 'SUBMITTED')).toEqual([]);
    expect(customerSideTargetsOfMove('SUBMITTED', 'MANAGER_APPROVED')).toEqual(['CUSTOMER']);
  });

  it('staff still get their messages for the moves that are silent for the customer', () => {
    const staff = (key: string): string[] =>
      moveRows(key)
        .filter((row) => row.recipientKind !== 'ORGANIZATION_CHAT')
        .map((row) => `${row.recipientRole ?? row.recipientUserId}:${row.type}`);
    expect(staff('MANAGER_APPROVED>ACCOUNTING_CLEARED')).toEqual([
      'WAREHOUSE_MANAGER:ORDER_ACCOUNTING_CLEARED',
    ]);
    expect(staff('ACCOUNTING_CLEARED>RELEASED')).toEqual(['driver-1:ORDER_RELEASED']);
    expect(staff('DELIVERED>RECEIVED')).toEqual(['MANAGER:ORDER_RECEIVED']);
  });
});
