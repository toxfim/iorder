import {
  blockUserResponseSchema,
  groupRemovalStatusResponseSchema,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { RETRY_DELAYS_SECONDS } from '../src/modules/notifications/delivery-policy.js';
import { NotificationsModule, OutboxDispatcher } from '../src/modules/notifications/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { TelegramSender } from '../src/modules/telegram/index.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
  staffActor,
} from './support/identity-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

// Blocking a customer together with removing them from their Telegram group(s): the request
// (real PostgreSQL), the outbox jobs and the dispatcher with a FAKE sender. Nothing here reaches
// Telegram.
describe('block with group removal (real PostgreSQL, fake Telegram)', () => {
  let t: TestApp;
  let sender: FakeTelegramSender;
  let dispatcher: OutboxDispatcher;

  beforeAll(async () => {
    sender = new FakeTelegramSender();
    t = await createTestApp([IdentityModule, OrganizationsModule, NotificationsModule], {
      env: { BOT_TOKEN: '123456:FAKE-TOKEN-FOR-TESTS-ONLY', WEB_APP_URL: 'https://app.example.uz' },
      overrides: [{ token: TelegramSender, value: sender }],
    });
    await t.prisma.$connect();
    dispatcher = t.get(OutboxDispatcher);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetIdentity(t.prisma);
    sender.removed.length = 0;
    sender.removalAttempts.length = 0;
    sender.clearFailures();
    sender.beforeSend = undefined;
    t.clock.set(new Date('2026-10-22T08:00:00Z'));
  });

  async function world() {
    const admin = await makeUser(t.prisma, { name: 'Admin', staff: ['ADMIN'] });
    const manager = await makeUser(t.prisma, { name: 'Manager', staff: ['MANAGER'] });
    const org = await makeOrganization(t.prisma, { name: 'Alpha shop' });
    const customer = await makeUser(t.prisma, { name: 'Customer', phone: '+998905556677' });
    await makeMember(t.prisma, org.id, customer.id, 'SELLER');
    const chatId = String(
      (await t.prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).telegramChatId,
    );
    return {
      admin,
      manager,
      org,
      customer,
      chatId,
      asAdmin: staffActor(admin.id, 'ADMIN'),
      asManager: staffActor(manager.id, 'MANAGER'),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const block = (w: World, body?: unknown, actor = w.asManager, id = w.customer.id) =>
    t.request('POST', `/staff/users/${id}/block`, {
      actor,
      ...(body === undefined ? {} : { body }),
    });
  const kickRows = () =>
    t.prisma.notificationOutbox.findMany({
      where: { type: 'KICK_MEMBER' },
      orderBy: { createdAt: 'asc' },
    });
  const status = async (w: World, id = w.customer.id) =>
    groupRemovalStatusResponseSchema.parse(
      (await t.request('GET', `/staff/users/${id}/removal-status`, { actor: w.asManager })).body,
    ).items;

  describe('the request', () => {
    it('blocks without the flag exactly as before and queues nothing', async () => {
      const w = await world();
      const res = await block(w);
      expect(res.status).toBe(200);
      const body = blockUserResponseSchema.parse(res.body);
      expect(body.status).toBe('BLOCKED');
      // The answer is exactly the old one: the extra key appears only when asked for.
      expect(body.groupRemoval).toBeUndefined();
      expect(Object.keys(res.body as object)).not.toContain('groupRemoval');
      expect(await kickRows()).toHaveLength(0);

      const explicit = await block(w, { removeFromGroups: false }, w.asManager);
      expect(explicit.status).toBe(200);
      expect(await kickRows()).toHaveLength(0);
    });

    it('rejects a wrong type or an unknown field with 422 and changes nothing', async () => {
      const w = await world();
      for (const body of [{ removeFromGroups: 'yes' }, { removeFromGroups: true, chatId: '-1' }]) {
        expect((await block(w, body)).status).toBe(422);
      }
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: w.customer.id } })).status).toBe(
        'ACTIVE',
      );
      expect(await kickRows()).toHaveLength(0);
    });

    it('queues one job per ACTIVE membership in the transaction of the block, with an allow-listed payload', async () => {
      const w = await world();
      // A past membership elsewhere is not removed again.
      const old = await makeOrganization(t.prisma, { name: 'Old shop' });
      await makeMember(t.prisma, old.id, w.customer.id, 'SELLER', 'LEFT');

      const res = await block(w, { removeFromGroups: true });
      expect(res.status).toBe(200);
      expect(blockUserResponseSchema.parse(res.body).groupRemoval).toEqual({
        requested: true,
        queued: 1,
        alreadyRequested: 0,
      });

      const rows = await kickRows();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        status: 'PENDING',
        recipientKind: 'ORGANIZATION_CHAT',
        recipientOrganizationId: w.org.id,
        recipientUserId: null,
        // No order and no order event: the order timelines (which read the outbox by order) can never
        // show a removal job to a customer.
        orderId: null,
        orderEventId: null,
      });
      // Allow-list: ids and one reason code, no name, no phone.
      expect(Object.keys(row?.payload as object).sort()).toEqual([
        'chatId',
        'joinedAt',
        'reason',
        'requestedAt',
        'requestedByUserId',
        'telegramUserId',
        'userId',
      ]);
      expect(row?.payload).toEqual({
        userId: w.customer.id,
        telegramUserId: w.customer.telegramUserId.toString(),
        chatId: w.chatId,
        reason: 'BLOCKED',
        joinedAt: '2026-10-01T00:00:00.000Z',
        requestedByUserId: w.manager.id,
        requestedAt: '2026-10-22T08:00:00.000Z',
      });
      expect(JSON.stringify(row?.payload)).not.toContain('Customer');
      expect(JSON.stringify(row?.payload)).not.toContain('998905556677');

      const audit = await t.prisma.auditLog.findMany({ where: { action: 'USER_BLOCKED' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.diff).toEqual({
        status: { from: 'ACTIVE', to: 'BLOCKED' },
        groupRemovalRequested: { from: false, to: true },
        groupRemovalQueued: { from: null, to: 1 },
      });
    });

    it('leaves no job when the audit row cannot be written (same transaction)', async () => {
      const w = await world();
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit down'));
      const res = await block(w, { removeFromGroups: true });
      expect(res.status).toBe(500);
      expect(await kickRows()).toHaveLength(0);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: w.customer.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('rolls back block AND jobs when a step fails after the jobs were written', async () => {
      const w = await world();
      let jobsSeenInsideTransaction = 0;
      vi.spyOn(t.get(AuditService), 'record').mockImplementationOnce(async (tx) => {
        // The failure comes AFTER the enqueue: the job is already visible inside the transaction.
        jobsSeenInsideTransaction = await tx.notificationOutbox.count({
          where: { type: 'KICK_MEMBER' },
        });
        throw new Error('audit down after the enqueue');
      });
      const res = await block(w, { removeFromGroups: true });
      expect(res.status).toBe(500);
      expect(jobsSeenInsideTransaction).toBe(1);
      expect(await kickRows()).toHaveLength(0);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: w.customer.id } })).status).toBe(
        'ACTIVE',
      );
      expect(await t.prisma.auditLog.count({ where: { action: 'USER_BLOCKED' } })).toBe(0);
    });

    it('queues nothing for staff or for a person in no group (a customer always has a Telegram id: the database requires it)', async () => {
      const w = await world();
      const staff = await makeUser(t.prisma, { name: 'Another manager', staff: ['MANAGER'] });
      const staffRes = await block(w, { removeFromGroups: true }, w.asAdmin, staff.id);
      expect(blockUserResponseSchema.parse(staffRes.body).groupRemoval?.queued).toBe(0);

      const loner = await makeUser(t.prisma, { name: 'Loner' });
      const lonerRes = await block(w, { removeFromGroups: true }, w.asManager, loner.id);
      expect(blockUserResponseSchema.parse(lonerRes.body).groupRemoval).toEqual({
        requested: true,
        queued: 0,
        alreadyRequested: 0,
      });
      expect(await kickRows()).toHaveLength(0);
    });

    it('is idempotent: blocking again creates no second job, a FAILED one may be asked again', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      const again = await block(w, { removeFromGroups: true });
      expect(blockUserResponseSchema.parse(again.body).groupRemoval).toEqual({
        requested: true,
        queued: 0,
        alreadyRequested: 1,
      });
      expect(await kickRows()).toHaveLength(1);

      // The bot could not do it (not an administrator). After the cause is fixed, blocking
      // again with the flag asks once more; nothing is kicked twice.
      sender.failRemovalFor(w.chatId, { failure: 'BOT_NOT_ADMIN' });
      await dispatcher.runOnce();
      sender.clearFailures();
      const retry = await block(w, { removeFromGroups: true });
      expect(blockUserResponseSchema.parse(retry.body).groupRemoval?.queued).toBe(1);
      await dispatcher.runOnce();
      expect(sender.removed).toEqual([
        { chatId: w.chatId, userId: w.customer.telegramUserId.toString() },
      ]);
      const done = await block(w, { removeFromGroups: true });
      expect(blockUserResponseSchema.parse(done.body).groupRemoval?.queued).toBe(0);
      expect(await kickRows()).toHaveLength(2);
    });
  });

  describe('the status read', () => {
    it('is never cached by a browser or proxy', async () => {
      const w = await world();
      const res = await t.request('GET', `/staff/users/${w.customer.id}/removal-status`, {
        actor: w.asManager,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('permissions', () => {
    it('answers 403 for customers and for staff roles that may not edit customers', async () => {
      const w = await world();
      const other = await makeUser(t.prisma, { name: 'Other' });
      for (const actor of [
        customerActor(other.id, w.org.id),
        staffActor(other.id, 'WAREHOUSE_MANAGER'),
        staffActor(other.id, 'ACCOUNTANT'),
        staffActor(other.id, 'DRIVER'),
      ]) {
        expect((await block(w, { removeFromGroups: true }, actor)).status).toBe(403);
        expect(
          (await t.request('GET', `/staff/users/${w.customer.id}/removal-status`, { actor }))
            .status,
        ).toBe(403);
      }
      expect(await kickRows()).toHaveLength(0);
    });

    it('lets a manager not touch an administrator, but an administrator may', async () => {
      const w = await world();
      expect((await block(w, { removeFromGroups: true }, w.asManager, w.admin.id)).status).toBe(
        403,
      );
      expect(
        (
          await t.request('GET', `/staff/users/${w.admin.id}/removal-status`, {
            actor: w.asManager,
          })
        ).status,
      ).toBe(403);
      const second = await makeUser(t.prisma, { name: 'Admin 2', staff: ['ADMIN'] });
      // Same as a write (MANAGE_STAFF for any staff target): a manager gets the SAME 403 for an
      // administrator and for another staff member, so the answer reveals nothing about the target.
      const warehouse = await makeUser(t.prisma, { name: 'Store', staff: ['WAREHOUSE_MANAGER'] });
      const read = (id: string, actor = w.asManager) =>
        t.request('GET', `/staff/users/${id}/removal-status`, { actor });
      const onAdmin = await read(w.admin.id);
      const onStaff = await read(warehouse.id);
      expect(onStaff.status).toBe(403);
      expect(onStaff.body).toEqual(onAdmin.body);
      expect((await read(warehouse.id, w.asAdmin)).status).toBe(200);
      expect((await read(w.customer.id)).status).toBe(200);
      expect((await block(w, { removeFromGroups: true }, w.asAdmin, second.id)).status).toBe(200);
    });
  });

  describe('the dispatcher', () => {
    it('removes the person, then marks the membership LEFT and writes the audit line', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      t.clock.set(new Date('2026-10-22T08:05:00Z'));

      const summary = await dispatcher.runOnce();
      expect(summary).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
      expect(sender.removed).toEqual([
        { chatId: w.chatId, userId: w.customer.telegramUserId.toString() },
      ]);
      // A removal sends no text.
      expect(sender.sent).toHaveLength(0);

      const [row] = await kickRows();
      expect(row).toMatchObject({ status: 'SENT', lastErrorCode: null });
      const member = await t.prisma.organizationMember.findFirstOrThrow({
        where: { userId: w.customer.id },
      });
      expect(member.status).toBe('LEFT');
      expect(member.leftAt).toEqual(new Date('2026-10-22T08:05:00Z'));

      const line = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'TELEGRAM_MEMBER_REMOVED_FROM_CHAT' },
      });
      expect(line.actorUserId).toBeNull();
      expect(line.entityId).toBe(w.org.id);
      expect(line.diff).toEqual({
        [`members.${w.customer.id}.status`]: { from: 'ACTIVE', to: 'LEFT' },
        removalReason: { from: null, to: 'BLOCKED' },
        removalRequestedByUserId: { from: null, to: w.manager.id },
        removalRequestedAt: { from: null, to: '2026-10-22T08:00:00.000Z' },
      });

      expect(await status(w)).toEqual([
        {
          organizationId: w.org.id,
          organizationName: 'Alpha shop',
          status: 'DONE',
          errorCode: null,
          maybeBanned: false,
          requestedAt: '2026-10-22T08:00:00.000Z',
          completedAt: '2026-10-22T08:05:00.000Z',
        },
      ]);
      // Nothing is sent twice.
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      expect(sender.removalAttempts).toHaveLength(1);
    });

    it.each([
      ['BOT_NOT_ADMIN', 'BOT_NOT_ADMIN'],
      ['NOT_A_MEMBER', 'NOT_A_MEMBER'],
      ['CHAT_NOT_FOUND', 'CHAT_NOT_FOUND'],
      ['CANNOT_REMOVE', 'CANNOT_REMOVE_MEMBER'],
      ['REJECTED', 'REMOVAL_REJECTED'],
      ['CHAT_MIGRATED', 'CHAT_MIGRATED'],
    ] as const)(
      '%s is final: no retry, membership untouched, visible to the manager',
      async (failure, code) => {
        const w = await world();
        await block(w, { removeFromGroups: true });
        sender.failRemovalFor(w.chatId, { failure });

        expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
        t.clock.set(new Date(t.clock.now().getTime() + 24 * 3600 * 1000));
        expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
        expect(sender.removalAttempts).toHaveLength(1);

        const [row] = await kickRows();
        expect(row).toMatchObject({ status: 'FAILED', lastErrorCode: code, attempts: 1 });
        const member = await t.prisma.organizationMember.findFirstOrThrow({
          where: { userId: w.customer.id },
        });
        expect(member).toMatchObject({ status: 'ACTIVE', leftAt: null });
        expect(
          await t.prisma.auditLog.count({ where: { action: 'TELEGRAM_MEMBER_REMOVED_FROM_CHAT' } }),
        ).toBe(0);
        const [item] = await status(w);
        expect(item).toMatchObject({ status: 'FAILED', errorCode: code, completedAt: null });
      },
    );

    it('ban done but unban failed: final UNBAN_FAILED, membership LEFT, audit line, flagged maybeBanned', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      sender.failRemovalFor(w.chatId, { failure: 'UNBAN_FAILED' });
      t.clock.set(new Date('2026-10-22T08:05:00Z'));

      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
      const [row] = await kickRows();
      expect(row).toMatchObject({ status: 'FAILED', lastErrorCode: 'UNBAN_FAILED' });
      const member = await t.prisma.organizationMember.findFirstOrThrow({
        where: { userId: w.customer.id },
      });
      expect(member.status).toBe('LEFT');
      const line = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'TELEGRAM_MEMBER_BANNED_NOT_UNBANNED' },
      });
      expect(line.diff).toMatchObject({
        memberBannedButNotUnbanned: { from: false, to: true },
      });
      expect(
        await t.prisma.auditLog.count({ where: { action: 'TELEGRAM_MEMBER_REMOVED_FROM_CHAT' } }),
      ).toBe(0);
      expect((await status(w))[0]).toMatchObject({
        status: 'FAILED',
        errorCode: 'UNBAN_FAILED',
        maybeBanned: true,
      });
    });

    it('waits for a rate limit without using up an attempt, then succeeds', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      sender.failRemovalFor(w.chatId, { failure: 'RATE_LIMITED', retryAfterSeconds: 7, times: 1 });

      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
      const [waiting] = await kickRows();
      expect(waiting).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        lastErrorCode: 'RATE_LIMITED',
      });
      expect(waiting?.nextAttemptAt).toEqual(new Date(t.clock.now().getTime() + 7000));
      expect((await status(w))[0]).toMatchObject({ status: 'PENDING', errorCode: null });

      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      t.clock.set(new Date(t.clock.now().getTime() + 8000));
      expect(await dispatcher.runOnce()).toMatchObject({ sent: 1 });
      expect(sender.removed).toHaveLength(1);
    });

    it('gives up on a removal that stays rate limited for more than a day (RATE_LIMITED_TOO_LONG)', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      sender.failRemovalFor(w.chatId, { failure: 'RATE_LIMITED', retryAfterSeconds: 3600 });

      // Still waiting after 23 hours: each 429 only defers.
      for (let hour = 0; hour < 23; hour += 1) {
        expect(await dispatcher.runOnce()).toMatchObject({ failed: 0 });
        t.clock.set(new Date(t.clock.now().getTime() + 3600_000 + 1000));
      }
      expect((await kickRows())[0]).toMatchObject({ status: 'PENDING' });

      // Past 24 hours since the request the next 429 is final.
      t.clock.set(new Date(Date.parse('2026-10-22T08:00:00Z') + 24 * 3600_000 + 1000));
      expect(await dispatcher.runOnce()).toMatchObject({ failed: 1 });
      expect((await kickRows())[0]).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'RATE_LIMITED_TOO_LONG',
      });
      expect((await status(w))[0]).toMatchObject({
        status: 'FAILED',
        errorCode: 'RATE_LIMITED_TOO_LONG',
      });
      const member = await t.prisma.organizationMember.findFirstOrThrow({
        where: { userId: w.customer.id },
      });
      expect(member.status).toBe('ACTIVE');
    });

    it('retries a transient failure with the normal backoff', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      sender.failRemovalFor(w.chatId, { failure: 'TRANSIENT', times: 1 });

      expect(await dispatcher.runOnce()).toMatchObject({ retried: 1, failed: 0 });
      const [row] = await kickRows();
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastErrorCode: 'SEND_FAILED' });
      expect(row?.nextAttemptAt).toEqual(
        new Date(t.clock.now().getTime() + (RETRY_DELAYS_SECONDS[0] ?? 0) * 1000),
      );
      t.clock.set(new Date(t.clock.now().getTime() + 31_000));
      expect(await dispatcher.runOnce()).toMatchObject({ sent: 1 });
    });

    it('unblocking cancels the waiting job; blocking again WITHOUT the flag does not revive it', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      const unblock = await t.request('POST', `/staff/users/${w.customer.id}/unblock`, {
        actor: w.asManager,
      });
      expect(unblock.status).toBe(200);
      const [cancelled] = await kickRows();
      expect(cancelled).toMatchObject({ status: 'FAILED', lastErrorCode: 'REMOVAL_NOT_ALLOWED' });

      await block(w); // no flag
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      expect(sender.removalAttempts).toHaveLength(0);
      // The membership stays as it was, and the cancellation is in the audit trail.
      const member = await t.prisma.organizationMember.findFirstOrThrow({
        where: { userId: w.customer.id },
      });
      expect(member.status).toBe('ACTIVE');
      const unblocked = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'USER_UNBLOCKED' },
      });
      expect(unblocked.diff).toMatchObject({ groupRemovalsCancelled: { from: null, to: 1 } });
    });

    it('send-time re-check: a person unblocked behind our back or with another Telegram id is not removed', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      await t.prisma.user.update({ where: { id: w.customer.id }, data: { status: 'ACTIVE' } });
      expect(await dispatcher.runOnce()).toMatchObject({ failed: 1 });
      expect(sender.removalAttempts).toHaveLength(0);
      expect((await kickRows())[0]?.lastErrorCode).toBe('REMOVAL_NOT_ALLOWED');

      await t.prisma.user.update({ where: { id: w.customer.id }, data: { status: 'BLOCKED' } });
      await block(w, { removeFromGroups: true });
      await t.prisma.user.update({
        where: { id: w.customer.id },
        data: { telegramUserId: 8_123_456_789n },
      });
      expect(await dispatcher.runOnce()).toMatchObject({ failed: 1 });
      expect(sender.removalAttempts).toHaveLength(0);
    });

    it('send-time re-check: a member who left meanwhile is not removed', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      await t.prisma.organizationMember.updateMany({
        where: { userId: w.customer.id },
        data: { status: 'LEFT', leftAt: t.clock.now() },
      });
      expect(await dispatcher.runOnce()).toMatchObject({ failed: 1 });
      expect(sender.removalAttempts).toHaveLength(0);
      expect((await kickRows())[0]?.lastErrorCode).toBe('REMOVAL_NOT_ALLOWED');
    });

    it('send-time re-check: a member who joined again (new joinedAt) is not removed by the old job', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      await t.prisma.organizationMember.updateMany({
        where: { userId: w.customer.id },
        data: { status: 'ACTIVE', leftAt: null, joinedAt: new Date('2026-10-22T08:03:00Z') },
      });
      expect(await dispatcher.runOnce()).toMatchObject({ failed: 1 });
      expect(sender.removalAttempts).toHaveLength(0);
      expect((await kickRows())[0]?.lastErrorCode).toBe('REMOVAL_NOT_ALLOWED');
    });

    it('unblocking after a successful removal does not bring the person back', async () => {
      const w = await world();
      await block(w, { removeFromGroups: true });
      await dispatcher.runOnce();
      const res = await t.request('POST', `/staff/users/${w.customer.id}/unblock`, {
        actor: w.asManager,
      });
      expect(res.status).toBe(200);
      expect(
        (await t.prisma.organizationMember.findFirstOrThrow({ where: { userId: w.customer.id } }))
          .status,
      ).toBe('LEFT');
      expect(await kickRows()).toHaveLength(1);
      expect(sender.removed).toHaveLength(1);
    });
  });
});
