import { ORDER_STATUSES, type StaffRole } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import type { Actor, ResourceContext } from './actor.js';
import { can, holdsAnyGrantFor } from './can.js';
import { scopeFor } from './scope-for.js';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MATRIX,
  type ContextFreeAction,
  type PermissionAction,
} from './permission-matrix.js';

const CONTEXT_FREE: readonly ContextFreeAction[] = [
  'BROWSE_PRICE_LIST',
  'USE_CART',
  'CREATE_ORDER_FOR_CUSTOMER',
  'MANAGER_DECIDE_ORDER',
  'MANAGE_ORDER_ALLOCATION',
  'SKIP_ACCOUNTING',
  'ACCOUNTING_DECIDE_ORDER',
  'VIEW_ORGANIZATION_BALANCE',
  'RECORD_ORGANIZATION_PAYMENT',
  'CORRECT_ORGANIZATION_PAYMENT',
  'VIEW_OWN_BALANCE',
  'VIEW_PAYMENT_METHOD',
  'SET_PAYMENT_METHOD',
  'UPDATE_PRICE_LIST',
  'VIEW_COST_REFERENCE',
  'VIEW_PRICE_ADMIN',
  'SET_USD_RATE',
  'DECIDE_SUPPLY_REMOVAL',
  'SET_SUPPLY_PARTY',
  'RUN_SHEET_SYNC',
  'CONFIGURE_TELEGRAM_SCHEDULE',
  'EDIT_CUSTOMERS',
  'CHANGE_ORGANIZATION_LABEL',
  'ARCHIVE_ORGANIZATION',
  'VIEW_CUSTOMERS',
  'LIST_DRIVERS',
  'MANAGE_STAFF',
  'MANAGE_STAFF_CREDENTIALS',
  'MANAGE_STAFF_ACCOUNTS',
  'VIEW_STAFF_DIRECTORY',
  'CONNECT_BOT_NOTIFICATIONS',
  'VIEW_MARKED_ORDER_NOTIFICATIONS',
  'OPEN_CUSTOMER_SITE',
  'VIEW_OWN_PROFILE',
  'SET_OWN_CONTACT',
  'EDIT_OWN_STAFF_PROFILE',
  'MANAGE_OWN_CUSTOMER_LOGIN',
  'VIEW_UNIT_CODES',
  'VIEW_PERSON_CARD',
  'FIND_PERSON_BY_TELEGRAM',
  'VIEW_TELEGRAM_IDS',
  'VIEW_STAFF_PHONE',
  'VIEW_RECEIVED_GOODS',
  'MANAGE_PRODUCT_IMAGES',
  'VIEW_OWN_RECOMMENDATIONS',
  'DECIDE_PRODUCT_SUCCESSION',
];

