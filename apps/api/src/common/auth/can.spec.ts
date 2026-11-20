import type { OrderStatus, StaffRole } from '@iorder/shared';
import { ORDER_STATUSES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import type { Actor, ResourceContext } from './actor.js';
import { can, holdsAnyGrantFor } from './can.js';
import { scopeFor } from './scope-for.js';
import { PERMISSION_ACTIONS, type PermissionAction } from './permission-matrix.js';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

type Principal = StaffRole | 'SHOP_OWNER' | 'SELLER' | 'NO_ROLES';

const PRINCIPALS: readonly Principal[] = [
  'ADMIN',
  'MANAGER',
  'ACCOUNTANT',
  'WAREHOUSE_MANAGER',
  'DRIVER',
  'PURCHASING_MANAGER',
  'SHOP_OWNER',
  'SELLER',
  'NO_ROLES',
];

function actorFor(principal: Principal): Actor {
  switch (principal) {
    case 'SHOP_OWNER':
    case 'SELLER':
      return {
        userId: 'u-1',
        staffRoles: [],
        membership: { organizationId: ORG, role: principal },
      };
    case 'NO_ROLES':
      return { userId: 'u-1', staffRoles: [] };
    default:
      return { userId: 'u-1', staffRoles: [principal] };
  }
}

// The most favourable context for an action: own organization, placed by the actor,
// assigned to the actor, in a status the action allows. Role is then the only variable.
function favourableContext(status: OrderStatus): ResourceContext {
  return {
    organizationId: ORG,
    placedByUserId: 'u-1',
    assignedDriverId: 'u-1',
    status,
  };
}

// Written by hand from order-lifecycle.md §5, independent of the matrix implementation.
const EXPECTED: ReadonlyArray<{
  action: PermissionAction;
  status: OrderStatus;
  wasManagerApproved?: true;
  allowed: readonly Principal[];
}> = [
  {
    action: 'BROWSE_PRICE_LIST',
    status: 'SUBMITTED',
    allowed: ['SHOP_OWNER', 'SELLER', 'MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  // No staff role holds the cart or the submit row; the staff viewer is covered in
  // staff-viewer.spec.ts.
  { action: 'USE_CART', status: 'SUBMITTED', allowed: ['SHOP_OWNER', 'SELLER'] },
  { action: 'SUBMIT_ORDER', status: 'SUBMITTED', allowed: ['SHOP_OWNER', 'SELLER'] },
  {
    action: 'VIEW_ORDER',
    status: 'ACCOUNTING_CLEARED',
    allowed: [
      'SHOP_OWNER',
      'SELLER',
      'MANAGER',
      'ACCOUNTANT',
      'ADMIN',
      'WAREHOUSE_MANAGER',
      'DRIVER',
      'PURCHASING_MANAGER',
    ],
  },
  { action: 'EDIT_ORDER_ITEMS', status: 'SUBMITTED', allowed: ['MANAGER'] },
  {
    action: 'CANCEL_ORDER',
    status: 'SUBMITTED',
    allowed: ['MANAGER'],
  },
  { action: 'MANAGER_DECIDE_ORDER', status: 'SUBMITTED', allowed: ['MANAGER'] },
  { action: 'MANAGE_ORDER_ALLOCATION', status: 'MANAGER_APPROVED', allowed: ['MANAGER'] },
  { action: 'SKIP_ACCOUNTING', status: 'SUBMITTED', allowed: ['MANAGER'] },
  { action: 'ACCOUNTING_DECIDE_ORDER', status: 'MANAGER_APPROVED', allowed: ['ACCOUNTANT'] },
  { action: 'RELEASE_ORDER', status: 'ACCOUNTING_CLEARED', allowed: ['WAREHOUSE_MANAGER'] },
  { action: 'RECORD_UNIT_CODES', status: 'ACCOUNTING_CLEARED', allowed: ['WAREHOUSE_MANAGER'] },
  {
    action: 'MARK_GOODS_RETURNED',
    status: 'CANCELLED',
    wasManagerApproved: true,
    allowed: ['WAREHOUSE_MANAGER'],
  },
  {
    action: 'VIEW_UNIT_CODES',
    status: 'ACCOUNTING_CLEARED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'WAREHOUSE_MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    action: 'VIEW_PERSON_CARD',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  {
    action: 'FIND_PERSON_BY_TELEGRAM',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'ADMIN'],
  },
  { action: 'VIEW_TELEGRAM_IDS', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'VIEW_STAFF_PHONE', status: 'SUBMITTED', allowed: ['MANAGER', 'ACCOUNTANT', 'ADMIN'] },
  { action: 'MARK_DELIVERED', status: 'RELEASED', allowed: ['DRIVER'] },
  { action: 'CONFIRM_RECEIPT', status: 'DELIVERED', allowed: ['SHOP_OWNER', 'SELLER'] },
  // [C] 2026-10-26: payments per organization; only the manager records, only the admin corrects.
  {
    action: 'VIEW_ORGANIZATION_BALANCE',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'],
  },
  { action: 'RECORD_ORGANIZATION_PAYMENT', status: 'SUBMITTED', allowed: ['MANAGER'] },
  { action: 'CORRECT_ORGANIZATION_PAYMENT', status: 'SUBMITTED', allowed: ['ADMIN'] },
  { action: 'VIEW_OWN_BALANCE', status: 'SUBMITTED', allowed: ['SHOP_OWNER', 'SELLER'] },
  // [C] 2026-10-24: manager and accountant see the payment method, only the manager sets it.
  {
    action: 'VIEW_PAYMENT_METHOD',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'PURCHASING_MANAGER'],
  },
  { action: 'SET_PAYMENT_METHOD', status: 'SUBMITTED', allowed: ['MANAGER'] },
  { action: 'SET_PAYMENT_PLAN', status: 'SUBMITTED', allowed: ['MANAGER'] },
  // [C, owner 2026-11-20] only the manager creates an order on behalf of a customer.
  { action: 'CREATE_ORDER_FOR_CUSTOMER', status: 'SUBMITTED', allowed: ['MANAGER'] },
  { action: 'CHANGE_OWN_PAYMENT_PLAN', status: 'SUBMITTED', allowed: ['SHOP_OWNER', 'SELLER'] },
  { action: 'UPDATE_PRICE_LIST', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  {
    action: 'VIEW_COST_REFERENCE',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  {
    action: 'VIEW_PRICE_ADMIN',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  {
    action: 'VIEW_CUSTOMERS',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  {
    action: 'VIEW_STAFF_DIRECTORY',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  { action: 'SET_USD_RATE', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'DECIDE_SUPPLY_REMOVAL', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'SET_SUPPLY_PARTY', status: 'SUBMITTED', allowed: ['MANAGER'] },
  {
    action: 'RUN_SHEET_SYNC',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  { action: 'CONFIGURE_TELEGRAM_SCHEDULE', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'EDIT_CUSTOMERS', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'CHANGE_ORGANIZATION_LABEL', status: 'SUBMITTED', allowed: ['ADMIN'] },
  { action: 'ARCHIVE_ORGANIZATION', status: 'SUBMITTED', allowed: ['ADMIN'] },
  {
    action: 'LIST_DRIVERS',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ADMIN', 'WAREHOUSE_MANAGER'],
  },
  { action: 'MANAGE_STAFF', status: 'SUBMITTED', allowed: ['ADMIN'] },
  { action: 'MANAGE_STAFF_CREDENTIALS', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'MANAGE_STAFF_ACCOUNTS', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  // [C] 2026-10-25: every staff member except an administrator gets bot messages.
  {
    action: 'CONNECT_BOT_NOTIFICATIONS',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER', 'PURCHASING_MANAGER'],
  },
  {
    action: 'VIEW_MARKED_ORDER_NOTIFICATIONS',
    status: 'SUBMITTED',
    allowed: ['PURCHASING_MANAGER'],
  },
  // [C] 2026-11-09: the handoff to the customer site, for the staff roles that may be viewers.
  {
    action: 'OPEN_CUSTOMER_SITE',
    status: 'SUBMITTED',
    allowed: ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'],
  },
  {
    action: 'VIEW_OWN_PROFILE',
    status: 'SUBMITTED',
    allowed: [
      'SHOP_OWNER',
      'SELLER',
      'MANAGER',
      'ACCOUNTANT',
      'ADMIN',
      'WAREHOUSE_MANAGER',
      'DRIVER',
      'PURCHASING_MANAGER',
    ],
  },
  { action: 'SET_OWN_CONTACT', status: 'SUBMITTED', allowed: ['SHOP_OWNER', 'SELLER'] },
  // [C] 2026-11-09: every staff member changes their own name and phone; customers have their own route.
  {
    action: 'EDIT_OWN_STAFF_PROFILE',
    status: 'SUBMITTED',
    allowed: [
      'MANAGER',
      'ACCOUNTANT',
      'ADMIN',
      'WAREHOUSE_MANAGER',
      'DRIVER',
      'PURCHASING_MANAGER',
    ],
  },
  { action: 'MANAGE_OWN_CUSTOMER_LOGIN', status: 'SUBMITTED', allowed: ['SHOP_OWNER', 'SELLER'] },
  { action: 'VIEW_RECEIVED_GOODS', status: 'RECEIVED', allowed: ['SHOP_OWNER', 'SELLER'] },
  { action: 'MANAGE_PRODUCT_IMAGES', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
  { action: 'VIEW_OWN_RECOMMENDATIONS', status: 'RECEIVED', allowed: ['SHOP_OWNER', 'SELLER'] },
  { action: 'DECIDE_PRODUCT_SUCCESSION', status: 'SUBMITTED', allowed: ['MANAGER', 'ADMIN'] },
];

describe('permission matrix', () => {
  it('has an expectation row for every action', () => {
    expect(EXPECTED.map((row) => row.action).sort()).toEqual([...PERMISSION_ACTIONS].sort());
  });

  describe.each(EXPECTED)('$action', ({ action, status, wasManagerApproved, allowed }) => {
    it.each(PRINCIPALS)('%s', (principal) => {
      const context = favourableContext(status);
      const result = can(
        actorFor(principal),
        action,
        wasManagerApproved ? { ...context, wasManagerApproved } : context,
      );
      expect(result).toBe(allowed.includes(principal));
    });
  });

  it('denies every action to an actor with no roles, with or without context', () => {
    const actor = actorFor('NO_ROLES');
    for (const action of PERMISSION_ACTIONS) {
      expect(can(actor, action, {})).toBe(false);
      expect(can(actor, action, favourableContext('SUBMITTED'))).toBe(false);
      expect(holdsAnyGrantFor(actor, action)).toBe(false);
    }
  });

  it('denies resource actions when the context lacks the needed facts (fail closed)', () => {
    expect(can(actorFor('SELLER'), 'VIEW_ORDER', {})).toBe(false);
    expect(can(actorFor('DRIVER'), 'MARK_DELIVERED', {})).toBe(false);
    expect(can(actorFor('MANAGER'), 'EDIT_ORDER_ITEMS', {})).toBe(false);
    expect(can(actorFor('WAREHOUSE_MANAGER'), 'VIEW_ORDER', {})).toBe(false);
    expect(can(actorFor('SHOP_OWNER'), 'SUBMIT_ORDER', {})).toBe(false);
  });
});

describe('customer isolation', () => {
  const customers: Principal[] = ['SHOP_OWNER', 'SELLER'];
  const orgActions: PermissionAction[] = ['SUBMIT_ORDER', 'VIEW_ORDER', 'CONFIRM_RECEIPT'];

  it.each(customers.flatMap((p) => orgActions.map((a) => [p, a] as const)))(
    '%s cannot %s in another organization',
    (principal, action) => {
      const context = { ...favourableContext('SUBMITTED'), organizationId: OTHER_ORG };
      expect(can(actorFor(principal), action, context)).toBe(false);
    },
  );

  it('a customer with a different organization id on the actor is denied', () => {
    const actor: Actor = {
      userId: 'u-1',
      staffRoles: [],
      membership: { organizationId: OTHER_ORG, role: 'SHOP_OWNER' },
    };
    expect(can(actor, 'VIEW_ORDER', favourableContext('SUBMITTED'))).toBe(false);
  });

  it('a seller sees colleagues orders of the same organization', () => {
    const context = { ...favourableContext('SUBMITTED'), placedByUserId: 'u-2' };
    expect(can(actorFor('SELLER'), 'VIEW_ORDER', context)).toBe(true);
  });

  it('a seller cannot confirm receipt of a colleagues order, a shop owner can', () => {
    const colleague = { ...favourableContext('DELIVERED'), placedByUserId: 'u-2' };
    expect(can(actorFor('SELLER'), 'CONFIRM_RECEIPT', colleague)).toBe(false);
    expect(can(actorFor('SHOP_OWNER'), 'CONFIRM_RECEIPT', colleague)).toBe(true);
  });

  it('customers can never cancel, in any status (owner rule 2026-10-22)', () => {
    for (const status of ORDER_STATUSES) {
      const context = favourableContext(status);
      expect(can(actorFor('SELLER'), 'CANCEL_ORDER', context)).toBe(false);
      expect(can(actorFor('SHOP_OWNER'), 'CANCEL_ORDER', context)).toBe(false);
    }
  });
});

describe('warehouse and driver scoping', () => {
  it('warehouse sees an order from MANAGER_APPROVED onward [C 2026-10-30]', () => {
    const visible: OrderStatus[] = [
      'MANAGER_APPROVED',
      'ACCOUNTING_CLEARED',
      'RELEASED',
      'DELIVERED',
      'RECEIVED',
    ];
    for (const status of ORDER_STATUSES) {
      expect(can(actorFor('WAREHOUSE_MANAGER'), 'VIEW_ORDER', favourableContext(status))).toBe(
        visible.includes(status),
      );
    }
  });

  it.each(['CANCELLED', 'REJECTED'] as const)(
    'warehouse sees %s only when the manager had approved the order',
    (status) => {
      const warehouse = actorFor('WAREHOUSE_MANAGER');
      const base = favourableContext(status);
      expect(can(warehouse, 'VIEW_ORDER', { ...base, wasManagerApproved: true })).toBe(true);
      expect(can(warehouse, 'VIEW_ORDER', { ...base, wasManagerApproved: false })).toBe(false);
      expect(can(warehouse, 'VIEW_ORDER', base)).toBe(false);
      // Other roles do not gain anything from the fact.
      const approved = { ...base, wasManagerApproved: true, assignedDriverId: null };
      expect(can(actorFor('DRIVER'), 'VIEW_ORDER', approved)).toBe(false);
    },
  );

  it('the approved fact alone does not open other statuses to the warehouse', () => {
    const submitted = { ...favourableContext('SUBMITTED'), wasManagerApproved: true };
    expect(can(actorFor('WAREHOUSE_MANAGER'), 'VIEW_ORDER', submitted)).toBe(false);
  });

  it('only the warehouse says goods are back, only for a closed order that was approved', () => {
    const warehouse = actorFor('WAREHOUSE_MANAGER');
    for (const status of ORDER_STATUSES) {
      const context = { ...favourableContext(status), wasManagerApproved: true };
      expect(can(warehouse, 'MARK_GOODS_RETURNED', context), status).toBe(
        status === 'CANCELLED' || status === 'REJECTED',
      );
    }
    const neverApproved = { ...favourableContext('CANCELLED'), wasManagerApproved: false };
    expect(can(warehouse, 'MARK_GOODS_RETURNED', neverApproved)).toBe(false);
  });

  it('the warehouse scans from the approval until the release, and still releases only cleared orders', () => {
    const warehouse = actorFor('WAREHOUSE_MANAGER');
    for (const status of ORDER_STATUSES) {
      const context = favourableContext(status);
      expect(can(warehouse, 'RECORD_UNIT_CODES', context), status).toBe(
        status === 'MANAGER_APPROVED' || status === 'ACCOUNTING_CLEARED',
      );
      expect(can(warehouse, 'RELEASE_ORDER', context), status).toBe(
        status === 'ACCOUNTING_CLEARED',
      );
    }
  });

  it('a driver sees and delivers only orders assigned to them', () => {
    const other = { ...favourableContext('RELEASED'), assignedDriverId: 'u-9' };
    const none = { ...favourableContext('RELEASED'), assignedDriverId: null };
    for (const context of [other, none]) {
      expect(can(actorFor('DRIVER'), 'VIEW_ORDER', context)).toBe(false);
      expect(can(actorFor('DRIVER'), 'MARK_DELIVERED', context)).toBe(false);
    }
  });
});

describe('status gating', () => {
  it('only the manager edits items, and only while SUBMITTED', () => {
    for (const status of ORDER_STATUSES) {
      expect(can(actorFor('MANAGER'), 'EDIT_ORDER_ITEMS', favourableContext(status))).toBe(
        status === 'SUBMITTED',
      );
      expect(can(actorFor('ADMIN'), 'EDIT_ORDER_ITEMS', favourableContext(status))).toBe(false);
    }
  });

  it('only the manager cancels, and only before RELEASED', () => {
    const cancellable: OrderStatus[] = ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'];
    for (const status of ORDER_STATUSES) {
      expect(can(actorFor('MANAGER'), 'CANCEL_ORDER', favourableContext(status))).toBe(
        cancellable.includes(status),
      );
      for (const role of ['ADMIN', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const) {
        expect(can(actorFor(role), 'CANCEL_ORDER', favourableContext(status))).toBe(false);
      }
    }
  });
});

describe('several staff roles', () => {
  it('grants the union of the permissions of every role', () => {
    const both: Actor = { userId: 'u-1', staffRoles: ['MANAGER', 'ACCOUNTANT'] };
    const manager = actorFor('MANAGER');
    const accountant = actorFor('ACCOUNTANT');
    const context = favourableContext('SUBMITTED');
    for (const action of PERMISSION_ACTIONS) {
      expect(can(both, action, context)).toBe(
        can(manager, action, context) || can(accountant, action, context),
      );
    }
    expect(can(both, 'MANAGER_DECIDE_ORDER')).toBe(true);
    expect(can(both, 'ACCOUNTING_DECIDE_ORDER')).toBe(true);
    expect(can(both, 'MANAGE_STAFF')).toBe(false);
  });

  it('staff never receive customer grants, even if a membership is present', () => {
    const dual: Actor = {
      userId: 'u-1',
      staffRoles: ['WAREHOUSE_MANAGER'],
      membership: { organizationId: ORG, role: 'SELLER' },
    };
    expect(can(dual, 'SUBMIT_ORDER', { organizationId: ORG })).toBe(false);
    expect(can(dual, 'CANCEL_ORDER', { organizationId: ORG, status: 'SUBMITTED' })).toBe(false);
    expect(can(dual, 'VIEW_ORDER', { organizationId: ORG, status: 'SUBMITTED' })).toBe(false);
    expect(holdsAnyGrantFor(dual, 'SUBMIT_ORDER')).toBe(false);
    // Its staff permissions are unaffected.
    expect(can(dual, 'RELEASE_ORDER', { status: 'ACCOUNTING_CLEARED' })).toBe(true);
  });

  it('SKIP_ACCOUNTING is manager-only: not admin, accountant or customers', () => {
    for (const principal of PRINCIPALS) {
      expect(can(actorFor(principal), 'SKIP_ACCOUNTING')).toBe(principal === 'MANAGER');
    }
  });
});

describe('holdsAnyGrantFor (route-level pre-check)', () => {
  it('ignores resource conditions but still requires a role that could ever succeed', () => {
    expect(holdsAnyGrantFor(actorFor('DRIVER'), 'MARK_DELIVERED')).toBe(true);
    expect(holdsAnyGrantFor(actorFor('MANAGER'), 'MARK_DELIVERED')).toBe(false);
    expect(holdsAnyGrantFor(actorFor('SELLER'), 'SUBMIT_ORDER')).toBe(true);
    expect(holdsAnyGrantFor(actorFor('ADMIN'), 'SUBMIT_ORDER')).toBe(false);
  });
});

describe('wasManagerApproved strictness', () => {
  // Guards against a later Boolean(...) or !! refactor: only the literal true may count.
  it.each(['false', 'true', 0, 1, null])('%j does not count as approved', (value) => {
    const context = {
      ...favourableContext('CANCELLED'),
      wasManagerApproved: value as never,
    };
    expect(can(actorFor('WAREHOUSE_MANAGER'), 'VIEW_ORDER', context)).toBe(false);
  });
});

describe('API token scopes narrow the roles of the person', () => {
  const tokenActor = (role: StaffRole, scopes: readonly PermissionAction[]): Actor => ({
    userId: 'u-token',
    staffRoles: [role],
    scopes,
  });

  it('allows an action only when it is in the scopes AND a current role grants it', () => {
    const admin = tokenActor('ADMIN', ['MANAGE_PRODUCT_IMAGES']);
    expect(can(admin, 'MANAGE_PRODUCT_IMAGES')).toBe(true);
    expect(holdsAnyGrantFor(admin, 'MANAGE_PRODUCT_IMAGES')).toBe(true);
    // The admin role grants these, the token does not.
    expect(can(admin, 'UPDATE_PRICE_LIST')).toBe(false);
    expect(holdsAnyGrantFor(admin, 'MANAGE_STAFF')).toBe(false);
    expect(holdsAnyGrantFor(admin, 'VIEW_OWN_PROFILE')).toBe(false);
  });

  it('a scope never adds an action the roles do not grant', () => {
    const driver = tokenActor('DRIVER', ['MANAGE_PRODUCT_IMAGES']);
    expect(can(driver, 'MANAGE_PRODUCT_IMAGES')).toBe(false);
    expect(holdsAnyGrantFor(driver, 'MANAGE_PRODUCT_IMAGES')).toBe(false);
  });

  it('empty scopes allow nothing; list scoping follows the same rule', () => {
    const manager = tokenActor('MANAGER', []);
    expect(can(manager, 'MANAGE_PRODUCT_IMAGES')).toBe(false);
    expect(scopeFor(manager, 'VIEW_ORDER')).toEqual([]);
    expect(scopeFor(tokenActor('MANAGER', ['MANAGE_PRODUCT_IMAGES']), 'VIEW_ORDER')).toEqual([]);
    expect(scopeFor({ userId: 'u', staffRoles: ['MANAGER'] }, 'VIEW_ORDER')).not.toEqual([]);
  });
});
