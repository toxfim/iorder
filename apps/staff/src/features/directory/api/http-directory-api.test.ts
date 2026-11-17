import { describe, expect, it, vi } from 'vitest';
import {
  staffOrganizationResponseSchema,
  staffOrganizationSummarySchema,
  staffUserResponseSchema,
  type StaffOrganizationResponse,
  type StaffOrganizationSummary,
  type StaffUserResponse,
} from '@iorder/shared';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { fakeUuid } from '@core/lib/fake-ids';
import { createHttpStaffUsersApi } from '@/features/staff-users/api/staff-users-api';
import { createHttpDirectoryApi } from './http-directory-api';

// CONTRACT test of the directory adapter: it composes the organization and user routes and maps
// their strict shared schemas onto the directory view-models. Payloads are checked against the
// same schemas, so a contract change breaks this test instead of the page.

const ORG = fakeUuid('org-orion-mobile');
const OWNER = fakeUuid('u-101');
const STAFF = fakeUuid('u-900');

const organization: StaffOrganizationSummary = staffOrganizationSummarySchema.parse({
  id: ORG,
  name: 'Orion Mobile',
  type: 'GROUP',
  label: 'STANDARD',
  priceTier: 'STANDARD',
  phone: null,
  invite: { status: 'LINKED', expiresAt: null },
  boundPerson: null,
  typeChangeable: false,
  telegramChatId: '-1001234567890',
  status: 'ACTIVE',
  pricePostingEnabled: true,
  activeMemberCount: 1,
  shopOwner: { userId: OWNER, fullName: 'Aziz Karimov' },
  addedBy: null,
  archivedAt: null,
  createdAt: '2026-03-01T08:00:00.000Z',
  updatedAt: '2026-03-01T08:00:00.000Z',
});

const owner: StaffUserResponse = staffUserResponseSchema.parse({
  id: OWNER,
  telegramUserId: '700000001',
  fullName: 'Aziz Karimov',
  phone: '+998903512210',
  language: 'UZ',
  status: 'ACTIVE',
  staffRoles: [],
  membership: {
    organizationId: ORG,
    organizationName: 'Orion Mobile',
    role: 'SHOP_OWNER',
    joinedAt: '2026-03-02T08:00:00.000Z',
  },
  createdAt: '2026-03-02T08:00:00.000Z',
  updatedAt: '2026-03-02T08:00:00.000Z',
});

// A staff account: no membership, so it is never a customer member.
const staff: StaffUserResponse = staffUserResponseSchema.parse({
  ...owner,
  id: STAFF,
  telegramUserId: null,
  fullName: 'Manager',
  phone: null,
  staffRoles: ['MANAGER'],
  membership: null,
});

const detail: StaffOrganizationResponse = staffOrganizationResponseSchema.parse({
  ...organization,
  members: [
    {
      userId: OWNER,
      fullName: owner.fullName,
      phone: owner.phone,
      role: 'SELLER',
      status: 'ACTIVE',
      joinedAt: '2026-03-02T08:00:00.000Z',
      leftAt: null,
    },
  ],
});

type Reply = { readonly status: number; readonly body?: unknown };

function setup(...replies: Reply[]) {
  const queue = [...replies];
  const fetchImpl = vi.fn(() => {
    const reply = queue.shift() ?? { status: 500 };
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      }),
    );
  });
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, api: createHttpDirectoryApi(http, createHttpStaffUsersApi(http)) };
}

function calls(fetchImpl: ReturnType<typeof setup>['fetchImpl']): [string, RequestInit][] {
  return fetchImpl.mock.calls as unknown as [string, RequestInit][];
}

describe('createHttpDirectoryApi', () => {
  it('lists organizations from the staff organizations route as directory organizations', async () => {
    const { api, fetchImpl } = setup({ status: 200, body: { items: [organization] } });
    const result = await api.listOrganizations();
    expect(calls(fetchImpl)[0]?.[0]).toBe('https://api.test/staff/organizations');
    expect(result).toEqual([
      {
        id: ORG,
        name: 'Orion Mobile',
        type: 'GROUP',
        address: '',
        phone: '',
        telegramGroup: '-1001234567890',
        isActive: true,
        since: '2026-03-01T08:00:00.000Z',
      },
    ]);
  });

  it('lists members from the staff users route, leaving out people without a membership', async () => {
    const { api, fetchImpl } = setup({ status: 200, body: { items: [staff, owner] } });
    const result = await api.listMembers();
    expect(calls(fetchImpl)[0]?.[0]).toBe('https://api.test/staff/users');
    expect(result).toEqual([
      {
        id: OWNER,
        organizationId: ORG,
        name: 'Aziz Karimov',
        phone: '+998903512210',
        telegramUsername: '700000001',
        role: 'SHOP_OWNER',
        isActive: true,
        joinedAt: '2026-03-02T08:00:00.000Z',
      },
    ]);
  });

  it('deactivates an organization with one status PATCH', async () => {
    const { api, fetchImpl } = setup({
      status: 200,
      body: { ...detail, status: 'INACTIVE' },
    });
    const result = await api.setOrganizationActive(ORG, false);
    const [url, init] = calls(fetchImpl)[0]!;
    expect(url).toBe(`https://api.test/staff/organizations/${ORG}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'INACTIVE' });
    expect(result.isActive).toBe(false);
  });

  it('blocks a member without touching the Telegram group, and unblocks', async () => {
    const { api, fetchImpl } = setup(
      { status: 200, body: { ...owner, status: 'BLOCKED' } },
      { status: 200, body: owner },
    );
    expect((await api.setMemberActive(OWNER, false)).isActive).toBe(false);
    expect((await api.setMemberActive(OWNER, true)).isActive).toBe(true);
    const [block, unblock] = calls(fetchImpl);
    expect(block?.[0]).toBe(`https://api.test/staff/users/${OWNER}/block`);
    expect(JSON.parse(String(block?.[1].body))).toEqual({ removeFromGroups: false });
    expect(unblock?.[0]).toBe(`https://api.test/staff/users/${OWNER}/unblock`);
    expect(unblock?.[1].method).toBe('POST');
  });

  it('changes a role on the organization member route and answers the re-read person', async () => {
    const { api, fetchImpl } = setup(
      { status: 200, body: detail },
      { status: 200, body: { ...owner, membership: { ...owner.membership!, role: 'SELLER' } } },
    );
    const result = await api.setMemberRole(OWNER, ORG, 'SELLER');
    const [change, read] = calls(fetchImpl);
    expect(change?.[0]).toBe(`https://api.test/staff/organizations/${ORG}/members/${OWNER}`);
    expect(change?.[1].method).toBe('PATCH');
    expect(JSON.parse(String(change?.[1].body))).toEqual({ role: 'SELLER' });
    expect(read?.[0]).toBe(`https://api.test/staff/users/${OWNER}`);
    expect(result.role).toBe('SELLER');
  });

  it('reports a person without a membership as not found after a write', async () => {
    const { api } = setup({ status: 200, body: staff });
    await expect(api.setMemberActive(STAFF, true)).rejects.toBeInstanceOf(ApiNotFoundError);
  });

  it('passes the typed errors through (403 is PermissionDeniedError)', async () => {
    const { api } = setup({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
    });
    await expect(api.listOrganizations()).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
