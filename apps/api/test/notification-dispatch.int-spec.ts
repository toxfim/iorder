import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/common/database/prisma.service.js';
import {
  BATCH_TIME_BUDGET_SECONDS,
  CLAIM_LEASE_SECONDS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
} from '../src/modules/notifications/delivery-policy.js';
import { IdentityService, StaffBotLinkService } from '../src/modules/identity/index.js';
import { OrganizationsService } from '../src/modules/organizations/index.js';
import { NotificationsModule, OutboxDispatcher } from '../src/modules/notifications/index.js';
import { OutboxRepository } from '../src/modules/notifications/outbox.repository.js';
import { OrdersModule, OrdersService } from '../src/modules/orders/index.js';
import { PriceListExportService } from '../src/modules/pricing/index.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { TelegramSender, WebLinks } from '../src/modules/telegram/index.js';
import { makeOrganization, makeUser } from './support/identity-fixtures.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { APP_ROLE_NAME, getRestrictedRoleUrl } from './support/test-env.js';

// The outbox dispatcher against a real PostgreSQL and a recording fake Telegram. Nothing here
// reaches the network; the token is not a real one.
const BASE_URL = 'https://app.example.uz';

type OutboxInput = {
  type?: string;
  kind: 'USER' | 'ROLE' | 'ORGANIZATION_CHAT';
  userId?: string;
  role?: string;
  organizationId?: string;
  orderId?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: Date;
};

