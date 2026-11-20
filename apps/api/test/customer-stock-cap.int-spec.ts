import {
  ORDER_ROUTES,
  PRICING_ROUTES,
  cartResponseSchema,
  customerOrderSchema,
  customerPriceListResponseSchema,
  stockLimitExceededDetailsSchema,
} from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { toStaffViewerActor } from '../src/common/auth/staff-viewer.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import {
  PriceListExportService,
  PricingModule,
  PricingService,
  StaffStockService,
} from '../src/modules/pricing/index.js';
import {
  findForbiddenKeys,
  findStaffOnlyFieldsInCustomerCart,
  findStaffOnlyFieldsInCustomerPriceList,
} from './support/forbidden-fields.js';
import { makeProduct, publishPriceList } from './support/orders-fixtures.js';
import { assertCustomerSafe, caller, expectError, expectParsed } from './support/orders-http.js';
import type { Reply } from './support/orders-http.js';
import { createWorld, stockUp, submitOrder, type World } from './support/orders-world.js';
import { recordSql } from './support/sql-counter.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// What a stock answer must never carry: the delivery line's secrets of `stockUp` and `sheetSays`.
const COST_WORDS = /cost|supplier|purchase|margin|usd|REF-|12000|Test supplier/i;

describe('customers see the orderable stock and cannot order more (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule, CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
    // These tests set their own stock: the world's lines are emptied, so p1 and p2 start as
    // tracked products with nothing left (out of stock) until a test stocks them.
    await t.prisma.priceReference.updateMany({ data: { availableQuantity: '0' } });
    await t.prisma.stockCache.updateMany({ data: { quantity: '0' } });
  });

  /** What the next sync would write: the sheet now shows this much on the product's lines. */
  async function sheetNowSays(productId: string, quantity: string): Promise<void> {
    const lines = await t.prisma.priceReference.findMany({
      where: { productId, removedAt: null },
      orderBy: { deliveredAt: 'asc' },
    });
    // Everything on the newest line, the others empty: only the sum matters to these tests.
    for (const [index, line] of lines.entries()) {
      await t.prisma.priceReference.update({
        where: { id: line.id },
        data: { availableQuantity: index === lines.length - 1 ? quantity : '0' },
      });
    }
    await t.prisma.stockCache.update({ where: { productId }, data: { quantity } });
  }

  /** A product the sheet knows nothing about: no stock aggregate at all (unknown stock). */
  async function stockUnknown(productId: string): Promise<void> {
    await t.prisma.stockCache.delete({ where: { productId } });
  }

  const priceList = async (actor: Actor) => {
    const reply = await call(PRICING_ROUTES.currentPriceList, { actor });
    expect(findForbiddenKeys(reply.body)).toEqual([]);
    expect(findStaffOnlyFieldsInCustomerPriceList(reply.body)).toEqual([]);
    expect(JSON.stringify(reply.body)).not.toMatch(COST_WORDS);
    return expectParsed(reply, 200, customerPriceListResponseSchema);
  };
  const figures = async (actor: Actor): Promise<Record<string, number | null>> =>
    Object.fromEntries(
      (await priceList(actor)).items.map((item) => [item.productCode, item.orderableStock]),
    );

  /** A customer answer of the cart routes, scanned for leaks whatever its status. */
  const scanned = (reply: Reply): Reply => {
    expect(findForbiddenKeys(reply.body)).toEqual([]);
    expect(findStaffOnlyFieldsInCustomerCart(reply.body)).toEqual([]);
    expect(JSON.stringify(reply.body)).not.toMatch(COST_WORDS);
    if (reply.status < 300) assertCustomerSafe(reply.body, w);
    return reply;
  };
  const putItem = async (actor: Actor, productId: string, quantity: string): Promise<Reply> =>
    scanned(
      await call(ORDER_ROUTES.setCartItem, { actor, params: { productId }, body: { quantity } }),
    );
  const removeItem = async (actor: Actor, productId: string): Promise<Reply> =>
    scanned(await call(ORDER_ROUTES.removeCartItem, { actor, params: { productId } }));
  const getCart = async (actor: Actor) =>
    expectParsed(scanned(await call(ORDER_ROUTES.getCart, { actor })), 200, cartResponseSchema);
  const submit = async (actor: Actor, expectedTotalAmount: string, key: string): Promise<Reply> =>
    scanned(
      await call(ORDER_ROUTES.submitOrder, {
        actor,
        key,
        body: { paymentPlan: 'FULL', expectedTotalAmount },
      }),
    );

  /** The refusal: 409 with the typed reason and the current figure of each refused product. */
  function expectStockRefusal(reply: Reply, expected: [productId: string, figure: number][]): void {
    const error = expectError(reply, 409, 'CONFLICT', 'STOCK_LIMIT_EXCEEDED');
    const details = stockLimitExceededDetailsSchema.parse(error.details);
    expect(details.lines.map((line) => [line.productId, line.orderableStock])).toEqual(expected);
  }

  const approve = (orderId: string) =>
    w.step(w.actors.manager, orderId, { to: 'MANAGER_APPROVED' });

  describe('the figure', () => {
    it('is the available stock minus the holds of approved orders of every organization', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p1, '30', { deliveryRef: 'REF-A' });
      await stockUp(t.prisma, p1, '20', { deliveryRef: 'REF-B' });
      await stockUp(t.prisma, p2, '8', { deliveryRef: 'REF-C' });
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-1': 50, 'P-2': 8 });

      // An order that is only submitted holds nothing: stock is not a reservation (hard rule 10).
      const waiting = await submitOrder(w, w.actors.ownerB, { items: [[p1, '12']] });
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-1': 50, 'P-2': 8 });

      // The manager approves organization B's order: its hold lowers the figure for EVERYONE,
      // organization A included, and by the held amount only.
      await approve(waiting.id);
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-1': 38, 'P-2': 8 });
      expect(await figures(w.actors.ownerB)).toEqual({ 'P-1': 38, 'P-2': 8 });

      // The same number the staff stock page shows as available ("Mavjud").
      const staff = await t.get(StaffStockService).listStock(w.actors.manager, {});
      const staffAvailable = Object.fromEntries(
        staff.items.map((item) => [item.product.productCode, item.availableQuantity?.toFixed(0)]),
      );
      expect(staffAvailable).toMatchObject({ 'P-1': '38', 'P-2': '8' });

      // The cart line carries the same figure.
      const cart = expectParsed(await putItem(w.actors.sellerA, p1, '2'), 200, cartResponseSchema);
      expect(cart.lines.map((line) => [line.productCode, line.orderableStock])).toEqual([
        ['P-1', 38],
      ]);
    });

    it('is whole pieces: a fraction on the sheet never rounds the figure up', async () => {
      await stockUp(t.prisma, w.products.p1, '7.900', { deliveryRef: 'REF-A' });
      await stockUp(t.prisma, w.products.p2, '0.900', { deliveryRef: 'REF-B' });
      // Less than one piece is nothing to order: out of stock, not "no figure".
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-1': 7, 'P-2': 0 });
    });

    it('costs a fixed number of queries whatever the size of the price list', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p1, '5', { deliveryRef: 'REF-A' });
      const small = await recordSql(t.prisma, () => priceList(w.actors.sellerA));

      const more: Record<string, string> = {};
      for (let index = 0; index < 12; index += 1) {
        const id = await makeProduct(t.prisma, { code: `P-BULK-${index}` });
        await stockUp(t.prisma, id, String(index + 1), { deliveryRef: `REF-BULK-${index}` });
        more[id] = '10.00';
      }
      await publishPriceList(w.pricing, { [p1]: '1500.00', [p2]: '750.50', ...more }, t.prisma);
      const large = await recordSql(t.prisma, () => priceList(w.actors.sellerA));

      // P-2's sheet stock is zero (beforeEach), so it is not listed: 1 + 12 of the 14 priced.
      expect((await priceList(w.actors.sellerA)).items).toHaveLength(13);
      expect(large.length).toBe(small.length);
    });
  });

  describe('no figure: unknown and untracked stock', () => {
    it('is null, shows nothing that names the kind of product, and has no cap', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p2, '5', { deliveryRef: 'REF-A' });
      // Unknown: a product the sheet has never delivered (no line, no aggregate).
      const unknown = await makeProduct(t.prisma, { code: 'P-NEW', names: { UZ: 'Yangi' } });
      // Untracked: a staff-added product. Rows that should not exist are planted (an aggregate of
      // 99 and one of 0) to prove the rule is the product's type, not the absence of rows.
      const manual = await t.prisma.product.create({
        data: {
          productCode: 'IO-000042',
          codeGenerated: true,
          unit: 'box',
          translations: { create: [{ lang: 'UZ', name: 'Qo`lda qo`shilgan' }] },
        },
      });
      await stockUp(t.prisma, manual.id, '99', { deliveryRef: 'REF-M' });
      const manualEmpty = await t.prisma.product.create({
        data: {
          productCode: 'IO-000043',
          codeGenerated: true,
          unit: 'box',
          translations: { create: [{ lang: 'UZ', name: 'Qo`lda qo`shilgan 2' }] },
        },
      });
      await stockUp(t.prisma, manualEmpty.id, '0', { deliveryRef: 'REF-M0' });
      await publishPriceList(
        w.pricing,
        {
          [p1]: '1500.00',
          [p2]: '750.50',
          [unknown]: '10.00',
          [manual.id]: '20.00',
          [manualEmpty.id]: '30.00',
        },
        t.prisma,
      );

      const list = await priceList(w.actors.sellerA);
      expect(
        Object.fromEntries(list.items.map((item) => [item.productCode, item.orderableStock])),
      ).toEqual({
        // The sheet product whose sheet stock is zero (P-1) is not listed at all [C, 2026-11-19];
        // the others have NO figure. A staff-added product is never hidden or "out of stock",
        // whatever its (planted) rows say.
        'P-2': 5,
        'P-NEW': null,
        'IO-000042': null,
        'IO-000043': null,
      });
      // A product without a figure looks like any other: the item has the same keys, and nothing
      // in the answer says which kind of product it is.
      const keysOf = (code: string): string[] =>
        Object.keys(list.items.find((item) => item.productCode === code) ?? {}).sort();
      expect(keysOf('IO-000042')).toEqual(keysOf('P-2'));
      expect(JSON.stringify(list)).not.toMatch(/generated|tracked|manual|byOrder/i);

      // No figure means no cap: any quantity goes into the cart and into an order.
      for (const productId of [unknown, manual.id, manualEmpty.id]) {
        expectParsed(await putItem(w.actors.sellerA, productId, '5000'), 200, cartResponseSchema);
      }
      const cart = await getCart(w.actors.sellerA);
      expect(cart.lines.map((line) => [line.orderableStock, line.problem])).toEqual([
        [null, null],
        [null, null],
        [null, null],
      ]);
      expect(cart.canSubmit).toBe(true);
      const placed = expectParsed(
        await submit(w.actors.sellerA, cart.totalAmount, 'stock-cap-uncapped-1'),
        201,
        customerOrderSchema,
      );
      expect(placed.items.map((item) => item.quantity)).toEqual([
        '5000.000',
        '5000.000',
        '5000.000',
      ]);
      // The order itself carries no stock figure: the strict order schema would refuse the key.
      expect(JSON.stringify(placed)).not.toMatch(/stock/i);
    });

    it('a sheet product without a stock aggregate is unknown, not out of stock', async () => {
      const { p1 } = w.products;
      await stockUnknown(p1);
      expect((await figures(w.actors.sellerA))['P-1']).toBeNull();
      const cart = expectParsed(
        await putItem(w.actors.sellerA, p1, '5000'),
        200,
        cartResponseSchema,
      );
      expect(cart.lines[0]).toMatchObject({ orderableStock: null, problem: null });
    });
  });

  describe('the sheet says zero: not in the price list [C, owner 2026-11-19]', () => {
    const exportedCodes = async (): Promise<string[]> =>
      (await t.get(PricingService).getCurrentForExport()).items.map((i) => i.product.productCode);

    it('is left out of the customer list and the Excel file, and comes back with stock', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p1, '4', { deliveryRef: 'REF-A' });
      await stockUp(t.prisma, p2, '5', { deliveryRef: 'REF-B' });
      await sheetNowSays(p1, '0');

      expect(await figures(w.actors.sellerA)).toEqual({ 'P-2': 5 });
      expect(await figures(w.actors.ownerB)).toEqual({ 'P-2': 5 });
      const viewer = toStaffViewerActor({ userId: w.ids.manager, staffRoles: ['MANAGER'] }, null);
      expect(await figures(viewer)).toEqual({ 'P-2': 5 });
      expect(await exportedCodes()).toEqual(['P-2']);
      expect((await t.get(PriceListExportService).buildCurrent('RU')).rowCount).toBe(1);

      // Staff still see and price it: only what customers are offered changes.
      const staff = await t.get(PricingService).getCurrentForStaff(w.actors.manager);
      expect(staff.items.map((i) => i.product.productCode).sort()).toEqual(['P-1', 'P-2']);

      // The next sync brings stock back: listed again, nothing to do by hand.
      await sheetNowSays(p1, '3');
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-1': 3, 'P-2': 5 });
      expect((await exportedCodes()).sort()).toEqual(['P-1', 'P-2']);
    });

    it('stays listed, as out of stock, while only approved orders hold the sheet stock', async () => {
      const { p1 } = w.products;
      await stockUp(t.prisma, p1, '5', { deliveryRef: 'REF-A' });
      await approve((await submitOrder(w, w.actors.ownerB, { items: [[p1, '5']] })).id);
      expect((await figures(w.actors.sellerA))['P-1']).toBe(0);
      expect(await exportedCodes()).toContain('P-1');
    });

    it('a staff-added product and an unknown stock are never left out', async () => {
      const { p1, p2 } = w.products;
      await stockUnknown(p1);
      const manual = await t.prisma.product.create({
        data: {
          productCode: 'IO-000044',
          codeGenerated: true,
          translations: { create: [{ lang: 'UZ', name: 'Buyurtma orqali' }] },
        },
      });
      // A planted zero aggregate: the product's type decides, not the rows.
      await stockUp(t.prisma, manual.id, '0', { deliveryRef: 'REF-M0' });
      await publishPriceList(
        w.pricing,
        { [p1]: '1500.00', [p2]: '750.50', [manual.id]: '20.00' },
        t.prisma,
      );
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-1': null, 'IO-000044': null });
      expect((await exportedCodes()).sort()).toEqual(['IO-000044', 'P-1']);
    });
  });

  describe('out of stock: a tracked product with nothing free', () => {
    it('the sheet says zero: not listed, and the product cannot enter the cart', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p2, '5', { deliveryRef: 'REF-A' });
      expect(await figures(w.actors.sellerA)).toEqual({ 'P-2': 5 });

      // Not even one piece, by setting or by adding; the refusal names the figure 0.
      expectStockRefusal(await putItem(w.actors.sellerA, p1, '1'), [[p1, 0]]);
      await expect(w.carts.addItem(w.actors.sellerA, p1, '1')).rejects.toMatchObject({
        reason: 'STOCK_LIMIT_EXCEEDED',
        details: { lines: [{ productId: p1, orderableStock: 0 }] },
      });
      expect((await getCart(w.actors.sellerA)).lines).toEqual([]);
      // The product with stock is not affected.
      expectParsed(await putItem(w.actors.sellerA, p2, '5'), 200, cartResponseSchema);
    });

    it('approved orders hold everything: the figure is 0 for everyone until a hold ends', async () => {
      const { p1 } = w.products;
      await stockUp(t.prisma, p1, '5', { deliveryRef: 'REF-A' });
      const theirs = await submitOrder(w, w.actors.ownerB, { items: [[p1, '5']] });
      // Submitted only: nothing is held, organization A may still take all five.
      expect((await figures(w.actors.sellerA))['P-1']).toBe(5);
      await approve(theirs.id);

      expect((await figures(w.actors.sellerA))['P-1']).toBe(0);
      expect((await figures(w.actors.ownerB))['P-1']).toBe(0);
      expectStockRefusal(await putItem(w.actors.sellerA, p1, '1'), [[p1, 0]]);
      // The staff page says the same: nothing available, although the sheet still shows five.
      const staff = await t.get(StaffStockService).listStock(w.actors.manager, {});
      expect(
        staff.items.find((item) => item.product.id === p1)?.availableQuantity?.toFixed(0),
      ).toBe('0');

      // The hold ends (the order is cancelled): the pieces can be ordered again.
      await w.step(w.actors.manager, theirs.id, { to: 'CANCELLED', reason: 'changed their mind' });
      expect((await figures(w.actors.sellerA))['P-1']).toBe(5);
      expectParsed(await putItem(w.actors.sellerA, p1, '5'), 200, cartResponseSchema);
    });

    it('a line whose stock ran out is a problem with a figure of 0; removing it is the way out', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });
      await stockUp(t.prisma, p2, '10', { deliveryRef: 'REF-B' });
      await putItem(w.actors.sellerA, p1, '3');
      await putItem(w.actors.sellerA, p2, '2');

      await sheetNowSays(p1, '0');
      const cart = await getCart(w.actors.sellerA);
      expect(
        cart.lines.map((line) => [line.productCode, line.orderableStock, line.problem]),
      ).toEqual([
        ['P-1', 0, 'STOCK_EXCEEDED'],
        ['P-2', 10, null],
      ]);
      // Still a priced product: the line keeps its prices, the order is blocked. The cart reads
      // the full list, so leaving P-1 out of the catalog does not turn the line into an unknown one.
      expect(cart.lines[0]).toMatchObject({ unitPrice: '1500.00', lineTotal: '4500.00' });
      expect(cart.canSubmit).toBe(false);

      // No quantity can be lowered to: every one is refused, and so is the order.
      expectStockRefusal(await putItem(w.actors.sellerA, p1, '1'), [[p1, 0]]);
      expectStockRefusal(await submit(w.actors.sellerA, cart.totalAmount, 'stock-cap-gone-1'), [
        [p1, 0],
      ]);
      expect(await t.prisma.order.count()).toBe(0);

      const without = expectParsed(await removeItem(w.actors.sellerA, p1), 200, cartResponseSchema);
      expect(without.lines.map((line) => line.productCode)).toEqual(['P-2']);
      expect(without.canSubmit).toBe(true);
      expectParsed(
        await submit(w.actors.sellerA, without.totalAmount, 'stock-cap-gone-2'),
        201,
        customerOrderSchema,
      );
    });
  });

  describe('the cap on a cart quantity', () => {
    it('refuses a quantity above the figure with the current figure, and changes nothing', async () => {
      const { p1 } = w.products;
      await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });

      expectStockRefusal(await putItem(w.actors.sellerA, p1, '11'), [[p1, 10]]);
      expect((await getCart(w.actors.sellerA)).lines).toEqual([]);

      // Up to the figure is fine, and a second customer may take the same last pieces: nothing
      // is reserved by a cart.
      const mine = expectParsed(await putItem(w.actors.sellerA, p1, '10'), 200, cartResponseSchema);
      expect(mine.lines[0]).toMatchObject({
        quantity: '10.000',
        orderableStock: 10,
        problem: null,
      });
      expect(mine.canSubmit).toBe(true);
      expectParsed(await putItem(w.actors.ownerB, p1, '10'), 200, cartResponseSchema);

      // A refused change leaves the line as it was.
      expectStockRefusal(await putItem(w.actors.sellerA, p1, '999999'), [[p1, 10]]);
      expect((await getCart(w.actors.sellerA)).lines[0]?.quantity).toBe('10.000');
    });

    it('counts what is already in the cart when a quantity is added', async () => {
      const { p1 } = w.products;
      await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });
      await w.carts.addItem(w.actors.sellerA, p1, '6');
      await expect(w.carts.addItem(w.actors.sellerA, p1, '5')).rejects.toMatchObject({
        code: 'CONFLICT',
        reason: 'STOCK_LIMIT_EXCEEDED',
        details: { lines: [{ productId: p1, orderableStock: 10 }] },
      });
      await w.carts.addItem(w.actors.sellerA, p1, '4');
      expect((await getCart(w.actors.sellerA)).lines[0]?.quantity).toBe('10.000');
    });

    it('binds a staff viewer`s personal cart the same way', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p1, '3', { deliveryRef: 'REF-A' });
      await stockUnknown(p2);
      const viewer = toStaffViewerActor({ userId: w.ids.manager, staffRoles: ['MANAGER'] }, null);

      expectStockRefusal(await putItem(viewer, p1, '4'), [[p1, 3]]);
      const cart = expectParsed(await putItem(viewer, p1, '3'), 200, cartResponseSchema);
      expect(cart.lines[0]).toMatchObject({ quantity: '3.000', orderableStock: 3, problem: null });
      // No figure, no cap, for the viewer too.
      expectParsed(await putItem(viewer, p2, '700'), 200, cartResponseSchema);

      await sheetNowSays(p1, '1');
      const fallen = await getCart(viewer);
      expect(
        fallen.lines.map((line) => [line.productCode, line.orderableStock, line.problem]),
      ).toEqual([
        ['P-1', 1, 'STOCK_EXCEEDED'],
        ['P-2', null, null],
      ]);
      expect(fallen.canSubmit).toBe(false);
      // Out of stock binds the viewer as well.
      await sheetNowSays(p1, '0');
      expectStockRefusal(await putItem(viewer, p1, '1'), [[p1, 0]]);
    });
  });

  describe('the stock fell after the product was put in the cart', () => {
    it('marks the line, keeps its prices, blocks the order until the quantity is lowered', async () => {
      const { p1, p2 } = w.products;
      await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });
      await stockUnknown(p2);
      await putItem(w.actors.sellerA, p1, '10');
      await putItem(w.actors.sellerA, p2, '2');

      await sheetNowSays(p1, '4');
      const cart = await getCart(w.actors.sellerA);
      expect(cart.lines).toEqual([
        {
          productId: p1,
          productCode: 'P-1',
          name: 'Olma',
          unit: 'PIECE',
          quantity: '10.000',
          // The product can still be ordered, so the line keeps its prices: only the quantity is wrong.
          unitPrice: '1500.00',
          lineTotal: '15000.00',
          deferredUnitPrice: null,
          deferredLineTotal: null,
          rrp: null,
          orderableStock: 4,
          problem: 'STOCK_EXCEEDED',
        },
        {
          productId: p2,
          productCode: 'P-2',
          name: 'Nok',
          unit: 'PIECE',
          quantity: '2.000',
          unitPrice: '750.50',
          lineTotal: '1501.00',
          deferredUnitPrice: null,
          deferredLineTotal: null,
          rrp: null,
          orderableStock: null,
          problem: null,
        },
      ]);
      // The total is what the screen shows; the order is blocked.
      expect([cart.totalAmount, cart.canSubmit]).toEqual(['16501.00', false]);

      // The server refuses the order itself, whatever the client shows, and creates nothing.
      expectStockRefusal(await submit(w.actors.sellerA, cart.totalAmount, 'stock-cap-fell-1'), [
        [p1, 4],
      ]);
      expect(await t.prisma.order.count()).toBe(0);
      expect((await getCart(w.actors.sellerA)).lines).toHaveLength(2);

      // Lowering, but not far enough, is refused too and names the figure.
      expectStockRefusal(await putItem(w.actors.sellerA, p1, '7'), [[p1, 4]]);

      // "Set to 4": the line is fine again and the order goes through.
      const fixed = expectParsed(await putItem(w.actors.sellerA, p1, '4'), 200, cartResponseSchema);
      expect(fixed.lines[0]).toMatchObject({ quantity: '4.000', orderableStock: 4, problem: null });
      expect(fixed.canSubmit).toBe(true);
      const placed = expectParsed(
        await submit(w.actors.sellerA, fixed.totalAmount, 'stock-cap-fell-2'),
        201,
        customerOrderSchema,
      );
      expect(placed.items.map((item) => [item.productCode, item.quantity])).toEqual([
        ['P-1', '4.000'],
        ['P-2', '2.000'],
      ]);
    });

    it('a hold of another organization`s approved order makes the line a problem', async () => {
      const { p1 } = w.products;
      await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });
      await putItem(w.actors.sellerA, p1, '10');

      const theirs = await submitOrder(w, w.actors.ownerB, { items: [[p1, '3']] });
      // Submitted only: A's cart is untouched.
      expect((await getCart(w.actors.sellerA)).lines[0]).toMatchObject({
        orderableStock: 10,
        problem: null,
      });
      await approve(theirs.id);

      const cart = await getCart(w.actors.sellerA);
      expect(cart.lines[0]).toMatchObject({ orderableStock: 7, problem: 'STOCK_EXCEEDED' });
      expectStockRefusal(await submit(w.actors.sellerA, cart.totalAmount, 'stock-cap-held-1'), [
        [p1, 7],
      ]);
      // A sees a number only: nothing about the other organization or its order.
      const text = JSON.stringify(cart);
      for (const secret of [w.orgB, w.ids.ownerB, theirs.id, theirs.orderNumber]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it('the stock is re-read at submit: a cart that was fine when shown is refused', async () => {
      const { p1 } = w.products;
      await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });
      const shown = expectParsed(await putItem(w.actors.sellerA, p1, '9'), 200, cartResponseSchema);
      expect(shown.canSubmit).toBe(true);

      await sheetNowSays(p1, '2');
      expectStockRefusal(await submit(w.actors.sellerA, shown.totalAmount, 'stock-cap-late-1'), [
        [p1, 2],
      ]);
      // Stock that ran out entirely refuses too, with a figure of zero.
      await sheetNowSays(p1, '0');
      expectStockRefusal(await submit(w.actors.sellerA, shown.totalAmount, 'stock-cap-late-2'), [
        [p1, 0],
      ]);
      expect(await t.prisma.order.count()).toBe(0);

      // The sheet shows enough again: the same cart goes through.
      await sheetNowSays(p1, '9');
      expectParsed(
        await submit(w.actors.sellerA, shown.totalAmount, 'stock-cap-late-3'),
        201,
        customerOrderSchema,
      );
    });
  });

  it('does not cap the manager`s later edit of an order', async () => {
    const { p1 } = w.products;
    await stockUp(t.prisma, p1, '10', { deliveryRef: 'REF-A' });
    const order = await submitOrder(w, w.actors.sellerA, { items: [[p1, '4']] });
    const edited = await w.edit(w.actors.manager, order.id, {
      changes: [{ itemId: order.items[0]!.id, quantity: '50' }],
      reason: 'the customer asked for more',
    });
    expect(edited.items[0]?.quantity.toFixed(0)).toBe('50');
  });
});
