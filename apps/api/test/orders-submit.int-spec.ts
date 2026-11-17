import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
} from '../src/common/errors/domain-errors.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { publishPriceList } from './support/orders-fixtures.js';
import {
  createWorld,
  fillCart,
  nextKey,
  submitOrder,
  toPlainJson,
  type World,
  placeCart,
} from './support/orders-world.js';

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConflictError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('cart and submit (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    w = await createWorld(t);
  });

  const count = async () => ({
    orders: await w.prisma.order.count(),
    items: await w.prisma.orderItem.count(),
    events: await w.prisma.orderEvent.count(),
    outbox: await w.prisma.notificationOutbox.count(),
  });

  describe('cart', () => {
    it('stores no prices and shows the cart priced with the published list', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '3'],
      ]);
      const cart = await w.carts.getCart(w.actors.sellerA);
      expect(
        cart.lines.map((l) => [
          l.productCode,
          l.quantity.toFixed(3),
          l.unitPrice?.toFixed(2),
          l.lineTotal?.toFixed(2),
        ]),
      ).toEqual([
        ['P-1', '2.000', '1500.00', '3000.00'],
        // 3 x 750.50 = 2251.50
        ['P-2', '3.000', '750.50', '2251.50'],
      ]);
      expect(cart.totalAmount.toFixed(2)).toBe('5251.50');
      expect(cart.canSubmit).toBe(true);
      expect(cart.priceListVersionNumber).not.toBeNull();

      // Hand-checked: the cart tables have no price column at all.
      const columns = await w.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name IN ('carts', 'cart_items')`;
      expect(columns.map((c) => c.column_name).filter((n) => /price|amount|total/.test(n))).toEqual(
        [],
      );
    });

    it('a later price publish re-prices the cart (nothing was stored)', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '2']]);
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1600.00', [w.products.p2]: '750.50' },
        w.prisma,
      );
      const cart = await w.carts.getCart(w.actors.sellerA);
      expect(cart.totalAmount.toFixed(2)).toBe('3200.00');
    });

    it('adds to, sets and removes a line', async () => {
      const a = w.actors.sellerA;
      await w.carts.addItem(a, w.products.p1, '1');
      await w.carts.addItem(a, w.products.p1, '2');
      expect((await w.carts.getCart(a)).lines[0]?.quantity.toFixed(3)).toBe('3.000');
      await w.carts.setItemQuantity(a, w.products.p1, '4');
      expect((await w.carts.getCart(a)).lines[0]?.quantity.toFixed(3)).toBe('4.000');
      expect((await w.carts.removeItem(a, w.products.p1)).lines).toEqual([]);
    });

    it('keeps one cart per person: a colleague has their own', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      expect((await w.carts.getCart(w.actors.sellerA2)).lines).toEqual([]);
      expect((await w.carts.getCart(w.actors.ownerA)).lines).toEqual([]);
    });

    it.each(['0', '-1', '1.2345', 'abc', '', '1e3', '1000000'])(
      'rejects the quantity %j',
      async (quantity) => {
        await expect(
          w.carts.addItem(w.actors.sellerA, w.products.p1, quantity),
        ).rejects.toBeInstanceOf(InputValidationError);
        await expect(
          w.carts.setItemQuantity(w.actors.sellerA, w.products.p1, quantity),
        ).rejects.toBeInstanceOf(InputValidationError);
      },
    );

    it('refuses to grow a line past the maximum quantity', async () => {
      // A product without a stock aggregate (unknown stock) has no stock cap, so the quantity
      // limit is what answers.
      await w.prisma.stockCache.deleteMany();
      await w.carts.setItemQuantity(w.actors.sellerA, w.products.p1, '999999');
      await expect(w.carts.addItem(w.actors.sellerA, w.products.p1, '1')).rejects.toBeInstanceOf(
        InputValidationError,
      );
    });

    it('does not take unpriced, inactive or unknown products', async () => {
      expect(await reason(w.carts.addItem(w.actors.sellerA, w.products.p3, '1'))).toBe(
        'PRODUCT_NOT_ORDERABLE',
      );
      await w.prisma.product.update({ where: { id: w.products.p2 }, data: { isActive: false } });
      expect(await reason(w.carts.addItem(w.actors.sellerA, w.products.p2, '1'))).toBe(
        'PRODUCT_NOT_ORDERABLE',
      );
      await expect(
        w.carts.addItem(w.actors.sellerA, '019a0000-0000-7000-8000-000000000000', '1'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('flags lines that became unorderable and blocks submitting them', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '1'],
        [w.products.p2, '1'],
      ]);
      await w.prisma.product.update({ where: { id: w.products.p2 }, data: { isActive: false } });
      const cart = await w.carts.getCart(w.actors.sellerA);
      expect(cart.lines.map((l) => [l.productCode, l.problem])).toEqual([
        ['P-1', null],
        ['P-2', 'INACTIVE'],
      ]);
      expect(cart.totalAmount.toFixed(2)).toBe('1500.00');
      expect(cart.canSubmit).toBe(false);
    });

    it('orders a product whose stored unit is NULL by the piece, with the common name in the snapshot', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p2, '2']]);
      // An older sheet-created product: no unit stored and only the sheet's Russian name.
      await w.prisma.$executeRaw`UPDATE products SET unit = NULL WHERE id = ${w.products.p2}::uuid`;
      await w.prisma.productTranslation.deleteMany({ where: { productId: w.products.p2 } });
      await w.prisma.productTranslation.create({
        data: { productId: w.products.p2, lang: 'RU', name: 'Груша' },
      });

      const cart = await w.carts.getCart(w.actors.sellerA);
      expect(cart.lines.map((l) => [l.productCode, l.name, l.unit, l.problem])).toEqual([
        ['P-2', 'Груша', 'PIECE', null],
      ]);
      await placeCart(w, w.actors.sellerA, w.orgA, 'null-unit-key-1', 'FULL');
      const items = await w.prisma.orderItem.findMany();
      expect(items.map((i) => [i.nameSnapshot, i.unitSnapshot])).toEqual([['Груша', 'PIECE']]);
    });

    it('is for customers only: staff, even admin, have no cart', async () => {
      for (const actor of [
        w.actors.manager,
        w.actors.admin,
        w.actors.accountant,
        w.actors.driver,
      ]) {
        await expect(w.carts.getCart(actor)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(w.carts.addItem(actor, w.products.p1, '1')).rejects.toBeInstanceOf(
          ForbiddenError,
        );
      }
    });
  });

  describe('submit', () => {
    it('creates the order from the published list, with an exact price snapshot', async () => {
      const order = await submitOrder(w, w.actors.sellerA, {
        items: [
          [w.products.p2, '2'],
          [w.products.p1, '3'],
        ],
      });
      expect(order.orderNumber).toMatch(/^IO-\d+$/);
      expect(Number(order.orderNumber.slice(3))).toBeGreaterThanOrEqual(10001);
      expect(order).toMatchObject({
        organizationId: w.orgA,
        placedByUserId: w.ids.sellerA,
        status: 'SUBMITTED',
        paymentStatus: 'UNPAID',
        currency: 'UZS',
        rowVersion: 1,
        staff: null,
      });
      // 3 x 1500.00 = 4500.00 ; 2 x 750.50 = 1501.00 ; total 6001.00
      expect(
        order.items.map((i) => [
          i.productCode,
          i.name,
          i.unit,
          i.quantity.toFixed(3),
          i.unitPrice.toFixed(2),
          i.lineTotal.toFixed(2),
        ]),
      ).toEqual([
        ['P-1', 'Olma', 'PIECE', '3.000', '1500.00', '4500.00'],
        ['P-2', 'Nok', 'PIECE', '2.000', '750.50', '1501.00'],
      ]);
      expect(order.totalAmount.toFixed(2)).toBe('6001.00');

      const row = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.priceListVersionId).toBe(w.versionId);
      expect(row.submittedAt).toEqual(new Date('2026-10-20T08:00:00Z'));
      expect(row.accountingMode).toBe('PENDING');
      expect(row.accountingClearedAt).toBeNull();
    });

    it('numbers orders one after another', async () => {
      const first = await submitOrder(w);
      const second = await submitOrder(w);
      expect(Number(second.orderNumber.slice(3))).toBe(Number(first.orderNumber.slice(3)) + 1);
    });

    it('empties the cart', async () => {
      await submitOrder(w);
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toEqual([]);
    });

    it('writes the SUBMITTED event and tells the managers, in the same transaction', async () => {
      const order = await submitOrder(w);
      const events = await w.prisma.orderEvent.findMany({ where: { orderId: order.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'SUBMITTED',
        fromStatus: null,
        toStatus: 'SUBMITTED',
        actorUserId: w.ids.sellerA,
        actorRole: 'SELLER',
        comment: null,
      });
      const payload = events[0]?.payload as { before: unknown; after: Record<string, unknown> };
      expect(payload.before).toBeNull();
      expect(payload.after).toMatchObject({ status: 'SUBMITTED', totalAmount: '3750.50' });
      expect((payload.after.lines as unknown[]).length).toBe(2);

      const outbox = await w.prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        type: 'ORDER_SUBMITTED',
        recipientKind: 'ROLE',
        recipientRole: 'MANAGER',
        status: 'PENDING',
        attempts: 0,
        sentAt: null,
      });
    });

    it('names products with one common name, whatever the language of the person', async () => {
      await w.prisma.user.update({ where: { id: w.ids.sellerA }, data: { language: 'RU' } });
      await w.prisma.user.update({ where: { id: w.ids.sellerA2 }, data: { language: 'EN' } });
      const ru = await submitOrder(w, w.actors.sellerA);
      const en = await submitOrder(w, w.actors.sellerA2);
      const uz = await submitOrder(w, w.actors.ownerA);
      // Owner, 2026-10-28: the stored UZ name for everyone; the RU and EN rows stay but are not used.
      for (const order of [ru, en, uz]) {
        expect(order.items.map((i) => i.name)).toEqual(['Olma', 'Nok']);
      }
    });

    it('rejects an empty cart and creates nothing', async () => {
      expect(await reason(placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL'))).toBe(
        'EMPTY_CART',
      );
      expect(await count()).toEqual({ orders: 0, items: 0, events: 0, outbox: 0 });
    });

    it('rejects inactive, unpriced and removed products with their ids and keeps the cart', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '1'],
        [w.products.p2, '1'],
      ]);
      // p2 leaves the price list: a new version without it
      await publishPriceList(w.pricing, { [w.products.p1]: '1500.00' }, w.prisma);
      try {
        await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
        expect.unreachable('should have been rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({
          reason: 'PRODUCT_NOT_ORDERABLE',
          details: { productIds: [w.products.p2] },
        });
      }
      expect(await count()).toEqual({ orders: 0, items: 0, events: 0, outbox: 0 });
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toHaveLength(2);

      await w.prisma.product.update({ where: { id: w.products.p1 }, data: { isActive: false } });
      expect(await reason(placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL'))).toBe(
        'PRODUCT_NOT_ORDERABLE',
      );
    });

    it('rejects when no price list is published', async () => {
      const bare = await createWorld(t, { publish: false });
      expect(await reason(placeCart(bare, bare.actors.sellerA, bare.orgA, nextKey(), 'FULL'))).toBe(
        'NO_PUBLISHED_VERSION',
      );
    });

    it('needs the customer contact first: CONTACT_REQUIRED, nothing is created', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      await w.prisma.user.update({ where: { id: w.ids.sellerA }, data: { phone: null } });
      expect(await reason(placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL'))).toBe(
        'CONTACT_REQUIRED',
      );
      expect(await count()).toEqual({ orders: 0, items: 0, events: 0, outbox: 0 });
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toHaveLength(1);

      await w.prisma.user.update({
        where: { id: w.ids.sellerA },
        data: { phone: '+998935550147' },
      });
      const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      expect(order.orderNumber).toBeTruthy();
      expect((await count()).orders).toBe(1);
    });

    it('still replays an existing order for the same key when the contact is gone', async () => {
      const key = nextKey();
      const first = await submitOrder(w, w.actors.sellerA, { key });
      await w.prisma.user.update({ where: { id: w.ids.sellerA }, data: { phone: null } });
      const again = await placeCart(w, w.actors.sellerA, w.orgA, key, 'FULL');
      expect(again.id).toBe(first.id);
    });

    it('is for active organizations only', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      await w.prisma.organization.update({ where: { id: w.orgA }, data: { status: 'INACTIVE' } });
      expect(await reason(placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL'))).toBe(
        'ORDERING_ORGANIZATION_INACTIVE',
      );
    });

    it('is for customers of that organization only', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      await expect(
        placeCart(w, w.actors.manager, w.orgA, nextKey(), 'FULL'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(placeCart(w, w.actors.admin, w.orgA, nextKey(), 'FULL')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        placeCart(w, w.actors.sellerA, w.orgB, nextKey(), 'FULL'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await count()).toEqual({ orders: 0, items: 0, events: 0, outbox: 0 });
    });

    it('rejects a malformed idempotency key', async () => {
      for (const key of ['', 'short', 'has space in it', 'x'.repeat(129)]) {
        await expect(placeCart(w, w.actors.sellerA, w.orgA, key, 'FULL')).rejects.toBeInstanceOf(
          InputValidationError,
        );
      }
    });

    it('lets an unpaid customer order (payment never blocks ordering, hard rule 11)', async () => {
      const first = await submitOrder(w);
      expect(first.paymentStatus).toBe('UNPAID');
      // still unpaid, and ordering again works
      const second = await submitOrder(w);
      expect(second.paymentStatus).toBe('UNPAID');
      expect(await w.prisma.order.count({ where: { paymentStatus: 'UNPAID' } })).toBe(2);
    });
  });

  describe('idempotency', () => {
    it('returns the existing order for a repeated key and creates nothing', async () => {
      const key = nextKey();
      const first = await submitOrder(w, w.actors.sellerA, { key });
      const before = await count();
      // the cart is empty now, and even a refilled one must not create a second order
      await fillCart(w, w.actors.sellerA, [[w.products.p2, '5']]);
      const again = await placeCart(w, w.actors.sellerA, w.orgA, key, 'FULL');
      expect(again.id).toBe(first.id);
      expect(again.items).toHaveLength(2);
      expect(await count()).toEqual(before);
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toHaveLength(1);
    });

    it('creates exactly one order when the same key arrives in parallel', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '1'],
        [w.products.p2, '1'],
      ]);
      const key = nextKey();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => placeCart(w, w.actors.sellerA, w.orgA, key, 'FULL')),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const ids = new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.id] : [])));
      expect(ids.size).toBe(1);
      expect(await count()).toEqual({ orders: 1, items: 2, events: 1, outbox: 1 });
    });

    it('lets two different keys race for one cart: one order, the other sees an empty cart', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const results = await Promise.allSettled([
        placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL'),
        placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason).toMatchObject({
        reason: 'EMPTY_CART',
      });
      expect(await w.prisma.order.count()).toBe(1);
    });

    it('does not hand an order to a colleague who reuses the key', async () => {
      const key = nextKey();
      await submitOrder(w, w.actors.sellerA, { key });
      await fillCart(w, w.actors.sellerA2, [[w.products.p1, '1']]);
      expect(await reason(placeCart(w, w.actors.sellerA2, w.orgA, key, 'FULL'))).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('scopes the key to the organization', async () => {
      const key = nextKey();
      const a = await submitOrder(w, w.actors.sellerA, { key });
      const b = await submitOrder(w, w.actors.sellerB, { key });
      expect(a.id).not.toBe(b.id);
      expect(await w.prisma.order.count()).toBe(2);
    });
  });

  describe('the snapshot', () => {
    it('is not changed by later price list publishes, product renames or deactivation', async () => {
      const order = await submitOrder(w);
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '9999.00', [w.products.p2]: '1.00' },
        w.prisma,
      );
      await w.prisma.productTranslation.updateMany({ data: { name: 'Renamed' } });
      await w.prisma.product.updateMany({ data: { isActive: false, unit: 'kg' } });

      const read = await w.orders.getOrderFor(w.actors.sellerA, order.id);
      expect(read.totalAmount.toFixed(2)).toBe('3750.50');
      expect(read.items.map((i) => [i.name, i.unit, i.unitPrice.toFixed(2)])).toEqual([
        ['Olma', 'PIECE', '1500.00'],
        ['Nok', 'PIECE', '750.50'],
      ]);
    });

    it('prices a new order with the new version', async () => {
      const old = await submitOrder(w);
      const newVersion = await publishPriceList(
        w.pricing,
        {
          [w.products.p1]: '1600.00',
          [w.products.p2]: '800.00',
        },
        w.prisma,
      );
      const fresh = await submitOrder(w);
      expect(fresh.totalAmount.toFixed(2)).toBe('4000.00'); // 2 x 1600 + 1 x 800
      expect(old.totalAmount.toFixed(2)).toBe('3750.50');
      expect(
        (await w.prisma.order.findUniqueOrThrow({ where: { id: fresh.id } })).priceListVersionId,
      ).toBe(newVersion);
    });
  });

  it('returns nothing that looks like cost data', async () => {
    const order = await submitOrder(w);
    const cart = await w.carts.getCart(w.actors.sellerA);
    expect(findForbiddenKeys(toPlainJson(order))).toEqual([]);
    expect(findForbiddenKeys(toPlainJson(cart))).toEqual([]);
  });
});
