import { ORDER_STATUSES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import type { Actor, ResourceContext } from './actor.js';
import { can } from './can.js';
import { PERMISSION_ACTIONS } from './permission-matrix.js';
import { scopeFilterToPredicate, scopeFor, type ScopeFilter } from './scope-for.js';

const customer = (role: 'SHOP_OWNER' | 'SELLER'): Actor => ({
  userId: 'u-1',
  staffRoles: [],
  membership: { organizationId: 'org-1', role },
});
const staff = (...roles: Actor['staffRoles']): Actor => ({ userId: 'u-1', staffRoles: roles });

describe('scopeFor VIEW_ORDER', () => {
  it('limits customers to their organization', () => {
    expect(scopeFor(customer('SHOP_OWNER'), 'VIEW_ORDER')).toEqual([{ organizationId: 'org-1' }]);
    expect(scopeFor(customer('SELLER'), 'VIEW_ORDER')).toEqual([{ organizationId: 'org-1' }]);
  });

  it('gives manager, accountant, admin and purchasing manager the unrestricted scope', () => {
    for (const role of ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'] as const) {
      expect(scopeFor(staff(role), 'VIEW_ORDER')).toEqual([{}]);
    }
  });

  it('limits warehouse to the visible status set', () => {
    expect(scopeFor(staff('WAREHOUSE_MANAGER'), 'VIEW_ORDER')).toEqual([
      { statuses: ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED', 'RECEIVED'] },
      { statuses: ['REJECTED', 'CANCELLED'], managerApproved: true },
    ]);
  });

  it('limits a driver to orders assigned to them', () => {
    expect(scopeFor(staff('DRIVER'), 'VIEW_ORDER')).toEqual([{ assignedDriverId: 'u-1' }]);
  });

  it('is empty for an actor with no roles, and for blank identities', () => {
    expect(scopeFor({ userId: 'u-1', staffRoles: [] }, 'VIEW_ORDER')).toEqual([]);
    // Staff never get a customer scope, even with a membership present.
    const staffWithMembership: Actor = {
      userId: 'u-1',
      staffRoles: ['ACCOUNTANT'],
      membership: { organizationId: 'org-1', role: 'SELLER' },
    };
    expect(scopeFor(staffWithMembership, 'SUBMIT_ORDER')).toEqual([]);
    expect(scopeFor({ userId: '', staffRoles: ['DRIVER'] }, 'VIEW_ORDER')).toEqual([]);
    expect(
      scopeFor(
        { userId: 'u-1', staffRoles: [], membership: { organizationId: '', role: 'SELLER' } },
        'VIEW_ORDER',
      ),
    ).toEqual([]);
  });

  it('returns one filter per matching role (the query ORs them)', () => {
    expect(scopeFor(staff('WAREHOUSE_MANAGER', 'DRIVER'), 'VIEW_ORDER')).toHaveLength(3);
  });
});

function matches(filter: ScopeFilter, context: ResourceContext): boolean {
  return scopeFilterToPredicate(filter)(context);
}

describe('scopeFor agrees with can for every action', () => {
  const actors: Actor[] = [
    customer('SHOP_OWNER'),
    customer('SELLER'),
    staff('ADMIN'),
    staff('MANAGER'),
    staff('ACCOUNTANT'),
    staff('WAREHOUSE_MANAGER'),
    staff('DRIVER'),
    staff('WAREHOUSE_MANAGER', 'DRIVER'),
    { userId: 'u-1', staffRoles: [] },
    {
      userId: 'u-1',
      staffRoles: ['WAREHOUSE_MANAGER'],
      membership: { organizationId: 'org-1', role: 'SELLER' },
    },
    // Staff viewers of the customer app: with and without an organization for staff orders.
    {
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['MANAGER'], orderingOrganizationId: 'org-1' },
    },
    {
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['MANAGER'], orderingOrganizationId: null },
    },
    {
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['ADMIN'], orderingOrganizationId: '' },
    },
  ];
  const contexts: ResourceContext[] = [];
  for (const status of ORDER_STATUSES) {
    for (const organizationId of ['org-1', 'org-2']) {
      for (const placedByUserId of ['u-1', 'u-2']) {
        for (const assignedDriverId of ['u-1', 'u-2', null]) {
          // Non-boolean values are cast on purpose: only the literal true may count as approved.
          for (const wasManagerApproved of [
            true,
            false,
            undefined,
            'true' as never,
            'false' as never,
            0 as never,
            1 as never,
            null as never,
          ]) {
            contexts.push({
              status,
              organizationId,
              placedByUserId,
              assignedDriverId,
              wasManagerApproved,
            });
          }
        }
      }
    }
  }

  it.each(PERMISSION_ACTIONS)('%s', (action) => {
    for (const actor of actors) {
      const filters = scopeFor(actor, action);
      for (const context of contexts) {
        expect(filters.some((filter) => matches(filter, context))).toBe(
          can(actor, action, context),
        );
      }
    }
  });
});

describe('scopeFor warehouse and the approved fact', () => {
  it('lets a REJECTED order through only when the manager had approved it', () => {
    const filters = scopeFor(staff('WAREHOUSE_MANAGER'), 'VIEW_ORDER');
    const approved: ResourceContext = { status: 'REJECTED', wasManagerApproved: true };
    const refused: ResourceContext = { status: 'REJECTED', wasManagerApproved: false };
    expect(filters.some((filter) => matches(filter, approved))).toBe(true);
    expect(filters.some((filter) => matches(filter, refused))).toBe(false);
  });
});
