import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { OrganizationsService } from '../src/modules/organizations/index.js';
import { PricingService } from '../src/modules/pricing/index.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { TelegramModule, TelegramSender } from '../src/modules/telegram/index.js';
import { makeMember, makeOrganization, makeUser, staffActor } from './support/identity-fixtures.js';
import { makeProduct, publishPriceList } from './support/orders-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetCatalogPricingAudit, resetIdentity } from './support/test-db.js';

// The bot against a real PostgreSQL. Telegram is a recording fake sender: no test reaches the
// network and the token below is not a real one.
const SECRET = 'integration-secret_0123456789';
const CHAT = -1001234567890;
const FAKE_TOKEN = '123456:FAKE-TOKEN-FOR-TESTS-ONLY';
const T0 = 1_790_000_000;

const BOT = { id: 999, is_bot: true, first_name: 'iOrder' };
const alice = {
  id: 7_100_000_001,
  is_bot: false,
  first_name: 'Alice',
  last_name: 'K',
  language_code: 'ru',
};
const bob = { id: 7_100_000_002, is_bot: false, first_name: 'Bob' };

const botAdded = (chat: number, title: string, date = T0, from: object | null = alice) => ({
  update_id: 1,
  my_chat_member: {
    chat: { id: chat, type: 'supergroup', title },
    ...(from ? { from } : {}),
    date,
    new_chat_member: { status: 'member', user: BOT },
  },
});
const botRemoved = (chat: number, date = T0 + 100) => ({
  update_id: 2,
  my_chat_member: {
    chat: { id: chat, type: 'supergroup', title: 'x' },
    date,
    new_chat_member: { status: 'kicked', user: BOT },
  },
});
const memberChange = (chat: number, user: object, status: string, date = T0 + 10) => ({
  update_id: 3,
  chat_member: {
    chat: { id: chat, type: 'supergroup', title: 'x' },
    date,
    new_chat_member: { status, user },
  },
});
const groupMessage = (chat: number, from: object, extra: object, date = T0 + 20) => ({
  update_id: 4,
  message: { date, chat: { id: chat, type: 'supergroup', title: 'x' }, from, ...extra },
});

