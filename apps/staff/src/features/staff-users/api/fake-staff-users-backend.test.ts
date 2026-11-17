import {
  staffAccountListResponseSchema,
  staffAccountResponseSchema,
} from '@iorder/shared/staff-auth';
import {
  blockUserResponseSchema,
  groupRemovalStatusResponseSchema,
} from '@iorder/shared/staff-orders';
import type { StaffRole } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import { createFakeStaffUsers, type FakeStaffUsersOptions } from './fake-staff-users-backend';

// The fake mirrors the api's rules; this holds it to the shared schemas and to the rules the
// screens rely on (uniform 403, a manager cannot touch an administrator, removal progress).

const IDEAL_OWNER = fakeUuid('u-101');
const SMART_ZONE_OWNER = fakeUuid('u-151');
const ADMIN = fakeUuid('staff-account:admin');
const MANAGER = fakeUuid('staff-account:manager');
const DRIVER = fakeUuid('staff-account:driver');

function make(roles: StaffRole[], extra: Partial<FakeStaffUsersOptions> = {}) {
  return createFakeStaffUsers({ roles: () => roles, ...extra });
}
const rejected = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('fake staff users: shapes', () => {
  it('answers with the shared schemas (accounts, block, removal status)', async () => {
    const fake = make(['ADMIN'], { pendingReads: 0 });
    const list = await fake.staffAccountsApi.list();
    expect(staffAccountListResponseSchema.safeParse({ items: list }).success).toBe(true);

    const blocked = await fake.staffUsersApi.blockUser(IDEAL_OWNER, { removeFromGroups: true });
    expect(blockUserResponseSchema.safeParse(blocked).success).toBe(true);
    const items = await fake.staffUsersApi.removalStatus(IDEAL_OWNER);
    expect(groupRemovalStatusResponseSchema.safeParse({ items }).success).toBe(true);

    const created = await fake.staffAccountsApi.create({
      fullName: 'Yangi Xodim',
      login: 'yangi@iorder.uz',
      password: 'correct-horse-battery',
      roles: ['DRIVER'],
      telegramUserId: '555000900',
    });
    expect(staffAccountResponseSchema.safeParse(created).success).toBe(true);
  });
});

