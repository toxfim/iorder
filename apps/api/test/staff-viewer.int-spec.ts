import {
  cartResponseSchema,
  customerBalanceResponseSchema,
  customerGoodsListSchema,
  customerGoodsSummarySchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerPriceListResponseSchema,
  customerTimelineResponseSchema,
  meResponseSchema,
} from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import {
  findForbiddenKeys,
  findStaffOnlyFieldsInCustomerPriceList,
} from './support/forbidden-fields.js';
import { customerActor, makeMember, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { signedLoginWidget } from './support/login-widget.js';
import { assertCustomerSafe, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// Staff members may open the CUSTOMER app as viewers ([C] 2026-11-09). Everything here goes
// through the PRODUCTION actor resolver over real HTTP: a real sign-in at the customer door, a
// real session token or real Mini App init data, a real PostgreSQL with two real organizations.

type Headers = Record<string, string>;

const TEST_ORG_ID = '0198c0de-5a17-7000-8000-00000000c0de';
const PASSWORD = 'manager secret password';
/** `2 x p1` of the test world: 2 x 1500.00. */
const TWO_APPLES = { paymentPlan: 'FULL', expectedTotalAmount: '3000.00' };

const bearer = (token: string): Headers => ({ authorization: `Bearer ${token}` });

let clockStep = 0;

function suite(env: Partial<Env>) {
  const state = {} as { t: TestApp; w: World };

  beforeAll(async () => {
    state.t = await createTestApp([IdentityModule, OrdersModule], {
      botToken: FAKE_BOT_TOKEN,
      env,
      overrides: [{ token: PasswordHasher, value: new PasswordHasher({ N: 1024, r: 8, p: 1 }) }],
    });
    await state.t.prisma.$connect();
  });
  afterAll(async () => {
    await state.t.close();
  });
  beforeEach(async () => {
    state.w = await createWorld(state.t);
    // A fresh hour per test: the sign-in throttles (in memory, per app) start empty.
    state.t.clock.set(new Date(Date.UTC(2026, 9, 21, 8) + (clockStep += 1) * 3_600_000));
  });

  const telegramIdOf = async (userId: string): Promise<bigint> => {
    const user = await state.t.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.telegramUserId === null) throw new Error('fixture user without a Telegram id');
    return user.telegramUserId;
  };

  const helpers = {
    /** Mini App init data of the person: the same header in the staff and the customer app. */
    miniApp: async (userId: string): Promise<Headers> =>
      tma(signedInitData({ telegramUserId: await telegramIdOf(userId), now: state.t.clock.now() })),

    async giveStaffLogin(userId: string, login: string, password = PASSWORD): Promise<void> {
      await state.t.prisma.staffCredential.create({
        data: {
          userId,
          scope: 'STAFF',
          login,
          passwordHash: await state.t.get(PasswordHasher).hash(password),
          passwordChangedAt: state.t.clock.now(),
        },
      });
    },

    customerDoor: (login: string, password: string) =>
      state.t.request('POST', '/customer/auth/password-login', { body: { login, password } }),

    /** A staff member signed in at the customer door with the staff login and password. */
    async viewerSession(userId: string, login: string): Promise<Headers> {
      await helpers.giveStaffLogin(userId, login);
      const reply = await helpers.customerDoor(login, PASSWORD);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return bearer((reply.body as { token: string }).token);
    },

    get: (path: string, headers: Headers) => state.t.request('GET', path, { headers }),

    putItem: (headers: Headers, productId: string, quantity: string) =>
      state.t.request('PUT', `/cart/items/${productId}`, { headers, body: { quantity } }),

    submit: (headers: Headers, key: string, body: unknown = TWO_APPLES) =>
      state.t.request('POST', '/orders', {
        headers: { ...headers, 'idempotency-key': key },
        body,
      }),

    ordersOf: (organizationId: string) => state.t.prisma.order.count({ where: { organizationId } }),
  };
  return { state, ...helpers };
}

describe('staff viewer in the customer app: no organization for staff orders (production)', () => {
  const s = suite({});
  const { state } = s;

  describe('sign-in at the customer door', () => {
    it('a staff login and password open a VIEWER session: no staff roles, no membership', async () => {
      const { w, t } = state;
      const auth = await s.viewerSession(w.ids.manager, 'boss');

      const me = expectParsed(await s.get('/me', auth), 200, meResponseSchema);
      expect(me).toMatchObject({
        userId: w.ids.manager,
        staffRoles: [],
        membership: null,
        contact: null,
        needsContact: false,
        staffViewer: { canOrder: false, organizationName: null },
      });

      // The session row is a viewer session and history says so, as a customer-door sign-in.
      const session = await t.prisma.staffSession.findFirstOrThrow({
        where: { userId: w.ids.manager },
      });
      expect(session).toMatchObject({ staffViewer: true, method: 'PASSWORD', revokedAt: null });
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { entityId: session.id, action: 'CUSTOMER_SESSION_CREATED' },
      });
      expect(audit.actorUserId).toBe(w.ids.manager);
      expect(audit.diff).toMatchObject({ staffViewer: { from: null, to: true } });
      await expect(
        t.prisma.auditLog.count({ where: { action: 'STAFF_SESSION_CREATED' } }),
      ).resolves.toBe(0);
    });

    it('the viewer token never works on a staff route, although the person is a manager', async () => {
      const { w } = state;
      const auth = await s.viewerSession(w.ids.manager, 'boss');
      for (const path of [
        '/staff/orders',
        '/staff/orders/counts',
        '/staff/users',
        '/staff/organizations',
        `/staff/organizations/${w.orgA}`,
        `/staff/organizations/${w.orgA}/balance`,
        '/staff/price-list/current',
        '/staff/price-list/current/costs',
        '/staff/usd-rate',
        '/staff/stock',
        '/staff/accounts',
      ]) {
        expectError(await s.get(path, auth), 403, 'FORBIDDEN');
      }
      // The same person's STAFF session still has the staff powers: nothing was taken away.
      const staffDoor = await state.t.request('POST', '/auth/password-login', {
        body: { login: 'boss', password: PASSWORD },
      });
      expect(staffDoor.status).toBe(200);
      const staffAuth = bearer((staffDoor.body as { token: string }).token);
      expect((await s.get('/staff/orders', staffAuth)).status).toBe(200);
      // And the viewer flag cannot be flipped on a stored session (trigger).
      await expect(
        state.t.prisma.staffSession.updateMany({
          where: { userId: w.ids.manager, staffViewer: true },
          data: { staffViewer: false },
        }),
      ).rejects.toThrow();
    });

    it('a Telegram Login Widget proof of a staff member opens a viewer session too', async () => {
      const { w, t } = state;
      const proof = signedLoginWidget({
        telegramUserId: await t.prisma.user
          .findUniqueOrThrow({ where: { id: w.ids.accountant } })
          .then((user) => user.telegramUserId ?? 0n),
        now: t.clock.now(),
      });
      const reply = await t.request('POST', '/customer/auth/telegram-widget', { body: proof });
      expect(reply.status).toBe(200);
      const auth = bearer((reply.body as { token: string }).token);
      const me = expectParsed(await s.get('/me', auth), 200, meResponseSchema);
      expect(me).toMatchObject({ staffRoles: [], membership: null });
      expect(me.staffViewer).toEqual({ canOrder: false, organizationName: null });
      expectError(await s.get('/staff/orders', auth), 403, 'FORBIDDEN');
      // The same proof cannot be replayed.
      expect(
        (await t.request('POST', '/customer/auth/telegram-widget', { body: proof })).status,
      ).toBe(401);
    });

    it('Mini App init data of a staff member: `/me` names the viewer mode and the customer routes treat them as one', async () => {
      const { w } = state;
      await submitOrder(w, w.actors.sellerA);
      await submitOrder(w, w.actors.sellerB);
      const auth = await s.miniApp(w.ids.manager);

      // `/me` is shared with the staff app, so the roles are still there; the customer app
      // reads only `staffViewer`.
      const me = expectParsed(await s.get('/me', auth), 200, meResponseSchema);
      expect(me).toMatchObject({ staffRoles: ['MANAGER'], membership: null, needsContact: false });
      expect(me.staffViewer).toEqual({ canOrder: false, organizationName: null });

      // The manager reads EVERY order through the staff route ...
      const staffList = await s.get('/staff/orders', auth);
      expect((staffList.body as { orders: unknown[] }).orders).toHaveLength(2);
      // ... and none through the customer route, with the very same credentials.
      const list = expectParsed(await s.get('/orders', auth), 200, customerOrderListResponseSchema);
      expect(list.orders).toEqual([]);
      expect((await s.get('/cart', auth)).status).toBe(200);
    });

    it('a blocked staff member gets in nowhere, and a live viewer session dies with the block', async () => {
      const { w, t } = state;
      const auth = await s.viewerSession(w.ids.manager, 'boss');
      expect((await s.get('/me', auth)).status).toBe(200);

      await t.prisma.user.update({ where: { id: w.ids.manager }, data: { status: 'BLOCKED' } });

      expect((await s.get('/me', auth)).status).toBe(401);
      expect((await s.get('/price-list/current', auth)).status).toBe(401);
      expect((await s.customerDoor('boss', PASSWORD)).status).toBe(401);
      expect((await s.get('/me', await s.miniApp(w.ids.manager))).status).toBe(401);
      const proof = signedLoginWidget({
        telegramUserId: await t.prisma.user
          .findUniqueOrThrow({ where: { id: w.ids.manager } })
          .then((user) => user.telegramUserId ?? 0n),
        now: t.clock.now(),
      });
      expect(
        (await t.request('POST', '/customer/auth/telegram-widget', { body: proof })).status,
      ).toBe(401);
    });

    it('the warehouse and the driver are not viewers: same refusal as a wrong password [P]', async () => {
      const { w, t } = state;
      await s.giveStaffLogin(w.ids.warehouse, 'store');
      await s.giveStaffLogin(w.ids.driver, 'wheels');
      const wrong = await s.customerDoor('store', 'not the password at all');
      const unknown = await s.customerDoor('nobody.here', PASSWORD);
      for (const reply of [
        await s.customerDoor('store', PASSWORD),
        await s.customerDoor('wheels', PASSWORD),
      ]) {
        expect(reply.status).toBe(401);
        expect(reply.body).toEqual(wrong.body);
        expect(reply.body).toEqual(unknown.body);
      }
      await expect(t.prisma.staffSession.count()).resolves.toBe(0);
      // In the Mini App they are nobody on the customer routes.
      const auth = await s.miniApp(w.ids.warehouse);
      const me = expectParsed(await s.get('/me', auth), 200, meResponseSchema);
      expect(me.staffViewer).toBeNull();
      for (const path of ['/price-list/current', '/cart', '/orders', '/me/balance']) {
        expectError(await s.get(path, auth), 403, 'FORBIDDEN');
      }
      // A viewer session ends when the roles that open the customer app are gone.
      const viewer = await s.viewerSession(w.ids.accountant, 'books');
      await t.prisma.userRole.deleteMany({ where: { userId: w.ids.accountant } });
      await t.prisma.userRole.create({ data: { userId: w.ids.accountant, role: 'DRIVER' } });
      expect((await s.get('/me', viewer)).status).toBe(401);
    });

    it('keeps every password protection: one answer for every failure, failures counted, lock honoured', async () => {
      const { w, t } = state;
      await s.giveStaffLogin(w.ids.manager, 'boss');
      const unknown = await s.customerDoor('nobody.here', 'whatever password');
      const wrong = await s.customerDoor('boss', 'whatever password');
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);

      // The wrong guess counted against the staff login, as it would at the staff door.
      const credential = () =>
        t.prisma.staffCredential.findFirstOrThrow({ where: { userId: w.ids.manager } });
      expect((await credential()).failedAttempts).toBe(1);

      // A locked login answers the same even with the right password, and is not counted.
      await t.prisma.staffCredential.updateMany({
        where: { userId: w.ids.manager },
        data: { lockedUntil: new Date(t.clock.now().getTime() + 600_000) },
      });
      const locked = await s.customerDoor('boss', PASSWORD);
      expect(locked.status).toBe(401);
      expect(locked.body).toEqual(unknown.body);
      expect((await credential()).failedAttempts).toBe(1);
      await expect(t.prisma.staffSession.count()).resolves.toBe(0);

      // No answer ever carries the password, a hash or the person.
      expect(JSON.stringify([unknown.body, wrong.body, locked.body])).not.toMatch(
        /whatever|secret|hash|boss/i,
      );
    });

    it('one login text in both scopes: the customer login is tried first, the staff login second', async () => {
      const { w, t } = state;
      const customerPassword = 'customer secret password';
      await t.prisma.staffCredential.create({
        data: {
          userId: w.ids.sellerA,
          scope: 'CUSTOMER',
          login: 'shared.login',
          passwordHash: await t.get(PasswordHasher).hash(customerPassword),
          passwordChangedAt: t.clock.now(),
        },
      });
      await s.giveStaffLogin(w.ids.manager, 'shared.login');
      const failures = async (userId: string) =>
        (await t.prisma.staffCredential.findFirstOrThrow({ where: { userId } })).failedAttempts;

      // The customer's password: the customer, in their own organization.
      const asCustomer = await s.customerDoor('shared.login', customerPassword);
      expect(asCustomer.status).toBe(200);
      const customerMe = await s.get('/me', bearer((asCustomer.body as { token: string }).token));
      expect(customerMe.body).toMatchObject({
        userId: w.ids.sellerA,
        membership: { organizationId: w.orgA },
        staffViewer: null,
      });

      // The staff password: the staff member, as a viewer. The customer is not penalised for it.
      const asStaff = await s.customerDoor('shared.login', PASSWORD);
      expect(asStaff.status).toBe(200);
      const staffMe = await s.get('/me', bearer((asStaff.body as { token: string }).token));
      expect(staffMe.body).toMatchObject({ userId: w.ids.manager, membership: null });
      expect(await failures(w.ids.sellerA)).toBe(0);

      // A password of neither: one wrong guess against each of the two logins.
      expect((await s.customerDoor('shared.login', 'neither of the two')).status).toBe(401);
      expect(await failures(w.ids.sellerA)).toBe(1);
      expect(await failures(w.ids.manager)).toBe(1);

      // The staff door is unchanged: it never accepts the customer's password.
      const staffDoor = (password: string) =>
        t.request('POST', '/auth/password-login', { body: { login: 'shared.login', password } });
      expect((await staffDoor(customerPassword)).status).toBe(401);
      expect((await staffDoor(PASSWORD)).status).toBe(200);
    });

    it('the customer credential routes stay customer-only and "taken" still hides staff logins', async () => {
      const { w } = state;
      const viewer = await s.viewerSession(w.ids.manager, 'boss');
      for (const auth of [viewer, await s.miniApp(w.ids.manager)]) {
        expectError(await s.get('/customer/auth/credentials', auth), 403, 'FORBIDDEN');
        expectError(
          await state.t.request('PUT', '/customer/auth/credentials', {
            headers: auth,
            body: { login: 'viewer.login', password: 'another long password' },
          }),
          403,
          'FORBIDDEN',
        );
      }
      // A customer may still take the very text a staff member uses: nothing is revealed.
      const taken = await state.t.request('PUT', '/customer/auth/credentials', {
        headers: await s.miniApp(w.ids.sellerA),
        body: { login: 'boss', password: 'customer secret password' },
      });
      expect(taken.status).toBe(200);
      await expect(
        state.t.prisma.staffCredential.count({ where: { userId: w.ids.manager } }),
      ).resolves.toBe(1);
    });
  });

  describe('what the viewer reads', () => {
    it('the published price list, byte for byte what a customer gets, with no cost field', async () => {
      const { w } = state;
      const customer = await s.get('/price-list/current', await s.miniApp(w.ids.sellerA));
      expect(customer.status).toBe(200);
      for (const auth of [
        await s.viewerSession(w.ids.manager, 'boss'),
        await s.miniApp(w.ids.admin),
        await s.miniApp(w.ids.accountant),
      ]) {
        const reply = await s.get('/price-list/current', auth);
        const list = expectParsed(reply, 200, customerPriceListResponseSchema); // strict
        expect(list.items.length).toBe(2);
        expect(findForbiddenKeys(reply.body)).toEqual([]);
        expect(findStaffOnlyFieldsInCustomerPriceList(reply.body)).toEqual([]);
        expect(reply.body).toEqual(customer.body);
      }
    });

    it('no organization`s orders, balance, goods or members, with two organizations that have them', async () => {
      const { w } = state;
      const received = await orderAt(w, 'RECEIVED');
      const orderB = await submitOrder(w, w.actors.sellerB);
      // Organization A really owes money and really has orders: the zero below is not luck.
      expect((await w.payments.getOwnAmountDue(w.actors.sellerA)).isZero()).toBe(false);
      expect(await s.ordersOf(w.orgA)).toBe(1);
      expect(await s.ordersOf(w.orgB)).toBe(1);

      for (const auth of [
        await s.viewerSession(w.ids.manager, 'boss'),
        await s.miniApp(w.ids.manager),
        await s.miniApp(w.ids.admin),
      ]) {
        const orders = expectParsed(
          await s.get('/orders', auth),
          200,
          customerOrderListResponseSchema,
        );
        expect(orders).toEqual({ orders: [], nextCursor: null });
        for (const id of [received.id, orderB.id]) {
          expectError(await s.get(`/orders/${id}`, auth), 404, 'NOT_FOUND');
          expectError(await s.get(`/orders/${id}/timeline`, auth), 404, 'NOT_FOUND');
          expectError(
            await state.t.request('POST', `/orders/${id}/receive`, { headers: auth, body: {} }),
            403,
            'FORBIDDEN',
          );
          expectError(
            await state.t.request('PUT', `/orders/${id}/payment-plan`, {
              headers: auth,
              body: { paymentPlan: 'DEFERRED' },
            }),
            403,
            'FORBIDDEN',
          );
        }

        const balance = expectParsed(
          await s.get('/me/balance', auth),
          200,
          customerBalanceResponseSchema,
        );
        expect(balance).toEqual({ amountDue: '0.00', currency: 'UZS' });

        expect(
          expectParsed(await s.get('/me/products/summary', auth), 200, customerGoodsSummarySchema),
        ).toEqual({ hasProducts: false, productCount: 0, unitCount: 0, discoveryPending: false });
        expect(
          expectParsed(await s.get('/me/products', auth), 200, customerGoodsListSchema),
        ).toEqual({ products: [], nextCursor: null });
        expectError(await s.get(`/me/products/${w.products.p1}`, auth), 404, 'NOT_FOUND');
        expectError(
          await state.t.request('POST', '/me/products/discovery/ack', { headers: auth }),
          403,
          'FORBIDDEN',
        );
        expectError(
          await state.t.request('PUT', '/me/contact', {
            headers: auth,
            body: { fullName: 'A Viewer', phone: '+998901234567' },
          }),
          403,
          'FORBIDDEN',
        );
      }

      // The customers of both organizations still see exactly their own.
      const ownA = await s.get('/orders', await s.miniApp(w.ids.sellerA));
      expect((ownA.body as { orders: { id: string }[] }).orders.map((o) => o.id)).toEqual([
        received.id,
      ]);
      const ownB = await s.get('/orders', await s.miniApp(w.ids.sellerB));
      expect((ownB.body as { orders: { id: string }[] }).orders.map((o) => o.id)).toEqual([
        orderB.id,
      ]);
    });
  });

  describe('the cart works, the order does not', () => {
    it('keeps a personal cart that belongs to no organization, one per person', async () => {
      const { w, t } = state;
      await w.carts.setItemQuantity(w.actors.sellerA, w.products.p2, '7');
      const viewer = await s.viewerSession(w.ids.manager, 'boss');
      const other = await s.miniApp(w.ids.accountant);

      const empty = expectParsed(await s.get('/cart', viewer), 200, cartResponseSchema);
      expect(empty.lines).toEqual([]);

      const filled = expectParsed(
        await s.putItem(viewer, w.products.p1, '2'),
        200,
        cartResponseSchema,
      );
      expect(filled).toMatchObject({ totalAmount: '3000.00', currency: 'UZS', canSubmit: true });
      expect(filled.lines).toHaveLength(1);
      assertCustomerSafe(filled, w);

      // Stored with NO organization, and the same cart whichever way the person comes in.
      const carts = await t.prisma.cart.findMany({ where: { userId: w.ids.manager } });
      expect(carts).toHaveLength(1);
      expect(carts[0]?.organizationId).toBeNull();
      const viaMiniApp = await s.get('/cart', await s.miniApp(w.ids.manager));
      expect(viaMiniApp.body).toEqual(filled);

      // Another viewer and the customers have their own carts; nobody sees anybody's.
      expect(expectParsed(await s.get('/cart', other), 200, cartResponseSchema).lines).toEqual([]);
      await s.putItem(other, w.products.p2, '1');
      await expect(t.prisma.cart.count({ where: { organizationId: null } })).resolves.toBe(2);
      const customerCart = await w.carts.getCart(w.actors.sellerA);
      expect(customerCart.lines.map((line) => line.quantity.toFixed(0))).toEqual(['7']);

      // Removing works too.
      const removed = await t.request('DELETE', `/cart/items/${w.products.p1}`, {
        headers: viewer,
      });
      expect(expectParsed(removed, 200, cartResponseSchema).lines).toEqual([]);
      // An unpriced product is refused exactly as for a customer.
      expectError(
        await s.putItem(viewer, w.products.p3, '1'),
        409,
        'CONFLICT',
        'PRODUCT_NOT_ORDERABLE',
      );
    });

    it('refuses the order with a typed error and writes nothing, however the viewer came in', async () => {
      const { w, t } = state;
      for (const [index, auth] of [
        await s.viewerSession(w.ids.manager, 'boss'),
        await s.miniApp(w.ids.admin),
      ].entries()) {
        await s.putItem(auth, w.products.p1, '2');
        const reply = await s.submit(auth, `staff-order-key-${index}`);
        expectError(reply, 409, 'CONFLICT', 'STAFF_ORDERING_DISABLED');
        // The cart is still there for the person.
        const cart = expectParsed(await s.get('/cart', auth), 200, cartResponseSchema);
        expect(cart.lines).toHaveLength(1);
      }
      await expect(t.prisma.order.count()).resolves.toBe(0);
      await expect(t.prisma.orderEvent.count()).resolves.toBe(0);
      await expect(t.prisma.notificationOutbox.count()).resolves.toBe(0);
    });

    it('the request cannot name an organization: there is no such field', async () => {
      const { w, t } = state;
      const viewer = await s.viewerSession(w.ids.manager, 'boss');
      await s.putItem(viewer, w.products.p1, '2');
      const reply = await s.submit(viewer, 'staff-order-key-org', {
        ...TWO_APPLES,
        organizationId: w.orgA,
      });
      expect(reply.status).toBe(422);
      await expect(t.prisma.order.count()).resolves.toBe(0);
    });
  });
});

