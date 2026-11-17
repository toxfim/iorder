import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { PRICE_LIST_POST_TYPE } from '../src/common/outbox/price-list-post.js';
import { NotificationsModule, OutboxDispatcher } from '../src/modules/notifications/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { BotIdentity } from '../src/modules/telegram/bot-identity.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { TelegramModule, TelegramSender } from '../src/modules/telegram/index.js';
import {
  containsStandalone,
  findForbiddenKeys,
  findStaffOnlyFieldsInCustomerPriceList,
} from './support/forbidden-fields.js';
import { createWorld, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// [C, owner 2026-11-11] organization type and label, two price tiers; [P] the invite link. Real
// PostgreSQL, a recording fake Telegram (nothing reaches the network; the token is not real).
const SECRET = 'integration-secret_0123456789';
const BOT_USERNAME = 'iorder_test_bot';
const FAKE_TOKEN = '123456:FAKE-TOKEN-FOR-TESTS-ONLY';
const T0 = 1_790_000_000;
const ali = { id: 7_300_000_001, is_bot: false, first_name: 'Ali', last_name: 'Valiyev' };
const vali = { id: 7_300_000_002, is_bot: false, first_name: 'Vali' };
const BOT = { id: 999, is_bot: true, first_name: 'iOrder' };

// p1 in USD: standard 15.00, wholesale 12.00 (at the world's rate 12000: 180 000 / 144 000 so'm).
const STANDARD_UZS = '180000.00';
const WHOLESALE_UZS = '144000.00';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

describe('organization type, label and price tiers (real PostgreSQL, fake Telegram)', () => {
  let t: TestApp;
  let w: World;
  let sender: FakeTelegramSender;
  let update = 100;
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
    // The bot's command rate limiter (5 per chat in 10 s) reads this clock: a new minute per test.
    tick += 1;
    t.clock.set(new Date(t.clock.now().getTime() + tick * 60_000));
    sender.sent.length = 0;
    sender.documents.length = 0;
    sender.clearFailures();
  });

  const call = async (
    method: string,
    path: string,
    actor: Actor,
    body?: unknown,
  ): Promise<{ status: number; body: Body; raw: string }> => {
    const r = await t.request(method, path, { actor, body });
    return { status: r.status, body: (r.body ?? {}) as Body, raw: r.raw };
  };
  const hook = async (body: unknown): Promise<void> => {
    const r = await t.request('POST', `/telegram/webhook/${SECRET}`, {
      body,
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
    });
    expect(r.status).toBe(200);
  };
  // A private /start asks the language first [C, owner 2026-11-13]; the binding runs on the
  // press of a language button, which carries the payload. This is that press (O'zbekcha).
  const privateStart = (from: object, payload: string) => ({
    update_id: (update += 1),
    callback_query: {
      id: `cb-${update}`,
      from,
      message: { message_id: update, chat: { id: (from as { id: number }).id, type: 'private' } },
      data: `lang:uz:${payload}`,
    },
  });
  const payloadOf = (url: string): string => new URL(url).searchParams.get('start') ?? '';

  async function publishTiers(): Promise<void> {
    const current = await call('GET', '/staff/price-list/current', w.actors.manager);
    const r = await call('POST', '/staff/price-list/publish', w.actors.manager, {
      baseVersionNumber: current.body.version.number,
      upserts: [
        {
          productId: w.products.p1,
          basePrice: '15.00',
          deferredPrice: '16.00',
          rrp: null,
          wholesalePrice: '12.00',
          wholesaleDeferredPrice: null,
        },
      ],
    });
    expect(r.status).toBe(200);
  }

  // A label change after creation is the admin's alone [C, owner 2026-11-12].
  const setLabel = async (organizationId: string, label: string): Promise<void> => {
    const r = await call('PATCH', `/staff/organizations/${organizationId}`, w.actors.admin, {
      label,
    });
    expect(r.status).toBe(200);
    expect(r.body.label).toBe(label);
  };

  const p1Of = (list: Body): Body =>
    (list.items as Body[]).find((item) => item.productId === w.products.p1) ?? {};
  const p2Of = (list: Body): Body =>
    (list.items as Body[]).find((item) => item.productId === w.products.p2) ?? {};

  describe('customer prices follow the organization tier, resolved on the server', () => {
    it('a STANDARD customer never gets the wholesale price, a WHOLESALE one never the standard one', async () => {
      await publishTiers();
      await setLabel(w.orgB, 'WHOLESALE');

      const standard = await call('GET', '/price-list/current', w.actors.sellerA);
      expect(standard.status).toBe(200);
      expect(p1Of(standard.body)).toMatchObject({ price: STANDARD_UZS });
      expect(containsStandalone(standard.raw, WHOLESALE_UZS)).toBe(false);

      const wholesale = await call('GET', '/price-list/current', w.actors.sellerB);
      expect(p1Of(wholesale.body)).toMatchObject({ price: WHOLESALE_UZS, deferredPrice: null });
      expect(containsStandalone(wholesale.raw, STANDARD_UZS)).toBe(false);
      // [P] no wholesale price for p2: the standard one (both tiers see the same).
      expect(p2Of(wholesale.body).price).toBe(p2Of(standard.body).price);

      // Hard rule 7 and the tier: no cost-like key, no tier key, no staff-only field.
      for (const body of [standard.body, wholesale.body]) {
        expect(findForbiddenKeys(body)).toEqual([]);
        expect(findStaffOnlyFieldsInCustomerPriceList(body)).toEqual([]);
        expect(JSON.stringify(body)).not.toMatch(/wholesale|priceTier/i);
      }
    });

    it('PARTNER shares the wholesale tier; staff see both tiers on the staff list', async () => {
      await publishTiers();
      await setLabel(w.orgA, 'PARTNER');
      const partner = await call('GET', '/price-list/current', w.actors.ownerA);
      expect(p1Of(partner.body).price).toBe(WHOLESALE_UZS);

      const staff = await call('GET', '/staff/price-list/current', w.actors.manager);
      expect(p1Of(staff.body)).toMatchObject({
        basePrice: '15.00',
        wholesalePrice: '12.00',
        wholesaleDeferredPrice: null,
      });
    });

    it('an omitted wholesale price keeps the published one; null removes it (audited)', async () => {
      await publishTiers();
      const keep = async (upsert: Record<string, unknown>): Promise<Body> => {
        const current = await call('GET', '/staff/price-list/current', w.actors.manager);
        const r = await call('POST', '/staff/price-list/publish', w.actors.manager, {
          baseVersionNumber: current.body.version.number,
          upserts: [{ productId: w.products.p1, basePrice: '15.50', ...upsert }],
        });
        expect(r.status).toBe(200);
        return p1Of((await call('GET', '/staff/price-list/current', w.actors.manager)).body);
      };
      expect((await keep({})).wholesalePrice).toBe('12.00');
      expect((await keep({ wholesalePrice: null })).wholesalePrice).toBeNull();
      // The clock stands still, so the rows are told apart by what they say.
      const audit = await t.prisma.auditLog.findMany({ where: { action: 'PRICE_LIST_PUBLISHED' } });
      const removal = audit.find((row) =>
        JSON.stringify(row.diff).includes(`"item.${w.products.p1}.wholesalePrice":{"to":null`),
      );
      expect(removal).toBeDefined();
    });

    it('an order keeps the tier it was priced with, whatever the label becomes (hard rule 4)', async () => {
      await publishTiers();
      await setLabel(w.orgB, 'WHOLESALE');
      const order = await submitOrder(w, w.actors.sellerB, { items: [[w.products.p1, '1']] });
      const row = await t.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      expect(row.priceTier).toBe('WHOLESALE_PARTNER');
      expect(row.items[0]?.unitPrice.toFixed(2)).toBe(WHOLESALE_UZS);

      await setLabel(w.orgB, 'STANDARD');
      const after = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.priceTier).toBe('WHOLESALE_PARTNER');
      await expect(
        t.prisma.order.update({ where: { id: order.id }, data: { priceTier: 'STANDARD' } }),
      ).rejects.toThrow();
    });
  });

  it('only the admin changes a label after creation; the manager still chooses it at creation [C, owner 2026-11-12]', async () => {
    const refused = await call('PATCH', `/staff/organizations/${w.orgB}`, w.actors.manager, {
      label: 'WHOLESALE',
    });
    expect(refused.status).toBe(403);
    expect((await t.prisma.organization.findUniqueOrThrow({ where: { id: w.orgB } })).label).toBe(
      'STANDARD',
    );
    // The same label is no change, so the manager's PATCH of other fields alongside it works.
    const same = await call('PATCH', `/staff/organizations/${w.orgB}`, w.actors.manager, {
      label: 'STANDARD',
      name: 'Beta shop 2',
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ name: 'Beta shop 2', label: 'STANDARD' });

    const changed = await call('PATCH', `/staff/organizations/${w.orgB}`, w.actors.admin, {
      label: 'WHOLESALE',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ label: 'WHOLESALE', priceTier: 'WHOLESALE_PARTNER' });
    const audit = await t.prisma.auditLog.findMany({
      where: { entityId: w.orgB, action: 'ORGANIZATION_UPDATED', actorUserId: w.ids.admin },
    });
    expect(audit.map((row) => row.diff)).toContainEqual({
      label: { from: 'STANDARD', to: 'WHOLESALE' },
    });

    const created = await call('POST', '/staff/organizations', w.actors.manager, {
      type: 'GROUP',
      name: 'Ulgurji savdo',
      label: 'WHOLESALE',
    });
    expect(created.status).toBe(201);
    expect(created.body.organization.label).toBe('WHOLESALE');
  });

  describe('the Alif factoring tier [C, owner 2026-11-12]: own prices, no price = not offered', () => {
    // p1 in USD: Alif 9.50 / deferred 10.00 (114 000 / 120 000 so'm); p2 has no Alif price.
    const ALIF_UZS = '114000.00';
    const ALIF_DEFERRED_UZS = '120000.00';

    async function publishAlif(): Promise<void> {
      await publishTiers();
      const current = await call('GET', '/staff/price-list/current', w.actors.manager);
      const r = await call('POST', '/staff/price-list/publish', w.actors.manager, {
        baseVersionNumber: current.body.version.number,
        upserts: [
          {
            productId: w.products.p1,
            basePrice: '15.00',
            deferredPrice: '16.00',
            rrp: null,
            alifPrice: '9.50',
            alifDeferredPrice: '10.00',
          },
        ],
      });
      expect(r.status).toBe(200);
    }

    const putCart = (actor: Actor, productId: string, quantity: string) =>
      call('PUT', `/cart/items/${productId}`, actor, { quantity });

    it('an Alif customer sees only products with an Alif price, at that price; nobody else sees it', async () => {
      await publishAlif();
      await setLabel(w.orgB, 'ALIF_FACTORING');

      const alif = await call('GET', '/price-list/current', w.actors.sellerB);
      expect(alif.status).toBe(200);
      expect(p1Of(alif.body)).toMatchObject({ price: ALIF_UZS, deferredPrice: ALIF_DEFERRED_UZS });
      // No fallback: p2 has no Alif price, so it is not in the list at all.
      expect(p2Of(alif.body)).toEqual({});
      expect(containsStandalone(alif.raw, STANDARD_UZS)).toBe(false);
      expect(containsStandalone(alif.raw, WHOLESALE_UZS)).toBe(false);

      const standard = await call('GET', '/price-list/current', w.actors.sellerA);
      expect(p1Of(standard.body).price).toBe(STANDARD_UZS);
      expect(p2Of(standard.body).productId).toBe(w.products.p2);
      expect(containsStandalone(standard.raw, ALIF_UZS)).toBe(false);
      for (const body of [alif.body, standard.body]) {
        expect(findForbiddenKeys(body)).toEqual([]);
        expect(findStaffOnlyFieldsInCustomerPriceList(body)).toEqual([]);
        expect(JSON.stringify(body)).not.toMatch(/wholesale|alif|priceTier/i);
      }

      // Staff see every tier; omitted Alif prices are kept, null removes them (audited).
      const staff = await call('GET', '/staff/price-list/current', w.actors.manager);
      expect(p1Of(staff.body)).toMatchObject({
        basePrice: '15.00',
        wholesalePrice: '12.00',
        alifPrice: '9.50',
        alifDeferredPrice: '10.00',
      });
      const keep = await call('POST', '/staff/price-list/publish', w.actors.manager, {
        baseVersionNumber: staff.body.version.number,
        upserts: [{ productId: w.products.p1, basePrice: '15.50' }],
      });
      expect(keep.status).toBe(200);
      const kept = await call('GET', '/staff/price-list/current', w.actors.manager);
      expect(p1Of(kept.body).alifPrice).toBe('9.50');
      // Removing only the sale price would leave the kept deferred one alone: refused.
      const pairRefused = await call('POST', '/staff/price-list/publish', w.actors.manager, {
        baseVersionNumber: kept.body.version.number,
        upserts: [{ productId: w.products.p1, basePrice: '15.50', alifPrice: null }],
      });
      expect(pairRefused.status).toBe(422);
      const removed = await call('POST', '/staff/price-list/publish', w.actors.manager, {
        baseVersionNumber: kept.body.version.number,
        upserts: [
          {
            productId: w.products.p1,
            basePrice: '15.50',
            alifPrice: null,
            alifDeferredPrice: null,
          },
        ],
      });
      expect(removed.status).toBe(200);
      const audit = await t.prisma.auditLog.findMany({ where: { action: 'PRICE_LIST_PUBLISHED' } });
      expect(
        audit.some((row) =>
          JSON.stringify(row.diff).includes(`"item.${w.products.p1}.alifPrice":{"to":null`),
        ),
      ).toBe(true);
      // Now nothing is priced for the Alif customer.
      const empty = await call('GET', '/price-list/current', w.actors.sellerB);
      expect(p1Of(empty.body)).toEqual({});
    });

    it('a product without an Alif price cannot enter the cart, blocks a line already there, and the submit', async () => {
      await publishAlif();
      // Put in while the organization was STANDARD; then the label changes.
      expect((await putCart(w.actors.sellerB, w.products.p2, '1')).status).toBe(200);
      await setLabel(w.orgB, 'ALIF_FACTORING');

      const refused = await putCart(w.actors.sellerB, w.products.p2, '2');
      expect(refused.status).toBe(409);
      expect(refused.body.error.reason).toBe('PRODUCT_NOT_ORDERABLE');
      expect((await putCart(w.actors.sellerB, w.products.p1, '1')).status).toBe(200);

      const cart = await call('GET', '/cart', w.actors.sellerB);
      const line = (cart.body.lines as Body[]).find((l) => l.productId === w.products.p2);
      expect(line).toMatchObject({ problem: 'NOT_PRICED', unitPrice: null });
      expect(JSON.stringify(cart.body)).not.toMatch(/alif|wholesale|priceTier/i);

      await expect(
        submitOrder(w, w.actors.sellerB, {
          items: [
            [w.products.p1, '1'],
            [w.products.p2, '1'],
          ],
        }),
      ).rejects.toThrow();
      expect(await t.prisma.order.count({ where: { organizationId: w.orgB } })).toBe(0);
    });

    it('DEFERRED is refused when the Alif item has no Alif deferred price, never priced at the standard one [review]', async () => {
      await publishTiers();
      const current = await call('GET', '/staff/price-list/current', w.actors.manager);
      // A standard deferred price (16.00 = 192 000 so'm) exists; the Alif pair has a sale price only.
      expect(
        (
          await call('POST', '/staff/price-list/publish', w.actors.manager, {
            baseVersionNumber: current.body.version.number,
            upserts: [
              {
                productId: w.products.p1,
                basePrice: '15.00',
                deferredPrice: '16.00',
                rrp: null,
                alifPrice: '9.50',
                alifDeferredPrice: null,
              },
            ],
          })
        ).status,
      ).toBe(200);
      await setLabel(w.orgB, 'ALIF_FACTORING');
      expect((await putCart(w.actors.sellerB, w.products.p1, '1')).status).toBe(200);
      const cart = await call('GET', '/cart', w.actors.sellerB);
      expect(cart.body).toMatchObject({ totalAmount: ALIF_UZS, deferredTotalAmount: null });

      const submit = await t.request('POST', '/orders', {
        actor: w.actors.sellerB,
        headers: { 'idempotency-key': 'alif-deferred-refused-1' },
        body: { paymentPlan: 'DEFERRED', expectedTotalAmount: '192000.00' },
      });
      expect(submit.status).toBeGreaterThanOrEqual(400);
      expect(submit.status).toBeLessThan(500);
      expect(await t.prisma.order.count({ where: { organizationId: w.orgB } })).toBe(0);
    });

    it("the customer's plan change on an Alif order reprices from the Alif snapshot [review]", async () => {
      await publishAlif();
      await setLabel(w.orgB, 'ALIF_FACTORING');
      const order = await submitOrder(w, w.actors.sellerB, { items: [[w.products.p1, '1']] });
      expect(order.totalAmount.toFixed(2)).toBe(ALIF_UZS);
      const changed = await w.orders.changeOwnPaymentPlan(w.actors.sellerB, order.id, {
        paymentPlan: 'DEFERRED',
        expectedRowVersion: order.rowVersion,
      });
      // The Alif deferred price (10.00 = 120 000 so'm), never the standard one (16.00).
      expect(changed.totalAmount.toFixed(2)).toBe(ALIF_DEFERRED_UZS);
      const row = await t.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      expect(row).toMatchObject({ paymentPlan: 'DEFERRED', priceTier: 'ALIF_FACTORING' });
      expect(row.items[0]?.unitPrice.toFixed(2)).toBe(ALIF_DEFERRED_UZS);
    });

    it('an order freezes ALIF_FACTORING and its Alif prices; DEFERRED uses the Alif deferred price', async () => {
      await publishAlif();
      await setLabel(w.orgB, 'ALIF_FACTORING');
      const order = await submitOrder(w, w.actors.sellerB, {
        items: [[w.products.p1, '1']],
        paymentPlan: 'DEFERRED',
      });
      const row = await t.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      expect(row.priceTier).toBe('ALIF_FACTORING');
      expect(row.items[0]?.unitPrice.toFixed(2)).toBe(ALIF_DEFERRED_UZS);

      await setLabel(w.orgB, 'STANDARD');
      const after = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.priceTier).toBe('ALIF_FACTORING');
    });

    it('an Alif chat with no Alif price yet is skipped, never sent an empty file [review]', async () => {
      await publishTiers();
      for (const id of [w.orgA, w.orgB]) {
        await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, {
          pricePostingEnabled: true,
        });
      }
      await setLabel(w.orgB, 'ALIF_FACTORING');
      const preview = await call(
        'GET',
        '/staff/price-list/post-to-groups/recipients',
        w.actors.manager,
      );
      expect(preview.body.recipients).toMatchObject({
        total: 1,
        byTier: { STANDARD: 1, WHOLESALE_PARTNER: 0, ALIF_FACTORING: 0 },
      });
      expect(preview.body.skipped.noPrices).toBe(1);
      const posted = await call('POST', '/staff/price-list/post-to-groups', w.actors.manager);
      expect(posted.body).toMatchObject({ queuedGroupCount: 1, skipped: { noPrices: 1 } });
      const rows = await t.prisma.notificationOutbox.findMany({
        where: { type: PRICE_LIST_POST_TYPE },
      });
      expect(rows.map((r) => r.recipientOrganizationId)).toEqual([w.orgA]);

      // Queued while STANDARD, Alif (still unpriced) at send time: refused, nothing sent.
      await setLabel(w.orgA, 'ALIF_FACTORING');
      sender.documents.length = 0;
      await t.get(OutboxDispatcher).runOnce();
      expect(sender.documents).toEqual([]);
      const row = await t.prisma.notificationOutbox.findFirstOrThrow({
        where: { type: PRICE_LIST_POST_TYPE },
      });
      expect(row).toMatchObject({ status: 'FAILED', lastErrorCode: 'NO_PRICED_ITEMS' });
    });

    it('the price post sends an Alif chat a file of only its products, at Alif prices', async () => {
      await publishAlif();
      for (const id of [w.orgA, w.orgB]) {
        await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, {
          pricePostingEnabled: true,
        });
      }
      await setLabel(w.orgB, 'ALIF_FACTORING');
      const preview = await call(
        'GET',
        '/staff/price-list/post-to-groups/recipients',
        w.actors.manager,
      );
      expect(preview.body.recipients.byTier).toEqual({
        STANDARD: 1,
        WHOLESALE_PARTNER: 0,
        ALIF_FACTORING: 1,
      });
      sender.documents.length = 0;
      await call('POST', '/staff/price-list/post-to-groups', w.actors.manager);
      await t.get(OutboxDispatcher).runOnce();
      const pricesIn = async (id: string): Promise<Record<string, unknown>> => {
        const org = await t.prisma.organization.findUniqueOrThrow({ where: { id } });
        const doc = sender.documents.find((d) => d.chatId === String(org.telegramChatId));
        expect(doc, id).toBeDefined();
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.from(doc?.file.data ?? []) as unknown as ArrayBuffer);
        const prices: Record<string, unknown> = {};
        book.eachSheet((sheet) =>
          sheet.eachRow((r) => {
            const code = r.getCell(2).value;
            if (typeof code === 'string' && code.startsWith('P-'))
              prices[code] = r.getCell(6).value;
          }),
        );
        return prices;
      };
      const alifFile = await pricesIn(w.orgB);
      expect(alifFile['P-1']).toBe(9.5);
      expect(alifFile).not.toHaveProperty('P-2');
      const standardFile = await pricesIn(w.orgA);
      expect(standardFile['P-1']).toBe(15);
      expect(standardFile).toHaveProperty('P-2');
    });
  });

  describe('staff create organizations with a one-time bot link [C; link P]', () => {
    it('creates an INACTIVE PERSON with a start link; only manager and admin may', async () => {
      const r = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Ali aka',
        label: 'PARTNER',
        phone: '+998 90 111 22 33',
      });
      expect(r.status).toBe(201);
      expect(r.body.organization).toMatchObject({
        type: 'PERSON',
        label: 'PARTNER',
        priceTier: 'WHOLESALE_PARTNER',
        phone: '+998901112233',
        status: 'INACTIVE',
        telegramChatId: null,
        invite: { status: 'PENDING' },
        boundPerson: null,
      });
      expect(r.body.invite.url).toMatch(
        new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?start=org_[A-Za-z0-9_-]{43}$`),
      );
      const audit = await t.prisma.auditLog.findMany({
        where: { entityId: r.body.organization.id },
      });
      expect(audit.map((a) => a.action)).toEqual(['ORGANIZATION_CREATED']);
      // The token is a secret: never in the history.
      expect(JSON.stringify(audit)).not.toContain(payloadOf(r.body.invite.url).slice(4));

      expect(
        (
          await call('POST', '/staff/organizations', w.actors.accountant, {
            type: 'PERSON',
            name: 'X',
          })
        ).status,
      ).toBe(403);
      const purchasing: Actor = { userId: w.ids.manager, staffRoles: ['PURCHASING_MANAGER'] };
      expect(
        (await call('GET', `/staff/organizations/${r.body.organization.id}/invite`, purchasing))
          .status,
      ).toBe(403);
      // Unbound: it cannot be activated by hand.
      const activate = await call(
        'PATCH',
        `/staff/organizations/${r.body.organization.id}`,
        w.actors.manager,
        { status: 'ACTIVE' },
      );
      expect(activate.status).toBe(409);
      expect(activate.body.error.reason).toBe('ORGANIZATION_NOT_LINKED');
    });

    it('a GROUP gets a startgroup link', async () => {
      const r = await call('POST', '/staff/organizations', w.actors.admin, {
        type: 'GROUP',
        name: 'Samarqand Savdo',
      });
      expect(r.status).toBe(201);
      expect(r.body.organization.label).toBe('STANDARD');
      expect(r.body.invite.url).toMatch(/\?startgroup=org_/);
    });

    it('the type changes only while unlinked [C; P]: audited, the link follows, the bind uses it', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.admin, {
        type: 'GROUP',
        name: 'Ali aka',
      });
      const id = created.body.organization.id as string;
      const payload = new URL(created.body.invite.url).searchParams.get('startgroup') ?? '';

      expect(
        (await call('PATCH', `/staff/organizations/${id}`, w.actors.accountant, { type: 'PERSON' }))
          .status,
      ).toBe(403);
      const changed = await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, {
        type: 'PERSON',
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ type: 'PERSON', invite: { status: 'PENDING' } });
      const audit = await t.prisma.auditLog.findMany({
        where: { entityId: id, action: 'ORGANIZATION_UPDATED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.diff).toEqual({ type: { from: 'GROUP', to: 'PERSON' } });
      // The same open invite, now as a private-chat link.
      const invite = await call('GET', `/staff/organizations/${id}/invite`, w.actors.manager);
      expect(payloadOf(invite.body.url)).toBe(payload);

      await hook(privateStart(ali, payload));
      const bound = await t.prisma.organization.findUniqueOrThrow({ where: { id } });
      expect(bound).toMatchObject({ type: 'PERSON', status: 'ACTIVE' });

      // Linked: the chat is what the type describes, so it stays (API and database).
      const refused = await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, {
        type: 'GROUP',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.reason).toBe('ORGANIZATION_ALREADY_LINKED');
      const groupRefused = await call('PATCH', `/staff/organizations/${w.orgA}`, w.actors.admin, {
        type: 'PERSON',
      });
      expect(groupRefused.body.error.reason).toBe('ORGANIZATION_ALREADY_LINKED');
      await expect(
        t.prisma.$executeRaw`UPDATE organizations SET type = 'PERSON' WHERE id = ${w.orgA}::uuid`,
      ).rejects.toThrow(/type of a linked organization is immutable/);
      // The trigger's other arm: binding and retyping in one statement is refused too.
      const fresh = await call('POST', '/staff/organizations', w.actors.admin, {
        type: 'GROUP',
        name: 'Bir zumda',
      });
      const freshId = fresh.body.organization.id as string;
      await expect(
        t.prisma
          .$executeRaw`UPDATE organizations SET type = 'PERSON', telegram_chat_id = -100777 WHERE id = ${freshId}::uuid`,
      ).rejects.toThrow(/type of a linked organization is immutable/);
      // A same-type PATCH is a no-op, not a refusal.
      expect(
        (await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, { type: 'PERSON' }))
          .status,
      ).toBe(200);
    });

    it('typeChangeable reports the same rule the PATCH enforces, on the list and the detail', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Yangi mijoz',
      });
      const id = created.body.organization.id as string;
      expect(created.body.organization.typeChangeable).toBe(true);
      const typeChangeableOnList = async (orgId: string): Promise<unknown> => {
        const list = await call('GET', '/staff/organizations', w.actors.manager);
        return (list.body.items as Body[]).find((o) => o.id === orgId)?.typeChangeable;
      };
      expect(await typeChangeableOnList(id)).toBe(true);
      expect(
        (await call('GET', `/staff/organizations/${id}`, w.actors.manager)).body,
      ).toMatchObject({ typeChangeable: true });
      // A bot-registered group has its chat from the start.
      expect(await typeChangeableOnList(w.orgA)).toBe(false);

      await hook(privateStart(ali, payloadOf(created.body.invite.url)));
      expect(await typeChangeableOnList(id)).toBe(false);
      const detail = await call('GET', `/staff/organizations/${id}`, w.actors.admin);
      expect(detail.body.typeChangeable).toBe(false);
      // The flag and the PATCH agree.
      const refused = await call('PATCH', `/staff/organizations/${id}`, w.actors.admin, {
        type: 'GROUP',
      });
      expect(refused.body.error.reason).toBe('ORGANIZATION_ALREADY_LINKED');
    });

    it('the language comes first: Start only asks; the press binds in the chosen language', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Ali aka',
      });
      const id = created.body.organization.id as string;
      const payload = payloadOf(created.body.invite.url);

      // The /start itself binds nothing: it asks, and the buttons carry the payload.
      await hook({
        update_id: (update += 1),
        message: {
          date: T0,
          chat: { id: (ali as { id: number }).id, type: 'private' },
          from: ali,
          text: `/start ${payload}`,
        },
      });
      expect(sender.sent.at(-1)?.text).toBe('Tilni tanlang\nВыберите язык\nChoose a language');
      expect(sender.sent.at(-1)?.options?.buttons?.[1]).toEqual({
        text: '🇷🇺 Русский',
        callbackData: `lang:ru:${payload}`,
      });
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'INACTIVE',
      );

      // The Russian button binds the person, created in Russian, answered in Russian.
      await hook({
        update_id: (update += 1),
        callback_query: {
          id: 'cb-ru',
          from: ali,
          message: { message_id: 9, chat: { id: (ali as { id: number }).id, type: 'private' } },
          data: `lang:ru:${payload}`,
        },
      });
      const org = await t.prisma.organization.findUniqueOrThrow({
        where: { id },
        include: { members: { include: { user: true } } },
      });
      expect(org.status).toBe('ACTIVE');
      expect(org.members[0]?.user.language).toBe('RU');
      expect(sender.sent.at(-1)?.text).toContain('Вы подключены к iOrder');
      expect(sender.sent.at(-1)?.text).toContain('Команды:');
    });

    it('Start binds the person: member, shop owner, ACTIVE; the link works once', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Ali aka',
      });
      const id = created.body.organization.id as string;
      const payload = payloadOf(created.body.invite.url);

      await hook(privateStart(ali, payload));
      const org = await t.prisma.organization.findUniqueOrThrow({
        where: { id },
        include: { members: { include: { user: true } } },
      });
      expect(org.status).toBe('ACTIVE');
      expect(org.telegramChatId).toBe(BigInt(ali.id));
      expect(org.members.map((m) => [m.role, m.status, String(m.user.telegramUserId)])).toEqual([
        ['SHOP_OWNER', 'ACTIVE', String(ali.id)],
      ]);
      expect(sender.sent.at(-1)).toMatchObject({ chatId: String(ali.id) });
      expect(sender.sent.at(-1)?.text).toContain("Salom, Ali Valiyev! Siz iOrder'ga ulandingiz.");
      // The staff member who created it is told (their own bot message).
      const notice = await t.prisma.notificationOutbox.findFirst({
        where: { type: 'ORGANIZATION_LINKED' },
      });
      expect(notice).toMatchObject({ recipientKind: 'USER', recipientUserId: w.ids.manager });
      const detail = await call('GET', `/staff/organizations/${id}`, w.actors.manager);
      expect(detail.body).toMatchObject({
        invite: { status: 'LINKED', expiresAt: null },
        boundPerson: { fullName: 'Ali Valiyev', telegramUserId: String(ali.id) },
      });

      // Used up: a second press (by anyone) is refused and changes nothing.
      await hook(privateStart(vali, payload));
      expect(sender.sent.at(-1)?.text).toContain('eskirgan yoki allaqachon ishlatilgan');
      const again = await t.prisma.organization.findUniqueOrThrow({ where: { id } });
      expect(again.telegramChatId).toBe(BigInt(ali.id));
      expect(
        (await call('POST', `/staff/organizations/${id}/invite`, w.actors.manager)).body.error
          .reason,
      ).toBe('ORGANIZATION_ALREADY_LINKED');
    });

    it('a regenerated link replaces the old one at once; an expired link does not bind', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Vali',
      });
      const id = created.body.organization.id as string;
      const old = payloadOf(created.body.invite.url);
      const regenerated = await call('POST', `/staff/organizations/${id}/invite`, w.actors.manager);
      expect(regenerated.status).toBe(200);
      const fresh = payloadOf(regenerated.body.url);
      expect(fresh).not.toBe(old);
      expect(
        (await t.prisma.auditLog.findMany({ where: { entityId: id } })).map((a) => a.action),
      ).toEqual(['ORGANIZATION_CREATED', 'ORGANIZATION_INVITE_REGENERATED']);

      await hook(privateStart(vali, old));
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'INACTIVE',
      );

      // Seven days later the fresh link has expired too.
      t.clock.set(new Date(t.clock.now().getTime() + 7 * 24 * 3600 * 1000 + 1000));
      await hook(privateStart(vali, fresh));
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'INACTIVE',
      );
      expect(
        (await call('GET', `/staff/organizations/${id}`, w.actors.manager)).body.invite,
      ).toMatchObject({ status: 'EXPIRED' });
    });

    it('a member of another organization is refused and the link stays usable', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Somebody',
      });
      const id = created.body.organization.id as string;
      const sellerA = await t.prisma.user.findUniqueOrThrow({ where: { id: w.ids.sellerA } });
      const member = { id: Number(sellerA.telegramUserId), is_bot: false, first_name: 'Seller' };
      await hook(privateStart(member, payloadOf(created.body.invite.url)));
      expect(sender.sent.at(-1)?.text).toContain('boshqa tashkilotga ulangansiz');
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'INACTIVE',
      );
      await hook(privateStart(ali, payloadOf(created.body.invite.url)));
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('a startgroup link binds the group; the group the bot just registered is retired, not merged by hand', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'GROUP',
        name: 'Navoiy Mobil',
        label: 'WHOLESALE',
      });
      const id = created.body.organization.id as string;
      const payload = new URL(created.body.invite.url).searchParams.get('startgroup') ?? '';
      const chat = -1009000000001;
      // Telegram reports the bot's arrival first, then the start command in the group.
      await hook({
        update_id: (update += 1),
        my_chat_member: {
          chat: { id: chat, type: 'supergroup', title: 'Navoiy chat' },
          from: ali,
          date: T0 + 1,
          new_chat_member: { status: 'member', user: BOT },
        },
      });
      const registered = await t.prisma.organization.findUniqueOrThrow({
        where: { telegramChatId: BigInt(chat) },
      });
      await hook({
        update_id: (update += 1),
        message: {
          date: T0 + 2,
          chat: { id: chat, type: 'supergroup', title: 'Navoiy chat' },
          from: ali,
          text: `/start@${BOT_USERNAME} ${payload}`,
        },
      });
      const bound = await t.prisma.organization.findUniqueOrThrow({ where: { id } });
      expect(bound).toMatchObject({ status: 'ACTIVE', telegramChatId: BigInt(chat) });
      const retired = await t.prisma.organization.findUniqueOrThrow({
        where: { id: registered.id },
      });
      expect(retired).toMatchObject({
        status: 'INACTIVE',
        telegramChatId: null,
        mergedIntoOrganizationId: id,
      });
      // Retired (merged), chat-less and member-less: still not a never-bound organization.
      const retiredDetail = await call(
        'GET',
        `/staff/organizations/${registered.id}`,
        w.actors.manager,
      );
      expect(retiredDetail.body.typeChangeable).toBe(false);
      // The adder is recorded as a member right away; the retired one is not listed.
      expect(await t.prisma.organizationMember.count({ where: { organizationId: id } })).toBe(1);
      const list = await call('GET', '/staff/organizations', w.actors.manager);
      expect((list.body.items as Body[]).map((o) => o.id)).not.toContain(registered.id);
      expect(sender.sent.at(-1)).toMatchObject({ chatId: String(chat) });
      expect(sender.sent.at(-1)?.text).toContain("Guruh iOrder'ga ulandi");
    });
  });

  describe('delivery to a PERSON goes to their private chat', () => {
    async function boundPerson(label: string): Promise<{ id: string; actor: Actor }> {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Ali aka',
        label,
      });
      const id = created.body.organization.id as string;
      await hook(privateStart(ali, payloadOf(created.body.invite.url)));
      const user = await t.prisma.user.findUniqueOrThrow({
        where: { telegramUserId: BigInt(ali.id) },
      });
      await t.prisma.user.update({ where: { id: user.id }, data: { phone: '+998901234567' } });
      return {
        id,
        actor: {
          userId: user.id,
          staffRoles: [],
          membership: { organizationId: id, role: 'SHOP_OWNER' },
        },
      };
    }

    it('the price post sends each chat the file of its tier, and counts who is skipped', async () => {
      await publishTiers();
      const person = await boundPerson('PARTNER');
      await call('POST', '/staff/organizations', w.actors.manager, { type: 'PERSON', name: 'X' });
      for (const id of [w.orgA, w.orgB, person.id]) {
        await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, {
          pricePostingEnabled: true,
        });
      }
      await setLabel(w.orgB, 'WHOLESALE');

      const preview = await call(
        'GET',
        '/staff/price-list/post-to-groups/recipients',
        w.actors.manager,
      );
      expect(preview.body).toEqual({
        recipients: {
          total: 3,
          byTier: { STANDARD: 1, WHOLESALE_PARTNER: 2, ALIF_FACTORING: 0 },
          byDestination: { GROUP: 2, PRIVATE: 1 },
        },
        skipped: { unbound: 1, inactive: 0, postingOff: 0, noPrices: 0 },
      });
      const posted = await call('POST', '/staff/price-list/post-to-groups', w.actors.manager);
      expect(posted.body).toMatchObject({ queuedGroupCount: 3, ...preview.body });
      const rows = await t.prisma.notificationOutbox.findMany({
        where: { type: PRICE_LIST_POST_TYPE },
      });
      expect(
        Object.fromEntries(
          rows.map((r) => [r.recipientOrganizationId, (r.payload as Body).priceTier]),
        ),
      ).toEqual({
        [w.orgA]: 'STANDARD',
        [w.orgB]: 'WHOLESALE_PARTNER',
        [person.id]: 'WHOLESALE_PARTNER',
      });

      await t.get(OutboxDispatcher).runOnce();
      const p1Price = async (chatId: string): Promise<unknown> => {
        const doc = sender.documents.find((d) => d.chatId === chatId);
        expect(doc, chatId).toBeDefined();
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.from(doc?.file.data ?? []) as unknown as ArrayBuffer);
        let price: unknown = null;
        book.eachSheet((sheet) =>
          sheet.eachRow((row) => {
            if (row.getCell(2).value === 'P-1') price = row.getCell(6).value;
          }),
        );
        return price;
      };
      const chatOf = async (id: string): Promise<string> =>
        String((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).telegramChatId);
      expect(await p1Price(await chatOf(w.orgA))).toBe(15);
      expect(await p1Price(await chatOf(w.orgB))).toBe(12);
      expect(await p1Price(String(ali.id))).toBe(12);
    });

    it('order news for a PERSON reach the private chat once, without the group mention', async () => {
      const person = await boundPerson('STANDARD');
      const order = await submitOrder(w, person.actor, { items: [[w.products.p1, '1']] });
      sender.sent.length = 0;
      await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'Tovar tugadi' });
      await t.get(OutboxDispatcher).runOnce();

      const toPerson = sender.sent.filter((m) => m.chatId === String(ali.id));
      expect(toPerson).toHaveLength(1);
      expect(toPerson[0]?.text).toContain('Tovar tugadi');
      expect(toPerson[0]?.options?.mentions ?? []).toEqual([]);
      const customerRows = await t.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, recipientKind: { in: ['ORGANIZATION_CHAT', 'USER'] } },
      });
      const sideRows = customerRows.filter(
        (r) => r.recipientKind === 'ORGANIZATION_CHAT' || r.recipientUserId === person.actor.userId,
      );
      expect(sideRows.map((r) => r.status).sort()).toEqual(['SENT', 'SENT']);
    });

    /** Price posting on for the person; returns what a post now would do. */
    const postPreview = async (id: string): Promise<Body> => {
      await call('PATCH', `/staff/organizations/${id}`, w.actors.manager, {
        pricePostingEnabled: true,
      });
      return (await call('GET', '/staff/price-list/post-to-groups/recipients', w.actors.manager))
        .body;
    };

    it('a BLOCKED person gets no price file and no order message (review B1)', async () => {
      const person = await boundPerson('PARTNER');
      const order = await submitOrder(w, person.actor, { items: [[w.products.p1, '1']] });
      const before = await postPreview(person.id);
      expect(before.recipients.byDestination.PRIVATE).toBe(1);

      await t.prisma.user.update({
        where: { id: person.actor.userId },
        data: { status: 'BLOCKED' },
      });
      const after = await postPreview(person.id);
      expect(after.recipients.byDestination.PRIVATE).toBe(0);
      expect(after.skipped.unbound).toBe(before.skipped.unbound + 1);

      sender.sent.length = 0;
      sender.documents.length = 0;
      await call('POST', '/staff/price-list/post-to-groups', w.actors.manager);
      await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'Tovar tugadi' });
      await t.get(OutboxDispatcher).runOnce();
      expect(sender.sent.filter((m) => m.chatId === String(ali.id))).toEqual([]);
      expect(sender.documents.filter((d) => d.chatId === String(ali.id))).toEqual([]);
    });

    it('a PERSON whose person left is INACTIVE without a chat and reaches nobody; roles never change there', async () => {
      const person = await boundPerson('STANDARD');
      const order = await submitOrder(w, person.actor, { items: [[w.products.p1, '1']] });
      for (const [method, path, body] of [
        ['DELETE', `/staff/organizations/${person.id}/shop-owner`, undefined],
        [
          'PATCH',
          `/staff/organizations/${person.id}/members/${person.actor.userId}`,
          { role: 'SELLER' },
        ],
        ['PUT', `/staff/organizations/${person.id}/shop-owner`, { userId: w.ids.sellerA }],
      ] as const) {
        const r = await call(method, path, w.actors.manager, body);
        expect(r.status, path).toBe(409);
        expect(r.body.error.reason).toBe('PERSON_ORGANIZATION');
      }

      const left = await call(
        'POST',
        `/staff/organizations/${person.id}/members/${person.actor.userId}/leave`,
        w.actors.manager,
      );
      expect(left.status).toBe(200);
      expect(left.body).toMatchObject({
        status: 'INACTIVE',
        telegramChatId: null,
        invite: { status: 'EXPIRED' },
      });
      // Staff can send a new link now.
      expect(
        (await call('POST', `/staff/organizations/${person.id}/invite`, w.actors.manager)).status,
      ).toBe(200);
      // Chat-less but not never-bound: its orders and debt stay, so a group must not inherit them.
      const retype = await call('PATCH', `/staff/organizations/${person.id}`, w.actors.manager, {
        type: 'GROUP',
      });
      expect(retype.status).toBe(409);
      expect(retype.body.error.reason).toBe('ORGANIZATION_ALREADY_LINKED');
      // A LEFT member is history too: the DTO says so before anyone tries.
      expect(left.body.typeChangeable).toBe(false);

      sender.sent.length = 0;
      await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'Tovar tugadi' });
      await t.get(OutboxDispatcher).runOnce();
      expect(sender.sent.filter((m) => m.chatId === String(ali.id))).toEqual([]);
      expect((await postPreview(person.id)).recipients.byDestination.PRIVATE).toBe(0);
    });

    it('a BLOCKED person cannot bind with a valid link, which stays usable', async () => {
      const created = await call('POST', '/staff/organizations', w.actors.manager, {
        type: 'PERSON',
        name: 'Blocked',
      });
      const id = created.body.organization.id as string;
      await t.prisma.user.create({
        data: { telegramUserId: BigInt(vali.id), fullName: 'Vali', status: 'BLOCKED' },
      });
      await hook(privateStart(vali, payloadOf(created.body.invite.url)));
      expect(sender.sent.at(-1)?.text).toContain('bloklangan');
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'INACTIVE',
      );
      await hook(privateStart(ali, payloadOf(created.body.invite.url)));
      expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
        'ACTIVE',
      );
    });
  });

  it('a regenerated group link binds after an expired first try retired nothing', async () => {
    const created = await call('POST', '/staff/organizations', w.actors.manager, {
      type: 'GROUP',
      name: 'Late group',
    });
    const id = created.body.organization.id as string;
    const first = new URL(created.body.invite.url).searchParams.get('startgroup') ?? '';
    const chat = -1009000000002;
    t.clock.set(new Date(t.clock.now().getTime() + 8 * 24 * 3600 * 1000));
    const groupStart = (payload: string) => ({
      update_id: (update += 1),
      message: {
        date: T0 + 3,
        chat: { id: chat, type: 'supergroup', title: 'Late chat' },
        from: ali,
        text: `/start@${BOT_USERNAME} ${payload}`,
      },
    });
    await hook({
      update_id: (update += 1),
      my_chat_member: {
        chat: { id: chat, type: 'supergroup', title: 'Late chat' },
        from: ali,
        date: T0 + 1,
        new_chat_member: { status: 'member', user: BOT },
      },
    });
    await hook(groupStart(first));
    expect((await t.prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe(
      'INACTIVE',
    );
    // Staff make a new link AFTER the bot registered the chat: it still binds.
    t.clock.set(new Date(t.clock.now().getTime() + 60_000));
    const fresh = await call('POST', `/staff/organizations/${id}/invite`, w.actors.manager);
    await hook(groupStart(new URL(fresh.body.url).searchParams.get('startgroup') ?? ''));
    expect(await t.prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'ACTIVE',
      telegramChatId: BigInt(chat),
    });
  });

  it('a draft upsert with a wholesale deferred price and no wholesale price is a validation error', async () => {
    const draft = await call('POST', '/staff/price-list/drafts', w.actors.manager, {
      copyFromCurrent: true,
    });
    const r = await call(
      'PUT',
      `/staff/price-list/drafts/${draft.body.id}/items`,
      w.actors.manager,
      {
        items: [{ productId: w.products.p2, basePrice: '1.00', wholesaleDeferredPrice: '2.00' }],
      },
    );
    expect(r.status).toBe(422);
  });
});