describe('Telegram bot against a real database (fake Telegram)', () => {
  let t: TestApp;
  let sender: FakeTelegramSender;

  beforeAll(async () => {
    sender = new FakeTelegramSender();
    t = await createTestApp([TelegramModule], {
      env: {
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        BOT_TOKEN: FAKE_TOKEN,
        WEB_APP_URL: 'https://app.example.uz',
      },
      overrides: [{ token: TelegramSender, value: sender }],
    });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  let tick = 0;
  beforeEach(async () => {
    // The command rate limiter reads the (fake) clock: a new minute per test keeps tests apart.
    tick += 1;
    t.clock.set(new Date(Date.UTC(2026, 9, 20, 8, tick % 60)));
    await resetIdentity(t.prisma);
    await resetCatalogPricingAudit(t.prisma);
    sender.sent.length = 0;
    sender.documents.length = 0;
    sender.attempts.length = 0;
    sender.clearFailures();
  });

  const hook = (update: unknown, options: { path?: string; header?: string | null } = {}) =>
    t.request('POST', `/telegram/webhook/${options.path ?? SECRET}`, {
      body: update,
      headers:
        options.header === null
          ? {}
          : { 'x-telegram-bot-api-secret-token': options.header ?? SECRET },
    });
  const send = async (update: unknown) => {
    const response = await hook(update);
    expect(response.status).toBe(200);
  };

  const orgs = () => t.prisma.organization.findMany();
  const audit = () => t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
  const actions = async () => (await audit()).map((row) => row.action);
  const membersOf = (organizationId: string) =>
    t.prisma.organizationMember.findMany({ where: { organizationId }, include: { user: true } });
  // Staff activate an organization through the staff endpoint (covered in organizations.int-spec);
  // here a direct update stands in for it, because the bot itself must never do it.
  const staffActivates = (organizationId: string) =>
    t.prisma.organization.update({ where: { id: organizationId }, data: { status: 'ACTIVE' } });
  const outbox = () => t.prisma.notificationOutbox.findMany({ orderBy: { createdAt: 'asc' } });

  describe('webhook secret checks', () => {
    it('rejects a wrong URL secret with 404 and processes nothing', async () => {
      const response = await hook(botAdded(CHAT, 'Alpha'), { path: 'wrong-secret-wrong-secret' });
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
      expect(await orgs()).toHaveLength(0);
    });

    it.each([
      ['a missing header', null],
      ['an empty header', ''],
      ['a wrong header', 'not-the-secret-not-the-secret'],
      ['the right header with one extra character', `${SECRET}x`],
    ])('rejects %s with 401 and processes nothing', async (_name, header) => {
      const response = await hook(botAdded(CHAT, 'Alpha'), { header });
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
      expect(await orgs()).toHaveLength(0);
      expect(await audit()).toHaveLength(0);
    });

    it('answers 200 to a valid request and processes it', async () => {
      const response = await hook(botAdded(CHAT, 'Alpha'));
      expect(response.status).toBe(200);
      expect(await orgs()).toHaveLength(1);
    });

    it('answers 200 and ignores a body that is not a Telegram update', async () => {
      for (const body of [{}, [], { update_id: 'x' }, { update_id: 1, message: { chat: 5 } }]) {
        expect((await hook(body)).status).toBe(200);
      }
      expect(await orgs()).toHaveLength(0);
      expect(sender.sent).toHaveLength(0);
    });

    it('is a 404 for everything when the mode is not webhook, even with the right secrets', async () => {
      const off = await createTestApp([TelegramModule], {
        env: { TELEGRAM_MODE: 'off', TELEGRAM_WEBHOOK_SECRET: SECRET },
        overrides: [{ token: TelegramSender, value: new FakeTelegramSender() }],
      });
      try {
        const response = await off.request('POST', `/telegram/webhook/${SECRET}`, {
          body: botAdded(CHAT, 'Alpha'),
          headers: { 'x-telegram-bot-api-secret-token': SECRET },
        });
        expect(response.status).toBe(404);
        expect(await orgs()).toHaveLength(0);
      } finally {
        await off.close();
      }
    });
  });

  describe('the bot added to and removed from a group', () => {
    it('creates the organization once, even with duplicate and concurrent updates', async () => {
      await Promise.all(Array.from({ length: 6 }, () => send(botAdded(CHAT, 'Alpha Trade'))));
      await send(botAdded(CHAT, 'Alpha Trade'));
      const rows = await orgs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Alpha Trade',
        telegramChatId: BigInt(CHAT),
        // Owner decision: the bot never starts an organization ACTIVE.
        status: 'INACTIVE',
        pricePostingEnabled: false,
        addedByTelegramUserId: BigInt(alice.id),
        addedByName: 'Alice K',
      });
      const log = await audit();
      expect(log.map((row) => row.action)).toEqual(['TELEGRAM_ORGANIZATION_CREATED']);
      expect(log[0]?.actorUserId).toBeNull();
      expect(log[0]?.entityId).toBe(rows[0]?.id);
    });

    it('records nobody when Telegram does not say who added the bot', async () => {
      await send(botAdded(CHAT, 'Alpha', T0, null));
      expect((await orgs())[0]).toMatchObject({
        status: 'INACTIVE',
        addedByTelegramUserId: null,
        addedByName: null,
      });
    });

    it('bounds the stored name of who added the bot', async () => {
      await send(botAdded(CHAT, 'Alpha', T0, { ...alice, first_name: 'N'.repeat(300) }));
      const [org] = await orgs();
      expect(org?.addedByName?.length).toBeLessThanOrEqual(200);
    });

    it('tells managers and admins once, with an allow-listed payload', async () => {
      await Promise.all(Array.from({ length: 4 }, () => send(botAdded(CHAT, 'Alpha Trade'))));
      const rows = await outbox();
      expect(rows.map((r) => [r.type, r.recipientKind, r.recipientRole]).sort()).toEqual([
        ['ORGANIZATION_PENDING', 'ROLE', 'ADMIN'],
        ['ORGANIZATION_PENDING', 'ROLE', 'MANAGER'],
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({ status: 'PENDING', orderId: null });
        expect(row.payload).toEqual({
          organizationName: 'Alpha Trade',
          chatId: String(CHAT),
          addedByName: 'Alice K',
          addedByTelegramUserId: String(alice.id),
        });
      }
      // Adding the bot again later does not announce the same group twice.
      await send(botAdded(CHAT, 'Alpha Trade', T0 + 500));
      expect(await outbox()).toHaveLength(2);
    });

    it('marks the organization INACTIVE when the bot is removed, never deletes it, and is idempotent', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      await staffActivates((await orgs())[0]?.id ?? '');
      await send(botRemoved(CHAT));
      await send(botRemoved(CHAT));
      const rows = await orgs();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('INACTIVE');
      expect(await actions()).toEqual([
        'TELEGRAM_ORGANIZATION_CREATED',
        'TELEGRAM_ORGANIZATION_DEACTIVATED',
      ]);
    });

    it('never activates: a bot added again stays INACTIVE when staff deactivated the organization', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      const [before] = await orgs();
      await staffActivates(before?.id ?? '');
      // Staff switch it off by hand (not through the bot) ...
      await t.prisma.organization.update({
        where: { id: before?.id ?? '' },
        data: { status: 'INACTIVE' },
      });
      // ... and the bot is added again by someone else: nothing changes except an audit row.
      await send(botAdded(CHAT, 'Renamed in the meantime', T0 + 200, bob));
      const rows = await orgs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: before?.id,
        status: 'INACTIVE',
        name: 'Alpha',
        addedByTelegramUserId: BigInt(alice.id),
      });
      expect(await actions()).toEqual([
        'TELEGRAM_ORGANIZATION_CREATED',
        'TELEGRAM_BOT_ADDED_AGAIN',
      ]);
      expect((await audit()).every((row) => row.actorUserId === null)).toBe(true);
    });

    it('removed and added again: still INACTIVE, never reactivated by the bot', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      await send(botRemoved(CHAT, T0 + 100));
      await send(botAdded(CHAT, 'Alpha', T0 + 200));
      expect((await orgs())[0]?.status).toBe('INACTIVE');
      expect(await actions()).not.toContain('TELEGRAM_ORGANIZATION_REACTIVATED');
    });

    it('ignores events older than the last status event (out of order or retried)', async () => {
      await send(botAdded(CHAT, 'Alpha', T0));
      const [org] = await orgs();
      await staffActivates(org?.id ?? '');
      await send(botRemoved(CHAT, T0 + 100));
      expect((await orgs())[0]?.status).toBe('INACTIVE');
      // Staff activate it again, the bot is added again, and the old removal is delivered once more:
      // the re-add moved the ordering guard forward, so the retried removal is ignored.
      await staffActivates(org?.id ?? '');
      await send(botAdded(CHAT, 'Alpha', T0 + 300));
      await send(botRemoved(CHAT, T0 + 100));
      expect((await orgs())[0]?.status).toBe('ACTIVE');
      // A newer removal still deactivates.
      await send(botRemoved(CHAT, T0 + 400));
      expect((await orgs())[0]?.status).toBe('INACTIVE');
    });

    it('follows a group title change and audits it; the same title writes nothing', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      const rename = (title: string) => send(groupMessage(CHAT, alice, { new_chat_title: title }));
      await rename('Alpha Trade LLC');
      await rename('Alpha Trade LLC');
      expect((await orgs())[0]?.name).toBe('Alpha Trade LLC');
      const log = await audit();
      const renamed = log.filter((row) => row.action === 'TELEGRAM_ORGANIZATION_RENAMED');
      expect(renamed).toHaveLength(1);
      expect(renamed[0]?.diff).toEqual({ name: { from: 'Alpha', to: 'Alpha Trade LLC' } });
      expect(renamed[0]?.actorUserId).toBeNull();
    });

    it('ignores private chats and channels, and titles of unknown groups', async () => {
      await send({
        update_id: 1,
        my_chat_member: {
          chat: { id: 555, type: 'private' },
          date: T0,
          new_chat_member: { status: 'kicked', user: BOT },
        },
      });
      await send({
        update_id: 2,
        my_chat_member: {
          chat: { id: -1009, type: 'channel', title: 'News' },
          date: T0,
          new_chat_member: { status: 'member', user: BOT },
        },
      });
      await send(groupMessage(-1005, alice, { new_chat_title: 'Nobody knows me' }));
      expect(await orgs()).toHaveLength(0);
      expect(await audit()).toHaveLength(0);
    });

    it('moves the organization to the new chat id when the group becomes a supergroup', async () => {
      await send(botAdded(-4242, 'Old group'));
      await send({
        update_id: 9,
        message: {
          date: T0 + 5,
          chat: { id: -4242, type: 'group', title: 'Old group' },
          migrate_to_chat_id: CHAT,
        },
      });
      const rows = await orgs();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.telegramChatId).toBe(BigInt(CHAT));
      expect(await actions()).toContain('TELEGRAM_ORGANIZATION_CHAT_MIGRATED');
    });
  });

  describe('group members', () => {
    async function groupWithBot() {
      await send(botAdded(CHAT, 'Alpha'));
      const [org] = await orgs();
      if (!org) throw new Error('no organization');
      // The bot creates it INACTIVE; staff have activated it.
      return staffActivates(org.id);
    }

    it('gives strangers nothing while the organization is still INACTIVE (no user, no membership)', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      const [org] = await orgs();
      expect(org?.status).toBe('INACTIVE');
      await send(memberChange(CHAT, bob, 'member'));
      await send(groupMessage(CHAT, bob, { text: 'hello' }));
      await send(groupMessage(CHAT, bob, { text: '/price' }, T0 + 30));
      await send(groupMessage(CHAT, alice, { new_chat_members: [bob] }, T0 + 40));
      expect(await t.prisma.user.count()).toBe(0);
      expect(await t.prisma.organizationMember.count()).toBe(0);
      expect(await actions()).toEqual(['TELEGRAM_ORGANIZATION_CREATED']);
      // The price command answers the group, but without a link.
      expect(sender.sent.every((m) => !m.text.includes('http'))).toBe(true);
    });

    it('joins people only after staff activate the organization, on their next signal', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      const [org] = await orgs();
      await send(memberChange(CHAT, bob, 'member', T0 + 10));
      expect(await membersOf(org?.id ?? '')).toHaveLength(0);
      await staffActivates(org?.id ?? '');
      // Nobody is back-filled: bob appears when he writes or joins again.
      expect(await membersOf(org?.id ?? '')).toHaveLength(0);
      await send(groupMessage(CHAT, bob, { text: 'hello' }, T0 + 60));
      expect(await membersOf(org?.id ?? '')).toHaveLength(1);
    });

    it('records a person who joins: a users row, an ACTIVE SELLER membership, audited', async () => {
      const org = await groupWithBot();
      await send(memberChange(CHAT, alice, 'member'));
      const members = await membersOf(org.id);
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ role: 'SELLER', status: 'ACTIVE' });
      expect(members[0]?.user).toMatchObject({
        telegramUserId: BigInt(alice.id),
        fullName: 'Alice K',
        language: 'RU',
      });
      expect(await actions()).toEqual([
        'TELEGRAM_ORGANIZATION_CREATED',
        'TELEGRAM_USER_CREATED',
        'TELEGRAM_MEMBER_JOINED',
      ]);
      expect((await audit()).every((row) => row.actorUserId === null)).toBe(true);
    });

    it('is idempotent for duplicate and concurrent join updates', async () => {
      const org = await groupWithBot();
      await Promise.all(Array.from({ length: 5 }, () => send(memberChange(CHAT, alice, 'member'))));
      expect(await membersOf(org.id)).toHaveLength(1);
      expect(await t.prisma.user.count()).toBe(1);
      const joined = (await actions()).filter((action) => action === 'TELEGRAM_MEMBER_JOINED');
      expect(joined).toHaveLength(1);
    });

    it('treats the new_chat_members service message and a group message as the same signal', async () => {
      const org = await groupWithBot();
      await send(groupMessage(CHAT, alice, { new_chat_members: [bob] }));
      await send(groupMessage(CHAT, alice, { text: 'hello everyone' }));
      const members = await membersOf(org.id);
      expect(members.map((m) => m.user.telegramUserId).sort()).toEqual(
        [BigInt(alice.id), BigInt(bob.id)].sort(),
      );
      expect(members.every((m) => m.status === 'ACTIVE')).toBe(true);
    });

    it('marks a member LEFT when they leave or are removed, and again ACTIVE when they come back', async () => {
      const org = await groupWithBot();
      await send(memberChange(CHAT, alice, 'member', T0 + 10));
      await send(memberChange(CHAT, alice, 'left', T0 + 20));
      await send(memberChange(CHAT, alice, 'left', T0 + 20));
      let [member] = await membersOf(org.id);
      expect(member).toMatchObject({ status: 'LEFT' });
      expect(member?.leftAt).toEqual(new Date((T0 + 20) * 1000));

      await send(memberChange(CHAT, alice, 'member', T0 + 30));
      [member] = await membersOf(org.id);
      expect(member).toMatchObject({ status: 'ACTIVE', leftAt: null });

      await send(groupMessage(CHAT, bob, { new_chat_members: [alice] }, T0 + 40));
      await send(groupMessage(CHAT, bob, { left_chat_member: alice }, T0 + 50));
      [member] = await membersOf(org.id);
      expect(member?.status).toBe('LEFT');
      const left = (await actions()).filter((a) => a === 'TELEGRAM_MEMBER_LEFT');
      expect(left.length).toBe(2);
    });

    it('ignores join and leave events that arrive out of order', async () => {
      const org = await groupWithBot();
      await send(memberChange(CHAT, alice, 'member', T0 + 10));
      await send(memberChange(CHAT, alice, 'left', T0 + 30));
      // The join of T0+10 is delivered again after the leave of T0+30.
      await send(memberChange(CHAT, alice, 'member', T0 + 10));
      expect((await membersOf(org.id))[0]?.status).toBe('LEFT');
      await send(memberChange(CHAT, alice, 'member', T0 + 40));
      // A leave older than the re-join must not undo it.
      await send(memberChange(CHAT, alice, 'left', T0 + 30));
      expect((await membersOf(org.id))[0]?.status).toBe('ACTIVE');
    });

    it('ignores staff in the group: no membership, no user changes', async () => {
      const org = await groupWithBot();
      const manager = await makeUser(t.prisma, { name: 'Manager', staff: ['MANAGER'] });
      const staffTelegram = Number(manager.telegramUserId);
      const staffUser = { id: staffTelegram, is_bot: false, first_name: 'Someone Else' };
      await send(memberChange(CHAT, staffUser, 'member'));
      await send(groupMessage(CHAT, staffUser, { text: '/price' }));
      expect(await membersOf(org.id)).toHaveLength(0);
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: manager.id } });
      expect(user.fullName).toBe('Manager');
      expect(await t.prisma.user.count()).toBe(1);
      expect(await actions()).toEqual(['TELEGRAM_ORGANIZATION_CREATED']);
    });

    it('keeps a person in their first organization and reports a typed conflict for the second', async () => {
      const first = await groupWithBot();
      await send(memberChange(CHAT, alice, 'member'));
      const SECOND_CHAT = -1009876543210;
      await send(botAdded(SECOND_CHAT, 'Beta'));
      const second = (await orgs()).find((o) => o.id !== first.id);
      if (!second) throw new Error('no second organization');
      await staffActivates(second.id);
      const noticesBefore = (await outbox()).length;

      await send(memberChange(SECOND_CHAT, alice, 'member'));
      expect(await membersOf(second.id)).toHaveLength(0);
      expect((await membersOf(first.id))[0]).toMatchObject({ status: 'ACTIVE' });

      // Staff are told (managers and admins), once, however often the person writes again.
      await send(groupMessage(SECOND_CHAT, alice, { text: 'hi again' }, T0 + 30));
      const notices = (await outbox()).slice(noticesBefore);
      expect(notices.map((n) => [n.type, n.recipientRole]).sort()).toEqual([
        ['MEMBERSHIP_CONFLICT', 'ADMIN'],
        ['MEMBERSHIP_CONFLICT', 'MANAGER'],
      ]);
      expect(notices[0]?.payload).toEqual({
        personName: 'Alice K',
        telegramUserId: String(alice.id),
        organizationName: 'Beta',
      });
      expect((await actions()).filter((a) => a === 'TELEGRAM_MEMBER_CONFLICT')).toHaveLength(1);

      const result = await t.get(OrganizationsService).recordTelegramMemberPresent({
        chatId: BigInt(SECOND_CHAT),
        telegramUserId: BigInt(alice.id),
        fullName: 'Alice K',
        language: 'RU',
        eventAt: new Date((T0 + 60) * 1000),
      });
      expect(result).toEqual({ kind: 'CONFLICT', reason: 'ALREADY_MEMBER_ELSEWHERE' });
      expect((await actions()).filter((a) => a === 'TELEGRAM_MEMBER_JOINED')).toHaveLength(1);
    });

    it('lets two groups race for the same person: exactly one membership wins', async () => {
      await groupWithBot();
      const SECOND_CHAT = -1009876543210;
      await send(botAdded(SECOND_CHAT, 'Beta'));
      for (const org of await orgs()) await staffActivates(org.id);
      await Promise.all([
        send(memberChange(CHAT, alice, 'member')),
        send(memberChange(SECOND_CHAT, alice, 'member')),
      ]);
      const active = await t.prisma.organizationMember.count({ where: { status: 'ACTIVE' } });
      expect(active).toBe(1);
    });

    it('ignores members of a group that is not an organization and of an INACTIVE one', async () => {
      await send(memberChange(-1005, alice, 'member'));
      expect(await t.prisma.user.count()).toBe(0);
      const org = await groupWithBot();
      await send(botRemoved(CHAT));
      await send(memberChange(CHAT, bob, 'member', T0 + 500));
      expect(await membersOf(org.id)).toHaveLength(0);
    });

    it('never touches memberships created by staff in another way', async () => {
      const org = await makeOrganization(t.prisma, { name: 'Manual' });
      const person = await makeUser(t.prisma, { telegramUserId: BigInt(alice.id) });
      await makeMember(t.prisma, org.id, person.id, 'SHOP_OWNER');
      const chat = await t.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
      await send(memberChange(Number(chat.telegramChatId), alice, 'member'));
      expect((await membersOf(org.id))[0]).toMatchObject({ role: 'SHOP_OWNER', status: 'ACTIVE' });
    });
  });

  describe('commands', () => {
    const command = (chat: number, from: object, text: string, type = 'private') => ({
      update_id: 5,
      message: { date: T0 + 70, chat: { id: chat, type }, from, text },
    });

    // A private /start asks the language first, then explains the commands [C, owner 2026-11-13].
    const press = (from: { id: number }, data: string) => ({
      update_id: 6,
      callback_query: {
        id: 'cb-1',
        from,
        message: { message_id: 77, chat: { id: from.id, type: 'private' } },
        data,
      },
    });

    it('/start asks the language with three buttons and writes nothing', async () => {
      await send(command(alice.id, alice, '/start'));
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]?.chatId).toBe(String(alice.id));
      expect(sender.sent[0]?.text).toBe('Tilni tanlang\nВыберите язык\nChoose a language');
      expect(sender.sent[0]?.options?.buttons?.map((b) => b.text)).toEqual([
        "🇺🇿 O'zbekcha",
        '🇷🇺 Русский',
        '🇺🇸 English',
      ]);
      expect(await audit()).toEqual([]);
    });

    it('a press saves the language of a known person once, audited, and explains the commands', async () => {
      const person = await makeUser(t.prisma, { telegramUserId: BigInt(alice.id) });
      await send(press(alice, 'lang:en'));
      expect(sender.answeredCallbacks).toEqual(['cb-1']);
      expect(sender.clearedButtons).toEqual([{ chatId: String(alice.id), messageId: 77 }]);
      expect(sender.sent[0]?.text).toContain('Commands:');
      expect(sender.sent[0]?.text).toContain('https://app.example.uz/');
      const stored = await t.prisma.user.findUniqueOrThrow({ where: { id: person.id } });
      expect(stored.language).toBe('EN');
      expect(stored.botStartedAt).not.toBeNull();
      const rows = (await audit()).filter((row) => row.action === 'USER_LANGUAGE_CHANGED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: person.id,
        entityId: person.id,
        diff: { language: { from: 'UZ', to: 'EN' } },
      });
      // The same choice again changes nothing and writes no second row.
      await send(press(alice, 'lang:en'));
      expect((await audit()).filter((row) => row.action === 'USER_LANGUAGE_CHANGED')).toHaveLength(
        1,
      );
    });

    it('a press of a stranger creates nobody and answers in the chosen language', async () => {
      await send(press(alice, 'lang:ru'));
      expect(await t.prisma.user.count()).toBe(0);
      expect(sender.sent[0]?.text).toContain('Команды:');
    });

    async function parsedDocument(index: number): Promise<ExcelJS.Worksheet> {
      const data = sender.documents[index]?.file.data;
      if (!data) throw new Error('no document sent');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new Error('no sheet');
      return sheet;
    }

    async function bobIsMember(): Promise<void> {
      const org = await makeOrganization(t.prisma);
      const person = await makeUser(t.prisma, { telegramUserId: BigInt(bob.id) });
      await makeMember(t.prisma, org.id, person.id);
    }

    it('/price refuses a stranger and sends the published list to a member of an ACTIVE organization', async () => {
      const p1 = await makeProduct(t.prisma, { code: 'A-1', names: { UZ: 'Kabel' } });
      await publishPriceList(t.get(PricingService), { [p1]: '12500.00' }, t.prisma, 'USD');
      await send(command(alice.id, alice, '/price'));
      expect(sender.documents).toHaveLength(0);
      expect(sender.sent[0]?.text).not.toContain('http');

      await bobIsMember();
      await send(command(bob.id, bob, '/price'));
      expect(sender.documents).toHaveLength(1);
      // The owner's layout (2026-10-28): no brand in "Kabel", so the last sheet; data from row 3.
      const sheet = await parsedDocument(0);
      expect(sheet.name).toBe('Boshqa');
      expect(sheet.getCell('B3').value).toBe('A-1');
      expect(sheet.getCell('D3').value).toBe('Kabel');
      expect(sheet.getCell('F3').value).toBe(12500);
    });

    it('/price never exports a draft, and says so when nothing is published', async () => {
      await bobIsMember();
      const p1 = await makeProduct(t.prisma, { code: 'A-1', names: { UZ: 'Kabel' } });
      const pricing = t.get(PricingService);
      const manager = staffActor('price-fixture-manager', 'MANAGER');
      const { draft } = await pricing.createDraft(manager, { copyFromCurrent: false, note: null });
      await pricing.upsertDraftItems(manager, draft.id, {
        items: [
          {
            productId: p1,
            basePrice: new Prisma.Decimal('999.00'),
            deferredPrice: null,
            rrp: null,
          },
        ],
      });
      await send(command(bob.id, bob, '/price'));
      expect(sender.documents).toHaveLength(0);
      expect(sender.sent[0]?.text).toContain("e'lon qilinmagan");
    });

    it('/price in a group answers only for an ACTIVE organization', async () => {
      const p1 = await makeProduct(t.prisma, { code: 'A-1', names: { UZ: 'Kabel' } });
      await publishPriceList(t.get(PricingService), { [p1]: '12500.00' }, t.prisma, 'USD');
      await send(botAdded(CHAT, 'Alpha'));
      const [org] = await orgs();
      const person = await makeUser(t.prisma, { telegramUserId: BigInt(bob.id) });
      await makeMember(t.prisma, org?.id ?? '', person.id);
      await send(command(CHAT, bob, '/price', 'supergroup'));
      expect(sender.documents).toHaveLength(0);
      expect(sender.sent[0]?.text).toContain("a'zolari");

      await staffActivates(org?.id ?? '');
      await send(command(CHAT, bob, '/price', 'supergroup'));
      expect(sender.documents).toHaveLength(1);
      expect(sender.documents[0]?.chatId).toBe(String(CHAT));
    });

    it('answers a group command in the group and counts it as a presence signal', async () => {
      await send(botAdded(CHAT, 'Alpha'));
      await staffActivates((await orgs())[0]?.id ?? '');
      await send(command(CHAT, alice, '/help', 'supergroup'));
      expect(sender.sent[0]?.chatId).toBe(String(CHAT));
      const [org] = await orgs();
      expect(await membersOf(org?.id ?? '')).toHaveLength(1);
    });

    it('does not fail the webhook when Telegram refuses the reply', async () => {
      sender.failFor(String(alice.id), { failure: 'RECIPIENT_UNREACHABLE' });
      const response = await hook(command(alice.id, alice, '/start'));
      expect(response.status).toBe(200);
    });

    it('limits repeated commands per chat', async () => {
      for (let i = 0; i < 12; i += 1) await send(command(bob.id, bob, '/help'));
      expect(sender.sent.length).toBeLessThan(12);
      expect(sender.sent.length).toBeGreaterThan(0);
    });
  });
});