describe('fake staff users: permissions', () => {
  it('answers the same 403 to every role except manager and admin', async () => {
    for (const role of ['ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      const fake = make([role]);
      const errors = await Promise.all([
        rejected(fake.staffAccountsApi.list()),
        rejected(fake.staffUsersApi.blockUser(IDEAL_OWNER, { removeFromGroups: false })),
        rejected(fake.staffUsersApi.removalStatus(IDEAL_OWNER)),
      ]);
      for (const error of errors) expect(error).toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('refuses a manager every action on an administrator, with the plain 403', async () => {
    const fake = make(['MANAGER']);
    expect(
      await rejected(fake.staffUsersApi.blockUser(ADMIN, { removeFromGroups: false })),
    ).toBeInstanceOf(PermissionDeniedError);
    expect(await rejected(fake.staffUsersApi.removalStatus(ADMIN))).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(await rejected(fake.staffAccountsApi.setTelegram(ADMIN, '123'))).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(
      await rejected(
        fake.staffAccountsApi.setCredentials(ADMIN, { password: 'a-long-new-password' }),
      ),
    ).toBeInstanceOf(PermissionDeniedError);
  });

  it('answers a manager the same 403 for a missing account as for an administrator', async () => {
    const fake = make(['MANAGER']);
    const missing = await rejected(fake.staffAccountsApi.setTelegram(fakeUuid('nobody'), '123'));
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    const admin = make(['ADMIN']);
    expect(
      await rejected(admin.staffAccountsApi.setTelegram(fakeUuid('nobody'), '123')),
    ).toBeInstanceOf(ApiNotFoundError);
  });

  it('lets only an administrator block or unblock a staff account', async () => {
    expect(
      await rejected(
        make(['MANAGER']).staffUsersApi.blockUser(DRIVER, { removeFromGroups: false }),
      ),
    ).toBeInstanceOf(PermissionDeniedError);
    const admin = make(['ADMIN']);
    const blocked = await admin.staffUsersApi.blockUser(DRIVER, { removeFromGroups: false });
    expect(blocked.status).toBe('BLOCKED');
    const accounts = await admin.staffAccountsApi.list();
    expect(accounts.find((a) => a.id === DRIVER)?.status).toBe('BLOCKED');
    expect((await admin.staffUsersApi.unblockUser(DRIVER)).status).toBe('ACTIVE');
  });

  it('refuses to block the last active administrator', async () => {
    expect(
      await rejected(make(['ADMIN']).staffUsersApi.blockUser(ADMIN, { removeFromGroups: false })),
    ).toBeInstanceOf(ApiConflictError);
  });

  it('does not let a manager create an administrator but lets an admin', async () => {
    const input = {
      fullName: 'Yangi Admin',
      login: 'yangi.admin@iorder.uz',
      password: 'correct-horse-battery',
      roles: ['ADMIN' as const],
      telegramUserId: '555000901',
    };
    expect(await rejected(make(['MANAGER']).staffAccountsApi.create(input))).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect((await make(['ADMIN']).staffAccountsApi.create(input)).roles).toEqual(['ADMIN']);
  });
});

describe('fake staff users: accounts', () => {
  it('validates the body with the shared schema (login shape, password length, role count)', async () => {
    const api = make(['MANAGER']).staffAccountsApi;
    const base = {
      fullName: 'Test',
      login: 'test@iorder.uz',
      password: 'correct-horse-battery',
      roles: ['DRIVER' as const],
      telegramUserId: '555000902',
    };
    for (const bad of [
      { ...base, login: 'Not A Login' },
      { ...base, password: 'short' },
      { ...base, roles: [] },
      { ...base, roles: ['DRIVER' as const, 'DRIVER' as const] },
      { ...base, telegramUserId: '12x' },
    ]) {
      expect(await rejected(api.create(bad))).toBeInstanceOf(ApiValidationError);
    }
  });

  it('refuses a taken login or Telegram id with the same 409', async () => {
    const api = make(['ADMIN']).staffAccountsApi;
    const body = {
      fullName: 'Test',
      login: 'manager@iorder.uz',
      password: 'correct-horse-battery',
      roles: ['DRIVER' as const],
      telegramUserId: '555000903',
    };
    expect(await rejected(api.create(body))).toBeInstanceOf(ApiConflictError);
    const linked = await api.setTelegram(MANAGER, '555000111');
    expect(linked.telegramLinked).toBe(true);
    expect(await rejected(api.setTelegram(DRIVER, '555000111'))).toBeInstanceOf(ApiConflictError);
    // Removing the id is not possible: an empty value is a validation error, the link stays.
    expect(await rejected(api.setTelegram(MANAGER, ''))).toBeInstanceOf(ApiValidationError);
    expect((await api.setTelegram(MANAGER, '555000112')).telegramLinked).toBe(true);
  });

  it('marks hasPassword after a reset and keeps the password out of every answer', async () => {
    const api = make(['ADMIN']).staffAccountsApi;
    const answer = await api.setCredentials(DRIVER, { password: 'a-long-new-password' });
    expect(JSON.stringify(answer)).not.toContain('a-long-new-password');
    const driver = (await api.list()).find((a) => a.id === DRIVER);
    expect(driver?.hasPassword).toBe(true);
    expect(JSON.stringify(await api.list())).not.toContain('a-long-new-password');
  });
});

describe('fake staff users: group removal', () => {
  it('stays PENDING for the configured reads, then ends DONE and removes the membership', async () => {
    const fake = make(['MANAGER'], { pendingReads: 1 });
    const blocked = await fake.staffUsersApi.blockUser(IDEAL_OWNER, { removeFromGroups: true });
    expect(blocked.groupRemoval).toEqual({ requested: true, queued: 1, alreadyRequested: 0 });
    expect((await fake.staffUsersApi.removalStatus(IDEAL_OWNER))[0]?.status).toBe('PENDING');
    expect((await fake.staffUsersApi.removalStatus(IDEAL_OWNER))[0]?.status).toBe('DONE');
  });

  it('ends FAILED with a code and re-queues only the failed one when blocked again', async () => {
    const fake = make(['MANAGER'], { pendingReads: 0 });
    await fake.staffUsersApi.blockUser(SMART_ZONE_OWNER, { removeFromGroups: true });
    const first = await fake.staffUsersApi.removalStatus(SMART_ZONE_OWNER);
    expect(first[0]).toMatchObject({ status: 'FAILED', errorCode: 'BOT_NOT_ADMIN' });

    const again = await fake.staffUsersApi.blockUser(SMART_ZONE_OWNER, { removeFromGroups: true });
    expect(again.groupRemoval).toEqual({ requested: true, queued: 1, alreadyRequested: 0 });
    expect((await fake.staffUsersApi.removalStatus(SMART_ZONE_OWNER))[0]?.status).toBe('DONE');

    const third = await fake.staffUsersApi.blockUser(SMART_ZONE_OWNER, { removeFromGroups: true });
    // The person left the group: nothing is queued twice.
    expect(third.groupRemoval?.queued).toBe(0);
  });

  it('flags a possible ban when the unban failed', async () => {
    const fake = make(['MANAGER'], { pendingReads: 0, removalOutcome: () => 'UNBAN_FAILED' });
    await fake.staffUsersApi.blockUser(IDEAL_OWNER, { removeFromGroups: true });
    expect((await fake.staffUsersApi.removalStatus(IDEAL_OWNER))[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'UNBAN_FAILED',
      maybeBanned: true,
    });
  });

  it('adds no groupRemoval to a block-only answer and queues nothing', async () => {
    const fake = make(['MANAGER']);
    const answer = await fake.staffUsersApi.blockUser(IDEAL_OWNER, { removeFromGroups: false });
    expect(answer.groupRemoval).toBeUndefined();
    expect(await fake.staffUsersApi.removalStatus(IDEAL_OWNER)).toEqual([]);
  });

  it('answers 404 for an unknown customer', async () => {
    const fake = make(['MANAGER']);
    expect(
      await rejected(fake.staffUsersApi.blockUser(fakeUuid('nobody'), { removeFromGroups: true })),
    ).toBeInstanceOf(ApiNotFoundError);
  });
});
