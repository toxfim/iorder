import {
  CUSTOMER_GOODS_ROUTES,
  ORDER_ROUTES,
  PRICING_ROUTES,
  cartResponseSchema,
  customerGoodsListSchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerPriceListResponseSchema,
  customerTimelineResponseSchema,
} from '@iorder/shared';
import {
  MANUAL_PRODUCT_ROUTES,
  byOrderProductsResponseSchema,
  createManualProductResponseSchema,
  mergeProductResponseSchema,
  type ByOrderProductsResponse,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { ManualProductsModule } from '../src/modules/manual-products/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { PricingModule, PricingService } from '../src/modules/pricing/index.js';
import {
  findForbiddenKeys,
  findStaffOnlyFields,
  findStaffOnlyFieldsInCustomerPriceList,
} from './support/forbidden-fields.js';
import { makeUser, staffActor } from './support/identity-fixtures.js';
import { assertCustomerSafe, caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, fillCart, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// The staff page "Buyurtma orqali" [C, owner 2026-11-09]: the staff-added products without a sheet
// «Товар_ID» with what open orders wait for. And the other half of the owner's sentence: the
// customer must never learn that a product is of this type.

// PricingModule first: the same order as AppModule (see StaffStockController).
describe('by-order products (real PostgreSQL, real HTTP)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([PricingModule, CatalogModule, OrdersModule, ManualProductsModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
  });

  /** A staff-added product priced in the world's list (a new published version). */
  async function manualProduct(
    name: string,
    basePrice: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const current = await t.get(PricingService).findPublishedVersion();
    const r = await call(MANUAL_PRODUCT_ROUTES.createManualProduct, {
      actor: w.actors.manager,
      body: { baseVersionNumber: current?.number ?? null, name, basePrice, ...extra },
    });
    return expectParsed(r, 201, createManualProductResponseSchema).productId;
  }

  /** Orders are told apart by when they were submitted: each one a minute after the last. */
  let minute = 0;
  const tick = (): void => {
    minute += 1;
    t.clock.set(new Date(Date.UTC(2026, 10, 9, 5, minute)));
  };
  beforeEach(() => {
    minute = 0;
  });

  const list = async (actor: Actor): Promise<ByOrderProductsResponse> =>
    expectParsed(
      await call(MANUAL_PRODUCT_ROUTES.byOrderProducts, { actor }),
      200,
      byOrderProductsResponseSchema,
    );

  describe('GET /staff/by-order-products', () => {
    it('counts only what open orders wait for, per product, across organizations', async () => {
      const quloqchin = await manualProduct('Quloqchin', '2.00', {
        deferredPrice: '2.50',
        category: 'Audio',
      });
      const kabel = await manualProduct('Kabel', '1.50');
      const adapter = await manualProduct('adapter', '3.00');

      // Three orders still wait for the goods: one per open status, from two organizations.
      tick();
      const submitted = await submitOrder(w, w.actors.sellerA, {
        items: [
          [quloqchin, '3'],
          [w.products.p1, '2'],
        ],
      });
      tick();
      const approved = await orderAt(w, 'MANAGER_APPROVED', {
        placedBy: w.actors.sellerB,
        items: [
          [quloqchin, '4'],
          [adapter, '2'],
        ],
      });
      tick();
      const cleared = await orderAt(w, 'ACCOUNTING_CLEARED', { items: [[quloqchin, '1']] });
      // The goods of these left the warehouse, or the order needs none: never counted.
      tick();
      await orderAt(w, 'RELEASED', { items: [[quloqchin, '10']] });
      await orderAt(w, 'DELIVERED', { items: [[quloqchin, '20']] });
      await orderAt(w, 'RECEIVED', { items: [[quloqchin, '30']] });
      await orderAt(w, 'REJECTED', { items: [[quloqchin, '40']] });
      await orderAt(w, 'CANCELLED', {
        cancelAfter: 'MANAGER_APPROVED',
        items: [[quloqchin, '50']],
      });

      const reply = await call(MANUAL_PRODUCT_ROUTES.byOrderProducts, { actor: w.actors.manager });
      const body = expectParsed(reply, 200, byOrderProductsResponseSchema);

      // Needed now first (the longest wait at the top), then the rest by name; sheet products never.
      expect(body.items.map((item) => item.name)).toEqual(['Quloqchin', 'adapter', 'Kabel']);
      expect(body.items[0]).toEqual({
        productId: quloqchin,
        productCode: expect.stringMatching(/^IO-\d{6}$/) as string,
        name: 'Quloqchin',
        brandName: null,
        category: 'Audio',
        isActive: true,
        basePrice: '2.00',
        deferredPrice: '2.50',
        currency: 'USD',
        openQuantity: '8.000',
        openOrderCount: 3,
        orders: [
          {
            orderId: submitted.id,
            orderNumber: submitted.orderNumber,
            organizationName: 'Alpha shop',
            status: 'SUBMITTED',
            quantity: '3.000',
            submittedAt: '2026-11-09T05:01:00.000Z',
          },
          {
            orderId: approved.id,
            orderNumber: approved.orderNumber,
            organizationName: 'Beta shop',
            status: 'MANAGER_APPROVED',
            quantity: '4.000',
            submittedAt: '2026-11-09T05:02:00.000Z',
          },
          {
            orderId: cleared.id,
            orderNumber: cleared.orderNumber,
            organizationName: 'Alpha shop',
            status: 'ACCOUNTING_CLEARED',
            quantity: '1.000',
            submittedAt: '2026-11-09T05:03:00.000Z',
          },
        ],
      });
      expect(body.items[1]).toMatchObject({
        productId: adapter,
        openQuantity: '2.000',
        openOrderCount: 1,
      });
      expect(body.items[2]).toMatchObject({
        productId: kabel,
        basePrice: '1.50',
        deferredPrice: null,
        openQuantity: '0.000',
        openOrderCount: 0,
        orders: [],
      });
      // No cost-class and no stock key under any name: such a product has neither.
      expect(findForbiddenKeys(reply.body)).toEqual([]);
      expect(findStaffOnlyFields({ items: withoutCategory(body.items) })).toEqual([]);
    });

    it('is for the roles of the stock page, and every one of them gets the same cost-free answer', async () => {
      const quloqchin = await manualProduct('Quloqchin', '2.00');
      tick();
      await submitOrder(w, w.actors.sellerA, { items: [[quloqchin, '3']] });
      const purchasing = staffActor(
        (await makeUser(t.prisma, { name: 'Umid aka', staff: ['PURCHASING_MANAGER'] })).id,
        'PURCHASING_MANAGER',
      );

      const manager = await list(w.actors.manager);
      expect(manager.items[0]).toMatchObject({ openQuantity: '3.000', openOrderCount: 1 });
      for (const actor of [w.actors.accountant, w.actors.admin, purchasing]) {
        expect(await list(actor)).toEqual(manager);
      }
      for (const actor of [
        w.actors.warehouse,
        w.actors.driver,
        w.actors.ownerA,
        w.actors.sellerB,
      ]) {
        expectError(await call(MANUAL_PRODUCT_ROUTES.byOrderProducts, { actor }), 403, 'FORBIDDEN');
      }
      expect((await call(MANUAL_PRODUCT_ROUTES.byOrderProducts)).status).toBe(401);
    });

    it('keeps a merged product while an order waits for it, and drops it afterwards', async () => {
      const quloqchin = await manualProduct('Quloqchin', '2.00');
      tick();
      const order = await orderAt(w, 'ACCOUNTING_CLEARED', { items: [[quloqchin, '3']] });
      const current = await t.get(PricingService).findPublishedVersion();
      expectParsed(
        await call(MANUAL_PRODUCT_ROUTES.mergeProduct, {
          actor: w.actors.manager,
          params: { id: quloqchin },
          body: { baseVersionNumber: current?.number ?? null, targetProductId: w.products.p3 },
        }),
        200,
        mergeProductResponseSchema,
      );

      // Merged: out of the price list and inactive, yet the open order still needs the goods.
      expect((await list(w.actors.manager)).items).toEqual([
        expect.objectContaining({
          productId: quloqchin,
          isActive: false,
          basePrice: null,
          currency: null,
          openQuantity: '3.000',
          openOrderCount: 1,
        }),
      ]);

      await w.step(w.actors.warehouse, order.id, { to: 'RELEASED', driverUserId: w.ids.driver });
      expect((await list(w.actors.manager)).items).toEqual([]);
    });

    it('lists a product taken out of the price list without a price', async () => {
      const kabel = await manualProduct('Kabel', '1.50');
      const current = await t.get(PricingService).findPublishedVersion();
      const removed = await call(PRICING_ROUTES.publishChanges, {
        actor: w.actors.manager,
        body: {
          baseVersionNumber: current?.number ?? null,
          upserts: [],
          removedProductIds: [kabel],
        },
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect((await list(w.actors.manager)).items).toEqual([
        expect.objectContaining({
          productId: kabel,
          isActive: true,
          basePrice: null,
          deferredPrice: null,
          currency: null,
        }),
      ]);
    });
  });

  describe('the customer never learns that a product is brought by order', () => {
    // Any name such a flag could plausibly take, and the wording of the staff app in three languages.
    const TYPE_KEY =
      /stockTracked|tracked|codeGenerated|generated|sheetMatch|mergedInto|byOrder|by_order|onOrder|manual|origin|source/i;
    const TYPE_WORDING = /buyurtma orqali|под заказ|by order|kuzatilmaydi|не отслеживается/i;

    function keysOf(value: unknown, into = new Set<string>()): Set<string> {
      if (Array.isArray(value)) for (const child of value) keysOf(child, into);
      else if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          into.add(key);
          keysOf(child, into);
        }
      }
      return into;
    }

    /** The staff-added line and the sheet line must be the same shape: nothing tells them apart. */
    function sameShape(
      rows: readonly { productId: string }[],
      manual: string,
      sheet: string,
    ): void {
      const keys = (id: string): string[] =>
        Object.keys(rows.find((row) => row.productId === id) ?? {}).sort();
      expect(keys(manual).length).toBeGreaterThan(0);
      expect(keys(manual)).toEqual(keys(sheet));
    }

    function assertNoType(body: unknown): void {
      expect([...keysOf(body)].filter((key) => TYPE_KEY.test(key))).toEqual([]);
      expect(JSON.stringify(body)).not.toMatch(TYPE_WORDING);
    }

    it('price list, cart, orders, timeline and received goods show it like any other product', async () => {
      const manual = await manualProduct('Quloqchin', '2.00', { category: 'Audio' });
      const sheet = w.products.p1;
      const customer = w.actors.ownerA;

      const priceList = await call(PRICING_ROUTES.currentPriceList, { actor: customer });
      const listed = expectParsed(priceList, 200, customerPriceListResponseSchema);
      sameShape(listed.items, manual, sheet);
      assertNoType(priceList.body);
      expect(findForbiddenKeys(priceList.body)).toEqual([]);
      expect(findStaffOnlyFieldsInCustomerPriceList(priceList.body)).toEqual([]);

      await fillCart(w, customer, [
        [manual, '3'],
        [sheet, '2'],
      ]);
      const cart = await call(ORDER_ROUTES.getCart, { actor: customer });
      sameShape(expectParsed(cart, 200, cartResponseSchema).lines, manual, sheet);
      assertNoType(cart.body);
      assertCustomerSafe(cart.body, w);

      // Through the whole life of an order: placed, approved (a plan that holds nothing for the
      // staff-added line), released, delivered, received.
      const order = await orderAt(w, 'RECEIVED', {
        placedBy: customer,
        items: [
          [manual, '3'],
          [sheet, '2'],
        ],
      });
      const detail = await call(ORDER_ROUTES.getOrder, {
        actor: customer,
        params: { id: order.id },
      });
      sameShape(expectParsed(detail, 200, customerOrderSchema).items, manual, sheet);
      const orders = await call(ORDER_ROUTES.listOrders, { actor: customer });
      expectParsed(orders, 200, customerOrderListResponseSchema);
      const timeline = await call(ORDER_ROUTES.getOrderTimeline, {
        actor: customer,
        params: { id: order.id },
      });
      expectParsed(timeline, 200, customerTimelineResponseSchema);
      const goods = await call(CUSTOMER_GOODS_ROUTES.list, { actor: customer });
      expectParsed(goods, 200, customerGoodsListSchema);
      for (const reply of [detail, orders, timeline, goods]) {
        assertNoType(reply.body);
        assertCustomerSafe(reply.body, w);
      }

      // The staff page itself is closed to the customer (403, not an empty list).
      expectError(
        await call(MANUAL_PRODUCT_ROUTES.byOrderProducts, { actor: customer }),
        403,
        'FORBIDDEN',
      );
    });
  });
});

/** `category` is a staff-visible field of this staff DTO; the scan is about everything else. */
function withoutCategory(items: readonly object[]): object[] {
  return items.map((item) =>
    Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'category')),
  );
}
