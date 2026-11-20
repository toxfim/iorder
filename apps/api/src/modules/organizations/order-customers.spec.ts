import { describe, expect, it } from 'vitest';
import type { AuditService } from '../audit/index.js';
import type { Clock } from '../../common/clock/clock.js';
import type { IdentityService, UserSummary } from '../identity/index.js';
import type { OrganizationWithMembers } from './organization.view.js';
import type { OrganizationsRepository } from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';

// The manager's new order, step 1: who an order may be placed by.
const at = new Date('2026-11-20T08:00:00Z');
const row: OrganizationWithMembers = {
  organization: {
    id: 'org-1',
    name: 'Alpha shop',
    type: 'GROUP',
    label: 'PARTNER',
    phone: null,
    telegramChatId: -100n,
    status: 'ACTIVE',
    pricePostingEnabled: true,
    addedBy: null,
    createdByUserId: null,
    merged: false,
    openInvite: null,
    archivedAt: null,
    archivedByUserId: null,
    createdAt: at,
    updatedAt: at,
  },
  members: [
    { userId: 'u-active', role: 'SHOP_OWNER', status: 'ACTIVE', joinedAt: at, leftAt: null },
    { userId: 'u-blocked', role: 'SELLER', status: 'ACTIVE', joinedAt: at, leftAt: null },
    { userId: 'u-left', role: 'SELLER', status: 'LEFT', joinedAt: at, leftAt: at },
  ],
};

const person = (id: string, status: UserSummary['status']): UserSummary => ({
  id,
  fullName: id,
  phone: null,
  status,
  staffRoles: [],
});

function service(): OrganizationsService {
  const repository = { findOrderable: () => Promise.resolve([row]) };
  const people = new Map([
    ['u-active', person('u-active', 'ACTIVE')],
    ['u-blocked', person('u-blocked', 'BLOCKED')],
    ['u-left', person('u-left', 'ACTIVE')],
  ]);
  const identity = {
    findIdsByNameOrPhone: () => Promise.resolve([]),
    findSummaries: (ids: readonly string[]) =>
      Promise.resolve(new Map(ids.flatMap((id) => (people.has(id) ? [[id, people.get(id)]] : [])))),
  };
  return new OrganizationsService(
    repository as unknown as OrganizationsRepository,
    identity as unknown as IdentityService,
    {} as AuditService,
    { now: () => at } as Clock,
  );
}

describe('findOrderCustomers', () => {
  it('lists only current members with an active account (others would be refused)', async () => {
    const [customer] = await service().findOrderCustomers({}, 10);
    expect(customer?.members.map((m) => m.userId)).toEqual(['u-active']);
  });
});
