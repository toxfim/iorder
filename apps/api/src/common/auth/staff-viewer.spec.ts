import { ORDER_STATUSES, STAFF_ROLES, type StaffRole } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import type { Actor, ResourceContext } from './actor.js';
import { can, holdsAnyGrantFor } from './can.js';
import {
  effectiveMembership,
  isStaffViewer,
  PERMISSION_ACTIONS,
  PERMISSION_MATRIX,
  type PermissionAction,
} from './permission-matrix.js';
import { scopeFor } from './scope-for.js';
import {
  mayUseCustomerApp,
  staffOrderingOrganizationOf,
  toStaffViewerActor,
} from './staff-viewer.js';

const TEST_ORG = 'org-test';
const REAL_ORG = 'org-real';
const manager = { userId: 'u-1', staffRoles: ['MANAGER'] as const };

const viewer = (orderingOrganizationId: string | null): Actor =>
  toStaffViewerActor(manager, orderingOrganizationId);

/** The most favourable facts there are: the configured organization, placed by the viewer. */
const favourable = (organizationId: string): ResourceContext[] =>
  ORDER_STATUSES.map((status) => ({
    organizationId,
    placedByUserId: 'u-1',
    assignedDriverId: 'u-1',
    status,
    wasManagerApproved: true,
  }));

describe('who may use the customer app as a viewer', () => {
  it('exactly the staff roles that may browse the price list; the warehouse and the driver may not', () => {
    const allowed = STAFF_ROLES.filter((role) => mayUseCustomerApp([role]));
    expect([...allowed].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'MANAGER', 'PURCHASING_MANAGER']);
    expect(mayUseCustomerApp([])).toBe(false);
  });

  // The dashboard hands a person over to the customer site ([C] 2026-11-09) only if they may be
  // a viewer there, and a viewer can never ask for a handoff itself.
  it('the handoff to the customer site is for exactly those roles, and never for a viewer or a customer', () => {
    for (const role of STAFF_ROLES) {
      expect(can({ userId: 'u', staffRoles: [role] }, 'OPEN_CUSTOMER_SITE'), role).toBe(
        mayUseCustomerApp([role]),
      );
    }
    expect(PERMISSION_MATRIX.OPEN_CUSTOMER_SITE.every((grant) => grant.kind === 'staff')).toBe(
      true,
    );
    expect(can(viewer(null), 'OPEN_CUSTOMER_SITE')).toBe(false);
    expect(can(viewer(TEST_ORG), 'OPEN_CUSTOMER_SITE')).toBe(false);
    const customer: Actor = {
      userId: 'c',
      staffRoles: [],
      membership: { organizationId: REAL_ORG, role: 'SHOP_OWNER' },
    };
    expect(can(customer, 'OPEN_CUSTOMER_SITE')).toBe(false);
  });

  it('one allowed role is enough for a person with several', () => {
    expect(mayUseCustomerApp(['DRIVER', 'ACCOUNTANT'])).toBe(true);
    expect(mayUseCustomerApp(['DRIVER', 'WAREHOUSE_MANAGER'])).toBe(false);
  });
});

