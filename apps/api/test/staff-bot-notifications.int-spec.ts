import type { StaffRole } from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { TelegramModule, TelegramSender } from '../src/modules/telegram/index.js';
import { BotIdentity } from '../src/modules/telegram/bot-identity.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

// [C] 2026-10-25: a staff member connects the bot from the staff app with a one-time deep link;
// pressing Start links their Telegram id and lets the bot write to them. Real PostgreSQL, fake
// Telegram, the real webhook path.

const SECRET = 'staff-bot-secret-0123456789';
const BOT_USERNAME = 'iorder_test_bot';

describe('staff bot notifications (real PostgreSQL, fake Telegram)', () => {
  let t: TestApp;
  let sender: FakeTelegramSender;

  beforeAll(async () => {
    sender = new FakeTelegramSender();
    t = await createTestApp([TelegramModule], {
      env: {
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        BOT_TOKEN: '123456:FAKE-TOKEN-FOR-TESTS-ONLY',
        WEB_APP_URL: 'https://app.example.uz',
      },
      overrides: [
        { token: TelegramSender, value: sender },
        { token: BotIdentity, value: { username: () => Promise.resolve(BOT_USERNAME) } },
      ],
    });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    await resetIdentity(t.prisma);
    sender.sent.length = 0;
    sender.clearFailures();
  });

  const staffActor = async (
    roles: StaffRole[],
    telegramUserId?: bigint,
  ): Promise<{ actor: Actor; id: string }> => {
    const user = await makeUser(t.prisma, {
      staff: roles,
      ...(telegramUserId === undefined ? {} : { telegramUserId }),
    });
    // Staff accounts are created with a login and no Telegram id; the fixture always sets one.
    if (telegramUserId === undefined) {
      await t.prisma.user.update({ where: { id: user.id }, data: { telegramUserId: null } });
    }
    return { actor: { userId: user.id, staffRoles: roles }, id: user.id };
  };
  const status = (actor: Actor) => t.request('GET', '/staff/me/notifications', { actor });
  const createLink = async (actor: Actor): Promise<string> => {
    const res = await t.request('POST', '/staff/me/notifications/link', { actor });
    expect(res.status).toBe(200);
    return (res.body as { url: string }).url;
  };
  const payloadOf = (url: string): string => new URL(url).searchParams.get('start') ?? '';
  let updateId = 0;
  const pressStart = (telegramUserId: number, payload?: string) => {
    updateId += 1;
    return t.request('POST', `/telegram/webhook/${SECRET}`, {
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      body: {
        update_id: updateId,
        // The press of a language button after /start [C, owner 2026-11-13], carrying the payload.
        callback_query: {
          id: `cb-${updateId}`,
          from: { id: telegramUserId, is_bot: false, first_name: 'Staff' },
          message: { message_id: updateId, chat: { id: telegramUserId, type: 'private' } },
          data: payload === undefined ? 'lang:uz' : `lang:uz:${payload}`,
        },
      },
    });
  };
  const userRow = (id: string) =>
    t.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { telegramUserId: true, botStartedAt: true, botBlockedAt: true },
    });

  it('connects a staff member without a Telegram id: links the id, starts the bot, audits', async () => {
    const { actor, id } = await staffActor(['WAREHOUSE_MANAGER']);
    expect((await status(actor)).body).toEqual({ telegramLinked: false, botConnected: false });

    const url = await createLink(actor);
    expect(url).toMatch(
      new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?start=staff_[A-Za-z0-9_-]{43}$`),
    );
    expect(await t.prisma.telegramLinkToken.count()).toBe(1);
    // Only the hash is stored.
    const stored = await t.prisma.telegramLinkToken.findFirstOrThrow();
    expect(url).not.toContain(stored.tokenHash);

    expect((await pressStart(7001, payloadOf(url))).status).toBe(200);
    expect(sender.sent.at(-1)).toMatchObject({ chatId: '7001' });
    expect(sender.sent.at(-1)?.text).toContain('Bildirishnomalar yoqildi');
    expect(await userRow(id)).toMatchObject({ telegramUserId: 7001n });
    expect((await status(actor)).body).toEqual({ telegramLinked: true, botConnected: true });

    const actions = await t.prisma.auditLog.findMany({
      where: { entityId: id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorUserId: true },
    });
    expect(actions.map((a) => a.action)).toEqual(['STAFF_BOT_LINK_CREATED', 'STAFF_BOT_CONNECTED']);
    expect(actions.every((a) => a.actorUserId === id)).toBe(true);
  });

  it('uses a link once and refuses an expired one', async () => {
    const { actor } = await staffActor(['MANAGER']);
    const once = payloadOf(await createLink(actor));
    await pressStart(7002, once);
    await pressStart(7002, once);
    expect(sender.sent.at(-1)?.text).toContain('eskirgan');

    const { actor: other, id: otherId } = await staffActor(['DRIVER']);
    const late = payloadOf(await createLink(other));
    t.clock.set(new Date(t.clock.now().getTime() + 601_000));
    await pressStart(7003, late);
    expect(sender.sent.at(-1)?.text).toContain('eskirgan');
    expect((await userRow(otherId)).telegramUserId).toBeNull();
  });

  it('never moves a Telegram id: refuses an id of another person and an account linked elsewhere', async () => {
    await makeUser(t.prisma, { telegramUserId: 7004n });
    const { actor: free, id: freeId } = await staffActor(['ACCOUNTANT']);
    await pressStart(7004, payloadOf(await createLink(free)));
    expect(sender.sent.at(-1)?.text).toContain('boshqa odamga');
    expect((await userRow(freeId)).telegramUserId).toBeNull();

    const { actor: linked, id: linkedId } = await staffActor(['MANAGER'], 7005n);
    await pressStart(7006, payloadOf(await createLink(linked)));
    expect(sender.sent.at(-1)?.text).toContain('boshqa Telegram akkauntiga');
    expect((await userRow(linkedId)).telegramUserId).toBe(7005n);
  });

  it('marks a plain private start of a known staff member as connected', async () => {
    const { actor, id } = await staffActor(['DRIVER'], 7007n);
    expect((await status(actor)).body).toEqual({ telegramLinked: true, botConnected: false });
    await pressStart(7007);
    expect((await userRow(id)).botStartedAt).not.toBeNull();
    expect((await status(actor)).body).toEqual({ telegramLinked: true, botConnected: true });
  });

  it('is closed to administrators, customers and strangers', async () => {
    const { actor: admin } = await staffActor(['ADMIN']);
    expect((await status(admin)).status).toBe(403);
    expect((await t.request('POST', '/staff/me/notifications/link', { actor: admin })).status).toBe(
      403,
    );
    const org = await makeOrganization(t.prisma);
    const customer = await makeUser(t.prisma);
    await makeMember(t.prisma, org.id, customer.id, 'SELLER');
    const seller: Actor = {
      userId: customer.id,
      staffRoles: [],
      membership: { organizationId: org.id, role: 'SELLER' },
    };
    expect((await status(seller)).status).toBe(403);
    expect((await t.request('GET', '/staff/me/notifications')).status).toBe(401);
    // A person who is admin AND manager gets manager messages, so may connect.
    const { actor: both } = await staffActor(['ADMIN', 'MANAGER']);
    expect((await status(both)).status).toBe(200);
  });
});
