import { ORDER_ROUTES, type OrderStatus } from '@iorder/shared';
import { PRODUCT_TRACKING_ROUTES } from '@iorder/shared/staff-cost';
import {
  STAFF_ORDER_ROUTES,
  STAFF_PICKING_ROUTES,
  pickingResponseSchema,
  staffOrderFulfilmentSchema,
  staffOrderListResponseSchema,
  staffTimelineResponseSchema,
  type PickingResponse,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { renderNotification } from '../src/modules/notifications/message-templates.js';
import { caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const IMEI_A = '490154203237518';
const IMEI_B = '356938035643809';

// [C] 2026-10-30: the warehouse prepares and scans from the manager's approval; the release waits
// for accounting. [P]: goods of an order closed after approval are confirmed as returned.
describe('warehouse flow from the approval on (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule, CatalogModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
  });

  const version = async (orderId: string): Promise<number> =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).rowVersion;

  /** p1 needs an IMEI: the order is only complete once it is scanned. */
  async function makeP1NeedImei(): Promise<void> {
    await t.prisma.product.update({
      where: { id: w.products.p1 },
      data: { category: 'Telefonlar' },
    });
    const reply = await call(PRODUCT_TRACKING_ROUTES.createCategory, {
      actor: w.actors.manager,
      body: { name: 'Telefonlar', trackingTypeDefault: 'IMEI', markingRequiredDefault: false },
    });
    expect(reply.status).toBe(201);
  }

  const picking = async (orderId: string): Promise<PickingResponse> =>
    expectParsed(
      await call(STAFF_PICKING_ROUTES.getPicking, {
        actor: w.actors.warehouse,
        params: { id: orderId },
      }),
      200,
      pickingResponseSchema,
    );

  function firstUnitWithSlot(view: PickingResponse): string {
    const unit = view.lines.flatMap((line) => line.units).find((u) => u.missing.length > 0);
    if (unit === undefined) throw new Error('no unit misses a code');
    return unit.unitId;
  }

  const scan = (orderId: string, unitId: string, value: string) =>
    call(STAFF_PICKING_ROUTES.recordUnitCode, {
      actor: w.actors.warehouse,
      params: { id: orderId, unitId },
      body: { kind: 'IMEI', slot: 1, value },
    });

  const warehouseRows = async (orderId: string): Promise<string[]> =>
    (
      await t.prisma.notificationOutbox.findMany({
        where: { orderId, recipientRole: 'WAREHOUSE_MANAGER' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.type);

  const returned = async (orderId: string, actor: Actor = w.actors.warehouse) =>
    call(STAFF_ORDER_ROUTES.markGoodsReturned, {
      actor,
      params: { id: orderId },
      body: { expectedRowVersion: await version(orderId) },
    });

  describe('after the approval', () => {
    it('shows the order without money, opens scanning, and keeps the release closed until accounting', async () => {
      await makeP1NeedImei();
      const order = await orderAt(w, 'MANAGER_APPROVED');

      // The strict fulfilment schema refuses a price, a total or a payment method.
      const read = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.warehouse,
          params: { id: order.id },
        }),
        200,
        staffOrderFulfilmentSchema,
      );
      expect(read.status).toBe('MANAGER_APPROVED');
      expect(JSON.stringify(read)).not.toMatch(/price|total|paymentMethod|paymentPlan/i);

      const view = await picking(order.id);
      expect(view.editable).toBe(true);
      expect(view.complete).toBe(false);
      const unitId = firstUnitWithSlot(view);

      // Accounting pending, codes missing: the state machine says no.
      const early = await call(STAFF_ORDER_ROUTES.releaseOrder, {
        actor: w.actors.warehouse,
        params: { id: order.id },
        body: { driverUserId: w.ids.driver, expectedRowVersion: await version(order.id) },
      });
      expectError(early, 409, 'CONFLICT', 'ILLEGAL_ORDER_TRANSITION');

      expect((await scan(order.id, unitId, IMEI_A)).status).toBe(200);

      // Accounting pending, codes complete for that unit: still no.
      const stillEarly = await call(STAFF_ORDER_ROUTES.releaseOrder, {
        actor: w.actors.warehouse,
        params: { id: order.id },
        body: { driverUserId: w.ids.driver, expectedRowVersion: await version(order.id) },
      });
      expectError(stillEarly, 409, 'CONFLICT', 'ILLEGAL_ORDER_TRANSITION');

      // The units made at the approval and the codes scanned then survive the clearance.
      await w.step(w.actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' });
      const after = await picking(order.id);
      expect(after.lines.flatMap((line) => line.units).map((unit) => unit.unitId)).toContain(
        unitId,
      );
      expect(
        after.lines.flatMap((line) => line.units).flatMap((unit) => unit.codes.map((c) => c.value)),
      ).toContain(IMEI_A);
    });

    it('scanning stays mandatory for the release after accounting cleared the order', async () => {
      await makeP1NeedImei();
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      const refused = await call(STAFF_ORDER_ROUTES.releaseOrder, {
        actor: w.actors.warehouse,
        params: { id: order.id },
        body: { driverUserId: w.ids.driver, expectedRowVersion: await version(order.id) },
      });
      expectError(refused, 409, 'CONFLICT', 'UNIT_CODES_INCOMPLETE');
    });

    it('nobody but the warehouse scans, and nothing is scannable before the approval', async () => {
      await makeP1NeedImei();
      const approved = await orderAt(w, 'MANAGER_APPROVED');
      const unitId = firstUnitWithSlot(await picking(approved.id));
      for (const actor of [w.actors.manager, w.actors.accountant, w.actors.admin]) {
        const reply = await call(STAFF_PICKING_ROUTES.recordUnitCode, {
          actor,
          params: { id: approved.id, unitId },
          body: { kind: 'IMEI', slot: 1, value: IMEI_A },
        });
        expect(reply.status).toBe(403);
      }
      const submitted = await submitOrder(w);
      expect(
        (
          await call(STAFF_PICKING_ROUTES.getPicking, {
            actor: w.actors.warehouse,
            params: { id: submitted.id },
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('messages', () => {
    it('a normal approval tells the warehouse to prepare, the clearance that it is ready: two distinct messages', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      expect(await warehouseRows(order.id)).toEqual(['ORDER_READY_TO_PREPARE']);
      await w.step(w.actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' });
      expect(await warehouseRows(order.id)).toEqual([
        'ORDER_READY_TO_PREPARE',
        'ORDER_ACCOUNTING_CLEARED',
      ]);
    });

    it('the skip sends the warehouse exactly one message', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED', skipAccounting: true });
      expect(await warehouseRows(order.id)).toEqual(['ORDER_ACCOUNTING_CLEARED']);
    });

    it('the warehouse messages carry no money, and the text shows none', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'mijoz aytdi' });
      const rows = await t.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, recipientRole: 'WAREHOUSE_MANAGER' },
      });
      expect(rows.map((row) => row.type).sort()).toEqual([
        'ORDER_CANCELLED',
        'ORDER_READY_TO_PREPARE',
      ]);
      for (const row of rows) {
        expect(row.payload).not.toHaveProperty('totalAmount');
        const text = renderNotification({
          type: row.type as 'ORDER_CANCELLED',
          audience: 'STAFF',
          locale: 'UZ',
          payload: row.payload,
        });
        expect(text).not.toBeNull();
        expect(text).not.toMatch(/Summa|so'm/);
      }
    });
  });

  describe.each([
    {
      name: 'cancelled by the manager',
      closer: 'manager' as const,
      to: 'CANCELLED' as const,
      voidReason: 'ORDER_CANCELLED',
    },
    {
      name: 'rejected by the accountant',
      closer: 'accountant' as const,
      to: 'REJECTED' as const,
      voidReason: 'ORDER_REJECTED',
    },
  ])('an approved order $name', ({ closer, to, voidReason }) => {
    it('frees the codes, prompts the warehouse once, and records who confirmed the return', async () => {
      await makeP1NeedImei();
      const order = await orderAt(w, 'MANAGER_APPROVED');
      const unitId = firstUnitWithSlot(await picking(order.id));
      expect((await scan(order.id, unitId, IMEI_A)).status).toBe(200);

      await w.step(w.actors[closer], order.id, { to, reason: 'sabab' });

      // The code went back to the pool, under the reason of the closing move.
      const code = await t.prisma.unitCode.findFirstOrThrow({ where: { orderId: order.id } });
      expect(code.voidedAt).not.toBeNull();
      expect(code.voidReason).toBe(voidReason);
      const other = await orderAt(w, 'MANAGER_APPROVED');
      expect(
        (await scan(other.id, firstUnitWithSlot(await picking(other.id)), IMEI_A)).status,
      ).toBe(200);

      // The warehouse still sees it, read-only, and is asked to bring the goods back.
      const pending = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.warehouse,
          params: { id: order.id },
        }),
        200,
        staffOrderFulfilmentSchema,
      );
      expect(pending.goodsReturn).toBe('PENDING');
      expect(pending.goodsReturnedAt).toBeNull();
      expect((await picking(order.id)).editable).toBe(false);
      const listed = expectParsed(
        await call(STAFF_ORDER_ROUTES.listOrders, {
          actor: w.actors.warehouse,
          query: { goodsReturn: 'PENDING' },
        }),
        200,
        staffOrderListResponseSchema,
      );
      expect(listed.orders.map((o) => o.id)).toEqual([order.id]);

      // The status does not move, the column and the event land together.
      const before = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const done = expectParsed(await returned(order.id), 200, staffOrderFulfilmentSchema);
      expect(done.status).toBe(to);
      expect(done.goodsReturn).toBe('RETURNED');
      expect(done.goodsReturnedAt).not.toBeNull();
      expect(done.rowVersion).toBe(before.rowVersion + 1);

      const row = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.goodsReturnedBy).toBe(w.ids.warehouse);
      const events = await t.prisma.orderEvent.findMany({
        where: { orderId: order.id, eventType: 'GOODS_RETURNED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: w.ids.warehouse,
        actorRole: 'WAREHOUSE_MANAGER',
        fromStatus: null,
        toStatus: null,
      });

      // Once: a second press is told so and writes nothing.
      expectError(await returned(order.id), 409, 'CONFLICT', 'GOODS_RETURN_NOT_PENDING');
      expect(
        await t.prisma.orderEvent.count({
          where: { orderId: order.id, eventType: 'GOODS_RETURNED' },
        }),
      ).toBe(1);
      const after = expectParsed(
        await call(STAFF_ORDER_ROUTES.listOrders, {
          actor: w.actors.warehouse,
          query: { goodsReturn: 'PENDING' },
        }),
        200,
        staffOrderListResponseSchema,
      );
      expect(after.orders).toEqual([]);
    });

    it('the customer sees nothing of it, staff timelines do', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      await w.step(w.actors[closer], order.id, { to, reason: 'sabab' });
      expect((await returned(order.id)).status).toBe(200);

      const customer = await call(ORDER_ROUTES.getOrder, {
        actor: w.actors.sellerA,
        params: { id: order.id },
      });
      expect(customer.status).toBe(200);
      expect(JSON.stringify(customer.body)).not.toMatch(/goodsReturn/i);
      const customerTimeline = await call(ORDER_ROUTES.getOrderTimeline, {
        actor: w.actors.sellerA,
        params: { id: order.id },
      });
      expect(customerTimeline.status).toBe(200);
      expect(JSON.stringify(customerTimeline.body)).not.toContain('GOODS_RETURNED');

      for (const actor of [w.actors.warehouse, w.actors.manager]) {
        const timeline = expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrderTimeline, { actor, params: { id: order.id } }),
          200,
          staffTimelineResponseSchema,
        );
        expect(timeline.events.map((event) => event.type)).toContain('GOODS_RETURNED');
      }
    });
  });

  describe('goods returned: who and when', () => {
    it('only the warehouse', async () => {
      const order = await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' });
      for (const actor of [w.actors.manager, w.actors.accountant, w.actors.admin]) {
        expect((await returned(order.id, actor)).status).toBe(403);
      }
      // The driver and a customer are refused before they learn anything about the order.
      expect((await returned(order.id, w.actors.driver)).status).toBe(403);
      expect((await returned(order.id, w.actors.sellerA)).status).toBe(403);
    });

    it('is refused on an open order, and an order closed before approval stays hidden', async () => {
      const open = await orderAt(w, 'MANAGER_APPROVED');
      expectError(await returned(open.id), 409, 'CONFLICT', 'GOODS_RETURN_NOT_PENDING');
      const early = await orderAt(w, 'CANCELLED');
      expect((await returned(early.id)).status).toBe(404);
      const rejected = await orderAt(w, 'REJECTED');
      expect((await returned(rejected.id)).status).toBe(404);
    });

    it('a stale version is told the order changed', async () => {
      const order = await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' });
      const reply = await call(STAFF_ORDER_ROUTES.markGoodsReturned, {
        actor: w.actors.warehouse,
        params: { id: order.id },
        body: { expectedRowVersion: 1 },
      });
      expectError(reply, 409, 'CONFLICT', 'ORDER_CHANGED');
    });

    it('an order closed before this rule does not prompt (the migration left a time without a person)', async () => {
      const order = await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' });
      await t.prisma
        .$executeRaw`UPDATE orders SET goods_returned_at = updated_at WHERE id = ${order.id}::uuid`;
      const read = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.warehouse,
          params: { id: order.id },
        }),
        200,
        staffOrderFulfilmentSchema,
      );
      expect(read.goodsReturn).toBe('NOT_NEEDED');
      expect(read.goodsReturnedAt).toBeNull();
      expectError(await returned(order.id), 409, 'CONFLICT', 'GOODS_RETURN_NOT_PENDING');
    });

    it('the database writes the facts once and only on a closed order', async () => {
      const order = await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' });
      await expect(
        t.prisma
          .$executeRaw`UPDATE orders SET manager_approved_at = now() WHERE id = ${order.id}::uuid`,
      ).rejects.toThrow(/written once/);
      expect((await returned(order.id)).status).toBe(200);
      await expect(
        t.prisma
          .$executeRaw`UPDATE orders SET goods_returned_at = now() WHERE id = ${order.id}::uuid`,
      ).rejects.toThrow(/written once/);
      const open = await orderAt(w, 'MANAGER_APPROVED');
      await expect(
        t.prisma
          .$executeRaw`UPDATE orders SET goods_returned_at = now() WHERE id = ${open.id}::uuid`,
      ).rejects.toThrow(/orders_goods_returned_only_when_closed/);
    });
  });

  describe('an order approved by the previous release in the deploy window', () => {
    /** The old process: approved or cleared, no approval time and no units. */
    async function approvedByOldProcess(status: 'MANAGER_APPROVED' | 'ACCOUNTING_CLEARED') {
      const order = await submitOrder(w);
      const move = async (from: OrderStatus, to: OrderStatus, role: 'MANAGER' | 'ACCOUNTANT') =>
        t.prisma.$transaction(async (tx) => {
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: 'STATUS_CHANGED',
              fromStatus: from,
              toStatus: to,
              actorUserId:
                role === 'MANAGER' ? w.actors.manager.userId : w.actors.accountant.userId,
              actorRole: role,
              payload: { before: { status: from }, after: { status: to } },
              createdAt: new Date(),
            },
          });
          await (to === 'ACCOUNTING_CLEARED'
            ? tx.$executeRaw`UPDATE orders SET status = 'ACCOUNTING_CLEARED',
                accounting_mode = 'APPROVED', accounting_cleared_at = now(),
                row_version = row_version + 1 WHERE id = ${order.id}::uuid`
            : tx.$executeRaw`UPDATE orders SET status = ${to}::order_status,
                row_version = row_version + 1 WHERE id = ${order.id}::uuid`);
        });
      await move('SUBMITTED', 'MANAGER_APPROVED', 'MANAGER');
      if (status === 'ACCOUNTING_CLEARED') {
        await move('MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'ACCOUNTANT');
      }
      return order;
    }
    const approvalTime = async (id: string): Promise<Date | null> =>
      (await t.prisma.order.findUniqueOrThrow({ where: { id } })).managerApprovedAt;

    it('gets its approval time and its units at the clearance, and an event says so', async () => {
      const order = await approvedByOldProcess('MANAGER_APPROVED');
      expect(await approvalTime(order.id)).toBeNull();
      const reply = await call(STAFF_ORDER_ROUTES.accountingApproveOrder, {
        actor: w.actors.accountant,
        params: { id: order.id },
        body: { expectedRowVersion: await version(order.id) },
      });
      expect(reply.status).toBe(200);
      expect(await approvalTime(order.id)).not.toBeNull();
      expect(await t.prisma.orderUnit.count({ where: { orderId: order.id } })).toBeGreaterThan(0);
      const event = await t.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, toStatus: 'ACCOUNTING_CLEARED' },
      });
      expect(event.payload).toMatchObject({ before: { managerApprovedAt: null } });
      const seen = await call(STAFF_ORDER_ROUTES.getOrder, {
        actor: w.actors.warehouse,
        params: { id: order.id },
      });
      expect(seen.status).toBe(200);
    });

    it('asks the warehouse for the goods when it is cancelled before the clearance', async () => {
      const order = await approvedByOldProcess('MANAGER_APPROVED');
      const reply = await call(STAFF_ORDER_ROUTES.cancelOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: { expectedRowVersion: await version(order.id), reason: 'mijoz aytdi' },
      });
      expect(reply.status).toBe(200);
      expect(await approvalTime(order.id)).not.toBeNull();
      expect((await returned(order.id)).status).toBe(200);
    });

    it('a cancel of an order still waiting for the manager stays without an approval', async () => {
      const order = await submitOrder(w);
      const reply = await call(STAFF_ORDER_ROUTES.cancelOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: { expectedRowVersion: await version(order.id), reason: 'mijoz aytdi' },
      });
      expect(reply.status).toBe(200);
      expect(await approvalTime(order.id)).toBeNull();
    });

    it('cleared without units: the release still checks the codes', async () => {
      await makeP1NeedImei();
      const order = await approvedByOldProcess('ACCOUNTING_CLEARED');
      const reply = await call(STAFF_ORDER_ROUTES.releaseOrder, {
        actor: w.actors.warehouse,
        params: { id: order.id },
        body: { expectedRowVersion: await version(order.id), driverUserId: w.actors.driver.userId },
      });
      expectError(reply, 409, 'CONFLICT', 'UNIT_CODES_INCOMPLETE');
    });
  });

  describe('concurrency', () => {
    it.each(['CANCELLED', 'REJECTED'] as const)(
      'a scan racing a move to %s never leaves a live code on a closed order',
      async (to) => {
        await makeP1NeedImei();
        for (const value of [IMEI_A, IMEI_B]) {
          const order = await orderAt(w, 'MANAGER_APPROVED');
          const unitId = firstUnitWithSlot(await picking(order.id));
          const actor = to === 'CANCELLED' ? w.actors.manager : w.actors.accountant;
          await Promise.allSettled([
            scan(order.id, unitId, value),
            w.step(actor, order.id, { to, reason: 'poyga' }),
          ]);
          const row = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
          expect(row.status).toBe(to);
          expect(
            await t.prisma.unitCode.count({ where: { orderId: order.id, voidedAt: null } }),
          ).toBe(0);
        }
      },
    );

    it('of two presses of "Returned" exactly one writes', async () => {
      const order = await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' });
      const replies = await Promise.all([returned(order.id), returned(order.id)]);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
      expect(
        await t.prisma.orderEvent.count({
          where: { orderId: order.id, eventType: 'GOODS_RETURNED' },
        }),
      ).toBe(1);
    });
  });
});