describe('toStaffViewerActor', () => {
  it('drops every staff role and keeps the real ones only as history', () => {
    const actor = toStaffViewerActor({ userId: 'u-1', staffRoles: ['ADMIN', 'MANAGER'] }, null);
    expect(actor).toEqual({
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['ADMIN', 'MANAGER'], orderingOrganizationId: null },
    });
    expect(isStaffViewer(actor)).toBe(true);
  });

  it('gives a staff member who may not use the customer app nothing at all', () => {
    for (const role of ['DRIVER', 'WAREHOUSE_MANAGER'] as const) {
      const actor = toStaffViewerActor({ userId: 'u-1', staffRoles: [role] }, TEST_ORG);
      expect(actor).toEqual({ userId: 'u-1', staffRoles: [] });
      for (const action of PERMISSION_ACTIONS) {
        expect(holdsAnyGrantFor(actor, action), action).toBe(false);
      }
    }
  });

  it('keeps the session id and the API token scopes, never a membership', () => {
    const actor = toStaffViewerActor(manager, null, {
      sessionId: 's-1',
      scopes: ['MANAGE_PRODUCT_IMAGES'],
    });
    expect(actor.sessionId).toBe('s-1');
    expect(actor.scopes).toEqual(['MANAGE_PRODUCT_IMAGES']);
    expect(actor.membership).toBeUndefined();
    // The token's scopes still narrow the viewer: it was not issued for the customer app.
    expect(can(actor, 'BROWSE_PRICE_LIST')).toBe(false);
    expect(can(actor, 'USE_CART')).toBe(false);
  });

  it('reads the setting as an id or null, never an empty string', () => {
    expect(staffOrderingOrganizationOf({})).toBeNull();
    expect(staffOrderingOrganizationOf({ STAFF_ORDERING_ORGANIZATION_ID: '' })).toBeNull();
    expect(staffOrderingOrganizationOf({ STAFF_ORDERING_ORGANIZATION_ID: TEST_ORG })).toBe(
      TEST_ORG,
    );
  });
});

describe('what a staff viewer may do (matrix)', () => {
  // Written by hand: a new viewer grant must be a decision, not a side effect.
  const VIEWER_ACTIONS: readonly PermissionAction[] = [
    'BROWSE_PRICE_LIST',
    'SUBMIT_ORDER',
    'USE_CART',
    'VIEW_ORDER',
    'VIEW_OWN_BALANCE',
    'VIEW_OWN_PROFILE',
    'VIEW_OWN_RECOMMENDATIONS',
    'VIEW_RECEIVED_GOODS',
  ];

  it('the matrix has a viewer grant on exactly these actions', () => {
    const granted = PERMISSION_ACTIONS.filter((action) =>
      PERMISSION_MATRIX[action].some((grant) => grant.kind === 'staffViewer'),
    );
    expect([...granted].sort()).toEqual([...VIEWER_ACTIONS].sort());
  });

  it('every other action is denied in the most favourable context, with or without an ordering organization', () => {
    for (const actor of [viewer(null), viewer(TEST_ORG)]) {
      for (const action of PERMISSION_ACTIONS) {
        if (VIEWER_ACTIONS.includes(action)) continue;
        expect(holdsAnyGrantFor(actor, action), action).toBe(false);
        for (const context of favourable(TEST_ORG)) {
          expect(can(actor, action, context), action).toBe(false);
        }
        expect(scopeFor(actor, action), action).toEqual([]);
      }
    }
  });

  it('a staff grant never applies: the manager who is a viewer cannot decide, cancel or see costs', () => {
    const actor = viewer(TEST_ORG);
    expect(can(actor, 'MANAGER_DECIDE_ORDER')).toBe(false);
    expect(can(actor, 'VIEW_COST_REFERENCE')).toBe(false);
    expect(can(actor, 'VIEW_ORGANIZATION_BALANCE')).toBe(false);
    expect(can(actor, 'VIEW_CUSTOMERS')).toBe(false);
    expect(can(actor, 'CANCEL_ORDER', { organizationId: TEST_ORG, status: 'SUBMITTED' })).toBe(
      false,
    );
  });

  describe('no organization configured for staff orders (production)', () => {
    const actor = viewer(null);

    it('can never submit an order, into any organization', () => {
      for (const organizationId of [TEST_ORG, REAL_ORG, '', undefined]) {
        expect(
          can(actor, 'SUBMIT_ORDER', organizationId === undefined ? {} : { organizationId }),
        ).toBe(false);
      }
    });

    it('sees no order: every single check fails and the list scope is empty', () => {
      for (const context of [...favourable(TEST_ORG), ...favourable(REAL_ORG)]) {
        expect(can(actor, 'VIEW_ORDER', context)).toBe(false);
      }
      expect(scopeFor(actor, 'VIEW_ORDER')).toEqual([]);
    });

    it('still browses prices and uses the cart', () => {
      expect(can(actor, 'BROWSE_PRICE_LIST')).toBe(true);
      expect(can(actor, 'USE_CART')).toBe(true);
    });
  });

  describe('an organization configured for staff orders (staging)', () => {
    const actor = viewer(TEST_ORG);

    it('submits into exactly that organization and no other', () => {
      expect(can(actor, 'SUBMIT_ORDER', { organizationId: TEST_ORG })).toBe(true);
      expect(can(actor, 'SUBMIT_ORDER', { organizationId: REAL_ORG })).toBe(false);
      expect(can(actor, 'SUBMIT_ORDER', {})).toBe(false);
    });

    it('sees only the orders it placed itself in that organization', () => {
      const own = { organizationId: TEST_ORG, placedByUserId: 'u-1', status: 'SUBMITTED' } as const;
      expect(can(actor, 'VIEW_ORDER', own)).toBe(true);
      // A colleague's or a customer's order in the test organization stays hidden.
      expect(can(actor, 'VIEW_ORDER', { ...own, placedByUserId: 'u-2' })).toBe(false);
      // Its own user id on an order of another organization opens nothing.
      expect(can(actor, 'VIEW_ORDER', { ...own, organizationId: REAL_ORG })).toBe(false);
      expect(scopeFor(actor, 'VIEW_ORDER')).toEqual([
        { organizationId: TEST_ORG, placedByUserId: 'u-1' },
      ]);
    });

    it('never confirms a receipt or changes a payment plan, even on its own test order', () => {
      const own = { organizationId: TEST_ORG, placedByUserId: 'u-1' };
      expect(can(actor, 'CONFIRM_RECEIPT', { ...own, status: 'DELIVERED' })).toBe(false);
      expect(can(actor, 'CHANGE_OWN_PAYMENT_PLAN', { ...own, status: 'SUBMITTED' })).toBe(false);
    });
  });
});

