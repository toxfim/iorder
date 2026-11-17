import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { NotificationsModule } from '../src/modules/notifications/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { OrganizationsService } from '../src/modules/organizations/index.js';
import { BotIdentity } from '../src/modules/telegram/bot-identity.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { TelegramModule, TelegramSender } from '../src/modules/telegram/index.js';
import { createWorld, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// [C, owner 2026-11-13] "deleting" an organization = archiving it (admin only, never a hard
// delete); the [P] parts: bot events never revive it, restore leaves it INACTIVE, repeats are
// no-ops. Real PostgreSQL, a recording fake Telegram (nothing reaches the network).
const SECRET = 'integration-secret_0123456789';
const BOT_USERNAME = 'iorder_test_bot';
const FAKE_TOKEN = '123456:FAKE-TOKEN-FOR-TESTS-ONLY';
const T0 = 1_790_000_000;
const ali = { id: 7_300_000_101, is_bot: false, first_name: 'Ali' };
const bob = { id: 7_300_000_102, is_bot: false, first_name: 'Bob' };
const BOT = { id: 999, is_bot: true, first_name: 'iOrder' };

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

describe('organization archive (real PostgreSQL, fake Telegram)', () => {
  let t: TestApp;
  let w: World;
  let sender: FakeTelegramSender;
  let update = 5000;
  let tick = 0;

  beforeAll(async () => {
    sender = new FakeTelegramSender();
    t = await createTestApp([OrdersModule, NotificationsModule, TelegramModule], {
      env: {
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        BOT_TOKEN: FAKE_TOKEN,
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
    w = await createWorld(t);
    // The bot's command rate limiter reads this clock: a new minute per test.
    tick += 1;
    t.clock.set(new Date(t.clock.now().getTime() + tick * 60_000));
    sender.sent.length = 0;
  });

  const call = async (
    method: string,
    path: string,
    actor: Actor,
    body?: unknown,
  ): Promise<{ status: number; body: Body }> => {
    const r = await t.request(method, path, { actor, body });
    return { status: r.status, body: (r.body ?? {}) as Body };
  };
  const hook = async (body: unknown): Promise<void> => {
    const r = await t.request('POST', `/telegram/webhook/${SECRET}`, {
      body,
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
    });
    expect(r.status).toBe(200);
  };
  const botAdded = (chat: number, date: number) => ({
    update_id: (update += 1),
    my_chat_member: {
      chat: { id: chat, type: 'supergroup', title: 'Some chat' },
      from: ali,
      date,
      new_chat_member: { status: 'member', user: BOT },
    },
  });
  const archive = (id: string, actor: Actor = w.actors.admin) =>
    call('POST', `/staff/organizations/${id}/archive`, actor);
  const restore = (id: string, actor: Actor = w.actors.admin) =>
    call('POST', `/staff/organizations/${id}/restore`, actor);
  const listIds = async (query = ''): Promise<string[]> => {
    const r = await call('GET', `/staff/organizations${query}`, w.actors.manager);
    expect(r.status).toBe(200);
    return (r.body.items as Body[]).map((o) => o.id as string);
  };
  const auditActions = async (id: string): Promise<string[]> =>
    (
      await t.prisma.auditLog.findMany({
        where: { entityId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map((row) => row.action);

  const auditOf = async (id: string, action: string): Promise<Body> =>
    (await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action } })) as Body;
  // The press of a language button after a private /start [C, owner 2026-11-13]: it carries the
  // payload, and the binding runs then.
  const privateStart = (from: { id: number }, payload: string) => ({
    update_id: (update += 1),
    callback_query: {
      id: `cb-${update}`,
      from,
      message: { message_id: update, chat: { id: from.id, type: 'private' } },
      data: `lang:uz:${payload}`,
    },
  });
  const groupStart = (chat: number, payload: string, date: number) => ({
    update_id: (update += 1),
    message: {
      date,
      chat: { id: chat, type: 'supergroup', title: 'Some chat' },
      from: ali,
      text: `/start@${BOT_USERNAME} ${payload}`,
    },
  });
  const createOrg = async (type: 'GROUP' | 'PERSON', name: string): Promise<[string, string]> => {
    const r = await call('POST', '/staff/organizations', w.actors.manager, { type, name });
    expect(r.status).toBe(201);
    const url = new URL(r.body.invite.url as string);
    const payload = url.searchParams.get(type === 'PERSON' ? 'start' : 'startgroup') ?? '';
    return [r.body.organization.id as string, payload];
  };
  const chatOf = async (id: string): Promise<bigint | null> =>
    (await t.prisma.organization.findUniqueOrThrow({ where: { id } })).telegramChatId;

  it('the admin archives: INACTIVE, members LEFT, chat released, invite revoked, out of the default list, audited', async () => {
    const [pendingId] = await createOrg('PERSON', 'Archive me');
    const r = await archive(pendingId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: pendingId, status: 'INACTIVE', typeChangeable: false });
    expect(r.body.archivedAt).toBe(t.clock.now().toISOString());
    expect(r.body.invite.status).not.toBe('PENDING');
    expect(
      await t.prisma.organizationInvite.count({
        where: { organizationId: pendingId, revokedAt: null, usedAt: null },
      }),
    ).toBe(0);
    // Already INACTIVE: the audit row records only what really changed.
    const pendingAudit = await auditOf(pendingId, 'ORGANIZATION_ARCHIVED');
    expect(pendingAudit.diff).not.toHaveProperty('status');
    expect(pendingAudit.diff).toMatchObject({
      archivedByUserId: { from: null, to: w.ids.admin },
      revokedInviteCount: { from: null, to: 1 },
    });

    // An ACTIVE one with members and an order.
    const order = await submitOrder(w, w.actors.sellerA);
    const chat = await chatOf(w.orgA);
    const archived = await archive(w.orgA);
    expect(archived.body).toMatchObject({ status: 'INACTIVE', telegramChatId: null });
    const members = await t.prisma.organizationMember.findMany({
      where: { organizationId: w.orgA },
    });
    expect(members).toHaveLength(3);
    expect(members.every((m) => m.status === 'LEFT' && m.leftAt !== null)).toBe(true);
    expect(await chatOf(w.orgA)).toBeNull();
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'SUBMITTED',
    );
    const audit = await auditOf(w.orgA, 'ORGANIZATION_ARCHIVED');
    expect(audit.actorUserId).toBe(w.ids.admin);
    expect(audit.diff).toMatchObject({
      status: { from: 'ACTIVE', to: 'INACTIVE' },
      telegramChatId: { from: chat?.toString(), to: null },
      [`members.${w.ids.ownerA}.status`]: { from: 'ACTIVE', to: 'LEFT' },
      [`members.${w.ids.sellerA}.status`]: { from: 'ACTIVE', to: 'LEFT' },
      [`members.${w.ids.sellerA2}.status`]: { from: 'ACTIVE', to: 'LEFT' },
      archivedByUserId: { from: null, to: w.ids.admin },
    });

    const defaults = await listIds();
    expect(defaults).not.toContain(pendingId);
    expect(defaults).not.toContain(w.orgA);
    expect(defaults).toContain(w.orgB);
    expect(await listIds('?archived=false')).toEqual(defaults);
    expect((await listIds('?archived=true')).sort()).toEqual([pendingId, w.orgA].sort());

    // The detail still answers, with archivedAt and the member history.
    const detail = await call('GET', `/staff/organizations/${w.orgA}`, w.actors.manager);
    expect(detail.status).toBe(200);
    expect(detail.body.archivedAt).not.toBeNull();
    expect(detail.body.members).toHaveLength(3);

    await expect(submitOrder(w, w.actors.sellerA)).rejects.toMatchObject({
      reason: 'ORDERING_ORGANIZATION_INACTIVE',
    });
    expect(await t.get(OrganizationsService).countAwaitingActivation(w.actors.manager)).toBe(0);
  });

  it('archive and restore are the admin alone: manager and purchasing manager get 403', async () => {
    const purchasing: Actor = { userId: w.ids.manager, staffRoles: ['PURCHASING_MANAGER'] };
    for (const actor of [w.actors.manager, purchasing, w.actors.accountant, w.actors.sellerA]) {
      expect((await archive(w.orgA, actor)).status).toBe(403);
    }
    expect((await archive(w.orgA)).status).toBe(200);
    for (const actor of [w.actors.manager, purchasing]) {
      expect((await restore(w.orgA, actor)).status).toBe(403);
    }
    expect(
      (await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } })).archivedAt,
    ).not.toBeNull();
  });

  it('every other write on an archived organization is 409 ORGANIZATION_ARCHIVED', async () => {
    const [pendingId] = await createOrg('GROUP', 'Pending group');
    await archive(w.orgA);
    await archive(pendingId);
    const base = `/staff/organizations/${w.orgA}`;
    const writes: [string, string, Actor, unknown?][] = [
      ['PATCH', base, w.actors.manager, { name: 'New name' }],
      ['PATCH', base, w.actors.manager, { status: 'ACTIVE' }],
      ['PATCH', base, w.actors.manager, { pricePostingEnabled: true }],
      ['PATCH', base, w.actors.manager, { phone: '+998901112233' }],
      ['PATCH', base, w.actors.admin, { label: 'WHOLESALE' }],
      ['PATCH', `/staff/organizations/${pendingId}`, w.actors.manager, { type: 'PERSON' }],
      ['DELETE', `${base}/shop-owner`, w.actors.manager],
      ['PUT', `${base}/shop-owner`, w.actors.manager, { userId: w.ids.sellerA }],
      ['PATCH', `${base}/members/${w.ids.sellerA}`, w.actors.manager, { role: 'SHOP_OWNER' }],
      ['POST', `${base}/members/${w.ids.sellerA}/leave`, w.actors.manager],
      ['POST', `/staff/organizations/${pendingId}/invite`, w.actors.manager],
    ];
    for (const [method, path, actor, body] of writes) {
      const r = await call(method, path, actor, body);
      expect({ method, path, status: r.status, reason: r.body.error?.reason }).toEqual({
        method,
        path,
        status: 409,
        reason: 'ORGANIZATION_ARCHIVED',
      });
    }
    const row = await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } });
    expect(row).toMatchObject({
      status: 'INACTIVE',
      label: 'STANDARD',
      pricePostingEnabled: false,
    });
    expect(await auditActions(w.orgA)).toEqual(['ORGANIZATION_ARCHIVED']);
  });

  it('the person of an archived PERSON organization can be bound to a new one (refused before the archive)', async () => {
    const [first, firstPayload] = await createOrg('PERSON', 'Ali first');
    await hook(privateStart(ali, firstPayload));
    expect(await t.prisma.organization.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      status: 'ACTIVE',
      telegramChatId: BigInt(ali.id),
    });

    // Control: while the first one holds Ali and his chat, the second link does not bind.
    const [second, secondPayload] = await createOrg('PERSON', 'Ali second');
    await hook(privateStart(ali, secondPayload));
    expect(await chatOf(second)).toBeNull();

    expect((await archive(first)).status).toBe(200);
    expect(await chatOf(first)).toBeNull();
    await hook(privateStart(ali, secondPayload));
    expect(await t.prisma.organization.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
      status: 'ACTIVE',
      telegramChatId: BigInt(ali.id),
    });
    const memberships = await t.prisma.organizationMember.findMany({
      where: { organizationId: { in: [first, second] } },
    });
    expect(memberships.map((m) => [m.organizationId, m.role, m.status]).sort()).toEqual(
      [
        [first, 'SHOP_OWNER', 'LEFT'],
        [second, 'SHOP_OWNER', 'ACTIVE'],
      ].sort(),
    );
  });

  it('the released chat is an unknown group to the bot: a new waiting organization, the archived one untouched', async () => {
    const chat = Number(await chatOf(w.orgA));
    // Control: before the archive the bot re-added to the chat finds orgA and creates nothing.
    await hook(botAdded(chat, T0 + 10));
    expect(await t.prisma.organization.count({ where: { telegramChatId: BigInt(chat) } })).toBe(1);
    expect(await chatOf(w.orgA)).toBe(BigInt(chat));

    await archive(w.orgA);
    await hook(botAdded(chat, T0 + 20));
    await hook({
      update_id: (update += 1),
      message: {
        date: T0 + 30,
        chat: { id: chat, type: 'supergroup', title: 'x' },
        from: bob,
        new_chat_members: [bob],
      },
    });
    const fresh = await t.prisma.organization.findUniqueOrThrow({
      where: { telegramChatId: BigInt(chat) },
    });
    expect(fresh.id).not.toBe(w.orgA);
    expect(fresh).toMatchObject({ status: 'INACTIVE', archivedAt: null });
    const archivedRow = await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } });
    expect(archivedRow).toMatchObject({ status: 'INACTIVE', telegramChatId: null });
    expect(archivedRow.archivedAt).not.toBeNull();
    expect(
      await t.prisma.organizationMember.count({
        where: { organizationId: w.orgA, status: 'ACTIVE' },
      }),
    ).toBe(0);
  });

  it("an archived organization's invite link no longer binds (the same flow binds a live one)", async () => {
    const [live, livePayload] = await createOrg('GROUP', 'Live group');
    const [gone, gonePayload] = await createOrg('GROUP', 'Archived group');
    const liveChat = -1009000000701;
    const goneChat = -1009000000702;
    await hook(botAdded(liveChat, T0 + 1));
    await hook(groupStart(liveChat, livePayload, T0 + 2));
    expect(await t.prisma.organization.findUniqueOrThrow({ where: { id: live } })).toMatchObject({
      status: 'ACTIVE',
      telegramChatId: BigInt(liveChat),
    });

    await archive(gone);
    await hook(botAdded(goneChat, T0 + 3));
    await hook(groupStart(goneChat, gonePayload, T0 + 4));
    expect(await t.prisma.organization.findUniqueOrThrow({ where: { id: gone } })).toMatchObject({
      status: 'INACTIVE',
      telegramChatId: null,
    });
    // The group the bot registered keeps its chat: nothing was retired into the archived one.
    expect(
      await t.prisma.organization.findUniqueOrThrow({
        where: { telegramChatId: BigInt(goneChat) },
      }),
    ).toMatchObject({ mergedIntoOrganizationId: null, status: 'INACTIVE' });
  });

  it('repeats are no-ops; restore brings it back unlinked and INACTIVE, and a new invite binds it', async () => {
    expect((await restore(w.orgA)).status).toBe(200);
    expect(await auditActions(w.orgA)).toEqual([]);

    const first = await archive(w.orgA);
    t.clock.set(new Date(t.clock.now().getTime() + 60_000));
    const again = await archive(w.orgA);
    expect(again.status).toBe(200);
    expect(again.body.archivedAt).toBe(first.body.archivedAt);
    expect(await auditActions(w.orgA)).toEqual(['ORGANIZATION_ARCHIVED']);

    const restored = await restore(w.orgA);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      archivedAt: null,
      status: 'INACTIVE',
      telegramChatId: null,
      // It has member history: the type stays as it is.
      typeChangeable: false,
    });
    const row = await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } });
    expect(row).toMatchObject({ archivedAt: null, archivedByUserId: null, status: 'INACTIVE' });
    expect(await auditActions(w.orgA)).toEqual(['ORGANIZATION_ARCHIVED', 'ORGANIZATION_RESTORED']);
    expect((await auditOf(w.orgA, 'ORGANIZATION_RESTORED')).diff).toMatchObject({
      archivedAt: { from: first.body.archivedAt, to: null },
      archivedByUserId: { from: w.ids.admin, to: null },
    });
    expect(await listIds()).toContain(w.orgA);

    // Unlinked: activation by hand is refused, a new invite link binds it again.
    const activate = await call('PATCH', `/staff/organizations/${w.orgA}`, w.actors.manager, {
      status: 'ACTIVE',
    });
    expect(activate.body.error?.reason).toBe('ORGANIZATION_NOT_LINKED');
    const invite = await call('POST', `/staff/organizations/${w.orgA}/invite`, w.actors.manager);
    expect(invite.status).toBe(200);
    const payload = new URL(invite.body.url as string).searchParams.get('startgroup') ?? '';
    const newChat = -1009000000703;
    // No bot-registered row first: the fixture's orgA carries a database created_at later than the
    // fake clock, so a fresh registration would not count as newer and would not be retired.
    await hook(groupStart(newChat, payload, T0 + 6));
    expect(await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } })).toMatchObject({
      status: 'ACTIVE',
      telegramChatId: BigInt(newChat),
    });
  });

  it('the database refuses an archived ACTIVE organization and a half-set archive', async () => {
    await expect(
      t.prisma.organization.update({
        where: { id: w.orgB },
        data: { archivedAt: new Date(), archivedByUserId: w.ids.admin },
      }),
    ).rejects.toThrow(/organizations_archived_is_inactive/);
    await expect(
      t.prisma.organization.update({
        where: { id: w.orgB },
        data: { status: 'INACTIVE', archivedAt: new Date() },
      }),
    ).rejects.toThrow(/organizations_archived_pair/);
  });
});
