import { RequestMethod } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { readRoutePolicy } from '../src/common/auth/route-access.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { DashboardModule } from '../src/modules/dashboard/index.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { NotificationsModule } from '../src/modules/notifications/index.js';
import { OutboxDispatcher } from '../src/modules/notifications/outbox-dispatcher.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { PricingModule } from '../src/modules/pricing/index.js';
import { SheetsSyncModule } from '../src/modules/sheets-sync/index.js';
import { FakeTelegramSender } from '../src/modules/telegram/fake-telegram-sender.js';
import { TelegramSender } from '../src/modules/telegram/index.js';
import { makeUser, staffActor } from './support/identity-fixtures.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { ACTOR_HEADER, createTestApp, type TestApp } from './support/test-app.js';

const BASE_URL = 'https://staff.example.test';
const CREDENTIAL_KEY = /login|password|credential|hash|session/i;
const TELEGRAM_KEY = /telegram|chatId/i;

/** Non-GET routes the role may use: its own session, bot link and profile, and the sheet sync. */
const ALLOWED_WRITES: ReadonlySet<string> = new Set([
  'POST /auth/logout',
  'POST /staff/me/notifications/link',
  // [C] 2026-11-09: every person changes their OWN name and phone; the route names nobody else.
  'PUT /staff/me/profile',
  'POST /staff/sheet-sync/runs',
  // As a staff viewer of the customer app ([C] 2026-11-09), like every role that may browse the
  // price list: a personal cart that belongs to no organization. `POST /orders` reaches the
  // service, which refuses it where no organization is configured for staff orders
  // (staff-viewer.int-spec.ts); no order of any organization can come of it.
  'PUT /cart/items/:productId',
  'DELETE /cart/items/:productId',
  'POST /orders',
]);

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

/** Every field whose name is about Telegram and that carries an id. */
function telegramValues(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => telegramValues(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      // A boolean such as the caller's own telegramLinked is no id.
      if (TELEGRAM_KEY.test(key) && typeof inner === 'string') into.push(key);
      telegramValues(inner, into);
    }
  }
  return into;
}

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.push(key);
      collectKeys(inner, into);
    }
  }
  return into;
}