describe('selling prices and cost visibility', () => {
  const roles = ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const;
  const staffActor = (role: (typeof roles)[number]): Actor => ({
    userId: 'u-1',
    staffRoles: [role],
  });
  const holders = (action: PermissionAction): string[] =>
    roles.filter((role) => can(staffActor(role), action as ContextFreeAction)).sort();

  it('party numbers: the manager alone', () => {
    expect(holders('SET_SUPPLY_PARTY')).toEqual(['MANAGER']);
  });

  it('supply removals: accountant may view the pending list but never decide; others cannot do either', () => {
    expect(holders('DECIDE_SUPPLY_REMOVAL')).toEqual(['ADMIN', 'MANAGER']);
    expect(holders('VIEW_COST_REFERENCE')).toContain('ACCOUNTANT');
    expect(can(staffActor('ACCOUNTANT'), 'DECIDE_SUPPLY_REMOVAL')).toBe(false);
    for (const role of ['WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      expect(can(staffActor(role), 'DECIDE_SUPPLY_REMOVAL')).toBe(false);
      expect(can(staffActor(role), 'VIEW_COST_REFERENCE')).toBe(false);
    }
    for (const organizationRole of ['SHOP_OWNER', 'SELLER'] as const) {
      const customer: Actor = {
        userId: 'u-1',
        staffRoles: [],
        membership: { organizationId: 'org-1', role: organizationRole },
      };
      expect(can(customer, 'DECIDE_SUPPLY_REMOVAL')).toBe(false);
    }
  });

  it('"sync now" with the sheet: manager and admin start a run, the accountant only reads the reports', () => {
    expect(holders('RUN_SHEET_SYNC')).toEqual(['ADMIN', 'MANAGER']);
    expect(can(staffActor('ACCOUNTANT'), 'RUN_SHEET_SYNC')).toBe(false);
    expect(can(staffActor('ACCOUNTANT'), 'VIEW_COST_REFERENCE')).toBe(true);
    for (const role of ['WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      expect(can(staffActor(role), 'RUN_SHEET_SYNC')).toBe(false);
    }
  });

  it('an organization label changes only by the admin after creation [C, owner 2026-11-12]', () => {
    expect(holders('CHANGE_ORGANIZATION_LABEL')).toEqual(['ADMIN']);
    expect(can(staffActor('MANAGER'), 'CHANGE_ORGANIZATION_LABEL')).toBe(false);
  });

  it('an organization is archived and restored only by the admin [C, owner 2026-11-13]', () => {
    expect(holders('ARCHIVE_ORGANIZATION')).toEqual(['ADMIN']);
    expect(can(staffActor('MANAGER'), 'ARCHIVE_ORGANIZATION')).toBe(false);
  });

  it('the accountant can NEVER change selling prices: only manager and admin may', () => {
    expect(holders('UPDATE_PRICE_LIST')).toEqual(['ADMIN', 'MANAGER']);
    expect(can(staffActor('ACCOUNTANT'), 'UPDATE_PRICE_LIST')).toBe(false);
    expect(holdsAnyGrantFor(staffActor('ACCOUNTANT'), 'UPDATE_PRICE_LIST')).toBe(false);
    expect(scopeFor(staffActor('ACCOUNTANT'), 'UPDATE_PRICE_LIST')).toEqual([]);
  });

  it('cost reference and USD rate: accountant may view, only manager and admin may change the rate', () => {
    expect(holders('VIEW_COST_REFERENCE')).toEqual(['ACCOUNTANT', 'ADMIN', 'MANAGER']);
    expect(holders('SET_USD_RATE')).toEqual(['ADMIN', 'MANAGER']);
  });

  it('customers, warehouse and driver are denied both cost actions', () => {
    const others: Actor[] = [
      staffActor('WAREHOUSE_MANAGER'),
      staffActor('DRIVER'),
      {
        userId: 'u-1',
        staffRoles: [],
        membership: { organizationId: 'org-1', role: 'SHOP_OWNER' },
      },
      { userId: 'u-1', staffRoles: [], membership: { organizationId: 'org-1', role: 'SELLER' } },
    ];
    for (const actor of others) {
      expect(can(actor, 'VIEW_COST_REFERENCE')).toBe(false);
      expect(can(actor, 'SET_USD_RATE')).toBe(false);
    }
  });
});

describe('matrix invariants', () => {
  it('every action has at least one grant', () => {
    for (const action of PERMISSION_ACTIONS) {
      expect(PERMISSION_MATRIX[action].length, action).toBeGreaterThan(0);
    }
  });

  it('no staff ROLE is ever granted the customer actions', () => {
    // A staff viewer grant ([C] 2026-11-09) is not a staff role grant: it applies only to the
    // viewer actor, which carries no staff role. Its own rows are pinned in staff-viewer.spec.ts.
    const withoutStaffRole = PERMISSION_ACTIONS.filter(
      (action) => !PERMISSION_MATRIX[action].some((grant) => grant.kind === 'staff'),
    );
    expect([...withoutStaffRole].sort()).toEqual([
      'CHANGE_OWN_PAYMENT_PLAN',
      'CONFIRM_RECEIPT',
      'MANAGE_OWN_CUSTOMER_LOGIN',
      'SET_OWN_CONTACT',
      'SUBMIT_ORDER',
      'USE_CART',
      'VIEW_OWN_BALANCE',
      'VIEW_OWN_RECOMMENDATIONS',
      'VIEW_RECEIVED_GOODS',
    ]);
  });

  it('only customers and no staff viewer hold the remaining customer-only actions', () => {
    const customerOnly = PERMISSION_ACTIONS.filter((action) =>
      PERMISSION_MATRIX[action].every((grant) => grant.kind === 'organization'),
    );
    expect([...customerOnly].sort()).toEqual([
      'CHANGE_OWN_PAYMENT_PLAN',
      'CONFIRM_RECEIPT',
      'MANAGE_OWN_CUSTOMER_LOGIN',
      'SET_OWN_CONTACT',
    ]);
  });

  it('the ContextFreeAction type lists exactly the actions without conditions', () => {
    const unconditioned = PERMISSION_ACTIONS.filter((action) =>
      PERMISSION_MATRIX[action].every((grant) => grant.when.length === 0),
    );
    expect([...unconditioned].sort()).toEqual([...CONTEXT_FREE].sort());
  });

  it('is deeply frozen: mutation attempts throw and change nothing', () => {
    const matrix = PERMISSION_MATRIX as unknown as Record<string, unknown[]>;
    const before = JSON.stringify(PERMISSION_MATRIX);
    expect(() => {
      matrix.MANAGE_STAFF = [];
    }).toThrow(TypeError);
    expect(() => {
      matrix.MANAGE_STAFF?.push({ kind: 'staff', role: 'DRIVER', when: [] });
    }).toThrow(TypeError);
    const grant = PERMISSION_MATRIX.MANAGE_STAFF[0] as unknown as { role: string };
    expect(() => {
      grant.role = 'DRIVER';
    }).toThrow(TypeError);
    const when = PERMISSION_MATRIX.CANCEL_ORDER[0]?.when as unknown as string[];
    expect(() => when.pop()).toThrow(TypeError);
    expect(JSON.stringify(PERMISSION_MATRIX)).toBe(before);
  });
});

describe('identity conditions fail closed on missing facts', () => {
  const owner = (userId: string, organizationId: string): Actor => ({
    userId,
    staffRoles: [],
    membership: { organizationId, role: 'SHOP_OWNER' },
  });
  const seller = (userId: string, organizationId: string): Actor => ({
    userId,
    staffRoles: [],
    membership: { organizationId, role: 'SELLER' },
  });
  const driver = (userId: string): Actor => ({ userId, staffRoles: ['DRIVER'] });
  const blank = ['', undefined] as const;

  describe('PLACED_BY_ACTOR', () => {
    it.each(blank)('actor userId %j never matches a missing placedByUserId', (value) => {
      const actor = seller(value as unknown as string, 'org-1');
      for (const placedByUserId of blank) {
        const context: ResourceContext = {
          organizationId: 'org-1',
          status: 'DELIVERED',
          placedByUserId,
        };
        expect(can(actor, 'CONFIRM_RECEIPT', context)).toBe(false);
      }
    });

    it.each(blank)('context placedByUserId %j does not match a real actor', (placedByUserId) => {
      const context: ResourceContext = {
        organizationId: 'org-1',
        status: 'DELIVERED',
        placedByUserId,
      };
      expect(can(seller('u-1', 'org-1'), 'CONFIRM_RECEIPT', context)).toBe(false);
    });
  });

  describe('SAME_ORGANIZATION', () => {
    it.each(blank)(
      'actor organizationId %j never matches a missing resource organization',
      (value) => {
        const actor = owner('u-1', value as unknown as string);
        for (const organizationId of blank) {
          const context: ResourceContext = { organizationId, status: 'SUBMITTED' };
          expect(can(actor, 'VIEW_ORDER', context)).toBe(false);
          expect(can(actor, 'SUBMIT_ORDER', context)).toBe(false);
          expect(can(actor, 'CONFIRM_RECEIPT', context)).toBe(false);
        }
      },
    );

    it.each(blank)(
      'context organizationId %j does not match a real organization',
      (organizationId) => {
        const context: ResourceContext = { organizationId, status: 'SUBMITTED' };
        expect(can(owner('u-1', 'org-1'), 'VIEW_ORDER', context)).toBe(false);
      },
    );

    it('an actor without membership never matches', () => {
      const actor: Actor = { userId: 'u-1', staffRoles: [] };
      expect(can(actor, 'VIEW_ORDER', { organizationId: 'org-1' })).toBe(false);
    });
  });

  describe('ASSIGNED_TO_ACTOR', () => {
    it.each(blank)('actor userId %j never matches an unassigned order', (value) => {
      const actor = driver(value as unknown as string);
      for (const assignedDriverId of [...blank, null]) {
        const context: ResourceContext = { status: 'RELEASED', assignedDriverId };
        expect(can(actor, 'VIEW_ORDER', context)).toBe(false);
        expect(can(actor, 'MARK_DELIVERED', context)).toBe(false);
      }
    });

    it.each([...blank, null])(
      'assignedDriverId %j does not match a real driver',
      (assignedDriverId) => {
        const context: ResourceContext = { status: 'RELEASED', assignedDriverId };
        expect(can(driver('u-1'), 'VIEW_ORDER', context)).toBe(false);
        expect(can(driver('u-1'), 'MARK_DELIVERED', context)).toBe(false);
      },
    );
  });
});

describe('status gating of release and delivery', () => {
  const warehouse: Actor = { userId: 'w-1', staffRoles: ['WAREHOUSE_MANAGER'] };
  const driver: Actor = { userId: 'd-1', staffRoles: ['DRIVER'] };

  it('warehouse can release only an ACCOUNTING_CLEARED order', () => {
    for (const status of ORDER_STATUSES) {
      expect(can(warehouse, 'RELEASE_ORDER', { status })).toBe(status === 'ACCOUNTING_CLEARED');
    }
    expect(can(warehouse, 'RELEASE_ORDER', {})).toBe(false);
  });

  it('the assigned driver can mark delivered only a RELEASED order', () => {
    for (const status of ORDER_STATUSES) {
      const context: ResourceContext = { status, assignedDriverId: 'd-1' };
      expect(can(driver, 'MARK_DELIVERED', context)).toBe(status === 'RELEASED');
    }
  });

  it('a warehouse manager cannot probe a SUBMITTED order through RELEASE_ORDER', () => {
    const action: PermissionAction = 'RELEASE_ORDER';
    expect(can(warehouse, action, { status: 'SUBMITTED' })).toBe(false);
    expect(can(warehouse, 'VIEW_ORDER', { status: 'SUBMITTED' })).toBe(false);
  });
});

describe('customers see their organization orders in every status', () => {
  it.each(['SHOP_OWNER', 'SELLER'] as const)('%s can view own-organization orders', (role) => {
    const actor: Actor = {
      userId: 'u-1',
      staffRoles: [],
      membership: { organizationId: 'org-1', role },
    };
    for (const status of ORDER_STATUSES) {
      expect(can(actor, 'VIEW_ORDER', { organizationId: 'org-1', status }), status).toBe(true);
    }
    expect(can(actor, 'VIEW_ORDER', { organizationId: 'org-1', status: 'REJECTED' })).toBe(true);
    expect(can(actor, 'VIEW_ORDER', { organizationId: 'org-1', status: 'CANCELLED' })).toBe(true);
  });
});

describe('customer cancel and receipt fail closed', () => {
  const member = (
    role: 'SHOP_OWNER' | 'SELLER',
    organizationId: string | undefined,
    userId = 'u-1',
  ): Actor => ({
    userId,
    staffRoles: [],
    membership: { organizationId: organizationId as string, role },
  });
  const roles = ['SHOP_OWNER', 'SELLER'] as const;
  const blank = ['', undefined] as const;

  it.each(roles)('%s cannot cancel, whatever placedByUserId says', (role) => {
    for (const placedByUserId of [...blank, 'u-1', 'u-2']) {
      const context: ResourceContext = {
        organizationId: 'org-1',
        status: 'SUBMITTED',
        placedByUserId,
      };
      expect(can(member(role, 'org-1', 'u-1'), 'CANCEL_ORDER', context)).toBe(false);
    }
  });

  it.each(roles)('%s cannot cancel with a blank organization on either side', (role) => {
    for (const blankOrg of blank) {
      expect(
        can(member(role, blankOrg), 'CANCEL_ORDER', {
          organizationId: 'org-1',
          status: 'SUBMITTED',
        }),
      ).toBe(false);
      expect(
        can(member(role, 'org-1'), 'CANCEL_ORDER', {
          organizationId: blankOrg,
          status: 'SUBMITTED',
        }),
      ).toBe(false);
      expect(
        can(member(role, blankOrg), 'CANCEL_ORDER', {
          organizationId: blankOrg,
          status: 'SUBMITTED',
        }),
      ).toBe(false);
    }
  });

  it.each(roles)('%s cannot cancel in any status', (role) => {
    expect(ORDER_STATUSES).toHaveLength(8);
    for (const status of ORDER_STATUSES) {
      expect(can(member(role, 'org-1'), 'CANCEL_ORDER', { organizationId: 'org-1', status })).toBe(
        false,
      );
    }
  });

  it.each(roles)('%s confirms receipt only for a DELIVERED order', (role) => {
    for (const status of ORDER_STATUSES) {
      const context: ResourceContext = { organizationId: 'org-1', placedByUserId: 'u-1', status };
      expect(can(member(role, 'org-1'), 'CONFIRM_RECEIPT', context)).toBe(status === 'DELIVERED');
    }
  });
});

describe('staff never gain customer grants from a membership', () => {
  const STAFF: readonly StaffRole[] = [
    'ADMIN',
    'MANAGER',
    'ACCOUNTANT',
    'WAREHOUSE_MANAGER',
    'DRIVER',
  ];
  const submitted: ResourceContext = {
    organizationId: 'org-1',
    placedByUserId: 'u-1',
    assignedDriverId: null,
    status: 'SUBMITTED',
  };
  const delivered: ResourceContext = { ...submitted, status: 'DELIVERED' };

  // Hand-written from the staff grants only (lifecycle §5); independent of effectiveMembership.
  const has = (roles: readonly StaffRole[], role: StaffRole): boolean => roles.includes(role);
  const EXPECT = {
    BROWSE_PRICE_LIST: (role: StaffRole) => has(['ADMIN', 'MANAGER', 'ACCOUNTANT'], role),
    SUBMIT_ORDER: () => false,
    CONFIRM_RECEIPT: () => false,
    CANCEL_ORDER: (role: StaffRole) => has(['MANAGER'], role),
    VIEW_ORDER: (role: StaffRole) => has(['ADMIN', 'MANAGER', 'ACCOUNTANT'], role),
  } as const;
  const ANY_GRANT = {
    BROWSE_PRICE_LIST: EXPECT.BROWSE_PRICE_LIST,
    SUBMIT_ORDER: EXPECT.SUBMIT_ORDER,
    CONFIRM_RECEIPT: EXPECT.CONFIRM_RECEIPT,
    CANCEL_ORDER: EXPECT.CANCEL_ORDER,
    // Warehouse and driver have a (conditioned) view grant.
    VIEW_ORDER: () => true,
  } as const;
  const SCOPES: Record<string, (role: StaffRole) => unknown[]> = {
    BROWSE_PRICE_LIST: (role) => (EXPECT.BROWSE_PRICE_LIST(role) ? [{}] : []),
    SUBMIT_ORDER: () => [],
    CONFIRM_RECEIPT: () => [],
    CANCEL_ORDER: (role) =>
      EXPECT.CANCEL_ORDER(role)
        ? [{ statuses: ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'] }]
        : [],
    VIEW_ORDER: (role) => {
      if (EXPECT.VIEW_ORDER(role)) return [{}];
      if (role === 'WAREHOUSE_MANAGER') {
        return [
          {
            statuses: [
              'MANAGER_APPROVED',
              'ACCOUNTING_CLEARED',
              'RELEASED',
              'DELIVERED',
              'RECEIVED',
            ],
          },
          { statuses: ['REJECTED', 'CANCELLED'], managerApproved: true },
        ];
      }
      return [{ assignedDriverId: 'u-1' }];
    },
  };

  const actions = Object.keys(EXPECT) as (keyof typeof EXPECT)[];
  const cases = STAFF.flatMap((role) =>
    (['SELLER', 'SHOP_OWNER'] as const).map((membershipRole) => [role, membershipRole] as const),
  );

  it.each(cases)('%s with a %s membership has staff grants only', (role, membershipRole) => {
    const actor: Actor = {
      userId: 'u-1',
      staffRoles: [role],
      membership: { organizationId: 'org-1', role: membershipRole },
    };
    for (const action of actions) {
      const context = action === 'CONFIRM_RECEIPT' ? delivered : submitted;
      expect(can(actor, action, context), `can ${action}`).toBe(EXPECT[action](role));
      expect(holdsAnyGrantFor(actor, action), `any ${action}`).toBe(ANY_GRANT[action](role));
      expect(scopeFor(actor, action), `scope ${action}`).toEqual(SCOPES[action]?.(role));
    }
  });
});
