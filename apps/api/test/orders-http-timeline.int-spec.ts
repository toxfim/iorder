import { ORDER_ROUTES, customerTimelineResponseSchema } from '@iorder/shared';
import {
  staffTimelineResponseSchema,
  type StaffTimelineEvent,
  STAFF_ORDER_ROUTES,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrdersModule } from '../src/modules/orders/index.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
import { assertCustomerSafe, caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, fillCart, nextKey, type World, placeCart } from './support/orders-world.js';
import { WORLD_USD_RATE } from './support/orders-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { recordSql } from './support/sql-counter.js';

const at = (time: string): Date => new Date(`2026-10-20T${time}:00Z`);

describe('order timeline over HTTP (real PostgreSQL)', () => {
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

  /**
   * One order walked through everything a history can hold, each step at its own time:
   * submit 09:00, edit 09:10, approve + skip accounting 09:30, release 10:00,
   * deliver 11:00, receive 12:00, the organization's payment makes it PAID 12:10.
   */
  async function fullStory(): Promise<{ id: string; itemIds: string[] }> {
    t.clock.set(at('09:00'));
    await fillCart(w, w.actors.sellerA, [
      [w.products.p1, '2'],
      [w.products.p2, '1'],
    ]);
    const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
    const [first, second] = order.items;
    if (!first || !second) throw new Error('expected two lines');

    t.clock.set(at('09:10'));
    await w.edit(w.actors.manager, order.id, {
      changes: [
        { itemId: first.id, quantity: '1' },
        { itemId: second.id, quantity: null },
      ],
      reason: 'only one in stock',
    });
    t.clock.set(at('09:30'));
    await w.step(w.actors.manager, order.id, {
      to: 'MANAGER_APPROVED',
      skipAccounting: true,
      reason: 'regular customer, skip accounting',
    });
    t.clock.set(at('10:00'));
    await w.step(w.actors.warehouse, order.id, {
      to: 'RELEASED',
      driverUserId: w.ids.driver,
      reason: 'fragile',
    });
    t.clock.set(at('11:00'));
    await w.step(w.actors.driver, order.id, { to: 'DELIVERED', reason: 'left with the neighbour' });
    t.clock.set(at('12:00'));
    await w.step(w.actors.ownerA, order.id, { to: 'RECEIVED' });
    // [C] 2026-10-26: the organization pays; the received order becomes PAID.
    t.clock.set(at('12:10'));
    const received = await w.orders.getOrderFor(w.actors.manager, order.id);
    await w.payments.recordPayment(w.actors.manager, w.orgA, {
      amount: received.totalAmount.toFixed(2),
      currency: 'UZS',
      rate: WORLD_USD_RATE,
      paidOn: '2026-10-20',
      comment: 'cash at the counter',
    });
    return { id: order.id, itemIds: [first.id, second.id] };
  }

  const markSent = async (orderId: string, type: string, recipientKind: string): Promise<void> => {
    await t.prisma.notificationOutbox.updateMany({
      where: { orderId, type, recipientKind: recipientKind as 'ORGANIZATION_CHAT' },
      data: { status: 'SENT', sentAt: at('12:30'), attempts: 1 },
    });
  };

  describe('the customer timeline', () => {
    it('tells the whole story with roles, never staff names or accounting', async () => {
      const { id } = await fullStory();
      await markSent(id, 'ORDER_MANAGER_APPROVED', 'ORGANIZATION_CHAT');
      await markSent(id, 'ORDER_ITEMS_EDITED', 'ORGANIZATION_CHAT');

      // A colleague (not the placer) reads it.
      const reply = await call(ORDER_ROUTES.getOrderTimeline, {
        actor: w.actors.sellerA2,
        params: { id },
      });
      const timeline = expectParsed(reply, 200, customerTimelineResponseSchema);
      assertCustomerSafe(reply.body, w);
      expect(timeline.orderId).toBe(id);

      const summary = timeline.events.map((e) => [
        e.type,
        e.fromStatus,
        e.toStatus,
        e.occurredAt,
        e.actor,
        e.comment,
        e.customerNotified,
      ]);
      expect(summary).toEqual([
        [
          'SUBMITTED',
          null,
          'SUBMITTED',
          '2026-10-20T09:00:00.000Z',
          { role: 'SELLER', name: 'Seller A' },
          null,
          false,
        ],
        [
          'ITEMS_EDITED',
          null,
          null,
          '2026-10-20T09:10:00.000Z',
          { role: 'MANAGER', name: null },
          'only one in stock',
          true,
        ],
        [
          'STATUS_CHANGED',
          'SUBMITTED',
          'MANAGER_APPROVED',
          '2026-10-20T09:30:00.000Z',
          { role: 'MANAGER', name: null },
          // A manager's working note is not shown; only reasons of rejections and cancellations are.
          null,
          true,
        ],
        // The accounting skip is shown as the plain status change, as a manager move: a skip
        // cannot be inferred from a missing or different role.
        [
          'STATUS_CHANGED',
          'MANAGER_APPROVED',
          'ACCOUNTING_CLEARED',
          '2026-10-20T09:30:00.000Z',
          { role: 'MANAGER', name: null },
          null,
          false,
        ],
        [
          'STATUS_CHANGED',
          'ACCOUNTING_CLEARED',
          'RELEASED',
          '2026-10-20T10:00:00.000Z',
          { role: 'WAREHOUSE_MANAGER', name: null },
          null,
          false,
        ],
        [
          'STATUS_CHANGED',
          'RELEASED',
          'DELIVERED',
          '2026-10-20T11:00:00.000Z',
          { role: 'DRIVER', name: null },
          null,
          false,
        ],
        [
          'STATUS_CHANGED',
          'DELIVERED',
          'RECEIVED',
          '2026-10-20T12:00:00.000Z',
          { role: 'SHOP_OWNER', name: 'Owner A' },
          null,
          false,
        ],
        // The organization's payment made the received order PAID.
        [
          'PAYMENT_STATUS_CHANGED',
          null,
          null,
          '2026-10-20T12:10:00.000Z',
          { role: 'MANAGER', name: null },
          null,
          false,
        ],
      ]);

      // Before and after of the edit: old and new totals and every changed line.
      expect(timeline.events[1]?.itemsChange).toEqual({
        oldTotal: '3750.50',
        newTotal: '1500.00',
        lines: [
          {
            productCode: 'P-1',
            name: 'Olma',
            change: 'QUANTITY_CHANGED',
            oldQuantity: '2.000',
            newQuantity: '1.000',
            oldLineTotal: '3000.00',
            newLineTotal: '1500.00',
          },
          {
            productCode: 'P-2',
            name: 'Nok',
            change: 'REMOVED',
            oldQuantity: '1.000',
            newQuantity: null,
            oldLineTotal: '750.50',
            newLineTotal: null,
          },
        ],
      });
      expect(timeline.events[7]?.paymentChange).toEqual({ from: 'UNPAID', to: 'PAID' });
    });

    it('shows rejection and cancellation reasons exactly as written', async () => {
      t.clock.set(at('09:00'));
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const rejected = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      await w.step(w.actors.manager, rejected.id, {
        to: 'REJECTED',
        reason: 'Out of stock until Monday',
      });
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const cancelled = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      await w.step(w.actors.manager, cancelled.id, { to: 'CANCELLED', reason: 'Ordered twice' });

      const rejectedTimeline = expectParsed(
        await call(ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.ownerA,
          params: { id: rejected.id },
        }),
        200,
        customerTimelineResponseSchema,
      );
      expect(rejectedTimeline.events.at(-1)).toMatchObject({
        toStatus: 'REJECTED',
        comment: 'Out of stock until Monday',
        actor: { role: 'MANAGER', name: null },
      });
      const cancelledTimeline = expectParsed(
        await call(ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.sellerA,
          params: { id: cancelled.id },
        }),
        200,
        customerTimelineResponseSchema,
      );
      // Only the manager cancels: the customer sees the role, never the name, and the reason as written.
      expect(cancelledTimeline.events.at(-1)).toMatchObject({
        toStatus: 'CANCELLED',
        comment: 'Ordered twice',
        actor: { role: 'MANAGER', name: null },
        customerNotified: false,
      });
    });

    it('marks the staff cancel as told to the customer once the message went out', async () => {
      t.clock.set(at('09:00'));
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'duplicate' });
      const read = async (): Promise<boolean[]> =>
        expectParsed(
          await call(ORDER_ROUTES.getOrderTimeline, {
            actor: w.actors.sellerA,
            params: { id: order.id },
          }),
          200,
          customerTimelineResponseSchema,
        ).events.map((e) => e.customerNotified);
      // Pending in the outbox is not "sent".
      expect(await read()).toEqual([false, false]);
      await markSent(order.id, 'ORDER_CANCELLED', 'ORGANIZATION_CHAT');
      expect(await read()).toEqual([false, true]);
    });

    it('404 for another organization and for an unknown order', async () => {
      const { id } = await fullStory();
      expectError(
        await call(ORDER_ROUTES.getOrderTimeline, { actor: w.actors.ownerB, params: { id } }),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('the staff timeline', () => {
    const labels = (event: StaffTimelineEvent): string[] =>
      event.notifications
        .map(
          (n) => `${n.type}>${n.recipientKind}:${n.recipientRole ?? n.recipientName}:${n.status}`,
        )
        .sort();

    it('names who did what, when, from what to what, with before/after and who was told', async () => {
      const { id } = await fullStory();
      await markSent(id, 'ORDER_MANAGER_APPROVED', 'ORGANIZATION_CHAT');
      const reply = await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
        actor: w.actors.accountant,
        params: { id },
      });
      const timeline = expectParsed(reply, 200, staffTimelineResponseSchema);
      expect(timeline.detail).toBe('FULL');
      expect(findForbiddenKeys(reply.body)).toEqual([]);

      expect(
        timeline.events.map((e) => [
          e.type,
          e.fromStatus,
          e.toStatus,
          e.occurredAt,
          e.actor.userId,
          e.actor.role,
          e.actor.name,
          e.comment,
        ]),
      ).toEqual([
        [
          'SUBMITTED',
          null,
          'SUBMITTED',
          '2026-10-20T09:00:00.000Z',
          w.ids.sellerA,
          'SELLER',
          'Seller A',
          null,
        ],
        [
          'ITEMS_EDITED',
          null,
          null,
          '2026-10-20T09:10:00.000Z',
          w.ids.manager,
          'MANAGER',
          'Manager',
          'only one in stock',
        ],
        [
          'STATUS_CHANGED',
          'SUBMITTED',
          'MANAGER_APPROVED',
          '2026-10-20T09:30:00.000Z',
          w.ids.manager,
          'MANAGER',
          'Manager',
          'regular customer, skip accounting',
        ],
        [
          'ACCOUNTING_SKIPPED',
          'MANAGER_APPROVED',
          'ACCOUNTING_CLEARED',
          '2026-10-20T09:30:00.000Z',
          w.ids.manager,
          'MANAGER',
          'Manager',
          null,
        ],
        [
          'STATUS_CHANGED',
          'ACCOUNTING_CLEARED',
          'RELEASED',
          '2026-10-20T10:00:00.000Z',
          w.ids.warehouse,
          'WAREHOUSE_MANAGER',
          'Warehouse',
          'fragile',
        ],
        [
          'STATUS_CHANGED',
          'RELEASED',
          'DELIVERED',
          '2026-10-20T11:00:00.000Z',
          w.ids.driver,
          'DRIVER',
          'Driver',
          'left with the neighbour',
        ],
        [
          'STATUS_CHANGED',
          'DELIVERED',
          'RECEIVED',
          '2026-10-20T12:00:00.000Z',
          w.ids.ownerA,
          'SHOP_OWNER',
          'Owner A',
          null,
        ],
        // The payment's comment stays on the payment, not on the order event.
        [
          'PAYMENT_STATUS_CHANGED',
          null,
          null,
          '2026-10-20T12:10:00.000Z',
          w.ids.manager,
          'MANAGER',
          'Manager',
          null,
        ],
      ]);

      const [submitted, edited, approved, skipped, released, delivered, received, paid] =
        timeline.events;
      expect(edited?.itemsChange?.oldTotal).toBe('3750.50');
      expect(edited?.itemsChange?.newTotal).toBe('1500.00');
      expect(edited?.itemsChange?.lines.map((l) => l.change)).toEqual([
        'QUANTITY_CHANGED',
        'REMOVED',
      ]);
      expect(paid?.paymentChange).toEqual({ from: 'UNPAID', to: 'PAID' });
      expect(skipped?.accountingMode).toEqual({ from: 'PENDING', to: 'SKIPPED_BY_MANAGER' });
      expect(approved?.accountingMode).toBeNull();
      expect(released?.driver).toMatchObject({ userId: w.ids.driver, fullName: 'Driver' });

      // What was sent, or waits to be sent, because of each event.
      expect(labels(submitted!)).toEqual(['ORDER_SUBMITTED>ROLE:MANAGER:PENDING']);
      expect(labels(edited!)).toEqual(['ORDER_ITEMS_EDITED>ORGANIZATION_CHAT:Alpha shop:PENDING']);
      expect(paid?.notifications).toEqual([]);
      expect(labels(approved!)).toEqual([
        'ORDER_MANAGER_APPROVED>ORGANIZATION_CHAT:Alpha shop:SENT',
        'ORDER_MANAGER_APPROVED>ROLE:ACCOUNTANT:PENDING',
      ]);
      // [C] 2026-11-09: clearance, release and delivery send nothing to the customer's chat.
      expect(labels(skipped!)).toEqual(['ORDER_ACCOUNTING_CLEARED>ROLE:WAREHOUSE_MANAGER:PENDING']);
      expect(labels(released!)).toEqual(['ORDER_RELEASED>USER:Driver:PENDING']);
      expect(labels(delivered!)).toEqual([]);
      expect(labels(received!)).toEqual(['ORDER_RECEIVED>ROLE:MANAGER:PENDING']);
      const sent = approved?.notifications.find((n) => n.status === 'SENT');
      expect(sent).toMatchObject({ attempts: 1, sentAt: '2026-10-20T12:30:00.000Z' });
    });

    it('links every message to its own event, also for two events at the same instant', async () => {
      t.clock.set(at('09:00'));
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '2']]);
      const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      const [line] = order.items;
      if (!line) throw new Error('expected a line');
      // Two edits under one frozen clock reading: same timestamp, same message type.
      t.clock.set(at('09:10'));
      await w.edit(w.actors.manager, order.id, { changes: [{ itemId: line.id, quantity: '1' }] });
      await w.edit(w.actors.manager, order.id, { changes: [{ itemId: line.id, quantity: '3' }] });

      const rows = await t.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, type: 'ORDER_ITEMS_EDITED' },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.orderEventId !== null)).toBe(true);
      expect(new Set(rows.map((r) => r.orderEventId)).size).toBe(2);

      const timeline = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.manager,
          params: { id: order.id },
        }),
        200,
        staffTimelineResponseSchema,
      );
      const edits = timeline.events.filter((e) => e.type === 'ITEMS_EDITED');
      expect(edits).toHaveLength(2);
      expect(edits[0]?.occurredAt).toBe(edits[1]?.occurredAt);
      for (const edit of edits) {
        const own = rows.filter((r) => r.orderEventId === edit.id);
        expect(edit.notifications.map((n) => n.id)).toEqual(own.map((r) => r.id));
      }
    });

    it('a message of the skip transition belongs to the matching step event', async () => {
      const { id } = await fullStory();
      const events = await t.prisma.orderEvent.findMany({ where: { orderId: id } });
      const rows = await t.prisma.notificationOutbox.findMany({ where: { orderId: id } });
      const eventOf = (rowType: string): string[] =>
        rows
          .filter((r) => r.type === rowType)
          .map((r) => events.find((e) => e.id === r.orderEventId)?.toStatus ?? 'NONE');
      expect(new Set(eventOf('ORDER_MANAGER_APPROVED'))).toEqual(new Set(['MANAGER_APPROVED']));
      expect(new Set(eventOf('ORDER_ACCOUNTING_CLEARED'))).toEqual(new Set(['ACCOUNTING_CLEARED']));
      expect(new Set(eventOf('ORDER_SUBMITTED'))).toEqual(new Set(['SUBMITTED']));
    });

    it('a row from before the link (null) is shown without a notification marker', async () => {
      const { id } = await fullStory();
      await t.prisma
        .$executeRaw`ALTER TABLE notification_outbox DISABLE TRIGGER notification_outbox_guard_rows`;
      try {
        await t.prisma
          .$executeRaw`UPDATE notification_outbox SET order_event_id = NULL WHERE order_id = ${id}::uuid`;
      } finally {
        await t.prisma
          .$executeRaw`ALTER TABLE notification_outbox ENABLE TRIGGER notification_outbox_guard_rows`;
      }
      const timeline = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.manager,
          params: { id },
        }),
        200,
        staffTimelineResponseSchema,
      );
      for (const event of timeline.events) expect(event.notifications).toEqual([]);
    });

    it('manager, accountant and admin see the same full history (admin without the payment method)', async () => {
      const { id } = await fullStory();
      const bodies = await Promise.all(
        (['manager', 'accountant', 'admin'] as const).map(async (role) =>
          expectParsed(
            await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
              actor: w.actors[role],
              params: { id },
            }),
            200,
            staffTimelineResponseSchema,
          ),
        ),
      );
      const [manager, accountant, admin] = bodies;
      if (!manager || !accountant || !admin) throw new Error('three timelines expected');
      expect(accountant).toEqual(manager);
      // [C] 2026-10-24: the payment method is for manager and accountant only.
      const approval = manager.events.find((e) => e.toStatus === 'MANAGER_APPROVED');
      expect(approval?.paymentMethodChange).toEqual({ from: null, to: 'CASH' });
      expect(admin).toEqual({
        ...manager,
        events: manager.events.map((e) => ({ ...e, paymentMethodChange: null })),
      });
    });

    it('the warehouse and the driver get the fulfilment view: no prices, accounting, payment or messages', async () => {
      const { id } = await fullStory();
      for (const role of ['warehouse', 'driver'] as const) {
        const reply = await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors[role],
          params: { id },
        });
        const timeline = expectParsed(reply, 200, staffTimelineResponseSchema);
        expect(timeline.detail).toBe('FULFILMENT');
        // No payment event, and the accounting skip shows as the plain move to ACCOUNTING_CLEARED.
        expect(timeline.events.map((e) => e.type)).toEqual([
          'SUBMITTED',
          'ITEMS_EDITED',
          'STATUS_CHANGED',
          'STATUS_CHANGED',
          'STATUS_CHANGED',
          'STATUS_CHANGED',
          'STATUS_CHANGED',
        ]);
        for (const event of timeline.events) {
          // Roles only: no names, no user ids of the actors.
          expect(event.actor.userId).toBeNull();
          expect(event.actor.name).toBeNull();
          expect(event.accountingMode).toBeNull();
          expect(event.paymentChange).toBeNull();
          expect(event.notifications).toEqual([]);
        }
        const edit = timeline.events.find((e) => e.type === 'ITEMS_EDITED');
        expect(edit?.itemsChange?.oldTotal).toBeNull();
        expect(edit?.itemsChange?.newTotal).toBeNull();
        expect(
          edit?.itemsChange?.lines.map((l) => [
            l.oldQuantity,
            l.newQuantity,
            l.oldLineTotal,
            l.newLineTotal,
          ]),
        ).toEqual([
          ['2.000', '1.000', null, null],
          ['1.000', null, null, null],
        ]);
        // Working notes only on release, delivery and cancellation.
        expect(timeline.events.filter((e) => e.comment !== null).map((e) => e.toStatus)).toEqual([
          'RELEASED',
          'DELIVERED',
        ]);
        const text = JSON.stringify(reply.body);
        expect(text).not.toContain(w.ids.manager);
        expect(text).not.toContain('only one in stock');
        expect(text).not.toContain('skip accounting');
        expect(text).not.toMatch(
          /SKIPPED_BY_MANAGER|ACCOUNTING_SKIPPED|PAYMENT_STATUS_CHANGED|3750|1500/,
        );
        expect(timeline.events.find((e) => e.toStatus === 'RELEASED')?.driver?.userId).toBe(
          w.ids.driver,
        );
      }
    });

    it('404 when the role may not see the order; 403 for customers on the staff route', async () => {
      t.clock.set(at('09:00'));
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const order = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      for (const role of ['warehouse', 'driver'] as const) {
        expectError(
          await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
            actor: w.actors[role],
            params: { id: order.id },
          }),
          404,
          'NOT_FOUND',
        );
      }
      expectError(
        await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.ownerA,
          params: { id: order.id },
        }),
        403,
        'FORBIDDEN',
      );
    });
  });

  describe('query count', () => {
    it('is the same for a one-event history and a long one, for every audience', async () => {
      // Small: submitted and cleared (3 events), visible to every role.
      const small = await fullStory();
      const smallOrder = await t.prisma.order.findUniqueOrThrow({ where: { id: small.id } });
      expect(smallOrder.status).toBe('RECEIVED');

      // Long: the same story plus many payment flips and extra actors' events.
      t.clock.set(at('13:00'));
      for (let i = 0; i < 20; i += 1) {
        t.clock.set(at(`13:${String(i).padStart(2, '0')}`));
        // Voiding the live payment makes the order unpaid, a new one pays it: two events a round.
        const live = (await w.payments.getBalance(w.actors.manager, w.orgA)).payments.find(
          (p) => p.voidedAt === null,
        );
        if (!live) throw new Error('expected a live payment');
        await w.payments.voidPayment(w.actors.admin, live.id, { reason: 'test' });
        await w.payments.recordPayment(w.actors.manager, w.orgA, {
          amount: smallOrder.totalAmount.toFixed(2),
          currency: 'UZS',
          rate: WORLD_USD_RATE,
          paidOn: '2026-10-20',
        });
      }
      const longEvents = await t.prisma.orderEvent.count({ where: { orderId: small.id } });
      expect(longEvents).toBeGreaterThan(25);

      // A tiny history: one SUBMITTED event.
      t.clock.set(at('14:00'));
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const tiny = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');

      const counts = async (actor: keyof World['actors'], id: string, customer: boolean) => {
        const route = customer
          ? ORDER_ROUTES.getOrderTimeline
          : STAFF_ORDER_ROUTES.getOrderTimeline;
        const sql = await recordSql(t.prisma, async () => {
          const reply = await call(route, { actor: w.actors[actor], params: { id } });
          expect(reply.status).toBe(200);
        });
        return sql.length;
      };

      const customerTiny = await counts('sellerA', tiny.id, true);
      const customerLong = await counts('sellerA', small.id, true);
      const managerTiny = await counts('manager', tiny.id, false);
      const managerLong = await counts('manager', small.id, false);
      const warehouseLong = await counts('warehouse', small.id, false);
      const driverLong = await counts('driver', small.id, false);
      // The warehouse cannot see the tiny order (404), so compare it with a cleared small one.
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const cleared = await placeCart(w, w.actors.sellerA, w.orgA, nextKey(), 'FULL');
      await w.step(w.actors.manager, cleared.id, { to: 'MANAGER_APPROVED', skipAccounting: true });
      // Released too: the driver is the one person the fulfilment view looks up.
      await w.step(w.actors.warehouse, cleared.id, {
        to: 'RELEASED',
        driverUserId: w.ids.driver,
      });
      const warehouseSmall = await counts('warehouse', cleared.id, false);

      expect(customerLong).toBe(customerTiny);
      expect(managerLong).toBe(managerTiny);
      expect(warehouseLong).toBe(warehouseSmall);
      expect(driverLong).toBe(warehouseLong);
      // And a sane bound, so a regression to one query per event cannot hide behind "equal".
      for (const n of [customerLong, managerLong, warehouseLong]) expect(n).toBeLessThanOrEqual(12);
    });
  });
});
