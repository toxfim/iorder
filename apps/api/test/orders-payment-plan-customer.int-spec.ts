import {
  ORDER_ROUTES,
  customerOrderListResponseSchema,
  customerOrderSchema,
  type PaymentPlan,
} from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import { OrdersRepository } from '../src/modules/orders/orders.repository.js';
import { UsdRateService } from '../src/modules/pricing/index.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { caller, expectError, expectParsed } from './support/orders-http.js';
import {
  createWorld,
  fillCart,
  nextKey,
  placeCart,
  shownCartRequest,
  submitOrder,
  type World,
} from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// 2 x p1 + 1 x p2: 2 x 1500.00 + 750.50 in full, 2 x 1800.00 + 900.25 in parts.
const FULL_TOTAL = '3750.50';
const DEFERRED_TOTAL = '4500.25';
const THREE_MINUTES_MS = 3 * 60 * 1000;

describe('the customer payment plan rules of 2026-10-30 (real PostgreSQL)', () => {
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
    vi.restoreAllMocks();
    w = await createWorld(t);
    call = caller(w);
    await publishBoth();
  });

  const publishBoth = (): Promise<string> =>
    publishPriceList(
      w.pricing,
      { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
      w.prisma,
      'UZS',
      { [w.products.p1]: '1800.00', [w.products.p2]: '900.25' },
    );
  const publishWithoutP2Deferred = (): Promise<string> =>
    publishPriceList(
      w.pricing,
      { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
      w.prisma,
      'UZS',
      { [w.products.p1]: '1800.00' },
    );

  const own = (actor: Actor, order: OrderView, paymentPlan: PaymentPlan) =>
    call(ORDER_ROUTES.changeOrderPaymentPlan, {
      actor,
      params: { id: order.id },
      body: { paymentPlan, expectedRowVersion: order.rowVersion },
    });
  const managerSets = (order: OrderView, paymentPlan: PaymentPlan) =>
    w.orders.setPaymentPlan(w.actors.manager, order.id, {
      paymentPlan,
      expectedRowVersion: order.rowVersion,
    });
  const stored = (orderId: string) =>
    w.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  const planEvents = (orderId: string) =>
    w.prisma.orderEvent.findMany({ where: { orderId, eventType: 'PAYMENT_PLAN_CHANGED' } });
  const planMessages = (orderId: string) =>
    w.prisma.notificationOutbox.findMany({
      where: { orderId, type: 'ORDER_PAYMENT_PLAN_CHANGED' },
    });
  const lineOf = (order: OrderView, code: string): string =>
    order.items.find((item) => item.productCode === code)?.id ?? '';
  const after = (order: OrderView, ms: number): Date => new Date(order.submittedAt.getTime() + ms);

  describe('the customer changes the plan after submitting', () => {
    it('recomputes from the snapshot in one event, tells the managers, not the chat', async () => {
      const order = await submitOrder(w);
      t.clock.set(after(order, 60_000));
      const got = expectParsed(
        await own(w.actors.sellerA, order, 'DEFERRED'),
        200,
        customerOrderSchema,
      );
      expect(got.paymentPlan).toBe('DEFERRED');
      expect(got.totalAmount).toBe(DEFERRED_TOTAL);
      expect(got.rowVersion).toBe(order.rowVersion + 1);
      expect(got.items.map((item) => item.unitPrice)).toEqual(['1800.00', '900.25']);

      const row = await stored(order.id);
      expect(row.paymentPlan).toBe('DEFERRED');
      expect(row.totalAmount.toFixed(2)).toBe(DEFERRED_TOTAL);

      const [event, ...moreEvents] = await planEvents(order.id);
      expect(moreEvents).toEqual([]);
      expect(event).toMatchObject({
        actorUserId: w.ids.sellerA,
        actorRole: 'SELLER',
        comment: null,
        payload: {
          before: { paymentPlan: 'FULL', totalAmount: FULL_TOTAL },
          after: { paymentPlan: 'DEFERRED', totalAmount: DEFERRED_TOTAL },
        },
      });
      const [message, ...moreMessages] = await planMessages(order.id);
      expect(moreMessages).toEqual([]);
      expect(message).toMatchObject({
        recipientKind: 'ROLE',
        recipientRole: 'MANAGER',
        orderEventId: event?.id,
        payload: {
          oldPaymentPlan: 'FULL',
          newPaymentPlan: 'DEFERRED',
          oldTotalAmount: FULL_TOTAL,
          newTotalAmount: DEFERRED_TOTAL,
        },
      });
    });

    it('goes back and forth, each change with its own message', async () => {
      const order = await submitOrder(w, w.actors.sellerA, { paymentPlan: 'DEFERRED' });
      const first = await own(w.actors.sellerA, order, 'FULL');
      const full = expectParsed(first, 200, customerOrderSchema);
      expect(full.totalAmount).toBe(FULL_TOTAL);
      const back = await call(ORDER_ROUTES.changeOrderPaymentPlan, {
        actor: w.actors.sellerA,
        params: { id: order.id },
        body: { paymentPlan: 'DEFERRED', expectedRowVersion: full.rowVersion },
      });
      expect(expectParsed(back, 200, customerOrderSchema).totalAmount).toBe(DEFERRED_TOTAL);
      expect(await planMessages(order.id)).toHaveLength(2);
    });

    it.each(['ownerA', 'sellerA2'] as const)(
      'any member of the organization may do it: %s',
      async (who) => {
        const order = await submitOrder(w);
        const reply = await own(w.actors[who], order, 'DEFERRED');
        expect(expectParsed(reply, 200, customerOrderSchema).paymentPlan).toBe('DEFERRED');
      },
    );

    it('the plan the order already has writes nothing', async () => {
      const order = await submitOrder(w);
      const reply = await own(w.actors.sellerA, order, 'FULL');
      expect(expectParsed(reply, 200, customerOrderSchema).rowVersion).toBe(order.rowVersion);
      expect(await planEvents(order.id)).toEqual([]);
      expect(await planMessages(order.id)).toEqual([]);
    });

    it('never reads the current price list (hard rule 4)', async () => {
      const order = await submitOrder(w);
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1.00', [w.products.p2]: '2.00' },
        w.prisma,
        'UZS',
        { [w.products.p1]: '3.00', [w.products.p2]: '4.00' },
      );
      const reply = await own(w.actors.sellerA, order, 'DEFERRED');
      expect(expectParsed(reply, 200, customerOrderSchema).totalAmount).toBe(DEFERRED_TOTAL);
    });

    it('is refused on the snapshot when a line has no deferred price', async () => {
      await publishWithoutP2Deferred();
      const order = await submitOrder(w);
      await publishBoth();
      const reply = await own(w.actors.sellerA, order, 'DEFERRED');
      expectError(reply, 409, 'CONFLICT', 'DEFERRED_PRICE_UNAVAILABLE');
      expect((await stored(order.id)).paymentPlan).toBe('FULL');
      expect(await planEvents(order.id)).toEqual([]);
    });

    it('a stale row version loses; a missing one is invalid', async () => {
      const order = await submitOrder(w);
      await managerSets(order, 'DEFERRED');
      expectError(await own(w.actors.sellerA, order, 'FULL'), 409, 'CONFLICT', 'ORDER_CHANGED');
      expect((await stored(order.id)).paymentPlan).toBe('DEFERRED');
      const missing = await call(ORDER_ROUTES.changeOrderPaymentPlan, {
        actor: w.actors.sellerA,
        params: { id: order.id },
        body: { paymentPlan: 'FULL' },
      });
      expect(missing.status).toBe(422);
    });

    it('of a customer change racing the approval, exactly one wins', async () => {
      const order = await submitOrder(w);
      const [changed, approved] = await Promise.allSettled([
        own(w.actors.sellerA, order, 'DEFERRED'),
        w.orders.transition(w.actors.manager, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: order.rowVersion,
        }),
      ]);
      const changeWon = changed.status === 'fulfilled' && changed.value.status === 200;
      expect(changeWon).toBe(approved.status === 'rejected');
      const row = await stored(order.id);
      expect(row.rowVersion).toBe(order.rowVersion + 1);
      expect(row.paymentPlan).toBe(changeWon ? 'DEFERRED' : 'FULL');
      expect(row.totalAmount.toFixed(2)).toBe(changeWon ? DEFERRED_TOTAL : FULL_TOTAL);
    });

    it('is one transaction: a failed outbox write leaves no trace', async () => {
      const order = await submitOrder(w);
      vi.spyOn(t.get(OrdersRepository), 'insertOutbox').mockRejectedValueOnce(
        new Error('outbox down'),
      );
      await expect(
        w.orders.changeOwnPaymentPlan(w.actors.sellerA, order.id, {
          paymentPlan: 'DEFERRED',
          expectedRowVersion: order.rowVersion,
        }),
      ).rejects.toThrow('outbox down');
      const row = await stored(order.id);
      expect(row.paymentPlan).toBe('FULL');
      expect(row.totalAmount.toFixed(2)).toBe(FULL_TOTAL);
      expect(row.rowVersion).toBe(order.rowVersion);
      expect(await planEvents(order.id)).toEqual([]);
    });
  });

  describe('the window', () => {
    it('is open until just before 3 minutes and closed exactly at them', async () => {
      const order = await submitOrder(w);
      t.clock.set(after(order, THREE_MINUTES_MS - 1));
      expect((await own(w.actors.sellerA, order, 'DEFERRED')).status).toBe(200);
      t.clock.set(after(order, THREE_MINUTES_MS));
      const current = await w.orders.getOrderFor(w.actors.sellerA, order.id);
      expectError(
        await own(w.actors.sellerA, current, 'FULL'),
        409,
        'CONFLICT',
        'PAYMENT_PLAN_WINDOW_ENDED',
      );
      const row = await stored(order.id);
      expect(row.paymentPlan).toBe('DEFERRED');
      expect(await planEvents(order.id)).toHaveLength(1);
    });

    it('does not bind the manager, who may still change it while SUBMITTED', async () => {
      const order = await submitOrder(w);
      t.clock.set(after(order, THREE_MINUTES_MS * 10));
      expect((await managerSets(order, 'DEFERRED')).paymentPlan).toBe('DEFERRED');
    });

    it('closes as soon as the order leaves SUBMITTED, inside the time', async () => {
      const order = await submitOrder(w);
      const approved = await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      expectError(
        await own(w.actors.sellerA, approved, 'DEFERRED'),
        409,
        'CONFLICT',
        'PAYMENT_PLAN_NOT_CHANGEABLE',
      );
      const got = expectParsed(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerA, params: { id: order.id } }),
        200,
        customerOrderSchema,
      );
      expect(got.paymentPlanChangeableUntil).toBeNull();
      expect(got.paymentPlanTotals).toBeNull();
    });

    it('follows the one env setting', async () => {
      const short = await createTestApp([OrdersModule], {
        env: { PAYMENT_PLAN_CHANGE_WINDOW_SECONDS: 60 },
      });
      try {
        await short.prisma.$connect();
        const world = await createWorld(short);
        await publishPriceList(
          world.pricing,
          { [world.products.p1]: '1500.00', [world.products.p2]: '750.50' },
          world.prisma,
          'UZS',
          { [world.products.p1]: '1800.00', [world.products.p2]: '900.25' },
        );
        const order = await submitOrder(world);
        const offer = world.orders.paymentPlanChangeOffer(order);
        expect(offer?.until.getTime()).toBe(order.submittedAt.getTime() + 60_000);
        short.clock.set(after(order, 60_000));
        expect(world.orders.paymentPlanChangeOffer(order)).toBeNull();
        await expect(
          world.orders.changeOwnPaymentPlan(world.actors.sellerA, order.id, {
            paymentPlan: 'DEFERRED',
            expectedRowVersion: order.rowVersion,
          }),
        ).rejects.toMatchObject({ reason: 'PAYMENT_PLAN_WINDOW_ENDED' });
      } finally {
        await short.close();
      }
    });
  });

  describe('who may and who sees what', () => {
    it('another organization gets 404 and nothing changes (hard rule 6)', async () => {
      const order = await submitOrder(w);
      expectError(await own(w.actors.sellerB, order, 'DEFERRED'), 404, 'NOT_FOUND');
      expectError(await own(w.actors.ownerB, order, 'DEFERRED'), 404, 'NOT_FOUND');
      expect((await stored(order.id)).paymentPlan).toBe('FULL');
      expect(await planEvents(order.id)).toEqual([]);
    });

    it.each(['manager', 'accountant', 'warehouse', 'driver', 'admin'] as const)(
      'the %s cannot use the customer route',
      async (role) => {
        const order = await submitOrder(w);
        expectError(await own(w.actors[role], order, 'DEFERRED'), 403, 'FORBIDDEN');
        expect((await stored(order.id)).paymentPlan).toBe('FULL');
      },
    );

    it('the order answer has the end time and both totals only while open', async () => {
      const order = await submitOrder(w);
      const read = async () =>
        expectParsed(
          await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerA, params: { id: order.id } }),
          200,
          customerOrderSchema,
        );
      const open = await read();
      expect(open.paymentPlanChangeableUntil).toBe(after(order, THREE_MINUTES_MS).toISOString());
      expect(open.paymentPlanTotals).toEqual({ FULL: FULL_TOTAL, DEFERRED: DEFERRED_TOTAL });
      // Only these two totals: the snapshots themselves stay staff-side.
      expect(JSON.stringify(open)).not.toMatch(/fullUnitPrice|deferredUnitPrice/);

      t.clock.set(after(order, THREE_MINUTES_MS));
      const closed = await read();
      expect(closed.paymentPlanChangeableUntil).toBeNull();
      expect(closed.paymentPlanTotals).toBeNull();

      const list = expectParsed(
        await call(ORDER_ROUTES.listOrders, { actor: w.actors.sellerA }),
        200,
        customerOrderListResponseSchema,
      );
      expect(JSON.stringify(list)).not.toMatch(/paymentPlanChangeableUntil|paymentPlanTotals/);
    });

    it('a line without a deferred price offers no deferred total', async () => {
      await publishWithoutP2Deferred();
      const order = await submitOrder(w);
      const got = expectParsed(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerA, params: { id: order.id } }),
        200,
        customerOrderSchema,
      );
      expect(got.paymentPlanTotals).toEqual({ FULL: FULL_TOTAL, DEFERRED: null });
    });
  });

  describe('the expected total on submit', () => {
    const fill = () =>
      fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '1'],
      ]);

    it.each(['FULL', 'DEFERRED'] as const)(
      'a price moved after the cart was read refuses %s and keeps the cart',
      async (paymentPlan) => {
        await fill();
        const seen = await shownCartRequest(w, w.actors.sellerA, paymentPlan);
        await publishPriceList(
          w.pricing,
          { [w.products.p1]: '1600.00', [w.products.p2]: '750.50' },
          w.prisma,
          'UZS',
          { [w.products.p1]: '1900.00', [w.products.p2]: '900.25' },
        );
        const reply = await call(ORDER_ROUTES.submitOrder, {
          actor: w.actors.sellerA,
          key: nextKey(),
          body: seen,
        });
        const error = expectError(reply, 409, 'CONFLICT', 'CART_TOTAL_CHANGED');
        expect(error.details).toEqual({
          currentTotalAmount: paymentPlan === 'FULL' ? '3950.50' : '4700.25',
        });
        expect(await w.prisma.order.count()).toBe(0);
        expect(await w.prisma.notificationOutbox.count()).toBe(0);
        const cart = await w.carts.getCart(w.actors.sellerA);
        expect(cart.lines).toHaveLength(2);
        // The re-read cart gives the total that now goes through.
        const fresh = await shownCartRequest(w, w.actors.sellerA, paymentPlan);
        const order = await w.orders.submitCart(w.actors.sellerA, w.orgA, nextKey(), fresh);
        expect(order.totalAmount.toFixed(2)).toBe(fresh.expectedTotalAmount);
      },
    );

    it('a rate moved after the cart was read refuses a USD priced cart', async () => {
      const rates = t.get(UsdRateService);
      await rates.setUsdRate(w.actors.manager, new Prisma.Decimal('12000'));
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '10.00', [w.products.p2]: '5.00' },
        w.prisma,
        'USD',
        { [w.products.p1]: '12.00', [w.products.p2]: '6.00' },
      );
      await fill();
      const seen = await shownCartRequest(w, w.actors.sellerA, 'FULL');
      await rates.setUsdRate(w.actors.manager, new Prisma.Decimal('12100'));
      const reply = await call(ORDER_ROUTES.submitOrder, {
        actor: w.actors.sellerA,
        key: nextKey(),
        body: seen,
      });
      expectError(reply, 409, 'CONFLICT', 'CART_TOTAL_CHANGED');
      expect(await w.prisma.order.count()).toBe(0);
    });

    it('a replay returns the existing order, whatever total it states', async () => {
      await fill();
      const key = nextKey();
      const first = expectParsed(
        await call(ORDER_ROUTES.submitOrder, {
          actor: w.actors.sellerA,
          key,
          body: { paymentPlan: 'FULL', expectedTotalAmount: FULL_TOTAL },
        }),
        201,
        customerOrderSchema,
      );
      await publishPriceList(w.pricing, { [w.products.p1]: '1.00' }, w.prisma);
      const again = expectParsed(
        await call(ORDER_ROUTES.submitOrder, {
          actor: w.actors.sellerA,
          key,
          body: { paymentPlan: 'FULL', expectedTotalAmount: '1.00' },
        }),
        201,
        customerOrderSchema,
      );
      expect(again.id).toBe(first.id);
      expect(again.totalAmount).toBe(FULL_TOTAL);
      expect(await w.prisma.order.count()).toBe(1);
    });
  });

  describe('edits and plan changes together', () => {
    it('edit, then plan change: the new quantity at the other price', async () => {
      const order = await submitOrder(w);
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: lineOf(order, 'P-1'), quantity: '1' }],
      });
      expect(edited.totalAmount.toFixed(2)).toBe('2250.50');
      const changed = await managerSets(edited, 'DEFERRED');
      expect(changed.totalAmount.toFixed(2)).toBe('2700.25');
      expect(changed.items.map((item) => item.lineTotal.toFixed(2))).toEqual(['1800.00', '900.25']);
    });

    it('DEFERRED, edit, back to FULL', async () => {
      const deferred = await managerSets(await submitOrder(w), 'DEFERRED');
      const edited = await w.edit(w.actors.manager, deferred.id, {
        changes: [{ itemId: lineOf(deferred, 'P-1'), quantity: '3' }],
      });
      expect(edited.totalAmount.toFixed(2)).toBe('6300.25');
      const full = await managerSets(edited, 'FULL');
      expect(full.totalAmount.toFixed(2)).toBe('5250.50');
      expect(full.items.map((item) => item.unitPrice.toFixed(2))).toEqual(['1500.00', '750.50']);
    });

    it('removing the only line without a deferred price makes DEFERRED possible', async () => {
      await publishWithoutP2Deferred();
      const order = await submitOrder(w);
      await expect(managerSets(order, 'DEFERRED')).rejects.toMatchObject({
        reason: 'DEFERRED_PRICE_UNAVAILABLE',
      });
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: lineOf(order, 'P-2'), quantity: null }],
      });
      const changed = await managerSets(edited, 'DEFERRED');
      expect(changed.totalAmount.toFixed(2)).toBe('3600.00');
    });

    it('a manager edit makes the customer re-read before changing the plan', async () => {
      const order = await submitOrder(w);
      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: lineOf(order, 'P-1'), quantity: '1' }],
      });
      expectError(await own(w.actors.sellerA, order, 'DEFERRED'), 409, 'CONFLICT', 'ORDER_CHANGED');
    });
  });

  describe('the cart total is what the order stores', () => {
    it.each(['FULL', 'DEFERRED'] as const)('in UZS, plan %s', async (paymentPlan) => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '7'],
        [w.products.p2, '3'],
      ]);
      const shown = await shownCartRequest(w, w.actors.sellerA, paymentPlan);
      const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), paymentPlan);
      const row = await stored(order.id);
      expect(row.totalAmount.toFixed(2)).toBe(shown.expectedTotalAmount);
    });

    it.each(['FULL', 'DEFERRED'] as const)('in USD with a rate, plan %s', async (paymentPlan) => {
      await t.get(UsdRateService).setUsdRate(w.actors.manager, new Prisma.Decimal('12044.72'));
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '123.45', [w.products.p2]: '67.89' },
        w.prisma,
        'USD',
        { [w.products.p1]: '135.79', [w.products.p2]: '74.67' },
      );
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '7'],
        [w.products.p2, '3'],
      ]);
      const shown = await shownCartRequest(w, w.actors.sellerA, paymentPlan);
      const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), paymentPlan);
      const row = await stored(order.id);
      expect(row.totalAmount.toFixed(2)).toBe(shown.expectedTotalAmount);
      expect(row.paymentPlan).toBe(paymentPlan);
    });
  });

  describe('database guards on the snapshots', () => {
    const firstItem = async (orderId: string) => {
      const [item] = (await stored(orderId)).items;
      if (item === undefined) throw new Error('The order has no lines');
      return item;
    };

    it('a line without a deferred price may only be charged the sale price', async () => {
      await publishWithoutP2Deferred();
      const order = await submitOrder(w);
      const row = await stored(order.id);
      const p2 = row.items.find((item) => item.deferredUnitPrice === null);
      if (p2 === undefined) throw new Error('Expected a line without a deferred price');
      // The old CHECK passed here: `unit_price = NULL` is unknown, and a CHECK lets unknown through.
      await expect(
        w.prisma.orderItem.update({
          where: { id: p2.id },
          data: { unitPrice: '1.00', lineTotal: '1.00' },
        }),
      ).rejects.toThrow(/order_items_unit_price_is_a_snapshot/);
    });

    it.each(['full_unit_price', 'deferred_unit_price'] as const)(
      'rejects a rewrite of %s',
      async (column) => {
        const order = await submitOrder(w);
        const item = await firstItem(order.id);
        await expect(
          w.prisma.$executeRawUnsafe(
            `UPDATE order_items SET ${column} = 1 WHERE id = '${item.id}'`,
          ),
        ).rejects.toThrow(/price snapshots of an order line are immutable/);
      },
    );

    it('rejects clearing or inventing a deferred snapshot', async () => {
      const order = await submitOrder(w);
      const item = await firstItem(order.id);
      await expect(
        w.prisma.$executeRawUnsafe(
          `UPDATE order_items SET deferred_unit_price = NULL WHERE id = '${item.id}'`,
        ),
      ).rejects.toThrow(/immutable/);
    });

    it('leaves quantity edits and the charged price alone', async () => {
      const order = await submitOrder(w);
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: lineOf(order, 'P-1'), quantity: '5' }],
      });
      expect(edited.items.find((item) => item.productCode === 'P-1')?.quantity.toFixed(0)).toBe(
        '5',
      );
      const changed = await managerSets(edited, 'DEFERRED');
      expect(changed.paymentPlan).toBe('DEFERRED');
      const item = await firstItem(order.id);
      expect(item.fullUnitPrice.toFixed(2)).toBe('1500.00');
      expect(item.deferredUnitPrice?.toFixed(2)).toBe('1800.00');
    });
  });
});
