import { describe, expect, it, vi } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiRateLimitedError,
  InvalidResponseError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { createFakeStaffUsers } from './fake-staff-users-backend';
import { createHttpStaffAccountsApi } from './staff-accounts-api';
import { createHttpStaffUsersApi } from './staff-users-api';

// CONTRACT tests of the HTTP adapters: each method hits its route with the body the shared strict
// schema wants and parses the answer with the shared schemas. Payloads come from the fake, whose
// own test holds it to the same schemas.

const MEMBER = fakeUuid('u-101');
const SMART_ZONE_OWNER = fakeUuid('u-151');

function setup(status: number, body?: unknown, headers?: Record<string, string>) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
    ),
  );
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return {
    fetchImpl,
    users: createHttpStaffUsersApi(http),
    accounts: createHttpStaffAccountsApi(http),
  };
}
type Fetch = ReturnType<typeof setup>['fetchImpl'];
const call = (fetchImpl: Fetch): [string, RequestInit] =>
  fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
const errorBody = (code: string, message: string) => ({ error: { code, message } });

function fake(roles: ('MANAGER' | 'ADMIN')[] = ['MANAGER']) {
  return createFakeStaffUsers({ roles: () => roles, pendingReads: 0 });
}

describe('staff users http adapter', () => {
  it('blocks with the flag in the body and parses the groupRemoval extension', async () => {
    const answer = await fake().staffUsersApi.blockUser(MEMBER, { removeFromGroups: true });
    const { users, fetchImpl } = setup(200, answer);
    const result = await users.blockUser(MEMBER, { removeFromGroups: true });
    expect(result.groupRemoval).toEqual({ requested: true, queued: 1, alreadyRequested: 0 });
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('POST');
    expect(url).toBe(`https://api.test/staff/users/${MEMBER}/block`);
    expect(JSON.parse(init.body as string)).toEqual({ removeFromGroups: true });
  });

  it('sends an explicit false for "block only"', async () => {
    const answer = await fake().staffUsersApi.blockUser(MEMBER, { removeFromGroups: false });
    const { users, fetchImpl } = setup(200, answer);
    const result = await users.blockUser(MEMBER, { removeFromGroups: false });
    expect(result.groupRemoval).toBeUndefined();
    expect(JSON.parse(call(fetchImpl)[1].body as string)).toEqual({ removeFromGroups: false });
  });

  it('reads the removal status and unwraps items', async () => {
    const api = fake().staffUsersApi;
    await api.blockUser(SMART_ZONE_OWNER, { removeFromGroups: true });
    const items = await api.removalStatus(SMART_ZONE_OWNER);
    const { users, fetchImpl } = setup(200, { items });
    const result = await users.removalStatus(SMART_ZONE_OWNER);
    expect(result[0]).toMatchObject({ status: 'FAILED', errorCode: 'BOT_NOT_ADMIN' });
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('GET');
    expect(url).toBe(`https://api.test/staff/users/${SMART_ZONE_OWNER}/removal-status`);
  });

  it('unblocks with a POST and no body', async () => {
    const answer = await fake().staffUsersApi.unblockUser(MEMBER);
    const { users, fetchImpl } = setup(200, answer);
    await users.unblockUser(MEMBER);
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('POST');
    expect(url).toBe(`https://api.test/staff/users/${MEMBER}/unblock`);
  });

  it('maps 403, 404, 409 and 429 to the typed errors', async () => {
    expect(
      await setup(403, errorBody('FORBIDDEN', 'x'))
        .users.blockUser(MEMBER, { removeFromGroups: false })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(PermissionDeniedError);
    expect(
      await setup(404, errorBody('NOT_FOUND', 'x'))
        .users.removalStatus(MEMBER)
        .catch((e: unknown) => e),
    ).toBeInstanceOf(ApiNotFoundError);
    expect(
      await setup(409, errorBody('CONFLICT', 'x'))
        .users.unblockUser(MEMBER)
        .catch((e: unknown) => e),
    ).toBeInstanceOf(ApiConflictError);
    const limited = await setup(429, errorBody('TOO_MANY_REQUESTS', 'x'), { 'Retry-After': '7' })
      .users.blockUser(MEMBER, { removeFromGroups: true })
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(ApiRateLimitedError);
    expect((limited as ApiRateLimitedError).retryAfterSeconds).toBe(7);
  });

  it('rejects an answer that breaks the contract (an unknown removal status)', async () => {
    const { users } = setup(200, { items: [{ organizationId: 'x', status: 'MAYBE' }] });
    expect(await users.removalStatus(MEMBER).catch((e: unknown) => e)).toBeInstanceOf(
      InvalidResponseError,
    );
  });
});

describe('staff accounts http adapter', () => {
  it('lists the accounts without ever receiving a password or a Telegram id', async () => {
    const items = await fake().staffAccountsApi.list();
    const { accounts, fetchImpl } = setup(200, { items });
    const result = await accounts.list();
    expect(result).toHaveLength(items.length);
    expect(call(fetchImpl)[0]).toBe('https://api.test/staff/accounts');
    for (const account of items) {
      expect(Object.keys(account)).not.toContain('password');
      expect(Object.keys(account)).not.toContain('telegramUserId');
    }
  });

  it('creates an account with the strict body and parses the answer', async () => {
    const input = {
      fullName: 'Yangi Xodim',
      login: 'yangi@iorder.uz',
      password: 'correct-horse-battery',
      roles: ['DRIVER' as const],
      telegramUserId: '555000904',
    };
    const created = await fake().staffAccountsApi.create(input);
    const { accounts, fetchImpl } = setup(200, created);
    const result = await accounts.create(input);
    expect(result.login).toBe('yangi@iorder.uz');
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('POST');
    expect(url).toBe('https://api.test/staff/users');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('links Telegram with a PUT whose body is only the id', async () => {
    const [first] = await fake(['ADMIN']).staffAccountsApi.list();
    const { accounts, fetchImpl } = setup(200, first);
    await accounts.setTelegram(first!.id, '123456789');
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('PUT');
    expect(url).toBe(`https://api.test/staff/users/${first!.id}/telegram`);
    expect(JSON.parse(init.body as string)).toEqual({ telegramUserId: '123456789' });
  });

  it('sets credentials with a PUT and parses an answer without a password', async () => {
    const [first] = await fake(['ADMIN']).staffAccountsApi.list();
    const answer = {
      userId: first!.id,
      login: 'new@iorder.uz',
      passwordChangedAt: '2026-10-19T04:30:00.000Z',
    };
    const { accounts, fetchImpl } = setup(200, answer);
    const result = await accounts.setCredentials(first!.id, { password: 'a-long-new-password' });
    expect(result).toEqual(answer);
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('PUT');
    expect(url).toBe(`https://api.test/staff/users/${first!.id}/credentials`);
    expect(JSON.parse(init.body as string)).toEqual({ password: 'a-long-new-password' });
  });

  it('maps a 403 to the permission error', async () => {
    expect(
      await setup(403, errorBody('FORBIDDEN', 'x'))
        .accounts.list()
        .catch((e: unknown) => e),
    ).toBeInstanceOf(PermissionDeniedError);
  });
});
