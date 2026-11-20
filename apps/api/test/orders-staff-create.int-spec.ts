import { ORDER_ROUTES, customerOrderSchema } from '@iorder/shared';
import {
  STAFF_ORDER_ROUTES,
  newOrderCatalogResponseSchema,
  newOrderCustomersResponseSchema,
  staffOrderSchema,
} from '@iorder/shared/staff-orders';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { makeUser, staffActor } from './support/identity-fixtures.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { caller, expectError, expectParsed, type Reply } from './support/orders-http.js';
import { createWorld, nextKey, stockUp, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// [C, owner 2026-11-20] "Manager nomidan ham buyurtma yaratilishi kerak": the manager creates an
// order on behalf of a customer. Real PostgreSQL, real HTTP.
describe("staff HTTP: the manager's new order on a customer's behalf (real PostgreSQL)", () => {
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

  /** p1 x2 at 1500.00 + p2 x1 at 750.50 (the world's prices, plan FULL). */
  const request = (overrides: Record<string, unknown> = {}) => ({
    organizationId: w.orgA,
    placedByUserId: w.ids.sellerA,
    paymentPlan: 'FULL',
    lines: [
      { productId: w.products.p1, quantity: '2' },
      { productId: w.products.p2, quantity: '1' },
    ],
    comment: 'Ertaga ertalab yetkazing',
    expectedTotalAmount: '3750.50',
    ...overrides,
  });

  const create = (
    actor: Actor,
    body: Record<string, unknown> = request(),
    key = nextKey(),
  ): Promise<Reply> => call(STAFF_ORDER_ROUTES.createOrder, { actor, body, key });

  describe('who may', () => {
    it('only the manager: every other staff role and every customer gets 403', async () => {
      const purchasing = staffActor(
        (await makeUser(t.prisma, { name: 'Buyer', staff: ['PURCHASING_MANAGER'] })).id,
        'PURCHASING_MANAGER',
      );
      const others = [
        w.actors.admin,
        w.actors.accountant,
        w.actors.warehouse,
        w.actors.driver,
        purchasing,
        w.actors.ownerA,
        w.actors.sellerA,
      ];
      for (const actor of others) {
        expectError(await create(actor), 403, 'FORBIDDEN');
        for (const route of [
          STAFF_ORDER_ROUTES.listNewOrderCustomers,
          STAFF_ORDER_ROUTES.getNewOrderCatalog,
        ]) {
          const reply = await call(route, { actor, query: { organizationId: w.orgA } });
          expect(reply.status).toBe(403);
        }
      }
      expect((await create(w.actors.manager)).status).toBe(201);
      expect(await t.prisma.order.count()).toBe(1);
    });

    it('401 without an actor; 422 without an Idempotency-Key', async () => {
      expect((await call(STAFF_ORDER_ROUTES.createOrder, { body: request() })).status).toBe(401);
      const reply = await call(STAFF_ORDER_ROUTES.createOrder, {
        actor: w.actors.manager,
        body: request(),
      });
      expect(reply.status).toBe(422);
    });
  });

  describe('the order', () => {
    it('is an ordinary SUBMITTED order of the organization, placed by the member, priced like a submit', async () => {
      const order = expectParsed(await create(w.actors.manager), 201, staffOrderSchema);
      if (order.detail !== 'FULL') throw new Error('expected the FULL shape');
      expect(order).toMatchObject({
        organizationId: w.orgA,
        status: 'SUBMITTED',
        paymentPlan: 'FULL',
        totalAmount: '3750.50',
        customerComment: 'Ertaga ertalab yetkazing',
        placedBy: { userId: w.ids.sellerA },
        organizationLabel: 'STANDARD',
      });
      const stored = await t.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      expect(stored.placedByUserId).toBe(w.ids.sellerA);
      expect(stored.priceTier).toBe('STANDARD');
      expect(stored.priceListVersionId).toBe(w.versionId);
      expect(stored.usdRate.toFixed(4)).toBe('12000.0000');
      expect(stored.items.map((i) => i.fullUnitPrice.toFixed(2)).sort()).toEqual([
        '1500.00',
        '750.50',
      ]);
      // Nothing is held at creation (hard rule 10): holds come with the approval.
      expect(await t.prisma.orderAllocation.count({ where: { orderId: order.id } })).toBe(0);
    });

    it('records the creating manager in the SUBMITTED event, on behalf of the member (hard rule 12)', async () => {
      const order = expectParsed(await create(w.actors.manager), 201, staffOrderSchema);
      const events = await t.prisma.orderEvent.findMany({ where: { orderId: order.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'SUBMITTED',
        actorUserId: w.ids.manager,
        actorRole: 'MANAGER',
        toStatus: 'SUBMITTED',
      });
      expect(events[0]?.payload).toMatchObject({
        after: {
          createdOnBehalfOf: { organizationId: w.orgA, placedByUserId: w.ids.sellerA },
          customerComment: 'Ertaga ertalab yetkazing',
        },
      });
    });

    it('sends the same staff messages as a customer order and nothing to the customer side', async () => {
      const order = expectParsed(await create(w.actors.manager), 201, staffOrderSchema);
      const rows = await t.prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
      expect(rows.map((r) => [r.type, r.recipientKind, r.recipientRole])).toEqual([
        ['ORDER_SUBMITTED', 'ROLE', 'MANAGER'],
      ]);
    });

    it('the customer side reads it as its own order', async () => {
      const order = expectParsed(await create(w.actors.manager), 201, staffOrderSchema);
      const seen = expectParsed(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.ownerA, params: { id: order.id } }),
        200,
        customerOrderSchema,
      );
      expect(seen.placedByName).toBe('Seller A');
      // Another organization never sees it (hard rule 6).
      expect(
        (await call(ORDER_ROUTES.getOrder, { actor: w.actors.ownerB, params: { id: order.id } }))
          .status,
      ).toBe(404);
    });

    it('an empty comment stores none', async () => {
      const order = expectParsed(
        await create(w.actors.manager, request({ comment: '   ' })),
        201,
        staffOrderSchema,
      );
      if (order.detail !== 'FULL') throw new Error('expected the FULL shape');
      expect(order.customerComment).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('a retry with the same key returns the same order and creates nothing', async () => {
      const key = nextKey();
      const first = expectParsed(
        await create(w.actors.manager, request(), key),
        201,
        staffOrderSchema,
      );
      const again = expectParsed(
        await create(w.actors.manager, request(), key),
        201,
        staffOrderSchema,
      );
      expect(again.id).toBe(first.id);
      expect(await t.prisma.order.count()).toBe(1);
      expect(await t.prisma.orderEvent.count()).toBe(1);
    });

    it('another manager with the same key is refused', async () => {
      const key = nextKey();
      await create(w.actors.manager, request(), key);
      expectError(
        await create(w.actors.manager2, request(), key),
        409,
        'CONFLICT',
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('a key a customer used for their own order is not replayed to the manager', async () => {
      const key = nextKey();
      await submitOrder(w, w.actors.sellerA, { key });
      expectError(
        await create(w.actors.manager, request(), key),
        409,
        'CONFLICT',
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('the member is checked against the organization (isolation)', () => {
    it.each([
      ['a member of another organization', (world: World) => world.ids.sellerB],
      ['a staff member', (world: World) => world.ids.accountant],
      ['an unknown id', () => randomUUID()],
    ])('refuses %s', async (_name, placer) => {
      expectError(
        await create(w.actors.manager, request({ placedByUserId: placer(w) })),
        409,
        'CONFLICT',
        'PLACER_NOT_MEMBER',
      );
      expect(await t.prisma.order.count()).toBe(0);
    });

    it('refuses a member who left', async () => {
      await t.prisma.organizationMember.updateMany({
        where: { organizationId: w.orgA, userId: w.ids.sellerA },
        data: { status: 'LEFT', leftAt: new Date('2026-10-19T00:00:00Z') },
      });
      expectError(await create(w.actors.manager), 409, 'CONFLICT', 'PLACER_NOT_MEMBER');
    });

    it('refuses a blocked member, and does not offer them in step 1', async () => {
      await t.prisma.user.update({ where: { id: w.ids.sellerA }, data: { status: 'BLOCKED' } });
      expectError(await create(w.actors.manager), 409, 'CONFLICT', 'PLACER_NOT_MEMBER');
      const found = expectParsed(
        await call(STAFF_ORDER_ROUTES.listNewOrderCustomers, {
          actor: w.actors.manager,
          query: { search: 'alpha' },
        }),
        200,
        newOrderCustomersResponseSchema,
      );
      expect(found.items[0]?.members.map((m) => m.userId)).not.toContain(w.ids.sellerA);
    });

    it('refuses an inactive organization', async () => {
      await t.prisma.organization.update({ where: { id: w.orgA }, data: { status: 'INACTIVE' } });
      expectError(
        await create(w.actors.manager),
        409,
        'CONFLICT',
        'ORDERING_ORGANIZATION_INACTIVE',
      );
    });
  });

  describe('prices, plan and stock', () => {
    it('refuses DEFERRED when a line has no deferred price', async () => {
      expectError(
        await create(w.actors.manager, request({ paymentPlan: 'DEFERRED' })),
        409,
        'CONFLICT',
        'DEFERRED_PRICE_UNAVAILABLE',
      );
    });

    it('prices DEFERRED from the deferred prices when every line has one', async () => {
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
        t.prisma,
        'UZS',
        { [w.products.p1]: '1600.00', [w.products.p2]: '800.00' },
      );
      const order = expectParsed(
        await create(
          w.actors.manager,
          request({ paymentPlan: 'DEFERRED', expectedTotalAmount: '4000.00' }),
        ),
        201,
        staffOrderSchema,
      );
      if (order.detail !== 'FULL') throw new Error('expected the FULL shape');
      expect(order).toMatchObject({ paymentPlan: 'DEFERRED', totalAmount: '4000.00' });
    });

    it('refuses a total the manager did not see', async () => {
      expectError(
        await create(w.actors.manager, request({ expectedTotalAmount: '1.00' })),
        409,
        'CONFLICT',
        'CART_TOTAL_CHANGED',
      );
    });

    it('is NOT capped by the free stock [P]: more than the stock is accepted', async () => {
      await t.prisma.priceReference.deleteMany({ where: { productId: w.products.p1 } });
      await t.prisma.stockCache.delete({ where: { productId: w.products.p1 } });
      await stockUp(t.prisma, w.products.p1, '1');
      expect((await create(w.actors.manager)).status).toBe(201);
    });

    it('does not offer, and refuses, a sheet product whose sheet stock is zero', async () => {
      await t.prisma.stockCache.update({
        where: { productId: w.products.p2 },
        data: { quantity: '0' },
      });
      const catalog = expectParsed(
        await call(STAFF_ORDER_ROUTES.getNewOrderCatalog, {
          actor: w.actors.manager,
          query: { organizationId: w.orgA },
        }),
        200,
        newOrderCatalogResponseSchema,
      );
      expect(catalog.items.map((i) => i.productId)).toEqual([w.products.p1]);
      expectError(await create(w.actors.manager), 409, 'CONFLICT', 'PRODUCT_NOT_ORDERABLE');
    });

    it("prices at the organization's tier: Alif factoring offers only the products with an Alif price", async () => {
      await t.prisma.organization.update({
        where: { id: w.orgA },
        data: { label: 'ALIF_FACTORING' },
      });
      const catalog = expectParsed(
        await call(STAFF_ORDER_ROUTES.getNewOrderCatalog, {
          actor: w.actors.manager,
          query: { organizationId: w.orgA },
        }),
        200,
        newOrderCatalogResponseSchema,
      );
      expect(catalog).toMatchObject({ priceTier: 'ALIF_FACTORING', items: [] });
      expectError(await create(w.actors.manager), 409, 'CONFLICT', 'PRODUCT_NOT_ORDERABLE');
    });
  });

  describe('step 1 and step 2 reads', () => {
    it('finds customers by organization, member name and phone, with their current members only', async () => {
      const search = async (query: Record<string, string>) =>
        expectParsed(
          await call(STAFF_ORDER_ROUTES.listNewOrderCustomers, { actor: w.actors.manager, query }),
          200,
          newOrderCustomersResponseSchema,
        );
      expect((await search({ search: 'beta' })).items.map((c) => c.name)).toEqual(['Beta shop']);
      expect((await search({ search: 'Seller A2' })).items.map((c) => c.name)).toEqual([
        'Alpha shop',
      ]);
      const sellerPhone = (await t.prisma.user.findUniqueOrThrow({ where: { id: w.ids.sellerB } }))
        .phone;
      expect((await search({ search: sellerPhone ?? '' })).items.map((c) => c.name)).toEqual([
        'Beta shop',
      ]);
      const alpha = (await search({ search: 'alpha' })).items[0];
      expect(alpha?.members.map((m) => m.fullName).sort()).toEqual([
        'Owner A',
        'Seller A',
        'Seller A2',
      ]);
      expect((await search({ type: 'PERSON' })).items).toEqual([]);
      expect((await search({ label: 'PARTNER' })).items).toEqual([]);
    });

    it('lists the organizations of the latest orders as the recent customers [P]', async () => {
      const before = expectParsed(
        await call(STAFF_ORDER_ROUTES.listNewOrderCustomers, { actor: w.actors.manager }),
        200,
        newOrderCustomersResponseSchema,
      );
      expect(before.recent).toEqual([]);
      await create(w.actors.manager);
      const after = expectParsed(
        await call(STAFF_ORDER_ROUTES.listNewOrderCustomers, { actor: w.actors.manager }),
        200,
        newOrderCustomersResponseSchema,
      );
      expect(after.recent.map((c) => c.organizationId)).toEqual([w.orgA]);
    });

    it('the catalog carries the prices of the tier and the free stock as a hint', async () => {
      const catalog = expectParsed(
        await call(STAFF_ORDER_ROUTES.getNewOrderCatalog, {
          actor: w.actors.manager,
          query: { organizationId: w.orgA },
        }),
        200,
        newOrderCatalogResponseSchema,
      );
      expect(catalog.priceTier).toBe('STANDARD');
      expect(catalog.items.find((i) => i.productId === w.products.p1)).toMatchObject({
        productCode: 'P-1',
        unitPrice: '1500.00',
        deferredUnitPrice: null,
        stock: 100000,
      });
    });
  });
});
