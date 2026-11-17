import {
  ORDER_ROUTES,
  cartResponseSchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerTimelineResponseSchema,
} from '@iorder/shared';
import { STAFF_ORDER_ROUTES } from '@iorder/shared/staff-orders';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import {
  assertCustomerSafe,
  caller,
  expectError,
  expectParsed,
  type CallOptions,
  type Reply,
} from './support/orders-http.js';
import { containsStandalone } from './support/forbidden-fields.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, rejectedByResolver, type TestApp } from './support/test-app.js';

// `fill` below: 2 x p1 + 1 x p2.
const FILLED_CART_BODY = { paymentPlan: 'FULL', expectedTotalAmount: '3750.50' };

describe('customer HTTP: cart, submit, read, receive (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
  });

  /** A customer call whose 200/201 body is also scanned for leaks, every time. */
  const asCustomer = async (
    route: Parameters<typeof call>[0],
    options: CallOptions,
  ): Promise<Reply> => {
    const reply = await call(route, options);
    if (reply.status < 300) assertCustomerSafe(reply.body, w);
    return reply;
  };

  const putItem = (actor: Actor, productId: string, quantity: unknown): Promise<Reply> =>
    asCustomer(ORDER_ROUTES.setCartItem, { actor, params: { productId }, body: { quantity } });

  describe('authentication and audience', () => {
    const routes = [
      [ORDER_ROUTES.getCart, {}],
      [ORDER_ROUTES.setCartItem, { params: { productId: randomUUID() }, body: { quantity: '1' } }],
      [ORDER_ROUTES.removeCartItem, { params: { productId: randomUUID() } }],
      [ORDER_ROUTES.submitOrder, { body: FILLED_CART_BODY, key: 'a-valid-key-1' }],
      [ORDER_ROUTES.listOrders, {}],
      [ORDER_ROUTES.getOrder, { params: { id: randomUUID() } }],
      [ORDER_ROUTES.getOrderTimeline, { params: { id: randomUUID() } }],
      [ORDER_ROUTES.receiveOrder, { params: { id: randomUUID() }, body: {} }],
    ] as const;

    // What a staff member gets on these routes since [C] 2026-11-09 (it used to be 403 for every
    // staff role): they are the staff viewer, who has no organization. A personal empty cart, no
    // order of anyone, no order placed (no organization is configured for staff orders here).
    const emptyCart = (reply: Reply): void =>
      expect(expectParsed(reply, 200, cartResponseSchema).lines).toEqual([]);
    const notFound = (reply: Reply): void => void expectError(reply, 404, 'NOT_FOUND');
    const VIEWER_ANSWERS: Record<string, (reply: Reply) => void> = {
      'GET /cart': emptyCart,
      // The random product id of this table does not exist.
      'PUT /cart/items/:productId': notFound,
      'DELETE /cart/items/:productId': emptyCart,
      'POST /orders': (reply) =>
        void expectError(reply, 409, 'CONFLICT', 'STAFF_ORDERING_DISABLED'),
      'GET /orders': (reply) =>
        expect(expectParsed(reply, 200, customerOrderListResponseSchema)).toEqual({
          orders: [],
          nextCursor: null,
        }),
      'GET /orders/:id': notFound,
      'GET /orders/:id/timeline': notFound,
      'POST /orders/:id/receive': (reply) => void expectError(reply, 403, 'FORBIDDEN'),
    };
    const viewerAnswer = (name: string, reply: Reply): void => {
      const check = VIEWER_ANSWERS[name];
      if (check === undefined) throw new Error(`no staff viewer expectation for ${name}`);
      check(reply);
    };

    it.each(routes.map((r) => [`${r[0].method} ${r[0].path}`, r] as const))(
      '%s: 401 without an actor, 403 for the warehouse and the driver, nothing of any organization for the other staff roles',
      async (name, [route, options]) => {
        expect((await call(route, options)).status).toBe(401);
        for (const staff of ['warehouse', 'driver'] as const) {
          const reply = await call(route, { ...options, actor: w.actors[staff] });
          expectError(reply, 403, 'FORBIDDEN');
        }
        // Both organizations have an order and a cart line: "empty" below is not an accident.
        await submitOrder(w, w.actors.sellerA);
        await submitOrder(w, w.actors.sellerB);
        await w.carts.setItemQuantity(w.actors.sellerA, w.products.p1, '5');
        for (const staff of ['manager', 'accountant', 'admin'] as const) {
          viewerAnswer(name, await call(route, { ...options, actor: w.actors[staff] }));
        }
        await expect(t.prisma.order.count()).resolves.toBe(2);
      },
    );

    it.each(routes.map((r) => [`${r[0].method} ${r[0].path}`, r] as const))(
      '%s: 401 for a blocked person (the resolver turns them away), whatever their membership',
      async (_name, [route, options]) => {
        await t.prisma.user.update({ where: { id: w.ids.sellerA }, data: { status: 'BLOCKED' } });
        const blocked = rejectedByResolver(w.actors.sellerA, 'BLOCKED');
        expectError(await call(route, { ...options, actor: blocked }), 401, 'UNAUTHENTICATED');
      },
    );

    it.each(routes.map((r) => [`${r[0].method} ${r[0].path}`, r] as const))(
      '%s: a stray organization membership gives staff nothing of that organization (staff are never members)',
      async (name, [route, options]) => {
        // Was 403; since [C] 2026-11-09 the staff member is the staff viewer here, and the stray
        // membership still opens nothing: not the organization's cart, not its orders.
        await submitOrder(w, w.actors.sellerA);
        await w.carts.setItemQuantity(w.actors.sellerA, w.products.p1, '5');
        const stray: Actor = { ...w.actors.manager, membership: w.actors.sellerA.membership };
        expect(stray.membership).toBeDefined();
        viewerAnswer(name, await call(route, { ...options, actor: stray }));
        await expect(t.prisma.order.count()).resolves.toBe(1);
      },
    );

    it('a person without an organization membership is turned away', async () => {
      const stranger: Actor = { userId: w.ids.sellerA, staffRoles: [] };
      expectError(await call(ORDER_ROUTES.listOrders, { actor: stranger }), 403, 'FORBIDDEN');
      expectError(await call(ORDER_ROUTES.getCart, { actor: stranger }), 403, 'FORBIDDEN');
    });
  });

  it('filters groups and searches before paging without exposing another organization', async () => {
    const active = await orderAt(w, 'RELEASED');
    const complete = await orderAt(w, 'RECEIVED');
    const foreign = await submitOrder(w, w.actors.sellerB);
    const read = async (query: Record<string, string | number>) =>
      expectParsed(
        await asCustomer(ORDER_ROUTES.listOrders, { actor: w.actors.sellerA, query }),
        200,
        customerOrderListResponseSchema,
      );
    expect((await read({ group: 'ACTIVE', limit: 1 })).orders.map((order) => order.id)).toEqual([
      active.id,
    ]);
    expect((await read({ group: 'COMPLETED', limit: 1 })).orders.map((order) => order.id)).toEqual([
      complete.id,
    ]);
    expect((await read({ search: active.orderNumber })).orders.map((order) => order.id)).toEqual([
      active.id,
    ]);
    expect((await read({ search: foreign.orderNumber })).orders).toEqual([]);
    expect((await read({ group: 'COMPLETED', search: active.orderNumber })).orders).toEqual([]);
  });

  describe('cart', () => {
    it('is empty at first and parses with the strict contract', async () => {
      const cart = expectParsed(
        await asCustomer(ORDER_ROUTES.getCart, { actor: w.actors.sellerA }),
        200,
        cartResponseSchema,
      );
      expect(cart).toMatchObject({
        lines: [],
        totalAmount: '0.00',
        currency: 'UZS',
        canSubmit: false,
      });
      expect(cart.priceListVersionNumber).toEqual(expect.any(Number));
    });

    it('sets and replaces a quantity; prices come from the published list as strings', async () => {
      expectParsed(await putItem(w.actors.sellerA, w.products.p1, '2'), 200, cartResponseSchema);
      const cart = expectParsed(
        await putItem(w.actors.sellerA, w.products.p2, '3'),
        200,
        cartResponseSchema,
      );
      expect(cart.lines).toEqual([
        {
          productId: w.products.p1,
          productCode: 'P-1',
          name: 'Olma',
          unit: 'PIECE',
          quantity: '2.000',
          unitPrice: '1500.00',
          lineTotal: '3000.00',
          deferredUnitPrice: null,
          deferredLineTotal: null,
          rrp: null,
          orderableStock: 100000,
          problem: null,
        },
        {
          productId: w.products.p2,
          productCode: 'P-2',
          name: 'Nok',
          unit: 'PIECE',
          quantity: '3.000',
          unitPrice: '750.50',
          lineTotal: '2251.50',
          deferredUnitPrice: null,
          deferredLineTotal: null,
          rrp: null,
          orderableStock: 100000,
          problem: null,
        },
      ]);
      expect(cart.totalAmount).toBe('5251.50');
      expect(cart.canSubmit).toBe(true);

      const replaced = expectParsed(
        await putItem(w.actors.sellerA, w.products.p1, '5'),
        200,
        cartResponseSchema,
      );
      expect(replaced.lines[0]?.quantity).toBe('5.000');
      expect(replaced.totalAmount).toBe('9751.50');
    });

    it('shows the recommended retail price of a line that has one, per piece, outside every total', async () => {
      // A USD list (rate 12000): p1 has an RRP, p2 has none.
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '7.00', [w.products.p2]: '5.00' },
        w.prisma,
        'USD',
        { [w.products.p1]: '8.00', [w.products.p2]: '6.00' },
        { [w.products.p1]: '14.99' },
      );
      await putItem(w.actors.sellerA, w.products.p1, '3');
      // `asCustomer` scans this body for cost-like and staff-only keys: the RRP is neither.
      const reply = await putItem(w.actors.sellerA, w.products.p2, '3');
      const cart = expectParsed(reply, 200, cartResponseSchema);
      expect(
        cart.lines.map((l) => [l.productCode, l.unitPrice, l.deferredUnitPrice, l.rrp]),
      ).toEqual([
        // 14.99 x 12000: one piece, not multiplied by the quantity of 3.
        ['P-1', '84000.00', '96000.00', '179880.00'],
        ['P-2', '60000.00', '72000.00', null],
      ]);
      // The totals are the sale and the deferred prices only.
      expect([cart.totalAmount, cart.deferredTotalAmount]).toEqual(['432000.00', '504000.00']);
      // Nothing of the cost side travels with it: the rate and the USD amount stay on the server.
      const text = JSON.stringify(reply.body);
      for (const secret of ['12000', '14.99'])
        expect(containsStandalone(text, secret), secret).toBe(false);
      expect(text).not.toMatch(/usd/i);

      // A line that cannot be ordered shows no price at all, the RRP included.
      await t.prisma.product.update({ where: { id: w.products.p1 }, data: { isActive: false } });
      const blocked = expectParsed(
        await asCustomer(ORDER_ROUTES.getCart, { actor: w.actors.sellerA }),
        200,
        cartResponseSchema,
      );
      expect(blocked.lines.map((l) => [l.productCode, l.problem, l.unitPrice, l.rrp])).toEqual([
        ['P-1', 'INACTIVE', null, null],
        ['P-2', null, '60000.00', null],
      ]);
    });

    it('the order placed from a cart with an RRP costs the sale price and carries no RRP', async () => {
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
        w.prisma,
        'UZS',
        {},
        { [w.products.p1]: '9999.00', [w.products.p2]: '8888.00' },
      );
      await putItem(w.actors.sellerA, w.products.p1, '2');
      const cart = expectParsed(
        await putItem(w.actors.sellerA, w.products.p2, '1'),
        200,
        cartResponseSchema,
      );
      expect(cart.lines.map((l) => l.rrp)).toEqual(['9999.00', '8888.00']);
      expect(cart.totalAmount).toBe('3750.50');
      const order = await submitOrder(w, w.actors.sellerA);
      const read = await asCustomer(ORDER_ROUTES.getOrder, {
        actor: w.actors.sellerA,
        params: { id: order.id },
      });
      // The strict order schema has no RRP key: one in the response would fail the parse.
      const parsed = expectParsed(read, 200, customerOrderSchema);
      expect(parsed.totalAmount).toBe('3750.50');
      expect(parsed.items.map((item) => [item.unitPrice, item.lineTotal])).toEqual([
        ['1500.00', '3000.00'],
        ['750.50', '750.50'],
      ]);
      expect(JSON.stringify(read.body)).not.toMatch(/rrp|9999|8888/i);
    });

    it('names are the one common product name, whatever the language of the person', async () => {
      await t.prisma.user.update({ where: { id: w.ids.sellerA }, data: { language: 'EN' } });
      await putItem(w.actors.sellerA, w.products.p1, '1');
      const cart = expectParsed(
        await putItem(w.actors.sellerA, w.products.p2, '1'),
        200,
        cartResponseSchema,
      );
      // Owner 2026-10-28: one name for everyone (the UZ row first); the EN row is not used.
      expect(cart.lines.map((l) => l.name)).toEqual(['Olma', 'Nok']);
      await t.prisma.user.update({ where: { id: w.ids.sellerA }, data: { language: 'RU' } });
      const ru = expectParsed(
        await asCustomer(ORDER_ROUTES.getCart, { actor: w.actors.sellerA }),
        200,
        cartResponseSchema,
      );
      expect(ru.lines.map((l) => l.name)).toEqual(['Olma', 'Nok']);
    });

    it('each person has their own cart', async () => {
      await putItem(w.actors.sellerA, w.products.p1, '1');
      const other = expectParsed(
        await asCustomer(ORDER_ROUTES.getCart, { actor: w.actors.sellerA2 }),
        200,
        cartResponseSchema,
      );
      expect(other.lines).toEqual([]);
    });

    it('removes a line, and removing a missing line is not an error', async () => {
      await putItem(w.actors.sellerA, w.products.p1, '1');
      const removed = expectParsed(
        await asCustomer(ORDER_ROUTES.removeCartItem, {
          actor: w.actors.sellerA,
          params: { productId: w.products.p1 },
        }),
        200,
        cartResponseSchema,
      );
      expect(removed.lines).toEqual([]);
      expectParsed(
        await asCustomer(ORDER_ROUTES.removeCartItem, {
          actor: w.actors.sellerA,
          params: { productId: w.products.p1 },
        }),
        200,
        cartResponseSchema,
      );
    });

    it('422 for a bad quantity, a bad product id or extra fields; 404 and 409 for products', async () => {
      for (const quantity of [2, '0', '-1', '1.2345', 'abc', '', '1000000', null]) {
        expectError(
          await putItem(w.actors.sellerA, w.products.p1, quantity),
          422,
          'VALIDATION_FAILED',
        );
      }
      expectError(
        await call(ORDER_ROUTES.setCartItem, {
          actor: w.actors.sellerA,
          params: { productId: w.products.p1 },
          body: { quantity: '1', price: '1.00' },
        }),
        422,
        'VALIDATION_FAILED',
      );
      expectError(await putItem(w.actors.sellerA, 'not-a-uuid', '1'), 422, 'VALIDATION_FAILED');
      expectError(await putItem(w.actors.sellerA, randomUUID(), '1'), 404, 'NOT_FOUND');
      const unpriced = expectError(
        await putItem(w.actors.sellerA, w.products.p3, '1'),
        409,
        'CONFLICT',
        'PRODUCT_NOT_ORDERABLE',
      );
      expect(unpriced.details).toEqual({ productIds: [w.products.p3] });
    });
  });

  describe('submit', () => {
    const fill = async (actor: Actor): Promise<void> => {
      await putItem(actor, w.products.p1, '2');
      await putItem(actor, w.products.p2, '1');
    };

    it('needs a valid Idempotency-Key header', async () => {
      await fill(w.actors.sellerA);
      for (const key of [undefined, 'short', 'has spaces in it', 'x'.repeat(129), 'bad/char/key']) {
        const reply = await call(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          ...(key === undefined ? {} : { key }),
        });
        expectError(reply, 422, 'VALIDATION_FAILED');
      }
      // Nothing was created by the failed attempts.
      expect(await t.prisma.order.count()).toBe(0);
    });

    it('409 EMPTY_CART for an empty cart', async () => {
      expectError(
        await call(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          key: 'empty-cart-key-1',
        }),
        409,
        'CONFLICT',
        'EMPTY_CART',
      );
    });

    it('409 CONTACT_REQUIRED until the customer has entered a phone; the cart is kept', async () => {
      await fill(w.actors.sellerA);
      await t.prisma.user.update({ where: { id: w.ids.sellerA }, data: { phone: null } });
      expectError(
        await call(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          key: 'no-contact-key-1',
        }),
        409,
        'CONFLICT',
        'CONTACT_REQUIRED',
      );
      expect(await t.prisma.order.count()).toBe(0);
      expect(await t.prisma.notificationOutbox.count()).toBe(0);
      expect(await t.prisma.cartItem.count()).toBe(2);
    });

    it('creates the order from the cart: 201, snapshot prices, cart emptied', async () => {
      await fill(w.actors.sellerA);
      const order = expectParsed(
        await asCustomer(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          key: 'first-key-0001',
        }),
        201,
        customerOrderSchema,
      );
      expect(order).toMatchObject({
        status: 'SUBMITTED',
        paymentStatus: 'UNPAID',
        totalAmount: '3750.50',
        currency: 'UZS',
        itemCount: 2,
        placedByName: 'Seller A',
        placedByMe: true,
        rowVersion: 1,
      });
      expect(order.orderNumber).toMatch(/^IO-\d+$/);
      expect(order.items.map((i) => [i.productCode, i.quantity, i.unitPrice, i.lineTotal])).toEqual(
        [
          ['P-1', '2.000', '1500.00', '3000.00'],
          ['P-2', '1.000', '750.50', '750.50'],
        ],
      );
      const cart = expectParsed(
        await asCustomer(ORDER_ROUTES.getCart, { actor: w.actors.sellerA }),
        200,
        cartResponseSchema,
      );
      expect(cart.lines).toEqual([]);
    });

    it('the same key twice gives the same order and creates exactly one', async () => {
      await fill(w.actors.sellerA);
      const first = expectParsed(
        await asCustomer(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          key: 'repeat-key-0001',
        }),
        201,
        customerOrderSchema,
      );
      // The cart is refilled between the two requests: the retry must still not create a second order.
      await fill(w.actors.sellerA);
      const second = expectParsed(
        await asCustomer(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          key: 'repeat-key-0001',
        }),
        201,
        customerOrderSchema,
      );
      expect(second.id).toBe(first.id);
      expect(second.orderNumber).toBe(first.orderNumber);
      expect(await t.prisma.order.count()).toBe(1);
    });

    it('parallel requests with one key create one order', async () => {
      await fill(w.actors.sellerA);
      const replies = await Promise.all(
        [1, 2, 3].map(() =>
          call(ORDER_ROUTES.submitOrder, {
            body: FILLED_CART_BODY,
            actor: w.actors.sellerA,
            key: 'parallel-key-001',
          }),
        ),
      );
      expect(replies.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(await t.prisma.order.count()).toBe(1);
    });

    it('a colleague reusing the key gets IDEMPOTENCY_KEY_REUSED; another organization is independent', async () => {
      await fill(w.actors.sellerA);
      await call(ORDER_ROUTES.submitOrder, {
        body: FILLED_CART_BODY,
        actor: w.actors.sellerA,
        key: 'shared-key-0001',
      });
      await fill(w.actors.sellerA2);
      expectError(
        await call(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA2,
          key: 'shared-key-0001',
        }),
        409,
        'CONFLICT',
        'IDEMPOTENCY_KEY_REUSED',
      );
      await fill(w.actors.sellerB);
      expectParsed(
        await asCustomer(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerB,
          key: 'shared-key-0001',
        }),
        201,
        customerOrderSchema,
      );
      expect(await t.prisma.order.count()).toBe(2);
    });

    it('409 ORDERING_ORGANIZATION_INACTIVE for an inactive organization', async () => {
      await fill(w.actors.sellerA);
      await t.prisma.organization.update({ where: { id: w.orgA }, data: { status: 'INACTIVE' } });
      expectError(
        await call(ORDER_ROUTES.submitOrder, {
          body: FILLED_CART_BODY,
          actor: w.actors.sellerA,
          key: 'inactive-key-001',
        }),
        409,
        'CONFLICT',
        'ORDERING_ORGANIZATION_INACTIVE',
      );
    });
  });

  describe('reading orders: isolation', () => {
    it('lists only the own organization, with filters and cursor paging', async () => {
      const a = [
        await orderAt(w, 'SUBMITTED'),
        await orderAt(w, 'MANAGER_APPROVED'),
        await orderAt(w, 'DELIVERED'),
        await orderAt(w, 'REJECTED'),
        await orderAt(w, 'SUBMITTED'),
      ];
      const b = [await submitOrder(w, w.actors.sellerB), await submitOrder(w, w.actors.ownerB)];

      // Every member of A sees all of A (also colleagues' orders), none of B.
      for (const actor of [w.actors.sellerA, w.actors.sellerA2, w.actors.ownerA]) {
        const page = expectParsed(
          await asCustomer(ORDER_ROUTES.listOrders, { actor, query: { limit: 100 } }),
          200,
          customerOrderListResponseSchema,
        );
        expect(page.orders.map((o) => o.id).sort()).toEqual(a.map((o) => o.id).sort());
        expect(page.nextCursor).toBeNull();
      }
      const bPage = expectParsed(
        await asCustomer(ORDER_ROUTES.listOrders, { actor: w.actors.ownerB }),
        200,
        customerOrderListResponseSchema,
      );
      expect(bPage.orders.map((o) => o.id).sort()).toEqual(b.map((o) => o.id).sort());

      // Filters.
      const submitted = expectParsed(
        await asCustomer(ORDER_ROUTES.listOrders, {
          actor: w.actors.ownerA,
          query: { status: 'SUBMITTED' },
        }),
        200,
        customerOrderListResponseSchema,
      );
      expect(submitted.orders).toHaveLength(2);
      const paid = expectParsed(
        await asCustomer(ORDER_ROUTES.listOrders, {
          actor: w.actors.ownerA,
          query: { paymentStatus: 'PAID' },
        }),
        200,
        customerOrderListResponseSchema,
      );
      expect(paid.orders).toEqual([]);

      // Paging: newest first, no duplicates, no gaps.
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = expectParsed(
          await asCustomer(ORDER_ROUTES.listOrders, {
            actor: w.actors.sellerA2,
            query: { limit: 2, ...(cursor ? { cursor } : {}) },
          }),
          200,
          customerOrderListResponseSchema,
        );
        seen.push(...page.orders.map((o) => o.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual(a.map((o) => o.id).reverse());
    });

    it('a customer cannot widen the scope with an organization filter, and bad queries are 422', async () => {
      await orderAt(w, 'SUBMITTED');
      await submitOrder(w, w.actors.sellerB);
      for (const query of [
        { organizationId: w.orgB },
        { status: 'NOPE' },
        { limit: 0 },
        { limit: 101 },
        { limit: 'many' },
        { cursor: 'not-a-uuid' },
        { search: 'x'.repeat(41) },
        { group: 'UNKNOWN' },
      ]) {
        expectError(
          await call(ORDER_ROUTES.listOrders, { actor: w.actors.sellerA, query }),
          422,
          'VALIDATION_FAILED',
        );
      }
    });

    it('GET /orders/:id: own order 200, another organization 404 (never 403), unknown 404, bad id 422', async () => {
      const own = await orderAt(w, 'MANAGER_APPROVED');
      const foreign = await submitOrder(w, w.actors.sellerB);
      const order = expectParsed(
        await asCustomer(ORDER_ROUTES.getOrder, {
          actor: w.actors.sellerA2,
          params: { id: own.id },
        }),
        200,
        customerOrderSchema,
      );
      expect(order.status).toBe('MANAGER_APPROVED');
      expect(order.placedByName).toBe('Seller A');
      expect(order.placedByMe).toBe(false);

      for (const actor of [w.actors.sellerA, w.actors.ownerA]) {
        expectError(
          await call(ORDER_ROUTES.getOrder, { actor, params: { id: foreign.id } }),
          404,
          'NOT_FOUND',
        );
        expectError(
          await call(ORDER_ROUTES.getOrderTimeline, { actor, params: { id: foreign.id } }),
          404,
          'NOT_FOUND',
        );
      }
      expectError(
        await call(ORDER_ROUTES.getOrder, {
          actor: w.actors.sellerA,
          params: { id: randomUUID() },
        }),
        404,
        'NOT_FOUND',
      );
      expectError(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerA, params: { id: 'nope' } }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('never shows accounting, staff ids or the price list version, also after a skipped accounting step', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
        skipAccounting: true,
      });
      await w.step(w.actors.warehouse, order.id, { to: 'RELEASED', driverUserId: w.ids.driver });
      for (const [route, params] of [
        [ORDER_ROUTES.getOrder, { id: order.id }],
        [ORDER_ROUTES.getOrderTimeline, { id: order.id }],
      ] as const) {
        const reply = await asCustomer(route, { actor: w.actors.sellerA, params });
        expect(reply.status).toBe(200);
      }
      const list = await asCustomer(ORDER_ROUTES.listOrders, { actor: w.actors.sellerA });
      expectParsed(list, 200, customerOrderListResponseSchema);
      const timeline = expectParsed(
        await call(ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.sellerA,
          params: { id: order.id },
        }),
        200,
        customerTimelineResponseSchema,
      );
      expect(timeline.events.map((e) => e.toStatus)).toEqual([
        'SUBMITTED',
        'MANAGER_APPROVED',
        'ACCOUNTING_CLEARED',
        'RELEASED',
      ]);
    });
  });

  describe('cancel and receive', () => {
    // Owner rule 2026-10-22: customers never cancel; only the manager does. The customer route
    // is gone, so the framework answers 404 and nothing changes.
    const REMOVED_CANCEL_ROUTE = { method: 'POST', path: '/orders/:id/cancel' } as const;

    it.each(['sellerA', 'sellerA2', 'ownerA'] as const)(
      'the customer cancel route no longer exists (%s gets 404, the order is untouched)',
      async (who) => {
        const order = await orderAt(w, 'SUBMITTED', { placedBy: w.actors.sellerA });
        for (const body of [{ reason: 'ordered twice' }, {}]) {
          const reply = await call(REMOVED_CANCEL_ROUTE, {
            actor: w.actors[who],
            params: { id: order.id },
            body,
          });
          expect(reply.status).toBe(404);
        }
        const row = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(row.status).toBe('SUBMITTED');
        expect(row.rowVersion).toBe(order.rowVersion);
        expect(
          await t.prisma.orderEvent.count({ where: { orderId: order.id, toStatus: 'CANCELLED' } }),
        ).toBe(0);
        expect(
          await t.prisma.notificationOutbox.count({
            where: { orderId: order.id, type: 'ORDER_CANCELLED' },
          }),
        ).toBe(0);
      },
    );

    it('the shop owner confirms receipt; a seller only for their own order', async () => {
      const delivered = await orderAt(w, 'DELIVERED', { placedBy: w.actors.sellerA });
      // A colleague seller did not place it: not allowed to confirm.
      expectError(
        await call(ORDER_ROUTES.receiveOrder, {
          actor: w.actors.sellerA2,
          params: { id: delivered.id },
        }),
        403,
        'FORBIDDEN',
      );
      expectError(
        await call(ORDER_ROUTES.receiveOrder, {
          actor: w.actors.sellerB,
          params: { id: delivered.id },
        }),
        404,
        'NOT_FOUND',
      );
      // The placer confirms, with no body at all.
      const received = expectParsed(
        await asCustomer(ORDER_ROUTES.receiveOrder, {
          actor: w.actors.sellerA,
          params: { id: delivered.id },
        }),
        200,
        customerOrderSchema,
      );
      expect(received.status).toBe('RECEIVED');

      const other = await orderAt(w, 'DELIVERED', { placedBy: w.actors.sellerA });
      const byOwner = expectParsed(
        await asCustomer(ORDER_ROUTES.receiveOrder, {
          actor: w.actors.ownerA,
          params: { id: other.id },
          body: { comment: 'all good' },
        }),
        200,
        customerOrderSchema,
      );
      expect(byOwner.status).toBe('RECEIVED');
    });

    it('receiving an order that is not delivered is 409 ILLEGAL_ORDER_TRANSITION', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const error = expectError(
        await call(ORDER_ROUTES.receiveOrder, { actor: w.actors.ownerA, params: { id: order.id } }),
        409,
        'CONFLICT',
        'ILLEGAL_ORDER_TRANSITION',
      );
      expect(error.details).toEqual({ from: 'SUBMITTED', to: 'RECEIVED' });
    });

    it('a customer cannot use the staff cancel route', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      expectError(
        await call(STAFF_ORDER_ROUTES.cancelOrder, {
          actor: w.actors.ownerA,
          params: { id: order.id },
          body: { reason: 'x', expectedRowVersion: 1 },
        }),
        403,
        'FORBIDDEN',
      );
    });
  });
});