describe('a staff viewer is never an organization member', () => {
  const membership = { organizationId: REAL_ORG, role: 'SHOP_OWNER' } as const;

  it('a membership on a viewer actor is void', () => {
    const actor: Actor = { ...viewer(REAL_ORG), membership };
    expect(effectiveMembership(actor)).toBeUndefined();
    expect(can(actor, 'CONFIRM_RECEIPT', { organizationId: REAL_ORG, status: 'DELIVERED' })).toBe(
      false,
    );
    expect(can(actor, 'SET_OWN_CONTACT')).toBe(false);
    // Only its own orders in the configured organization, as for every viewer.
    expect(scopeFor(actor, 'VIEW_ORDER')).toEqual([
      { organizationId: REAL_ORG, placedByUserId: 'u-1' },
    ]);
  });

  it('an actor that still carries staff roles gets neither the viewer grants nor a membership', () => {
    const roles: StaffRole[] = ['WAREHOUSE_MANAGER'];
    const mixed: Actor = {
      userId: 'u-1',
      staffRoles: roles,
      membership,
      staffViewer: { staffRoles: ['MANAGER'], orderingOrganizationId: TEST_ORG },
    };
    expect(isStaffViewer(mixed)).toBe(false);
    expect(effectiveMembership(mixed)).toBeUndefined();
    expect(can(mixed, 'USE_CART')).toBe(false);
    expect(can(mixed, 'BROWSE_PRICE_LIST')).toBe(false);
    expect(can(mixed, 'SUBMIT_ORDER', { organizationId: TEST_ORG })).toBe(false);
    // Its staff permissions are unaffected.
    expect(can(mixed, 'RELEASE_ORDER', { status: 'ACCOUNTING_CLEARED' })).toBe(true);
  });
});