describe('outbox dispatcher (real PostgreSQL, fake Telegram)', () => {
  let t: TestApp;
  let w: World;
  let sender: FakeTelegramSender;
  let dispatcher: OutboxDispatcher;
  let repository: OutboxRepository;
  let counter = 0;

  beforeAll(async () => {
    sender = new FakeTelegramSender();
    t = await createTestApp([OrdersModule, NotificationsModule], {
      env: { BOT_TOKEN: '123456:FAKE-TOKEN-FOR-TESTS-ONLY', WEB_APP_URL: BASE_URL },
      overrides: [{ token: TelegramSender, value: sender }],
    });
    await t.prisma.$connect();
    dispatcher = t.get(OutboxDispatcher);
    repository = t.get(OutboxRepository);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    sender.sent.length = 0;
    sender.attempts.length = 0;
    sender.clearFailures();
    sender.beforeSend = undefined;
    vi.restoreAllMocks();
    // createWorld resets the clock; nothing else in this file depends on the wall clock.
  });

  const advance = (seconds: number) =>
    t.clock.set(new Date(t.clock.now().getTime() + seconds * 1000));
  const chatOf = async (userId: string): Promise<string> =>
    String((await t.prisma.user.findUniqueOrThrow({ where: { id: userId } })).telegramUserId);
  const orgChat = async (organizationId: string): Promise<string> =>
    String(
      (await t.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }))
        .telegramChatId,
    );
  const rows = () => t.prisma.notificationOutbox.findMany({ orderBy: { createdAt: 'asc' } });
  const rowOf = (id: string) => t.prisma.notificationOutbox.findUniqueOrThrow({ where: { id } });

  async function insertRow(input: OutboxInput): Promise<string> {
    counter += 1;
    const row = await t.prisma.notificationOutbox.create({
      data: {
        type: input.type ?? 'ORDER_MANAGER_APPROVED',
        recipientKind: input.kind,
        recipientUserId: input.userId ?? null,
        recipientRole: input.role ?? null,
        recipientOrganizationId: input.organizationId ?? null,
        orderId: input.orderId ?? null,
        payload: (input.payload ?? {
          orderNumber: `IO-${20000 + counter}`,
          totalAmount: '1500.00',
        }) as object,
        dedupeKey: `test-${randomUUID()}`,
        createdAt: input.createdAt ?? new Date(t.clock.now().getTime() + counter),
      },
    });
    return row.id;
  }

  describe('delivery', () => {
    it('sends a submitted order to every manager, once, and marks the row SENT', async () => {
      const order = await submitOrder(w);
      const pending = await rows();
      expect(pending.map((r) => [r.type, r.recipientKind, r.recipientRole, r.status])).toEqual([
        ['ORDER_SUBMITTED', 'ROLE', 'MANAGER', 'PENDING'],
      ]);

      const summary = await dispatcher.runOnce();
      expect(summary).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0, errors: 0 });

      const managers = [await chatOf(w.ids.manager), await chatOf(w.ids.manager2)].sort();
      expect(sender.sent.map((m) => m.chatId).sort()).toEqual(managers);
      // [C] 2026-10-25: staff get the order behind two buttons (website, Mini App), not in the text.
      const staffUrl = `${BASE_URL}/staff/orders/${order.id}`;
      for (const message of sender.sent) {
        expect(message.text).toContain(order.orderNumber);
        expect(message.text).not.toContain('/staff/orders/');
        expect(message.options).toEqual({
          disableLinkPreview: true,
          buttons: [
            { text: "Veb'da ochish", url: staffUrl },
            { text: "Mini App'da ochish", webAppUrl: staffUrl },
          ],
        });
      }

      const [row] = await rows();
      expect(row).toMatchObject({
        status: 'SENT',
        attempts: 1,
        lastErrorCode: null,
        nextAttemptAt: null,
      });
      expect(row?.sentAt).toEqual(t.clock.now());
      expect([...(row?.deliveredChatIds ?? [])].sort()).toEqual(managers);

      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      expect(sender.sent).toHaveLength(2);
    });

    it('walks a whole order: customer group, driver and staff all get their own text', async () => {
      const order = await orderAt(w, 'RECEIVED');
      let guard = 0;
      while ((await t.prisma.notificationOutbox.count({ where: { status: 'PENDING' } })) > 0) {
        await dispatcher.runOnce(50);
        if ((guard += 1) > 5) throw new Error('outbox does not drain');
      }
      const all = await rows();
      expect(all.length).toBeGreaterThan(5);
      expect(all.every((r) => r.status === 'SENT')).toBe(true);

      // [C] 2026-11-09: of a whole order life the customer's group hears about the approval
      // only. The order is behind a button (no Mini App URL here: the browser one alone), the
      // text has no link, and the person who placed the order is mentioned by Telegram id.
      const toGroup = sender.messagesTo(await orgChat(w.orgA));
      expect(toGroup).toHaveLength(1);
      const placedBy = 'Buyurtmachi: Seller A';
      expect(toGroup[0]?.text).toBe(
        `Buyurtma ${order.orderNumber} menejer tomonidan tasdiqlandi.\nSumma: 3 750,50 so'm\n${placedBy}`,
      );
      expect(toGroup[0]?.text).not.toContain('http');
      expect(toGroup[0]?.options).toEqual({
        disableLinkPreview: true,
        buttons: [{ text: 'Brauzerda ochish', url: `${BASE_URL}/orders/${order.id}` }],
        mentions: [
          {
            offset: (toGroup[0]?.text.length ?? 0) - 'Seller A'.length,
            length: 'Seller A'.length,
            userId: await chatOf(w.ids.sellerA),
          },
        ],
      });
      // The placer hears in private only about a cancellation: nothing here.
      expect(sender.messagesTo(await chatOf(w.ids.sellerA))).toEqual([]);
      const driverMessages = sender.messagesTo(await chatOf(w.ids.driver));
      expect(driverMessages).toHaveLength(1);
      expect(driverMessages[0]?.options?.buttons?.[0]).toEqual({
        text: "Veb'da ochish",
        url: `${BASE_URL}/staff/orders/${order.id}`,
      });
      // "Prepare" at the approval, "ready" at the clearance ([C] 2026-10-30).
      expect(sender.messagesTo(await chatOf(w.ids.warehouse))).toHaveLength(2);
      expect(sender.messagesTo(await chatOf(w.ids.accountant))).toHaveLength(1);
    });

    it('never puts cost data into any text of a full order walk', async () => {
      await orderAt(w, 'RECEIVED');
      await dispatcher.runOnce(100);
      await dispatcher.runOnce(100);
      expect(sender.sent.length).toBeGreaterThan(5);
      for (const message of sender.sent) {
        expect(message.text).not.toMatch(
          /cost|purchase|margin|supplier|usd|себестоим|закуп|маржа|поставщик|tannarx/i,
        );
      }
    });

    it('writes the text in the language of the reader (UZ default for the group)', async () => {
      const ru = await makeUser(t.prisma, { name: 'RU manager', staff: ['ACCOUNTANT'] });
      await t.prisma.user.update({ where: { id: ru.id }, data: { language: 'RU' } });
      const en = await makeUser(t.prisma, { name: 'EN driver', staff: ['DRIVER'] });
      await t.prisma.user.update({ where: { id: en.id }, data: { language: 'EN' } });
      await insertRow({ kind: 'USER', userId: ru.id, type: 'ORDER_ACCOUNTING_CLEARED' });
      await insertRow({ kind: 'USER', userId: en.id, type: 'ORDER_RELEASED' });
      await insertRow({
        kind: 'ORGANIZATION_CHAT',
        organizationId: w.orgA,
        type: 'ORDER_RELEASED',
      });
      await dispatcher.runOnce();
      expect(sender.messagesTo(await chatOf(ru.id))[0]?.text).toContain('готов для склада');
      expect(sender.messagesTo(await chatOf(en.id))[0]?.text).toContain('assigned to you');
      expect(sender.messagesTo(await orgChat(w.orgA))[0]?.text).toContain('haydovchiga');
    });

    // Owner 2026-11-09: staff open the staff app as a Mini App. With the staff Mini App's direct
    // link the button launches THAT app on the order; a separate staff bot without a link leaves
    // only the website button (the main bot's web_app launch would sign nobody in).
    it('builds the staff Mini App button from the staff Mini App settings', async () => {
      const DIRECT = 'https://t.me/iorder_staff_bot/staff';
      const dispatcherWith = (links: WebLinks): OutboxDispatcher =>
        new OutboxDispatcher(
          repository,
          sender,
          t.get(IdentityService),
          t.get(OrganizationsService),
          t.get(OrdersService),
          links,
          t.clock,
          t.get(StaffBotLinkService),
          t.get(PriceListExportService),
        );
      const buttonsAfter = async (links: WebLinks) => {
        const order = await submitOrder(w);
        sender.sent.length = 0;
        await dispatcherWith(links).runOnce();
        const [message] = sender.messagesTo(await chatOf(w.ids.manager));
        return { order, buttons: message?.options?.buttons };
      };

      const direct = await buttonsAfter(
        new WebLinks(BASE_URL, undefined, undefined, { directLink: DIRECT }),
      );
      expect(direct.buttons).toEqual([
        { text: "Veb'da ochish", url: `${BASE_URL}/staff/orders/${direct.order.id}` },
        { text: "Mini App'da ochish", url: `${DIRECT}?startapp=order_${direct.order.id}` },
      ]);

      const staffBotWithoutLink = await buttonsAfter(
        new WebLinks(BASE_URL, undefined, undefined, { mainBotSignsStaffIn: false }),
      );
      expect(staffBotWithoutLink.buttons).toEqual([
        { text: "Veb'da ochish", url: `${BASE_URL}/staff/orders/${staffBotWithoutLink.order.id}` },
      ]);
    });

    it('does nothing and leaves the rows alone when no bot token is configured', async () => {
      const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const disabled = new OutboxDispatcher(
        repository,
        new FakeTelegramSender(false),
        t.get(IdentityService),
        t.get(OrganizationsService),
        t.get(OrdersService),
        t.get(WebLinks),
        t.clock,
        t.get(StaffBotLinkService),
        t.get(PriceListExportService),
      );
      expect(await disabled.runOnce()).toEqual({
        claimed: 0,
        sent: 0,
        retried: 0,
        failed: 0,
        errors: 0,
      });
      expect(await rowOf(id)).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: null,
      });
    });
  });

  describe('recipients that cannot be reached', () => {
    it.each([
      ['an unknown role', { kind: 'ROLE', role: 'NOT_A_ROLE' } as OutboxInput, 'NO_RECIPIENT'],
      ['a role nobody holds', { kind: 'ROLE', role: 'DRIVER' } as OutboxInput, 'NO_RECIPIENT'],
      [
        'an invalid payload',
        { kind: 'ROLE', role: 'MANAGER', payload: { nope: 1 } } as OutboxInput,
        'INVALID_PAYLOAD',
      ],
      [
        'an unknown type',
        { kind: 'ROLE', role: 'MANAGER', type: 'ORDER_SOMETHING_NEW' } as OutboxInput,
        'INVALID_PAYLOAD',
      ],
    ])('fails %s at once with a code and no retry', async (_name, input, code) => {
      if (input.role === 'DRIVER') {
        await t.prisma.userRole.deleteMany({ where: { role: 'DRIVER' } });
      }
      const id = await insertRow(input);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, failed: 1 });
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', lastErrorCode: code, attempts: 1 });
      expect(sender.sent).toHaveLength(0);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
    });

    it('does not message a blocked person or an INACTIVE organization', async () => {
      await t.prisma.user.update({ where: { id: w.ids.sellerA }, data: { status: 'BLOCKED' } });
      const blocked = await insertRow({ kind: 'USER', userId: w.ids.sellerA });
      await t.prisma.organization.update({ where: { id: w.orgB }, data: { status: 'INACTIVE' } });
      const inactive = await insertRow({ kind: 'ORGANIZATION_CHAT', organizationId: w.orgB });
      await dispatcher.runOnce();
      expect(await rowOf(blocked)).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'NO_RECIPIENT',
      });
      expect(await rowOf(inactive)).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'ORGANIZATION_INACTIVE',
      });
      expect(sender.sent).toHaveLength(0);
    });

    it('403 is final: FAILED without retries, the organization stays as it is', async () => {
      const id = await insertRow({ kind: 'ORGANIZATION_CHAT', organizationId: w.orgA });
      sender.failFor(await orgChat(w.orgA), { failure: 'RECIPIENT_UNREACHABLE' });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'RECIPIENT_UNREACHABLE',
        attempts: 1,
        nextAttemptAt: null,
      });
      advance(10 * 3600);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      expect(sender.attempts).toHaveLength(1);
      expect(
        (await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } })).status,
      ).toBe('ACTIVE');
    });

    it('a blocked person among several recipients does not stop the others', async () => {
      const id = await insertRow({ kind: 'ROLE', role: 'MANAGER' });
      const blockedChat = await chatOf(w.ids.manager);
      sender.failFor(blockedChat, { failure: 'RECIPIENT_UNREACHABLE' });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(sender.sent.map((m) => m.chatId)).toEqual([await chatOf(w.ids.manager2)]);
    });

    it('remembers that the bot no longer reaches a person, so the staff app asks to reconnect', async () => {
      await insertRow({ kind: 'ROLE', role: 'MANAGER' });
      const blocked = (id: string) =>
        t.prisma.user
          .findUniqueOrThrow({ where: { id }, select: { botBlockedAt: true } })
          .then((user) => user.botBlockedAt);
      sender.failFor(await chatOf(w.ids.manager), { failure: 'RECIPIENT_UNREACHABLE' });
      await dispatcher.runOnce();
      expect(await blocked(w.ids.manager)).toEqual(t.clock.now());
      expect(await blocked(w.ids.manager2)).toBeNull();
    });
  });

  describe('retry and backoff', () => {
    it('retries a network failure with the exponential schedule and finally succeeds', async () => {
      const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const chat = await chatOf(w.ids.manager);
      sender.failFor(chat, { failure: 'TRANSIENT', times: 2 });

      await dispatcher.runOnce();
      let row = await rowOf(id);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastErrorCode: 'SEND_FAILED' });
      expect(row.nextAttemptAt).toEqual(
        new Date(t.clock.now().getTime() + RETRY_DELAYS_SECONDS[0]! * 1000),
      );

      // Not due yet: nothing is claimed.
      advance(RETRY_DELAYS_SECONDS[0]! - 1);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });

      advance(1);
      await dispatcher.runOnce();
      row = await rowOf(id);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 2 });
      expect(row.nextAttemptAt).toEqual(
        new Date(t.clock.now().getTime() + RETRY_DELAYS_SECONDS[1]! * 1000),
      );

      advance(RETRY_DELAYS_SECONDS[1]!);
      await dispatcher.runOnce();
      row = await rowOf(id);
      expect(row).toMatchObject({
        status: 'SENT',
        attempts: 3,
        lastErrorCode: null,
        nextAttemptAt: null,
      });
      expect(sender.sent).toHaveLength(1);
    });

    it('marks the row FAILED after the last allowed attempt', async () => {
      const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
      sender.failFor(await chatOf(w.ids.manager), { failure: 'TRANSIENT' });
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1 });
        expect((await rowOf(id)).attempts).toBe(attempt);
        advance(3 * 3600);
      }
      expect(await rowOf(id)).toMatchObject({
        status: 'FAILED',
        attempts: MAX_DELIVERY_ATTEMPTS,
        lastErrorCode: 'RETRIES_EXHAUSTED',
        nextAttemptAt: null,
      });
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
    });

    it('a retry skips the people who already got the message', async () => {
      const id = await insertRow({ kind: 'ROLE', role: 'MANAGER' });
      const first = await chatOf(w.ids.manager);
      const second = await chatOf(w.ids.manager2);
      sender.failFor(second, { failure: 'TRANSIENT', times: 1 });
      await dispatcher.runOnce();
      let row = await rowOf(id);
      expect(row.status).toBe('PENDING');
      expect(row.deliveredChatIds).toEqual([first]);

      advance(RETRY_DELAYS_SECONDS[0]!);
      await dispatcher.runOnce();
      row = await rowOf(id);
      expect(row.status).toBe('SENT');
      expect([...row.deliveredChatIds].sort()).toEqual([first, second].sort());
      expect(sender.messagesTo(first)).toHaveLength(1);
      expect(sender.messagesTo(second)).toHaveLength(1);
    });
  });

  describe('rate limits (429)', () => {
    it('honours retry_after, gives the attempt back and pauses the rest of the batch', async () => {
      const a = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const b = await insertRow({ kind: 'USER', userId: w.ids.manager2 });
      const c = await insertRow({ kind: 'USER', userId: w.ids.accountant });
      sender.failFor(await chatOf(w.ids.manager), {
        failure: 'RATE_LIMITED',
        retryAfterSeconds: 42,
      });

      const summary = await dispatcher.runOnce();
      expect(summary).toMatchObject({ claimed: 3, sent: 0, retried: 3, failed: 0 });
      // Only the first send was even tried: the others were deferred without hammering Telegram.
      expect(sender.attempts).toHaveLength(1);
      for (const id of [a, b, c]) {
        const row = await rowOf(id);
        expect(row).toMatchObject({
          status: 'PENDING',
          attempts: 0,
          lastErrorCode: 'RATE_LIMITED',
        });
        expect(row.nextAttemptAt).toEqual(new Date(t.clock.now().getTime() + 42_000));
      }

      advance(41);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      advance(1);
      sender.clearFailures();
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 3, sent: 3 });
    });
  });

  describe('several dispatchers and crashes', () => {
    it('two concurrent dispatchers send every row exactly once (FOR UPDATE SKIP LOCKED)', async () => {
      const count = 40;
      for (let i = 0; i < count; i += 1) {
        await insertRow({
          kind: 'USER',
          userId: w.ids.manager,
          payload: { orderNumber: `IO-${30000 + i}`, totalAmount: '10.00' },
        });
      }
      sender.beforeSend = () => new Promise((resolve) => setTimeout(resolve, 5));
      const [one, two] = await Promise.all([dispatcher.runOnce(25), dispatcher.runOnce(25)]);
      expect((one?.claimed ?? 0) + (two?.claimed ?? 0)).toBe(count);
      expect(sender.sent).toHaveLength(count);
      expect(new Set(sender.sent.map((m) => m.text)).size).toBe(count);
      const all = await rows();
      expect(all.every((r) => r.status === 'SENT' && r.attempts === 1)).toBe(true);
    });

    it('claims in one statement: a row claimed by one dispatcher is invisible to another until the lease ends', async () => {
      const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const now = t.clock.now();
      const lease = new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000);
      const first = await repository.claimDue(now, lease, 10);
      expect(first.map((r) => r.id)).toEqual([id]);
      expect(await repository.claimDue(now, lease, 10)).toEqual([]);
      // The first worker died before sending: after the lease the row is due again, counted once more.
      const later = new Date(lease.getTime() + 1000);
      const again = await repository.claimDue(later, new Date(later.getTime() + 1000), 10);
      expect(again.map((r) => [r.id, r.attempts])).toEqual([[id, 2]]);
    });

    it('crash window: a lost database write after the send is not repeated until the lease ends, then it is (at least once)', async () => {
      const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const chat = await chatOf(w.ids.manager);
      vi.spyOn(repository, 'recordDelivered').mockRejectedValueOnce(new Error('connection lost'));

      const first = await dispatcher.runOnce();
      expect(first).toMatchObject({ claimed: 1, sent: 0, errors: 1 });
      expect(sender.messagesTo(chat)).toHaveLength(1);
      expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: 1 });

      // Inside the lease the row is untouchable: no second copy.
      advance(CLAIM_LEASE_SECONDS - 1);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      expect(sender.messagesTo(chat)).toHaveLength(1);

      // The documented trade-off: after the lease the in-doubt row is sent again, then finished.
      advance(2);
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, sent: 1 });
      expect(sender.messagesTo(chat)).toHaveLength(2);
      expect(await rowOf(id)).toMatchObject({ status: 'SENT', attempts: 2 });
    });

    it('a fault on one row does not stop the rest of the batch', async () => {
      const a = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const b = await insertRow({ kind: 'USER', userId: w.ids.manager2 });
      vi.spyOn(repository, 'markSent').mockRejectedValueOnce(new Error('connection lost'));
      const summary = await dispatcher.runOnce();
      expect(summary).toMatchObject({ claimed: 2, sent: 1, errors: 1 });
      expect((await rowOf(b)).status).toBe('SENT');
      expect((await rowOf(a)).status).toBe('PENDING');
    });
  });

  describe('staff notices (no order)', () => {
    const pendingPayload = {
      organizationName: 'Alpha Trade',
      chatId: '-1001234567890',
      addedByName: 'Alice K',
      addedByTelegramUserId: '7100000001',
    };

    it('sends an ORGANIZATION_PENDING notice to every manager and every admin, in their language', async () => {
      const ru = await makeUser(t.prisma, { name: 'RU admin', staff: ['ADMIN'] });
      await t.prisma.user.update({ where: { id: ru.id }, data: { language: 'RU' } });
      const manager = await insertRow({
        kind: 'ROLE',
        role: 'MANAGER',
        type: 'ORGANIZATION_PENDING',
        payload: pendingPayload,
      });
      const admin = await insertRow({
        kind: 'ROLE',
        role: 'ADMIN',
        type: 'ORGANIZATION_PENDING',
        payload: pendingPayload,
      });
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
      expect(await rowOf(manager)).toMatchObject({ status: 'SENT' });
      expect(await rowOf(admin)).toMatchObject({ status: 'SENT' });
      const managerText = sender.messagesTo(await chatOf(w.ids.manager))[0]?.text ?? '';
      expect(managerText).toContain('Alpha Trade');
      expect(managerText).toContain('Alice K (Telegram 7100000001)');
      expect(sender.messagesTo(await chatOf(ru.id))[0]?.text).toContain('Новая группа клиента');
      expect(sender.messagesTo(await chatOf(w.ids.admin))).toHaveLength(1);
    });

    it('fails a notice whose payload leaves the allow-list', async () => {
      const id = await insertRow({
        kind: 'ROLE',
        role: 'MANAGER',
        type: 'ORGANIZATION_PENDING',
        payload: { ...pendingPayload, phone: '+998901234567' },
      });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'INVALID_PAYLOAD' });
      expect(sender.sent).toHaveLength(0);
    });
  });

  describe('safety nets', () => {
    it('S1: a row that used its last attempt is failed, not sent again, even if the bookkeeping write keeps failing', async () => {
      const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
      const chat = await chatOf(w.ids.manager);
      vi.spyOn(repository, 'recordDelivered').mockRejectedValue(new Error('connection lost'));
      vi.spyOn(repository, 'markSent').mockRejectedValue(new Error('connection lost'));

      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, errors: 1 });
        advance(CLAIM_LEASE_SECONDS + 1);
      }
      expect(sender.messagesTo(chat)).toHaveLength(MAX_DELIVERY_ATTEMPTS);
      expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: MAX_DELIVERY_ATTEMPTS });

      // The next pass finishes the row instead of sending a seventh copy.
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
      expect(await rowOf(id)).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'RETRIES_EXHAUSTED',
        nextAttemptAt: null,
      });
      expect(sender.messagesTo(chat)).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    });

    it('S1: the restricted application role can finish an exhausted row', async () => {
      const restricted = new PrismaService({ DATABASE_URL: getRestrictedRoleUrl() });
      try {
        await restricted.$connect();
        const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
        await t.prisma.notificationOutbox.update({
          where: { id },
          data: { attempts: MAX_DELIVERY_ATTEMPTS },
        });
        const now = t.clock.now();
        const claimed = await new OutboxRepository(restricted).claimDue(
          now,
          new Date(now.getTime() + 600_000),
          10,
        );
        expect(claimed).toEqual([]);
        expect(await rowOf(id)).toMatchObject({
          status: 'FAILED',
          lastErrorCode: 'RETRIES_EXHAUSTED',
        });
      } finally {
        await restricted.$disconnect();
      }
    });

    it('S1: the delivery-grant check passes for the application role and names a missing column', async () => {
      const restricted = new PrismaService({ DATABASE_URL: getRestrictedRoleUrl() });
      try {
        await restricted.$connect();
        const asApp = new OutboxRepository(restricted);
        expect(await asApp.findMissingUpdateGrants()).toEqual([]);
        await t.prisma.$executeRawUnsafe(
          `REVOKE UPDATE (delivered_chat_ids) ON TABLE notification_outbox FROM ${APP_ROLE_NAME}`,
        );
        try {
          expect(await asApp.findMissingUpdateGrants()).toEqual(['delivered_chat_ids']);
          const checked = new OutboxDispatcher(
            asApp,
            sender,
            t.get(IdentityService),
            t.get(OrganizationsService),
            t.get(OrdersService),
            t.get(WebLinks),
            t.clock,
            t.get(StaffBotLinkService),
            t.get(PriceListExportService),
          );
          const error = await checked.assertDeliveryGrants().catch((e: unknown) => e);
          expect((error as Error).message).toContain('delivered_chat_ids');
          expect((error as Error).message).toContain('app-role-grants.sql');
        } finally {
          await t.prisma.$executeRawUnsafe(
            `GRANT UPDATE (delivered_chat_ids) ON TABLE notification_outbox TO ${APP_ROLE_NAME}`,
          );
        }
        expect(await asApp.findMissingUpdateGrants()).toEqual([]);
      } finally {
        await restricted.$disconnect();
      }
    });

    it('a slow batch stops at its time budget and gives the unprocessed rows back', async () => {
      const ids = [
        await insertRow({ kind: 'USER', userId: w.ids.manager }),
        await insertRow({ kind: 'USER', userId: w.ids.manager }),
        await insertRow({ kind: 'USER', userId: w.ids.manager2 }),
      ];
      sender.beforeSend = () => {
        advance(BATCH_TIME_BUDGET_SECONDS + 1);
        return Promise.resolve();
      };
      const summary = await dispatcher.runOnce();
      expect(summary).toMatchObject({ claimed: 3, sent: 1, retried: 2 });
      const [first, second, third] = await Promise.all(ids.map(rowOf));
      expect(first?.status).toBe('SENT');
      for (const row of [second, third]) {
        // Given back: the attempt is returned and the row is due again at once, not after a lease.
        expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
        expect(row?.nextAttemptAt).toEqual(t.clock.now());
      }
      sender.beforeSend = undefined;
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 2, sent: 2 });
    });
  });

  describe('hard rule 6: customer-side recipients stay inside the order organization', () => {
    async function orderForOrgA(): Promise<string> {
      const order = await submitOrder(w);
      await dispatcher.runOnce();
      sender.sent.length = 0;
      return order.id;
    }
    const sellerOf = async (organizationId: string, userId: string, status: 'ACTIVE' | 'LEFT') =>
      t.prisma.organizationMember.updateMany({
        where: { organizationId, userId },
        data: { status, leftAt: status === 'LEFT' ? t.clock.now() : null },
      });

    it('an ACTIVE member of the order organization is messaged', async () => {
      const orderId = await orderForOrgA();
      const id = await insertRow({ kind: 'USER', userId: w.ids.sellerA2, orderId });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'SENT' });
      expect(sender.messagesTo(await chatOf(w.ids.sellerA2))).toHaveLength(1);
    });

    it('a former member gets nothing', async () => {
      const orderId = await orderForOrgA();
      await sellerOf(w.orgA, w.ids.sellerA2, 'LEFT');
      const id = await insertRow({ kind: 'USER', userId: w.ids.sellerA2, orderId });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'NO_RECIPIENT' });
      expect(sender.sent).toHaveLength(0);
    });

    it('a member of ANOTHER organization gets nothing about this order', async () => {
      const orderId = await orderForOrgA();
      const id = await insertRow({ kind: 'USER', userId: w.ids.sellerB, orderId });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'NO_RECIPIENT' });
      expect(sender.sent).toHaveLength(0);
    });

    it('a member of an INACTIVE organization gets nothing', async () => {
      const orderId = await orderForOrgA();
      await t.prisma.organization.update({ where: { id: w.orgA }, data: { status: 'INACTIVE' } });
      const id = await insertRow({ kind: 'USER', userId: w.ids.sellerA2, orderId });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'NO_RECIPIENT' });
      expect(sender.sent).toHaveLength(0);
    });

    it('a customer-side USER row without an order gets nothing; staff are unaffected', async () => {
      const noOrder = await insertRow({ kind: 'USER', userId: w.ids.sellerA2 });
      const staff = await insertRow({ kind: 'USER', userId: w.ids.manager });
      await dispatcher.runOnce();
      expect(await rowOf(noOrder)).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'NO_RECIPIENT',
      });
      expect(await rowOf(staff)).toMatchObject({ status: 'SENT' });
    });
  });

  describe('what is stored', () => {
    it('keeps the payload and recipient untouched and stores only short codes', async () => {
      const id = await insertRow({
        kind: 'USER',
        userId: w.ids.manager,
        payload: { orderNumber: 'IO-77777', totalAmount: '5.00', reason: 'PRIVATE-REASON-TEXT' },
        type: 'ORDER_REJECTED',
      });
      const before = await rowOf(id);
      sender.failFor(await chatOf(w.ids.manager), { failure: 'TRANSIENT', times: 1 });
      await dispatcher.runOnce();
      advance(RETRY_DELAYS_SECONDS[0]!);
      await dispatcher.runOnce();
      const after = await rowOf(id);
      expect(after.payload).toEqual(before.payload);
      expect(after.type).toBe(before.type);
      expect(after.recipientUserId).toBe(before.recipientUserId);
      expect(after.dedupeKey).toBe(before.dedupeKey);
      const stored = JSON.stringify(after);
      expect(stored.replace(JSON.stringify(after.payload), '')).not.toContain(
        'PRIVATE-REASON-TEXT',
      );
      expect(stored).not.toMatch(/Buyurtma|Заказ|Order IO/);
    });

    it('works with the restricted application role: only the delivery columns are written', async () => {
      const restricted = new PrismaService({ DATABASE_URL: getRestrictedRoleUrl() });
      try {
        await restricted.$connect();
        const asApp = new OutboxRepository(restricted);
        const id = await insertRow({ kind: 'USER', userId: w.ids.manager });
        const now = t.clock.now();
        const claimed = await asApp.claimDue(now, new Date(now.getTime() + 600_000), 10);
        expect(claimed.map((r) => r.id)).toEqual([id]);
        await asApp.recordDelivered(id, '123');
        await asApp.scheduleRetry(id, new Date(now.getTime() + 1000), 'SEND_FAILED');
        await asApp.deferWithoutAttempt(id, new Date(now.getTime() + 2000));
        await asApp.markSent(id, now);
        expect(await rowOf(id)).toMatchObject({ status: 'SENT', deliveredChatIds: ['123'] });
        const other = await insertRow({ kind: 'USER', userId: w.ids.manager });
        await asApp.markFailed(other, 'NO_RECIPIENT');
        expect(await rowOf(other)).toMatchObject({
          status: 'FAILED',
          lastErrorCode: 'NO_RECIPIENT',
        });
        await expect(
          restricted.$executeRaw`UPDATE notification_outbox SET payload = '{}'::jsonb`,
        ).rejects.toThrow();
      } finally {
        await restricted.$disconnect();
      }
    });

    it('reads nothing about organizations other than the chat of the addressed one', async () => {
      const other = await makeOrganization(t.prisma, { name: 'Other' });
      const id = await insertRow({ kind: 'ORGANIZATION_CHAT', organizationId: w.orgA });
      await dispatcher.runOnce();
      expect(await rowOf(id)).toMatchObject({ status: 'SENT' });
      expect(sender.sent.map((m) => m.chatId)).toEqual([await orgChat(w.orgA)]);
      expect(sender.messagesTo(await orgChat(other.id))).toHaveLength(0);
    });
  });
});