describe('staff viewer in the customer app: an organization for staff orders (staging)', () => {
  const s = suite({ STAFF_ORDERING_ORGANIZATION_ID: TEST_ORG_ID });
  const { state } = s;

  const makeTestOrganization = (status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') =>
    state.t.prisma.organization.create({
      data: {
        id: TEST_ORG_ID,
        name: 'Staff test shop',
        telegramChatId: BigInt(-1_009_999_999_999),
        status,
      },
    });

  it('`/me` says ordering is on and names the organization the order goes to', async () => {
    await makeTestOrganization();
    const { w } = state;
    for (const auth of [
      await s.viewerSession(w.ids.manager, 'boss'),
      await s.miniApp(w.ids.accountant),
    ]) {
      const me = expectParsed(await s.get('/me', auth), 200, meResponseSchema);
      expect(me.staffViewer).toEqual({ canOrder: true, organizationName: 'Staff test shop' });
      expect(me.membership).toBeNull();
    }
    // A customer hears nothing about it.
    const customer = await s.get('/me', await s.miniApp(w.ids.sellerA));
    expect(meResponseSchema.parse(customer.body).staffViewer).toBeNull();
  });

  it('writes the order to exactly the configured organization, as an ordinary order of that staff member', async () => {
    await makeTestOrganization();
    const { w, t } = state;
    await submitOrder(w, w.actors.sellerA);
    await submitOrder(w, w.actors.sellerB);
    const viewer = await s.viewerSession(w.ids.manager, 'boss');
    await s.putItem(viewer, w.products.p1, '2');

    const reply = await s.submit(viewer, 'staff-order-key-1');
    const placed = expectParsed(reply, 201, customerOrderSchema);
    assertCustomerSafe(reply.body, w);
    expect(placed).toMatchObject({ status: 'SUBMITTED', totalAmount: '3000.00' });
    // A viewer reads the test order but is offered no plan change.
    expect(placed.paymentPlanChangeableUntil).toBeNull();
    expect(placed.paymentPlanTotals).toBeNull();

    const row = await t.prisma.order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(row).toMatchObject({
      organizationId: TEST_ORG_ID,
      placedByUserId: w.ids.manager,
      status: 'SUBMITTED',
    });
    // Never any other organization.
    expect(await s.ordersOf(TEST_ORG_ID)).toBe(1);
    expect(await s.ordersOf(w.orgA)).toBe(1);
    expect(await s.ordersOf(w.orgB)).toBe(1);

    // Hard rules 2 and 12: the event and its notifications were written with the order, and the
    // history names the staff member in the role they really hold.
    const events = await t.prisma.orderEvent.findMany({ where: { orderId: placed.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'SUBMITTED',
      toStatus: 'SUBMITTED',
      actorUserId: w.ids.manager,
      actorRole: 'MANAGER',
    });
    await expect(
      t.prisma.notificationOutbox.count({ where: { orderEventId: events[0]?.id ?? '' } }),
    ).resolves.toBeGreaterThan(0);

    // The cart was used up, and the same key returns the same order.
    expect(expectParsed(await s.get('/cart', viewer), 200, cartResponseSchema).lines).toEqual([]);
    const again = await s.submit(viewer, 'staff-order-key-1');
    expect(expectParsed(again, 201, customerOrderSchema).id).toBe(placed.id);
    expect(await s.ordersOf(TEST_ORG_ID)).toBe(1);

    // From here it is an order like any other: the manager rejects it through the one transition.
    const rejected = await w.step(w.actors.manager2, placed.id, {
      to: 'REJECTED',
      reason: 'a test order',
    });
    expect(rejected.status).toBe('REJECTED');
  });

  it('prices the viewer in the test organization tier: no Alif price, nothing to order [review 2026-11-12]', async () => {
    await makeTestOrganization();
    const { w, t } = state;
    await t.prisma.organization.update({
      where: { id: TEST_ORG_ID },
      data: { label: 'ALIF_FACTORING' },
    });
    const viewer = await s.viewerSession(w.ids.manager, 'boss');
    // The world's list has no Alif price: the viewer is offered nothing, never the standard price.
    const list = await s.get('/price-list/current', viewer);
    expect(list.status).toBe(200);
    expect((list.body as { items: unknown[] }).items).toEqual([]);
    const put = await s.putItem(viewer, w.products.p1, '1');
    expect(put.status).toBe(409);
    expect((put.body as { error: { reason: string } }).error.reason).toBe('PRODUCT_NOT_ORDERABLE');
  });

  it('the viewer reads only the test orders they placed themselves; nothing else, anywhere', async () => {
    await makeTestOrganization();
    const { w, t } = state;
    // A real member of the test organization and customers elsewhere have orders too.
    const tester = await makeUser(t.prisma, { name: 'Test client', phone: '+998711112233' });
    await makeMember(t.prisma, TEST_ORG_ID, tester.id, 'SHOP_OWNER');
    const memberOrder = await submitOrder(w, customerActor(tester.id, TEST_ORG_ID, 'SHOP_OWNER'));
    const orderA = await submitOrder(w, w.actors.sellerA);

    const viewer = await s.viewerSession(w.ids.manager, 'boss');
    await s.putItem(viewer, w.products.p1, '2');
    const own = expectParsed(await s.submit(viewer, 'own-order-key'), 201, customerOrderSchema);

    for (const auth of [viewer, await s.miniApp(w.ids.manager)]) {
      const list = expectParsed(await s.get('/orders', auth), 200, customerOrderListResponseSchema);
      expect(list.orders.map((order) => order.id)).toEqual([own.id]);
      assertCustomerSafe(list, w);
      expectParsed(await s.get(`/orders/${own.id}`, auth), 200, customerOrderSchema);
      expectParsed(
        await s.get(`/orders/${own.id}/timeline`, auth),
        200,
        customerTimelineResponseSchema,
      );
      for (const foreign of [memberOrder.id, orderA.id]) {
        expectError(await s.get(`/orders/${foreign}`, auth), 404, 'NOT_FOUND');
        expectError(await s.get(`/orders/${foreign}/timeline`, auth), 404, 'NOT_FOUND');
      }
      // The test order gives no further power over it.
      expectError(
        await t.request('POST', `/orders/${own.id}/receive`, { headers: auth, body: {} }),
        403,
        'FORBIDDEN',
      );
      expectError(
        await t.request('PUT', `/orders/${own.id}/payment-plan`, {
          headers: auth,
          body: { paymentPlan: 'DEFERRED' },
        }),
        403,
        'FORBIDDEN',
      );
      // Still no balance of anyone, the test organization included.
      expect((await s.get('/me/balance', auth)).body).toEqual({
        amountDue: '0.00',
        currency: 'UZS',
      });
    }

    // Another staff member sees neither the order nor the cart of the first.
    const colleague = await s.miniApp(w.ids.accountant);
    expect((await s.get('/orders', colleague)).body).toEqual({ orders: [], nextCursor: null });
    expectError(await s.get(`/orders/${own.id}`, colleague), 404, 'NOT_FOUND');
    // The member of the test organization sees the staff order as one of the organization's.
    const memberList = await s.get('/orders', await s.miniApp(tester.id));
    expect(
      (memberList.body as { orders: { id: string }[] }).orders.map((order) => order.id).sort(),
    ).toEqual([memberOrder.id, own.id].sort());
  });

  it('an inactive configured organization refuses the order and `/me` says so', async () => {
    await makeTestOrganization('INACTIVE');
    const { w, t } = state;
    const viewer = await s.viewerSession(w.ids.manager, 'boss');
    const me = expectParsed(await s.get('/me', viewer), 200, meResponseSchema);
    expect(me.staffViewer).toEqual({ canOrder: false, organizationName: null });

    await s.putItem(viewer, w.products.p1, '2');
    expectError(
      await s.submit(viewer, 'inactive-org-key'),
      409,
      'CONFLICT',
      'ORDERING_ORGANIZATION_INACTIVE',
    );
    await expect(t.prisma.order.count()).resolves.toBe(0);
  });

  it('a configured id that names no organization refuses too, and never falls back to another one', async () => {
    const { w, t } = state;
    const viewer = await s.viewerSession(w.ids.manager, 'boss');
    const me = expectParsed(await s.get('/me', viewer), 200, meResponseSchema);
    expect(me.staffViewer).toEqual({ canOrder: false, organizationName: null });

    await s.putItem(viewer, w.products.p1, '2');
    expectError(
      await s.submit(viewer, 'missing-org-key'),
      409,
      'CONFLICT',
      'ORDERING_ORGANIZATION_INACTIVE',
    );
    await expect(t.prisma.order.count()).resolves.toBe(0);
    expect((await s.get('/orders', viewer)).body).toEqual({ orders: [], nextCursor: null });
  });

  it('customers are untouched by the setting: they order into their own organization only', async () => {
    await makeTestOrganization();
    const { w } = state;
    const seller = await s.miniApp(w.ids.sellerA);
    await s.putItem(seller, w.products.p1, '2');
    const placed = expectParsed(await s.submit(seller, 'customer-key-1'), 201, customerOrderSchema);
    const row = await state.t.prisma.order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(row.organizationId).toBe(w.orgA);
    expect(await s.ordersOf(TEST_ORG_ID)).toBe(0);
  });
});