describe('purchasing manager (real PostgreSQL, real HTTP)', () => {
  let t: TestApp;
  let w: World;
  let umid: Actor;
  let sender: FakeTelegramSender;

  beforeAll(async () => {
    sender = new FakeTelegramSender();
    t = await createTestApp(
      [
        PricingModule,
        CatalogModule,
        SheetsSyncModule,
        IdentityModule,
        OrganizationsModule,
        OrdersModule,
        DashboardModule,
        NotificationsModule,
      ],
      {
        env: { BOT_TOKEN: '123456:FAKE-TOKEN-FOR-TESTS-ONLY', WEB_APP_URL: BASE_URL },
        overrides: [{ token: TelegramSender, value: sender }],
      },
    );
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    sender.sent.length = 0;
    const user = await makeUser(t.prisma, { name: 'Umid aka', staff: ['PURCHASING_MANAGER'] });
    umid = staffActor(user.id, 'PURCHASING_MANAGER');
  });

  const mark = (productId: string): Promise<unknown> =>
    t.prisma.product.update({ where: { id: productId }, data: { markingRequired: true } });
  const purchasingRows = () =>
    t.prisma.notificationOutbox.findMany({
      where: { recipientRole: 'PURCHASING_MANAGER' },
      orderBy: { createdAt: 'asc' },
    });

  /** Every non-GET, non-public route the application has, read from the controllers themselves. */
  function writeRoutes(): { method: string; path: string; label: string }[] {
    const reflector = new Reflector();
    const routes: { method: string; path: string; label: string }[] = [];
    for (const module of t.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        if (!controller) continue;
        const base = Reflect.getMetadata('path', controller) as string;
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const own = Reflect.getMetadata('path', handler) as string | undefined;
          if (own === undefined) continue;
          const method = METHOD_NAMES[Reflect.getMetadata('method', handler) as RequestMethod];
          if (method === undefined) continue;
          const policy = readRoutePolicy(reflector, handler, controller);
          if (policy?.kind === 'PUBLIC') continue;
          const path = `/${[base, own].filter((part) => part !== '' && part !== '/').join('/')}`;
          routes.push({ method, path, label: `${method} ${path}` });
        }
      }
    }
    return routes;
  }

  describe('writes', () => {
    it('gets 403 on every write route of the application, before any validation', async () => {
      const routes = writeRoutes();
      // A broken reflection must not make this test pass by finding nothing.
      expect(routes.length).toBeGreaterThan(50);
      const wrong: string[] = [];
      for (const route of routes) {
        if (ALLOWED_WRITES.has(route.label)) continue;
        const path = route.path.replace(/:[a-zA-Z]+/g, randomUUID());
        const reply = await t.request(route.method, path, { actor: umid, body: {} });
        if (reply.status !== 403) wrong.push(`${route.label} -> ${reply.status}`);
      }
      expect(wrong).toEqual([]);
    });

    it.each([
      ['PUT', '/staff/usd-rate'],
      ['POST', '/staff/usd-rate/follow-central-bank'],
      ['POST', '/staff/price-list/publish'],
      ['POST', '/staff/price-list/post-to-groups'],
      ['POST', '/staff/brands'],
      ['POST', '/staff/product-categories'],
      ['POST', '/staff/product-categories/bulk'],
      ['POST', '/staff/products'],
      ['PUT', '/staff/supply-parties'],
      ['POST', '/staff/users'],
    ])('names the sensitive ones: %s %s', async (method, path) => {
      expect((await t.request(method, path, { actor: umid, body: {} })).status).toBe(403);
    });

    it.each([
      ['approve', 'approve'],
      ['reject', 'reject'],
      ['cancel', 'cancel'],
      ['accounting approve', 'accounting-approve'],
      ['release', 'release'],
      ['allocations', 'allocations'],
    ])('cannot %s a real order, and the order stays', async (_label, action) => {
      const order = await submitOrder(w);
      const reply = await t.request('POST', `/staff/orders/${order.id}/${action}`, {
        actor: umid,
        body: { expectedRowVersion: 1, reason: 'x' },
      });
      expect(reply.status).toBe(403);
      const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored.status).toBe('SUBMITTED');
    });

    it('may press the sheet sync', async () => {
      const reply = await t.request('POST', '/staff/sheet-sync/runs', { actor: umid });
      expect(reply.status, JSON.stringify(reply.body)).not.toBe(403);
    });
  });

  describe('reads', () => {
    async function readPaths(): Promise<[string, string][]> {
      const order = await submitOrder(w);
      const { p1 } = w.products;
      const version = await t.prisma.priceListVersion.findFirstOrThrow({
        where: { status: 'PUBLISHED' },
      });
      return [
        ['orders', '/staff/orders'],
        ['order counts', '/staff/orders/counts'],
        ['an order', `/staff/orders/${order.id}`],
        ['its timeline', `/staff/orders/${order.id}/timeline`],
        ['dashboard', '/staff/dashboard/summary'],
        ['products', '/staff/products'],
        ['a product', `/staff/products/${p1}`],
        ['categories', '/staff/product-categories'],
        ['sheet categories', '/staff/product-categories/sheet'],
        ['brands', '/staff/brands'],
        ['unbranded', '/staff/brands/unbranded-products'],
        ['price list', '/staff/price-list/current'],
        ['costs', '/staff/price-list/current/costs'],
        ['versions', '/staff/price-list/versions'],
        ['a version', `/staff/price-list/versions/${version.id}`],
        ['price history', `/staff/products/${p1}/price-history`],
        ['cost reference', `/staff/products/${p1}/cost-reference`],
        ['stock', '/staff/stock'],
        ['unpriced', '/staff/products/unpriced'],
        ['removals', '/staff/supply-removals'],
        ['sync runs', '/staff/sheet-sync/runs'],
        ['organizations', '/staff/organizations'],
        ['an organization', `/staff/organizations/${w.orgA}`],
        ['its balance', `/staff/organizations/${w.orgA}/balance`],
        ['customers', '/staff/users'],
        ['a customer', `/staff/users/${w.ids.ownerA}`],
        ['removal status', `/staff/users/${w.ids.ownerA}/removal-status`],
        ['a person card', `/staff/people/${w.ids.ownerA}`],
        ['a staff person card', `/staff/people/${w.ids.manager}`],
        ['staff directory', '/staff/accounts/directory'],
        ['own profile', '/me'],
        ['own bot state', '/staff/me/notifications'],
      ];
    }

    it('gets 200 on every read of the manager pages, with no credential field', async () => {
      const wrong: string[] = [];
      for (const [label, path] of await readPaths()) {
        const reply = await t.request('GET', path, { actor: umid });
        if (reply.status !== 200) wrong.push(`${label} ${path} -> ${reply.status}`);
        const leaked = collectKeys(reply.body).filter((key) => CREDENTIAL_KEY.test(key));
        if (leaked.length > 0) wrong.push(`${label} leaks ${leaked.join(',')}`);
        const ids = telegramValues(reply.body);
        if (ids.length > 0) wrong.push(`${label} has Telegram ids in ${ids.join(',')}`);
      }
      expect(wrong).toEqual([]);
    });

    it('downloads the price list file', async () => {
      const base = await t.app.getUrl();
      const response = await fetch(`${base}/staff/price-list/current/excel`, {
        headers: { [ACTOR_HEADER]: JSON.stringify(umid) },
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    it('sees the payment method and the money of an order', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      const reply = await t.request('GET', `/staff/orders/${order.id}`, { actor: umid });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ detail: 'FULL', paymentMethod: 'CASH' });
      expect((reply.body as { totalAmount: unknown }).totalAmount).toEqual(expect.any(String));
    });

    it('the staff directory has names, roles and status only', async () => {
      const reply = await t.request('GET', '/staff/accounts/directory', { actor: umid });
      expect(reply.status).toBe(200);
      const { items } = reply.body as { items: Record<string, unknown>[] };
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([
          'createdAt',
          'fullName',
          'id',
          'roles',
          'status',
        ]);
      }
    });

    it('the customer list hides staff people, whose phone and Telegram id it would carry', async () => {
      const reply = await t.request('GET', '/staff/users', { actor: umid });
      const { items } = reply.body as { items: { id: string; staffRoles: string[] }[] };
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.staffRoles.length === 0)).toBe(true);
      const staffPerson = await t.request('GET', `/staff/users/${w.ids.manager}`, { actor: umid });
      expect(staffPerson.status).toBe(404);
      // The manager's own view is unchanged.
      const asManager = await t.request('GET', `/staff/users/${w.ids.accountant}`, {
        actor: w.actors.manager,
      });
      expect(asManager.status).toBe(200);
    });

    describe('Telegram ids', () => {
      const ADDED_BY_ID = 770077007700n;
      let chatId: string;
      let ownerTelegramId: string;

      beforeEach(async () => {
        const org = await t.prisma.organization.update({
          where: { id: w.orgA },
          data: { addedByTelegramUserId: ADDED_BY_ID, addedByName: 'Who added the bot' },
        });
        chatId = String(org.telegramChatId);
        const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: w.ids.ownerA } });
        ownerTelegramId = String(owner.telegramUserId);
      });

      const expectNoId = (body: unknown): void => {
        const text = JSON.stringify(body);
        expect(text).not.toContain(chatId);
        expect(text).not.toContain(ownerTelegramId);
        expect(text).not.toContain(ADDED_BY_ID.toString());
        expect(telegramValues(body)).toEqual([]);
      };

      it.each([
        ['organization list', () => '/staff/organizations'],
        ['organization detail', () => `/staff/organizations/${w.orgA}`],
        ['customer list', () => '/staff/users'],
        ['customer detail', () => `/staff/users/${w.ids.ownerA}`],
        ['person card', () => `/staff/people/${w.ids.ownerA}`],
      ])('the %s carries none', async (_label, path) => {
        const reply = await t.request('GET', path(), { actor: umid });
        expect(reply.status).toBe(200);
        expectNoId(reply.body);
      });

      it('keeps what the manager pages show: the phone and who added the bot', async () => {
        const person = await t.request('GET', `/staff/users/${w.ids.ownerA}`, { actor: umid });
        const stored = await t.prisma.user.findUniqueOrThrow({ where: { id: w.ids.ownerA } });
        expect(stored.phone).not.toBeNull();
        expect(person.body).toMatchObject({ phone: stored.phone, telegramUserId: null });
        const org = await t.request('GET', `/staff/organizations/${w.orgA}`, { actor: umid });
        expect(org.body).toMatchObject({
          telegramChatId: null,
          addedBy: { telegramUserId: null, name: 'Who added the bot' },
        });
      });

      it('the person card opens by user id, not by a Telegram id', async () => {
        const byUser = await t.request('GET', `/staff/people/${w.ids.ownerA}`, { actor: umid });
        expect(byUser.status).toBe(200);
        const byTelegram = await t.request('GET', `/staff/people/by-telegram/${ownerTelegramId}`, {
          actor: umid,
        });
        expect(byTelegram.status).toBe(403);
      });

      it("the card shows a customer's phone, never a staff member's", async () => {
        await t.prisma.user.update({
          where: { id: w.ids.manager },
          data: { phone: '+998900000099' },
        });
        const staffCard = await t.request('GET', `/staff/people/${w.ids.manager}`, { actor: umid });
        expect(staffCard.body).toMatchObject({ fullName: 'Manager', phone: null });
        const customerCard = await t.request('GET', `/staff/people/${w.ids.ownerA}`, {
          actor: umid,
        });
        expect((customerCard.body as { phone: unknown }).phone).toEqual(expect.any(String));
        const asManager = await t.request('GET', `/staff/people/${w.ids.manager}`, {
          actor: w.actors.manager,
        });
        expect(asManager.body).toMatchObject({ phone: '+998900000099' });
      });

      it('a search cannot tell whose Telegram id it is', async () => {
        const query = `search=${ownerTelegramId}`;
        const reply = await t.request('GET', `/staff/users?${query}`, { actor: umid });
        expect((reply.body as { items: unknown[] }).items).toEqual([]);
        const asManager = await t.request('GET', `/staff/users?${query}`, {
          actor: w.actors.manager,
        });
        expect((asManager.body as { items: { id: string }[] }).items.map((u) => u.id)).toEqual([
          w.ids.ownerA,
        ]);
      });

      it("the editors' responses are unchanged", async () => {
        for (const actor of [w.actors.manager, w.actors.admin]) {
          const org = await t.request('GET', `/staff/organizations/${w.orgA}`, { actor });
          expect(org.body).toMatchObject({
            telegramChatId: chatId,
            addedBy: { telegramUserId: ADDED_BY_ID.toString(), name: 'Who added the bot' },
          });
          const list = await t.request('GET', '/staff/organizations', { actor });
          const row = (list.body as { items: { id: string; telegramChatId: string }[] }).items.find(
            (item) => item.id === w.orgA,
          );
          expect(row?.telegramChatId).toBe(chatId);
          const person = await t.request('GET', `/staff/users/${w.ids.ownerA}`, { actor });
          expect(person.body).toMatchObject({ telegramUserId: ownerTelegramId });
        }
      });
    });

    it.each([
      ['the accounts with logins', '/staff/accounts'],
      ['the open draft', '/staff/price-list/drafts/current'],
      ['the supply search of the party dialog', '/staff/supplies'],
      ['product photos management', '/staff/product-images/products'],
    ])('does not read %s', async (_label, path) => {
      expect((await t.request('GET', path, { actor: umid })).status).toBe(403);
    });

    it('the new reads stay closed to the other roles', async () => {
      for (const actor of [w.actors.accountant, w.actors.warehouse, w.actors.driver]) {
        for (const path of ['/staff/products', '/staff/brands', '/staff/price-list/versions']) {
          expect((await t.request('GET', path, { actor })).status).toBe(403);
        }
      }
      for (const actor of [w.actors.warehouse, w.actors.driver, w.actors.accountant]) {
        for (const path of ['/staff/users', '/staff/organizations', '/staff/accounts/directory']) {
          expect((await t.request('GET', path, { actor })).status).toBe(403);
        }
      }
      expect((await t.request('GET', '/staff/products', { actor: w.actors.ownerA })).status).toBe(
        403,
      );
    });
  });

  describe('in-app list', () => {
    const PATH = '/staff/orders/marked-notifications';
    type Feed = { items: { type: string; orderId: string; lines: Record<string, string>[] }[] };

    it('shows the order with its marked lines only, with no money or cost', async () => {
      await mark(w.products.p2);
      const order = await submitOrder(w, w.actors.sellerA, {
        items: [
          [w.products.p1, '1'],
          [w.products.p2, '2'],
        ],
      });
      const res = await t.request('GET', PATH, { actor: umid });
      expect(res.status).toBe(200);
      const body = res.body as Feed;
      expect(body.items.map((i) => [i.type, i.orderId])).toEqual([['ORDER_SUBMITTED', order.id]]);
      expect(body.items[0]?.lines).toHaveLength(1);
      expect(body.items[0]?.lines[0]?.quantity).toBe('2.000');
      expect(JSON.stringify(body)).not.toMatch(/cost|purchase|supplier|margin|rate|price|total/i);
    });

    it('an order without a marked product does not appear', async () => {
      await submitOrder(w);
      const res = await t.request('GET', PATH, { actor: umid });
      expect((res.body as Feed).items).toEqual([]);
    });

    it('is closed to every other role, and is not taken for an order id', async () => {
      for (const actor of [
        w.actors.manager,
        w.actors.accountant,
        w.actors.warehouse,
        w.actors.driver,
        w.actors.ownerA,
      ]) {
        expect((await t.request('GET', PATH, { actor })).status).toBe(403);
      }
    });
  });

  describe('bot messages', () => {
    it('a new order without a marked product: nothing', async () => {
      await submitOrder(w);
      expect(await purchasingRows()).toEqual([]);
    });

    it('a new order with a marked product: one row, marked lines first, no cost', async () => {
      await mark(w.products.p2);
      const order = await submitOrder(w, w.actors.sellerA, {
        items: [
          [w.products.p1, '1'],
          [w.products.p2, '2'],
        ],
      });
      const rows = await purchasingRows();
      expect(rows.map((row) => [row.type, row.recipientKind, row.orderId])).toEqual([
        ['ORDER_SUBMITTED', 'ROLE', order.id],
      ]);
      const payload = rows[0]?.payload as {
        orderNumber: string;
        orderLines: { productCode: string; marked: boolean; quantity: string }[];
      };
      expect(payload.orderNumber).toBe(order.orderNumber);
      expect(payload.orderLines.map((line) => line.marked)).toEqual([true, false]);
      expect(JSON.stringify(payload)).not.toMatch(/cost|purchase|supplier|margin|rate/i);
      // The row and the event are one transaction: the row points at the event.
      expect(rows[0]?.orderEventId).not.toBeNull();
    });

    it('sends it to the role with the two staff buttons', async () => {
      await mark(w.products.p1);
      await submitOrder(w);
      await t.get(OutboxDispatcher).runOnce();
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: umid.userId } });
      const message = sender.sent.find((m) => m.chatId === String(user.telegramUserId));
      expect(message?.text).toContain('Markirovkali tovarlar:');
      expect(message?.options?.buttons?.map((b) => ['url' in b, 'webAppUrl' in b])).toEqual([
        [true, false],
        [false, true],
      ]);
    });

    it('an edit of lines already on the order says nothing, marked or not', async () => {
      await mark(w.products.p1);
      const order = await submitOrder(w);
      const before = (await purchasingRows()).length;
      const item = (await t.prisma.orderItem.findMany({ where: { orderId: order.id } }))[0];
      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: item?.id ?? '', quantity: '5' }],
      });
      expect(await purchasingRows()).toHaveLength(before);
    });

    it('a cancellation: only when the order holds a marked product', async () => {
      const plain = await submitOrder(w);
      await w.step(w.actors.manager, plain.id, { to: 'CANCELLED', reason: 'no' });
      expect(await purchasingRows()).toEqual([]);

      await mark(w.products.p1);
      const marked = await submitOrder(w);
      await w.step(w.actors.manager, marked.id, { to: 'CANCELLED', reason: 'no' });
      const rows = await purchasingRows();
      expect(rows.map((row) => row.type)).toEqual(['ORDER_SUBMITTED', 'ORDER_CANCELLED']);
      expect(rows[1]?.payload).toMatchObject({ reason: 'no', orderNumber: marked.orderNumber });
    });

    it('a rejection says nothing: the owner did not ask for it', async () => {
      await mark(w.products.p1);
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'REJECTED', reason: 'no' });
      expect((await purchasingRows()).map((row) => row.type)).toEqual(['ORDER_SUBMITTED']);
    });
  });
});
