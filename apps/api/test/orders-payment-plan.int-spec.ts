import {
  ORDER_ROUTES,
  cartResponseSchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerTimelineResponseSchema,
} from '@iorder/shared';
import {
  STAFF_ORDER_ROUTES,
  staffOrderListResponseSchema,
  staffOrderSchema,
  staffTimelineResponseSchema,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { ConflictError, ForbiddenError } from '../src/common/errors/domain-errors.js';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import { OrdersRepository } from '../src/modules/orders/orders.repository.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { caller, expectError, expectParsed } from './support/orders-http.js';
import {
  fillCart,
  nextKey,
  submitOrder,
  createWorld,
  type World,
  placeCart,
} from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

async function conflict(promise: Promise<unknown>): Promise<ConflictError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictError);
    return error as ConflictError;
  }
  return expect.unreachable('expected a conflict');
}

// The world's list has sale prices only; here p1 and p2 also have deferred prices:
// 2 x p1 + 1 x p2 costs 3750.50 in full and 2 x 1800.00 + 900.25 = 4500.25 in parts.
const FULL_TOTAL = '3750.50';
const DEFERRED_TOTAL = '4500.25';

describe('payment plan (real PostgreSQL)', () => {
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
  /** p2 loses its deferred price. */
  const publishWithoutP2Deferred = (): Promise<string> =>
    publishPriceList(
      w.pricing,
      { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
      w.prisma,
      'UZS',
      { [w.products.p1]: '1800.00' },
    );

  const change = (actor: Actor, order: OrderView, paymentPlan: 'FULL' | 'DEFERRED') =>
    w.orders.setPaymentPlan(actor, order.id, {
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
  /** The order, moved so that the warehouse and then the driver may read it. */
  const releasedDeferredOrder = async (): Promise<OrderView> => {
    const order = await submitOrder(w, w.actors.sellerA, { paymentPlan: 'DEFERRED' });
    await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED', skipAccounting: true });
    return w.step(w.actors.warehouse, order.id, { to: 'RELEASED', driverUserId: w.ids.driver });
  };

  describe('the cart', () => {
    it('shows both totals when every line has a deferred price', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '1'],
      ]);
      const cart = expectParsed(
        await call(ORDER_ROUTES.getCart, { actor: w.actors.sellerA }),
        200,
        cartResponseSchema,
      );
      expect(cart.totalAmount).toBe(FULL_TOTAL);
      expect(cart.deferredTotalAmount).toBe(DEFERRED_TOTAL);
      expect(cart.lines[0]).toMatchObject({
        unitPrice: '1500.00',
        lineTotal: '3000.00',
        deferredUnitPrice: '1800.00',
        deferredLineTotal: '3600.00',
      });
    });

    it('has no deferred total when one line has no deferred price', async () => {
      await publishWithoutP2Deferred();
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '1'],
      ]);
      const cart = await w.carts.getCart(w.actors.sellerA);
      expect(cart.deferredTotalAmount).toBeNull();
      expect(cart.totalAmount.toFixed(2)).toBe(FULL_TOTAL);
      expect(cart.lines.map((line) => line.deferredUnitPrice?.toFixed(2) ?? null)).toEqual([
        '1800.00',
        null,
      ]);
      expect(cart.canSubmit).toBe(true);
    });
  });

  describe('submit', () => {
    it('FULL charges the sale price and snapshots both prices', async () => {
      const order = await submitOrder(w, w.actors.sellerA, { paymentPlan: 'FULL' });
      expect(order.paymentPlan).toBe('FULL');
      expect(order.totalAmount.toFixed(2)).toBe(FULL_TOTAL);
      const row = await stored(order.id);
      expect(row.paymentPlan).toBe('FULL');
      expect(
        row.items
          .map((i) => [
            i.productCodeSnapshot,
            i.unitPrice.toFixed(2),
            i.fullUnitPrice.toFixed(2),
            i.deferredUnitPrice?.toFixed(2),
          ])
          .sort(),
      ).toEqual([
        ['P-1', '1500.00', '1500.00', '1800.00'],
        ['P-2', '750.50', '750.50', '900.25'],
      ]);
    });

    it('DEFERRED charges the deferred price over HTTP and records the plan in the event', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '1'],
      ]);
      const order = expectParsed(
        await call(ORDER_ROUTES.submitOrder, {
          actor: w.actors.sellerA,
          key: nextKey(),
          body: { paymentPlan: 'DEFERRED', expectedTotalAmount: DEFERRED_TOTAL },
        }),
        201,
        customerOrderSchema,
      );
      expect(order.paymentPlan).toBe('DEFERRED');
      expect(order.totalAmount).toBe(DEFERRED_TOTAL);
      expect(order.items.map((i) => i.unitPrice)).toEqual(['1800.00', '900.25']);
      const [event] = await w.prisma.orderEvent.findMany({ where: { orderId: order.id } });
      expect(event?.payload).toMatchObject({ after: { paymentPlan: 'DEFERRED' } });
    });

    it('a request without a plan is refused: the server never guesses it', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      for (const body of [
        undefined,
        {},
        { paymentPlan: 'CASH', expectedTotalAmount: '1500.00' },
        { paymentPlan: 'FULL' },
        { expectedTotalAmount: '1500.00' },
      ]) {
        const reply = await call(ORDER_ROUTES.submitOrder, {
          actor: w.actors.sellerA,
          key: nextKey(),
          ...(body === undefined ? {} : { body }),
        });
        expect(reply.status).toBe(422);
      }
      expect(await w.prisma.order.count()).toBe(0);
    });

    it('DEFERRED is refused when a product has no deferred price; the cart stays', async () => {
      await publishWithoutP2Deferred();
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '1'],
      ]);
      const error = await conflict(placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'DEFERRED'));
      expect(error.reason).toBe('DEFERRED_PRICE_UNAVAILABLE');
      expect(error.details).toEqual({ productIds: [w.products.p2] });
      expect(await w.prisma.order.count()).toBe(0);
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toHaveLength(2);
    });

    it('a deferred price removed between viewing and submitting refuses the order', async () => {
      await fillCart(w, w.actors.sellerA, [
        [w.products.p1, '2'],
        [w.products.p2, '1'],
      ]);
      const seen = await w.carts.getCart(w.actors.sellerA);
      expect(seen.deferredTotalAmount?.toFixed(2)).toBe(DEFERRED_TOTAL);
      await publishWithoutP2Deferred();
      const reply = await call(ORDER_ROUTES.submitOrder, {
        actor: w.actors.sellerA,
        key: nextKey(),
        body: { paymentPlan: 'DEFERRED', expectedTotalAmount: DEFERRED_TOTAL },
      });
      expectError(reply, 409, 'CONFLICT', 'DEFERRED_PRICE_UNAVAILABLE');
      expect(await w.prisma.order.count()).toBe(0);
    });

    it('FULL still works for a product without a deferred price', async () => {
      await publishWithoutP2Deferred();
      const order = await submitOrder(w);
      expect(order.paymentPlan).toBe('FULL');
      const row = await stored(order.id);
      const p2 = row.items.find((i) => i.productCodeSnapshot === 'P-2');
      expect(p2?.deferredUnitPrice).toBeNull();
    });
  });

  describe('the manager changes the plan', () => {
    it('recomputes from the snapshot, one event, one message, row_version + 1', async () => {
      const order = await submitOrder(w);
      t.clock.set(new Date('2026-10-20T09:30:00Z'));
      const changed = await w.orders.setPaymentPlan(w.actors.manager, order.id, {
        paymentPlan: 'DEFERRED',
        reason: 'agreed by phone',
        expectedRowVersion: order.rowVersion,
      });
      expect(changed.paymentPlan).toBe('DEFERRED');
      expect(changed.totalAmount.toFixed(2)).toBe(DEFERRED_TOTAL);
      expect(changed.rowVersion).toBe(order.rowVersion + 1);
      expect(changed.items.map((i) => i.lineTotal.toFixed(2))).toEqual(['3600.00', '900.25']);

      const [event, ...moreEvents] = await planEvents(order.id);
      expect(moreEvents).toEqual([]);
      expect(event).toMatchObject({
        actorUserId: w.ids.manager,
        actorRole: 'MANAGER',
        comment: 'agreed by phone',
        fromStatus: null,
        toStatus: null,
        createdAt: new Date('2026-10-20T09:30:00Z'),
        payload: {
          before: { paymentPlan: 'FULL', totalAmount: FULL_TOTAL },
          after: { paymentPlan: 'DEFERRED', totalAmount: DEFERRED_TOTAL },
        },
      });
      const [message, ...moreMessages] = await planMessages(order.id);
      expect(moreMessages).toEqual([]);
      expect(message).toMatchObject({
        recipientKind: 'ORGANIZATION_CHAT',
        recipientOrganizationId: w.orgA,
        orderEventId: event?.id,
        payload: {
          oldPaymentPlan: 'FULL',
          newPaymentPlan: 'DEFERRED',
          oldTotalAmount: FULL_TOTAL,
          newTotalAmount: DEFERRED_TOTAL,
        },
      });
    });

    it('goes back and forth to the exact original amounts', async () => {
      const order = await submitOrder(w);
      const deferred = await change(w.actors.manager, order, 'DEFERRED');
      const back = await change(w.actors.manager, deferred, 'FULL');
      expect(back.totalAmount.toFixed(2)).toBe(FULL_TOTAL);
      expect(back.items.map((i) => i.unitPrice.toFixed(2))).toEqual(['1500.00', '750.50']);
      expect(await planEvents(order.id)).toHaveLength(2);
      expect(await planMessages(order.id)).toHaveLength(2);
    });

    it('never reads the current price list (hard rule 4)', async () => {
      const order = await submitOrder(w);
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1.00', [w.products.p2]: '2.00' },
        w.prisma,
        'UZS',
        { [w.products.p1]: '3.00' },
      );
      const changed = await change(w.actors.manager, order, 'DEFERRED');
      expect(changed.totalAmount.toFixed(2)).toBe(DEFERRED_TOTAL);
    });

    it('edits after the change keep the plan price', async () => {
      const order = await change(w.actors.manager, await submitOrder(w), 'DEFERRED');
      const p1 = order.items.find((i) => i.productCode === 'P-1');
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: p1?.id ?? '', quantity: '1' }],
      });
      expect(edited.totalAmount.toFixed(2)).toBe('2700.25'); // 1800.00 + 900.25
    });

    it('choosing the plan the order has writes nothing', async () => {
      const order = await submitOrder(w);
      const same = await change(w.actors.manager, order, 'FULL');
      expect(same.rowVersion).toBe(order.rowVersion);
      expect(await planEvents(order.id)).toEqual([]);
      expect(await planMessages(order.id)).toEqual([]);
    });

    it('is refused on the snapshot when a line has no deferred price, whatever the list says now', async () => {
      await publishWithoutP2Deferred();
      const order = await submitOrder(w);
      await publishBoth(); // the price exists again, but the order's own snapshot has none
      const error = await conflict(change(w.actors.manager, order, 'DEFERRED'));
      expect(error.reason).toBe('DEFERRED_PRICE_UNAVAILABLE');
      expect(error.details).toEqual({ productIds: [w.products.p2] });
      const row = await stored(order.id);
      expect(row.paymentPlan).toBe('FULL');
      expect(row.rowVersion).toBe(order.rowVersion);
      expect(await planEvents(order.id)).toEqual([]);
    });

    it.each(['MANAGER_APPROVED', 'REJECTED', 'CANCELLED'] as const)(
      'is refused once the order is %s',
      async (status) => {
        const order = await submitOrder(w);
        const moved = await w.step(w.actors.manager, order.id, {
          to: status,
          ...(status === 'MANAGER_APPROVED' ? {} : { reason: 'test' }),
        });
        const error = await conflict(change(w.actors.manager, moved, 'DEFERRED'));
        expect(error.reason).toBe('PAYMENT_PLAN_NOT_CHANGEABLE');
        const row = await stored(order.id);
        expect(row.paymentPlan).toBe('FULL');
        expect(row.totalAmount.toFixed(2)).toBe(FULL_TOTAL);
      },
    );

    it('a stale row version loses with ORDER_CHANGED', async () => {
      const order = await submitOrder(w);
      await change(w.actors.manager, order, 'DEFERRED');
      const error = await conflict(change(w.actors.manager2, order, 'DEFERRED'));
      expect(error.reason).toBe('ORDER_CHANGED');
      expect(await planEvents(order.id)).toHaveLength(1);
    });

    it('of a plan change racing an approval, exactly one wins', async () => {
      const order = await submitOrder(w);
      const results = await Promise.allSettled([
        change(w.actors.manager, order, 'DEFERRED'),
        w.orders.transition(w.actors.manager2, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: order.rowVersion,
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const row = await stored(order.id);
      expect(row.rowVersion).toBe(order.rowVersion + 1);
      const moved = row.status === 'MANAGER_APPROVED';
      expect(row.paymentPlan).toBe(moved ? 'FULL' : 'DEFERRED');
      expect(row.totalAmount.toFixed(2)).toBe(moved ? FULL_TOTAL : DEFERRED_TOTAL);
    });

    it('is one transaction: a failed outbox write leaves no trace of the change', async () => {
      const order = await submitOrder(w);
      vi.spyOn(t.get(OrdersRepository), 'insertOutbox').mockRejectedValueOnce(
        new Error('outbox down'),
      );
      await expect(change(w.actors.manager, order, 'DEFERRED')).rejects.toThrow('outbox down');
      const row = await stored(order.id);
      expect(row.paymentPlan).toBe('FULL');
      expect(row.totalAmount.toFixed(2)).toBe(FULL_TOTAL);
      expect(row.rowVersion).toBe(order.rowVersion);
      expect(row.items.map((i) => i.unitPrice.toFixed(2)).sort()).toEqual(['1500.00', '750.50']);
      expect(await planEvents(order.id)).toEqual([]);
    });
  });

  describe('who may change it', () => {
    it('a customer cannot: 403 over HTTP, forbidden in the service, nothing changes', async () => {
      const order = await submitOrder(w);
      for (const actor of [w.actors.sellerA, w.actors.ownerA]) {
        expectError(
          await call(STAFF_ORDER_ROUTES.setPaymentPlan, {
            actor,
            params: { id: order.id },
            body: { paymentPlan: 'DEFERRED', expectedRowVersion: order.rowVersion },
          }),
          403,
          'FORBIDDEN',
        );
        await expect(change(actor, order, 'DEFERRED')).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect((await stored(order.id)).paymentPlan).toBe('FULL');
    });

    it.each(['accountant', 'warehouse', 'driver', 'admin'] as const)(
      'the %s cannot',
      async (role) => {
        const order = await submitOrder(w);
        expectError(
          await call(STAFF_ORDER_ROUTES.setPaymentPlan, {
            actor: w.actors[role],
            params: { id: order.id },
            body: { paymentPlan: 'DEFERRED', expectedRowVersion: order.rowVersion },
          }),
          403,
          'FORBIDDEN',
        );
        expect((await stored(order.id)).paymentPlan).toBe('FULL');
      },
    );

    it('the manager can over HTTP; the version is required', async () => {
      const order = await submitOrder(w);
      const params = { id: order.id };
      const missing = await call(STAFF_ORDER_ROUTES.setPaymentPlan, {
        actor: w.actors.manager,
        params,
        body: { paymentPlan: 'DEFERRED' },
      });
      expect(missing.status).toBe(422);
      const got = expectParsed(
        await call(STAFF_ORDER_ROUTES.setPaymentPlan, {
          actor: w.actors.manager,
          params,
          body: { paymentPlan: 'DEFERRED', expectedRowVersion: order.rowVersion },
        }),
        200,
        staffOrderSchema,
      );
      expect(got.detail === 'FULL' && got.paymentPlan).toBe('DEFERRED');
    });
  });

  describe('who sees it', () => {
    it('the customer sees the plan and the change on their own order, not the snapshots', async () => {
      const order = await change(w.actors.manager, await submitOrder(w), 'DEFERRED');
      const got = expectParsed(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerA2, params: { id: order.id } }),
        200,
        customerOrderSchema,
      );
      expect(got.paymentPlan).toBe('DEFERRED');
      expect(JSON.stringify(got.items)).not.toMatch(/fullUnitPrice|deferredUnitPrice/);
      const list = expectParsed(
        await call(ORDER_ROUTES.listOrders, { actor: w.actors.sellerA }),
        200,
        customerOrderListResponseSchema,
      );
      expect(list.orders[0]?.paymentPlan).toBe('DEFERRED');
      const timeline = expectParsed(
        await call(ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.sellerA,
          params: { id: order.id },
        }),
        200,
        customerTimelineResponseSchema,
      );
      expect(timeline.events.find((e) => e.type === 'PAYMENT_PLAN_CHANGED')).toMatchObject({
        paymentPlanChange: {
          from: 'FULL',
          to: 'DEFERRED',
          oldTotal: FULL_TOTAL,
          newTotal: DEFERRED_TOTAL,
        },
      });
    });

    it('another organization cannot see the order', async () => {
      const order = await submitOrder(w, w.actors.sellerA, { paymentPlan: 'DEFERRED' });
      expectError(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerB, params: { id: order.id } }),
        404,
        'NOT_FOUND',
      );
    });

    it.each(['manager', 'accountant', 'admin'] as const)(
      'the %s sees the plan, both snapshots and the change',
      async (role) => {
        const order = await change(w.actors.manager, await submitOrder(w), 'DEFERRED');
        const got = expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrder, {
            actor: w.actors[role],
            params: { id: order.id },
          }),
          200,
          staffOrderSchema,
        );
        if (got.detail !== 'FULL') return expect.unreachable('expected the FULL detail');
        expect(got.paymentPlan).toBe('DEFERRED');
        expect(got.items[0]).toMatchObject({
          fullUnitPrice: '1500.00',
          deferredUnitPrice: '1800.00',
        });
        const timeline = expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
            actor: w.actors[role],
            params: { id: order.id },
          }),
          200,
          staffTimelineResponseSchema,
        );
        expect(
          timeline.events.find((e) => e.type === 'PAYMENT_PLAN_CHANGED')?.paymentPlanChange,
        ).toMatchObject({ to: 'DEFERRED' });
      },
    );

    it.each(['warehouse', 'driver'] as const)(
      'the %s never gets the plan, its prices or its event',
      async (role) => {
        const submitted = await submitOrder(w);
        await w.orders.setPaymentPlan(w.actors.manager, submitted.id, {
          paymentPlan: 'DEFERRED',
          expectedRowVersion: submitted.rowVersion,
        });
        await w.step(w.actors.manager, submitted.id, {
          to: 'MANAGER_APPROVED',
          skipAccounting: true,
        });
        await w.step(w.actors.warehouse, submitted.id, {
          to: 'RELEASED',
          driverUserId: w.ids.driver,
        });
        const actor = w.actors[role];
        const params = { id: submitted.id };

        const detail = await call(STAFF_ORDER_ROUTES.getOrder, { actor, params });
        expect(expectParsed(detail, 200, staffOrderSchema).detail).toBe('FULFILMENT');
        const list = await call(STAFF_ORDER_ROUTES.listOrders, { actor });
        expectParsed(list, 200, staffOrderListResponseSchema);
        const timeline = await call(STAFF_ORDER_ROUTES.getOrderTimeline, { actor, params });
        const events = expectParsed(timeline, 200, staffTimelineResponseSchema).events;
        expect(events.map((e) => e.type)).not.toContain('PAYMENT_PLAN_CHANGED');
        expect(events.every((e) => e.paymentPlanChange === null)).toBe(true);
        for (const body of [detail.body, list.body]) {
          expect(JSON.stringify(body)).not.toMatch(
            /paymentPlan|fullUnitPrice|deferredUnitPrice|DEFERRED/,
          );
        }
      },
    );

    it('the plan stays visible to the customer through fulfilment', async () => {
      const order = await releasedDeferredOrder();
      const got = expectParsed(
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.sellerA, params: { id: order.id } }),
        200,
        customerOrderSchema,
      );
      expect(got.paymentPlan).toBe('DEFERRED');
    });
  });

  describe('database guards', () => {
    it('rejects a plan change once the order left SUBMITTED, whoever writes it', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      await expect(
        w.prisma.$executeRawUnsafe(
          `UPDATE orders SET payment_plan = 'DEFERRED', row_version = row_version + 1 WHERE id = '${order.id}'`,
        ),
      ).rejects.toThrow(/immutable once the order left SUBMITTED/);
    });

    it('rejects a plan change that does not move row_version', async () => {
      const order = await submitOrder(w);
      await expect(
        w.prisma.$executeRawUnsafe(
          `UPDATE orders SET payment_plan = 'DEFERRED' WHERE id = '${order.id}'`,
        ),
      ).rejects.toThrow(/only change together with row_version/);
    });

    it('rejects a charged price that is neither of the two snapshots', async () => {
      const order = await submitOrder(w);
      const [item] = (await stored(order.id)).items;
      await expect(
        w.prisma.orderItem.update({
          where: { id: item?.id ?? '' },
          data: { unitPrice: '1.00', lineTotal: '2.00' },
        }),
      ).rejects.toThrow(/order_items_unit_price_is_a_snapshot/);
    });
  });
});
