import { ORDER_ROUTES, customerOrderSchema } from '@iorder/shared';
import {
  STAFF_ORDER_ROUTES,
  STAFF_PICKING_ROUTES,
  allocationPreviewSchema,
  pickingResponseSchema,
  staffOrderFulfilmentSchema,
  staffOrderSchema,
  staffTimelineResponseSchema,
  type AllocationPreview,
} from '@iorder/shared/staff-orders';
import { COST_ROUTES, stockOverviewResponseSchema } from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import {
  PriceReferenceService,
  PricingModule,
  SupplyAllocationService,
  SupplyRemovalService,
} from '../src/modules/pricing/index.js';
import { assertCustomerSafe, caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, orderAt, stockUp, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const COST_WORDS = /cost|supplier|purchase|margin|usdRate|REF-SECRET-COST/i;

describe('stock holds and FIFO (real PostgreSQL)', () => {
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
    // These tests set their own stock: no world line may help.
    await t.prisma.priceReference.updateMany({ data: { availableQuantity: '0' } });
    await t.prisma.stockCache.updateMany({ data: { quantity: '0' } });
  });

  const OLD = new Date('2026-08-01T00:00:00Z');
  const NEW = new Date('2026-09-15T00:00:00Z');

  const onlyP1 = (quantity: string) => ({
    items: [[w.products.p1, quantity]] as [string, string][],
  });

  const version = async (orderId: string): Promise<number> =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).rowVersion;

  const preview = async (orderId: string): Promise<AllocationPreview> =>
    expectParsed(
      await call(STAFF_ORDER_ROUTES.getAllocationPreview, {
        actor: w.actors.manager,
        params: { id: orderId },
      }),
      200,
      allocationPreviewSchema,
    );

  const fifoRows = (view: AllocationPreview) =>
    view.items.flatMap((item) =>
      item.fifo.map((row) => ({
        orderItemId: item.orderItemId,
        supplyLineId: row.supplyLineId,
        quantity: row.quantity,
      })),
    );

  async function approve(
    orderId: string,
    extra: Record<string, unknown> = {},
    actor = w.actors.manager,
  ) {
    const plan = await preview(orderId);
    return call(STAFF_ORDER_ROUTES.approveOrder, {
      actor,
      params: { id: orderId },
      body: {
        paymentMethod: 'CASH',
        allocationMode: 'FIFO',
        allocations: fifoRows(plan),
        expectedRowVersion: plan.rowVersion,
        ...extra,
      },
    });
  }

  const activeHolds = (orderId: string) =>
    t.prisma.orderAllocation.findMany({
      where: { orderId, holdEndedAt: null, voidedAt: null },
      orderBy: { id: 'asc' },
    });

  const rowsOf = async (orderId: string) =>
    t.prisma.orderAllocation.findMany({ where: { orderId } });

  /** A sync writes what the sheet says, through the real service. */
  async function sheetSays(
    productId: string,
    ref: string,
    available: string,
    at = OLD,
  ): Promise<void> {
    await t.get(PriceReferenceService).upsertDeliveries([
      {
        productId,
        deliveryRef: ref,
        supplier: 'Test supplier',
        purchaseMethod: 'Bank',
        category: 'Test',
        deliveredQuantity: new Prisma.Decimal('1000'),
        availableQuantity: new Prisma.Decimal(available),
        costUsd: new Prisma.Decimal('1'),
        usdRateUsed: new Prisma.Decimal('12000'),
        costUzs: new Prisma.Decimal('12000'),
        deliveredAt: at,
      },
    ]);
  }

  /**
   * An order of p1 for MORE than its free stock. A customer cannot place one any more (the cart
   * and the submit stop at the free stock since 2026-11-09), so it is placed while the sheet still
   * shows plenty on one of the product's lines, and the sheet then falls back to what the test had
   * set: the stock fell after the order, which is the case the manager's plan has to deal with.
   */
  async function submitBeforeStockFell(
    actor: Parameters<typeof submitOrder>[1],
    quantity: string,
  ): ReturnType<typeof submitOrder> {
    const productId = w.products.p1;
    const line = await t.prisma.priceReference.findFirstOrThrow({
      where: { productId, removedAt: null },
      orderBy: { deliveredAt: 'desc' },
    });
    const cache = await t.prisma.stockCache.findUniqueOrThrow({ where: { productId } });
    const sheetShows = async (onLine: Prisma.Decimal | string, total: Prisma.Decimal | string) => {
      await t.prisma.priceReference.update({
        where: { id: line.id },
        data: { availableQuantity: onLine },
      });
      await t.prisma.stockCache.update({ where: { productId }, data: { quantity: total } });
    };
    await sheetShows('100000', '100000');
    const order = await submitOrder(w, actor, onlyP1(quantity));
    await sheetShows(line.availableQuantity, cache.quantity);
    return order;
  }

  describe('preview', () => {
    it('proposes the oldest line, names what is short and who came earlier', async () => {
      await stockUp(t.prisma, w.products.p1, '5', { deliveryRef: 'B-NEW', deliveredAt: NEW });
      await stockUp(t.prisma, w.products.p1, '2', { deliveryRef: 'A-OLD', deliveredAt: OLD });
      const earlier = await submitOrder(w, w.actors.ownerB, onlyP1('3'));
      t.clock.set(new Date('2026-10-20T09:00:00Z'));
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('4'));

      const view = await preview(order.id);
      expect(view.feasible).toBe(true);
      expect(view.items[0]?.fifo.map((r) => [r.deliveryRef, r.quantity])).toEqual([
        ['A-OLD', '2.000'],
        ['B-NEW', '2.000'],
      ]);
      expect(view.items[0]?.earlierDemand).toEqual({ orders: 1, quantity: '3.000' });
      expect(view.notAllocated).toBe(false);
      expect((await preview(earlier.id)).items[0]?.earlierDemand.orders).toBe(0);

      const short = await submitBeforeStockFell(w.actors.sellerB, '10');
      const shortView = await preview(short.id);
      expect(shortView.feasible).toBe(false);
      expect(shortView.items[0]?.shortQuantity).toBe('3.000');
    });

    it.each(['accountant', 'warehouse', 'driver', 'admin'] as const)(
      'is refused to the %s',
      async (who) => {
        await stockUp(t.prisma, w.products.p1, '5', { deliveredAt: OLD, deliveryRef: 'R1' });
        const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
        expectError(
          await call(STAFF_ORDER_ROUTES.getAllocationPreview, {
            actor: w.actors[who],
            params: { id: order.id },
          }),
          403,
          'FORBIDDEN',
        );
      },
    );

    it('is closed to customers', async () => {
      await stockUp(t.prisma, w.products.p1, '5', { deliveredAt: OLD, deliveryRef: 'R1' });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      const reply = await call(STAFF_ORDER_ROUTES.getAllocationPreview, {
        actor: w.actors.sellerA,
        params: { id: order.id },
      });
      expect(reply.status).toBe(403);
    });

    it('carries no cost and no supplier', async () => {
      await stockUp(t.prisma, w.products.p1, '5', { deliveredAt: OLD, deliveryRef: 'R1' });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      expect(JSON.stringify(await preview(order.id))).not.toMatch(COST_WORDS);
    });
  });

  describe('approve', () => {
    it('writes holds, the event and the outbox in one transaction with the status', async () => {
      const line = await stockUp(t.prisma, w.products.p1, '5', {
        deliveredAt: OLD,
        deliveryRef: 'R1',
      });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      const body = expectParsed(await approve(order.id), 200, staffOrderSchema);
      expect(body.status).toBe('MANAGER_APPROVED');

      const holds = await activeHolds(order.id);
      expect(holds.map((h) => [h.priceReferenceId, h.quantity.toFixed(3)])).toEqual([
        [line, '2.000'],
      ]);
      expect(holds[0]?.createdBy).toBe(w.ids.manager);

      const event = await t.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, toStatus: 'MANAGER_APPROVED' },
      });
      const after = (event.payload as { after: Record<string, unknown> }).after;
      expect(after.allocationMode).toBe('FIFO');
      expect(after.allocations).toEqual([
        expect.objectContaining({ supplyLineId: line, quantity: '2.000', productCode: 'P-1' }),
      ]);
      expect(JSON.stringify(event.payload)).not.toMatch(COST_WORDS);
      expect(
        await t.prisma.notificationOutbox.count({
          where: { orderId: order.id, orderEventId: event.id },
        }),
      ).toBeGreaterThan(0);
      // The sheet's figures are not touched: hold, never subtract.
      expect(
        (
          await t.prisma.stockCache.findUniqueOrThrow({ where: { productId: w.products.p1 } })
        ).quantity.toFixed(3),
      ).toBe('5.000');
    });

    it('rolls everything back when the plan is refused', async () => {
      await stockUp(t.prisma, w.products.p1, '1', { deliveredAt: OLD, deliveryRef: 'R1' });
      const order = await submitBeforeStockFell(w.actors.sellerA, '2');
      expectError(await approve(order.id), 409, 'CONFLICT');
      const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored.status).toBe('SUBMITTED');
      expect(await rowsOf(order.id)).toEqual([]);
      expect(
        await t.prisma.notificationOutbox.count({
          where: { orderId: order.id, type: 'ORDER_MANAGER_APPROVED' },
        }),
      ).toBe(0);
    });

    it('answers zero stock with STOCK_INSUFFICIENT, whatever the body says', async () => {
      // Ordered while the sheet still showed stock; it is gone by the time the manager approves.
      const order = await submitBeforeStockFell(w.actors.sellerA, '1');
      const reply = await call(STAFF_ORDER_ROUTES.approveOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: {
          paymentMethod: 'CASH',
          allocationMode: 'FIFO',
          allocations: [],
          expectedRowVersion: await version(order.id),
        },
      });
      expectError(reply, 409, 'CONFLICT');
      const error = (reply.body as { error: { reason: string; details: { preview: unknown } } })
        .error;
      expect(error.reason).toBe('STOCK_INSUFFICIENT');
      const shown = allocationPreviewSchema.parse(error.details.preview);
      expect(shown.items[0]?.shortQuantity).toBe('1.000');
    });

    it('needs a plan: a missing one is 4xx at the door and in the service', async () => {
      await stockUp(t.prisma, w.products.p1, '5', { deliveredAt: OLD, deliveryRef: 'R1' });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      const rowVersion = await version(order.id);
      const reply = await call(STAFF_ORDER_ROUTES.approveOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: { paymentMethod: 'CASH', expectedRowVersion: rowVersion },
      });
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
      await expect(
        w.orders.transition(w.actors.manager, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: rowVersion,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('turns a plan the sync made stale into ALLOCATION_CHANGED with the fresh plan, one click away', async () => {
      await sheetSays(w.products.p1, 'R-NEW', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      const seen = await preview(order.id);
      // An older line arrives. The plan still fits, but it is no longer the FIFO.
      await sheetSays(w.products.p1, 'R-OLD', '5', OLD);

      const stale = await call(STAFF_ORDER_ROUTES.approveOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: {
          paymentMethod: 'CASH',
          allocationMode: 'FIFO',
          allocations: fifoRows(seen),
          expectedRowVersion: seen.rowVersion,
        },
      });
      expectError(stale, 409, 'CONFLICT');
      const error = (stale.body as { error: { reason: string; details: { preview: unknown } } })
        .error;
      expect(error.reason).toBe('ALLOCATION_CHANGED');
      const fresh = allocationPreviewSchema.parse(error.details.preview);
      expect(fresh.items[0]?.fifo.map((r) => r.deliveryRef)).toEqual(['R-OLD']);

      const confirmed = await call(STAFF_ORDER_ROUTES.approveOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: {
          paymentMethod: 'CASH',
          allocationMode: 'FIFO',
          allocations: fifoRows(fresh),
          expectedRowVersion: fresh.rowVersion,
        },
      });
      expect(confirmed.status).toBe(200);
    });

    it('lets the manager choose a newer line, and records the choice', async () => {
      await sheetSays(w.products.p1, 'R-OLD', '5', OLD);
      await sheetSays(w.products.p1, 'R-NEW', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      const view = await preview(order.id);
      const newer = view.items[0]?.lines.find((l) => l.deliveryRef === 'R-NEW');
      expect(newer).toBeDefined();
      const reply = await approve(order.id, {
        allocationMode: 'MANUAL',
        allocations: [
          {
            orderItemId: view.items[0]?.orderItemId,
            supplyLineId: newer?.supplyLineId,
            quantity: '2',
          },
        ],
      });
      expect(reply.status).toBe(200);
      expect((await activeHolds(order.id))[0]?.priceReferenceId).toBe(newer?.supplyLineId);
    });

    it('refuses a manual plan over the line limit with the total still enough', async () => {
      await sheetSays(w.products.p1, 'R-OLD', '2', OLD);
      await sheetSays(w.products.p1, 'R-NEW', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('3'));
      const view = await preview(order.id);
      const old = view.items[0]?.lines.find((l) => l.deliveryRef === 'R-OLD');
      const reply = await approve(order.id, {
        allocationMode: 'MANUAL',
        allocations: [
          {
            orderItemId: view.items[0]?.orderItemId,
            supplyLineId: old?.supplyLineId,
            quantity: '3',
          },
        ],
      });
      expectError(reply, 409, 'CONFLICT');
      expect((reply.body as { error: { reason: string } }).error.reason).toBe('ALLOCATION_CHANGED');
      expect(await rowsOf(order.id)).toEqual([]);
    });

    it('refuses a manual plan that does not add up, or names another product', async () => {
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      const other = await stockUp(t.prisma, w.products.p2, '5', {
        deliveredAt: OLD,
        deliveryRef: 'R2',
      });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      const view = await preview(order.id);
      const item = view.items[0];
      const line = item?.lines[0];
      for (const allocations of [
        [{ orderItemId: item?.orderItemId, supplyLineId: line?.supplyLineId, quantity: '1' }],
        [{ orderItemId: item?.orderItemId, supplyLineId: other, quantity: '2' }],
      ]) {
        const reply = await approve(order.id, { allocationMode: 'MANUAL', allocations });
        expect(reply.status).toBe(422);
      }
    });

    it('of two orders wanting the last unit, exactly one wins; the other hears STOCK_INSUFFICIENT', async () => {
      await sheetSays(w.products.p1, 'R1', '1', OLD);
      const a = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      const b = await submitOrder(w, w.actors.ownerB, onlyP1('1'));
      const [planA, planB] = [await preview(a.id), await preview(b.id)];
      const send = (orderId: string, plan: AllocationPreview) =>
        call(STAFF_ORDER_ROUTES.approveOrder, {
          actor: w.actors.manager,
          params: { id: orderId },
          body: {
            paymentMethod: 'CASH',
            allocationMode: 'FIFO',
            allocations: fifoRows(plan),
            expectedRowVersion: plan.rowVersion,
          },
        });
      const replies = await Promise.all([send(a.id, planA), send(b.id, planB)]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = replies.find((r) => r.status === 409);
      expect((loser?.body as { error: { reason: string } }).error.reason).toBe(
        'STOCK_INSUFFICIENT',
      );
      const total = await t.prisma.orderAllocation.aggregate({
        where: { holdEndedAt: null, voidedAt: null },
        _sum: { quantity: true },
      });
      expect(total._sum.quantity?.toFixed(3)).toBe('1.000');
    });

    it('approval and sync racing on one line never interleave and never deadlock', async () => {
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      for (let round = 0; round < 8; round += 1) {
        const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
        const plan = await preview(order.id);
        const [reply] = await Promise.all([
          call(STAFF_ORDER_ROUTES.approveOrder, {
            actor: w.actors.manager,
            params: { id: order.id },
            body: {
              paymentMethod: 'CASH',
              allocationMode: 'FIFO',
              allocations: fifoRows(plan),
              expectedRowVersion: plan.rowVersion,
            },
          }),
          sheetSays(w.products.p1, 'R1', round % 2 === 0 ? '0' : '5', OLD),
        ]);
        // The sync came first or the approval did; each answer is a clean one, never a 500.
        expect([200, 409]).toContain(reply.status);
        await sheetSays(w.products.p1, 'R1', '5', OLD);
        // Nothing is ever held past what the approval saw under the lock.
        if (reply.status === 409) expect(await rowsOf(order.id)).toEqual([]);
        else await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'next round' });
      }
    }, 60_000);

    it('the approval waits for a sync that holds the lock, then reads what it wrote', async () => {
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      const plan = await preview(order.id);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      // A sync chunk in progress: holds the lock, has written the line, has not committed.
      const sync = t.get(PriceReferenceService).upsertDeliveriesResolved(
        () => {
          return Promise.resolve([
            {
              productId: w.products.p1,
              deliveryRef: 'R1',
              supplier: 'Test supplier',
              purchaseMethod: 'Bank',
              category: 'Test',
              deliveredQuantity: new Prisma.Decimal('1000'),
              availableQuantity: new Prisma.Decimal('1'),
              costUsd: new Prisma.Decimal('1'),
              usdRateUsed: new Prisma.Decimal('12000'),
              costUzs: new Prisma.Decimal('12000'),
              deliveredAt: OLD,
            },
          ]);
        },
        async () => {
          entered();
          await gate;
        },
      );
      await inside;
      const approval = call(STAFF_ORDER_ROUTES.approveOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
        body: {
          paymentMethod: 'CASH',
          allocationMode: 'FIFO',
          allocations: fifoRows(plan),
          expectedRowVersion: plan.rowVersion,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await rowsOf(order.id)).toEqual([]);
      release();
      await sync;
      const reply = await approval;
      expectError(reply, 409, 'CONFLICT');
      expect((reply.body as { error: { reason: string } }).error.reason).toBe('STOCK_INSUFFICIENT');
    });

    it('an item edit racing the approval ends in a clean answer, not a deadlock', async () => {
      await sheetSays(w.products.p1, 'R1', '50', OLD);
      await sheetSays(w.products.p2, 'R2', '50', OLD);
      for (let round = 0; round < 6; round += 1) {
        const order = await submitOrder(w, w.actors.sellerA);
        const plan = await preview(order.id);
        const second = order.items.find((item) => item.productId === w.products.p2);
        const outcomes = await Promise.allSettled([
          call(STAFF_ORDER_ROUTES.approveOrder, {
            actor: w.actors.manager,
            params: { id: order.id },
            body: {
              paymentMethod: 'CASH',
              allocationMode: 'FIFO',
              allocations: fifoRows(plan),
              expectedRowVersion: plan.rowVersion,
            },
          }),
          w.orders.editItems(w.actors.manager, order.id, {
            changes: [{ itemId: second?.id ?? '', quantity: null }],
            expectedRowVersion: plan.rowVersion,
          }),
        ]);
        const [approveOutcome] = outcomes;
        expect(approveOutcome.status).toBe('fulfilled');
        if (approveOutcome.status === 'fulfilled') {
          expect([200, 409]).toContain(approveOutcome.value.status);
        }
        const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        if (stored.status === 'MANAGER_APPROVED') {
          await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'next round' });
        } else {
          await w.step(w.actors.manager, order.id, { to: 'REJECTED', reason: 'next round' });
        }
      }
    }, 60_000);
  });

  describe('holds and the sync', () => {
    it('survive a sync rewriting the line and the aggregate, and count against the next order', async () => {
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      const first = await submitOrder(w, w.actors.sellerA, onlyP1('3'));
      expect((await approve(first.id)).status).toBe(200);
      const before = await activeHolds(first.id);

      await sheetSays(w.products.p1, 'R1', '4', OLD);
      expect((await activeHolds(first.id)).map((h) => h.id)).toEqual(before.map((h) => h.id));
      const line = await t.prisma.priceReference.findFirstOrThrow({
        where: { productId: w.products.p1, deliveryRef: 'R1' },
      });
      expect(line.availableQuantity.toFixed(3)).toBe('4.000');

      const second = await submitBeforeStockFell(w.actors.ownerB, '2');
      const view = await preview(second.id);
      expect(view.items[0]?.lines[0]).toMatchObject({
        availableQuantity: '4.000',
        heldQuantity: '3.000',
        freeQuantity: '1.000',
      });
      expect(view.feasible).toBe(false);
    });

    it('below its holds a line is flagged with a ready alternative; nothing changes by itself', async () => {
      await sheetSays(w.products.p1, 'R-OLD', '5', OLD);
      await sheetSays(w.products.p1, 'R-NEW', '9', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('3'));
      expect((await approve(order.id)).status).toBe(200);
      const holds = await activeHolds(order.id);

      await sheetSays(w.products.p1, 'R-OLD', '1', OLD);
      const view = await preview(order.id);
      expect(view.attention).toBe(true);
      expect(view.items[0]?.current).toEqual([
        expect.objectContaining({ deliveryRef: 'R-OLD', attention: 'LINE_SHORT' }),
      ]);
      expect(view.items[0]?.fifo.map((r) => [r.deliveryRef, r.quantity])).toEqual([
        ['R-OLD', '1.000'],
        ['R-NEW', '2.000'],
      ]);
      expect((await activeHolds(order.id)).map((h) => h.id)).toEqual(holds.map((h) => h.id));
    });

    it('a confirmed removal under a hold flags it and does not crash', async () => {
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      await sheetSays(w.products.p1, 'R2', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      expect((await approve(order.id)).status).toBe(200);

      const removals = t.get(SupplyRemovalService);
      await removals.syncDetected({
        missing: [{ productId: w.products.p1, deliveryRef: 'R1' }],
        present: [],
      });
      const request = await t.prisma.supplyRemovalRequest.findFirstOrThrow({
        where: { productId: w.products.p1, deliveryRef: 'R1' },
      });
      await removals.confirm(w.actors.manager, request.id);

      const view = await preview(order.id);
      expect(view.items[0]?.current[0]?.attention).toBe('LINE_REMOVED');
      expect(view.items[0]?.current[0]?.deliveryRef).toBe('R1');
      expect(view.items[0]?.lines.map((l) => l.deliveryRef)).not.toContain('R1');
      expect(view.items[0]?.fifo.map((r) => r.deliveryRef)).toEqual(['R2']);
    });
  });

  describe('holds end with the order', () => {
    async function approved(): Promise<string> {
      await sheetSays(w.products.p1, 'R1', '50', OLD);
      await sheetSays(w.products.p2, 'R2', '50', OLD);
      const order = await orderAt(w, 'MANAGER_APPROVED');
      expect((await activeHolds(order.id)).length).toBeGreaterThan(0);
      return order.id;
    }

    async function expectEnded(orderId: string): Promise<void> {
      expect(await activeHolds(orderId)).toEqual([]);
      const rows = await rowsOf(orderId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.holdEndedAt).not.toBeNull();
    }

    it('on RELEASED, also recorded on the event', async () => {
      const id = await approved();
      await w.step(w.actors.accountant, id, { to: 'ACCOUNTING_CLEARED' });
      await w.step(w.actors.warehouse, id, { to: 'RELEASED', driverUserId: w.ids.driver });
      await expectEnded(id);
      const event = await t.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: id, toStatus: 'RELEASED' },
      });
      const count = (await rowsOf(id)).length;
      expect((event.payload as { after: { holdsEnded: number } }).after.holdsEnded).toBe(count);
    });

    it('on REJECTED by the accountant', async () => {
      const id = await approved();
      await w.step(w.actors.accountant, id, { to: 'REJECTED', reason: 'no' });
      await expectEnded(id);
    });

    it('on CANCELLED by the manager', async () => {
      const id = await approved();
      await w.step(w.actors.manager, id, { to: 'CANCELLED', reason: 'no' });
      await expectEnded(id);
    });

    it('a rollback keeps the holds: a refused release ends nothing', async () => {
      const id = await approved();
      await w.step(w.actors.accountant, id, { to: 'ACCOUNTING_CLEARED' });
      await expect(
        w.step(w.actors.warehouse, id, { to: 'RELEASED', driverUserId: w.ids.manager }),
      ).rejects.toThrow();
      expect((await activeHolds(id)).length).toBeGreaterThan(0);
    });

    it('an ended hold frees the stock for the next order', async () => {
      const id = await approved();
      const before = await preview(id);
      await w.step(w.actors.manager, id, { to: 'CANCELLED', reason: 'no' });
      const next = await submitOrder(w, w.actors.ownerB);
      const after = await preview(next.id);
      expect(after.items[0]?.lines[0]?.heldQuantity).toBe('0.000');
      expect(before.feasible).toBe(true);
    });
  });

  describe('the manager moves holds until the release', () => {
    async function setup(): Promise<{ id: string; view: AllocationPreview }> {
      await sheetSays(w.products.p1, 'R-OLD', '5', OLD);
      await sheetSays(w.products.p1, 'R-NEW', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      expect((await approve(order.id)).status).toBe(200);
      return { id: order.id, view: await preview(order.id) };
    }
    const toNew = (view: AllocationPreview) => {
      const item = view.items[0];
      const line = item?.lines.find((l) => l.deliveryRef === 'R-NEW');
      return [{ orderItemId: item?.orderItemId, supplyLineId: line?.supplyLineId, quantity: '2' }];
    };

    it('voids the old rows, adds new ones, and records before and after', async () => {
      const { id, view } = await setup();
      const oldHolds = await activeHolds(id);
      const reply = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body: {
          allocationMode: 'MANUAL',
          allocations: toNew(view),
          comment: 'customer asked',
          expectedRowVersion: view.rowVersion,
        },
      });
      const shown = expectParsed(reply, 200, allocationPreviewSchema);
      expect(shown.items[0]?.current.map((r) => r.deliveryRef)).toEqual(['R-NEW']);

      const voided = await t.prisma.orderAllocation.findUniqueOrThrow({
        where: { id: oldHolds[0]?.id ?? '' },
      });
      expect(voided.voidedBy).toBe(w.ids.manager);
      expect(voided.quantity.toFixed(3)).toBe('2.000');
      const event = await t.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: id, eventType: 'ALLOCATION_CHANGED' },
      });
      expect(event.comment).toBe('customer asked');
      const payload = event.payload as {
        before: { allocations: { supplyLineId: string }[] };
        after: { allocations: { supplyLineId: string }[] };
      };
      expect(payload.before.allocations[0]?.supplyLineId).toBe(oldHolds[0]?.priceReferenceId);
      expect(payload.after.allocations[0]?.supplyLineId).toBe(toNew(view)[0]?.supplyLineId);
      // Not a workflow step: decisions in progress stay valid.
      expect(await version(id)).toBe(view.rowVersion);
    });

    it('over the line limit is refused and nothing moves', async () => {
      const { id, view } = await setup();
      const item = view.items[0];
      const line = item?.lines.find((l) => l.deliveryRef === 'R-NEW');
      await t.prisma.priceReference.update({
        where: { id: line?.supplyLineId ?? '' },
        data: { availableQuantity: '1' },
      });
      const before = await activeHolds(id);
      const reply = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body: {
          allocationMode: 'MANUAL',
          allocations: toNew(view),
          expectedRowVersion: view.rowVersion,
        },
      });
      expectError(reply, 409, 'CONFLICT');
      expect((reply.body as { error: { reason: string } }).error.reason).toBe('ALLOCATION_CHANGED');
      expect((await activeHolds(id)).map((h) => h.id)).toEqual(before.map((h) => h.id));
    });

    it('the same plan writes nothing', async () => {
      const { id, view } = await setup();
      const before = await rowsOf(id);
      const reply = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body: {
          allocationMode: 'FIFO',
          allocations: fifoRows(view),
          expectedRowVersion: view.rowVersion,
        },
      });
      expect(reply.status).toBe(200);
      expect((await rowsOf(id)).length).toBe(before.length);
      expect(
        await t.prisma.orderEvent.count({
          where: { orderId: id, eventType: 'ALLOCATION_CHANGED' },
        }),
      ).toBe(0);
    });

    it('a stale version is ORDER_CHANGED; after the release it is closed', async () => {
      const { id, view } = await setup();
      const body = {
        allocationMode: 'MANUAL',
        allocations: toNew(view),
        expectedRowVersion: view.rowVersion + 5,
      };
      const stale = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body,
      });
      expect((stale.body as { error: { reason: string } }).error.reason).toBe('ORDER_CHANGED');

      await w.step(w.actors.accountant, id, { to: 'ACCOUNTING_CLEARED' });
      await w.step(w.actors.warehouse, id, { to: 'RELEASED', driverUserId: w.ids.driver });
      const late = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body: { ...body, expectedRowVersion: await version(id) },
      });
      expect((late.body as { error: { reason: string } }).error.reason).toBe(
        'ALLOCATION_NOT_CHANGEABLE',
      );
      const closed = await call(STAFF_ORDER_ROUTES.getAllocationPreview, {
        actor: w.actors.manager,
        params: { id },
      });
      expect((closed.body as { error: { reason: string } }).error.reason).toBe(
        'ALLOCATION_NOT_CHANGEABLE',
      );
    });

    it.each(['accountant', 'warehouse', 'driver', 'admin'] as const)(
      'is refused to the %s',
      async (who) => {
        const { id, view } = await setup();
        const reply = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
          actor: w.actors[who],
          params: { id },
          body: {
            allocationMode: 'MANUAL',
            allocations: toNew(view),
            expectedRowVersion: view.rowVersion,
          },
        });
        expectError(reply, 403, 'FORBIDDEN');
      },
    );

    it('an order approved before holds shows "not allocated" and may get its first holds', async () => {
      const { id, view } = await setup();
      // An older approved order: no rows at all (allocations are never deleted by the app).
      const raw = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`DELETE FROM order_allocations WHERE order_id = ${id}::uuid`;
        return id;
      });
      const legacy = await preview(raw);
      expect(legacy.notAllocated).toBe(true);
      expect(legacy.items[0]?.current).toEqual([]);
      const reply = await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body: {
          allocationMode: 'MANUAL',
          allocations: toNew(view),
          expectedRowVersion: view.rowVersion,
        },
      });
      expect(reply.status).toBe(200);
      expect((await preview(id)).notAllocated).toBe(false);
    });
  });

  describe('who sees what', () => {
    async function setup(): Promise<string> {
      await sheetSays(w.products.p1, 'R-SECRET', '50', OLD);
      await sheetSays(w.products.p2, 'R-SECRET2', '50', OLD);
      return (await orderAt(w, 'MANAGER_APPROVED')).id;
    }

    it('the customer reads no allocation, no ref, in the order or the timeline', async () => {
      const id = await setup();
      for (const route of [ORDER_ROUTES.getOrder, ORDER_ROUTES.getOrderTimeline]) {
        const reply = await call(route, { actor: w.actors.sellerA, params: { id } });
        expect(reply.status).toBe(200);
        const text = JSON.stringify(reply.body);
        expect(text).not.toMatch(/allocation|R-SECRET|supplyLine|hold/i);
        expect(text).not.toMatch(COST_WORDS);
      }
    });

    it('the warehouse order and timeline carry no cost and no allocation event', async () => {
      const id = await setup();
      const view = await w.step(w.actors.manager, id, { to: 'CANCELLED', reason: 'x' });
      expect(view.status).toBe('CANCELLED');
      const order = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, { actor: w.actors.warehouse, params: { id } }),
        200,
        staffOrderFulfilmentSchema,
      );
      expect(JSON.stringify(order)).not.toMatch(COST_WORDS);
      const timeline = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.warehouse,
          params: { id },
        }),
        200,
        staffTimelineResponseSchema,
      );
      expect(JSON.stringify(timeline)).not.toMatch(/R-SECRET|ALLOCATION_CHANGED/);
    });

    it('the allocation event is on the manager timeline only as a type; payload stays in the table', async () => {
      const id = await setup();
      const view = await preview(id);
      const item = view.items[0];
      const line = item?.lines[0];
      await sheetSays(w.products.p1, 'R-OTHER', '50', NEW);
      const fresh = await preview(id);
      const other = fresh.items[0]?.lines.find((l) => l.deliveryRef === 'R-OTHER');
      expect(line).toBeDefined();
      await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
        actor: w.actors.manager,
        params: { id },
        body: {
          allocationMode: 'MANUAL',
          allocations: [
            ...fresh.items
              .filter((i) => i.orderItemId !== item?.orderItemId)
              .flatMap((i) =>
                i.current.map((c) => ({
                  orderItemId: i.orderItemId,
                  supplyLineId: c.supplyLineId,
                  quantity: c.quantity,
                })),
              ),
            {
              orderItemId: item?.orderItemId,
              supplyLineId: other?.supplyLineId,
              quantity: item?.quantity,
            },
          ],
          expectedRowVersion: fresh.rowVersion,
        },
      });
      const timeline = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.manager,
          params: { id },
        }),
        200,
        staffTimelineResponseSchema,
      );
      expect(timeline.events.map((e) => e.type)).toContain('ALLOCATION_CHANGED');
      const customer = await call(ORDER_ROUTES.getOrderTimeline, {
        actor: w.actors.sellerA,
        params: { id },
      });
      expect(JSON.stringify(customer.body)).not.toContain('ALLOCATION_CHANGED');
    });
  });

  describe('order details by supply and party', () => {
    /** 4 pieces of p1: 3 from the older delivery, 1 from the newer one; the older has a party. */
    async function splitOrder(method: 'CASH' | 'OFFICIAL' = 'OFFICIAL'): Promise<string> {
      await sheetSays(w.products.p1, '77343', '3', OLD);
      await sheetSays(w.products.p1, '34343', '10', NEW);
      await t.prisma.supplyParty.create({
        data: {
          deliveryRef: '77343',
          partyNumber: 'P-7',
          updatedBy: w.ids.manager,
          updatedAt: new Date(),
        },
      });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('4'));
      expect((await approve(order.id, { paymentMethod: method })).status).toBe(200);
      return order.id;
    }
    const SPLIT = [
      { supplyRef: '77343', partyNumber: 'P-7', quantity: '3.000' },
      { supplyRef: '34343', partyNumber: null, quantity: '1.000' },
    ];
    const readAs = (actor: typeof w.actors.manager, id: string) =>
      call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id } });

    it('manager and accountant see the split with party and money', async () => {
      const id = await splitOrder();
      for (const actor of [w.actors.manager, w.actors.accountant]) {
        const order = expectParsed(await readAs(actor, id), 200, staffOrderSchema);
        if (order.detail !== 'FULL') throw new Error('expected the full view');
        expect(order.items[0]?.allocations).toEqual(SPLIT);
        expect(order.items[0]?.lineTotal).toBeDefined();
        expect(order.paymentPlan).toBe('FULL');
        // The full view carries the order's frozen usdRate on purpose (USD debt), nothing else of cost.
        expect(JSON.stringify(order)).not.toMatch(/cost|supplier|purchase|margin|REF-SECRET-COST/i);
      }
    });

    it('the warehouse sees supply, party and pieces, and no money or payment method', async () => {
      const id = await splitOrder();
      const order = expectParsed(
        await readAs(w.actors.warehouse, id),
        200,
        staffOrderFulfilmentSchema,
      );
      expect(order.items[0]?.allocations).toEqual(SPLIT);
      const text = JSON.stringify(order);
      expect(text).not.toMatch(/price|total|amount|paymentMethod|paymentPlan/i);
      expect(text).not.toMatch(COST_WORDS);

      const picking = await call(STAFF_PICKING_ROUTES.getPicking, {
        actor: w.actors.warehouse,
        params: { id },
      });
      const parsed = expectParsed(picking, 200, pickingResponseSchema);
      expect(parsed.lines[0]?.allocations).toEqual(SPLIT);
      expect(JSON.stringify(parsed)).not.toMatch(/price|total|amount|paymentMethod/i);
    });

    it('the driver gets no supply at all', async () => {
      const id = await splitOrder();
      await w.step(w.actors.accountant, id, { to: 'ACCOUNTING_CLEARED' });
      await w.step(w.actors.warehouse, id, { to: 'RELEASED', driverUserId: w.ids.driver });
      const order = expectParsed(
        await readAs(w.actors.driver, id),
        200,
        staffOrderFulfilmentSchema,
      );
      expect(JSON.stringify(order)).not.toMatch(/allocations|supplyRef|partyNumber|77343/);
    });

    it('the customer response has no allocation field, on a split order with a party', async () => {
      const id = await splitOrder();
      const single = await call(ORDER_ROUTES.getOrder, {
        actor: w.actors.sellerA,
        params: { id },
      });
      const page = await call(ORDER_ROUTES.listOrders, { actor: w.actors.sellerA });
      for (const reply of [single, page]) {
        expect(reply.status).toBe(200);
        assertCustomerSafe(reply.body, w);
        expect(JSON.stringify(reply.body)).not.toMatch(
          /allocation|supplyRef|partyNumber|77343|34343|P-7/,
        );
      }
      expectParsed(single, 200, customerOrderSchema);
    });

    it('a party set after the approval shows on the order: read live, not copied', async () => {
      const id = await splitOrder();
      await t.prisma.supplyParty.create({
        data: {
          deliveryRef: '34343',
          partyNumber: 'LATE',
          updatedBy: w.ids.manager,
          updatedAt: new Date(),
        },
      });
      const order = expectParsed(await readAs(w.actors.accountant, id), 200, staffOrderSchema);
      expect(order.items[0]?.allocations?.[1]?.partyNumber).toBe('LATE');
    });

    it('a replaced plan is gone from the view; a released order keeps where the goods left from', async () => {
      const id = await splitOrder();
      const fresh = await preview(id);
      const item = fresh.items[0];
      const newer = item?.lines.find((line) => line.deliveryRef === '34343');
      expect(
        (
          await call(STAFF_ORDER_ROUTES.setOrderAllocations, {
            actor: w.actors.manager,
            params: { id },
            body: {
              allocationMode: 'MANUAL',
              allocations: [
                {
                  orderItemId: item?.orderItemId,
                  supplyLineId: newer?.supplyLineId,
                  quantity: '4',
                },
              ],
              expectedRowVersion: fresh.rowVersion,
            },
          })
        ).status,
      ).toBe(200);
      const moved = [{ supplyRef: '34343', partyNumber: null, quantity: '4.000' }];
      const after = expectParsed(await readAs(w.actors.manager, id), 200, staffOrderSchema);
      expect(after.items[0]?.allocations).toEqual(moved);

      await w.step(w.actors.accountant, id, { to: 'ACCOUNTING_CLEARED' });
      await w.step(w.actors.warehouse, id, { to: 'RELEASED', driverUserId: w.ids.driver });
      const released = expectParsed(await readAs(w.actors.manager, id), 200, staffOrderSchema);
      expect(released.items[0]?.allocations).toEqual(moved);
    });

    it('an order with no holds reads as an empty list', async () => {
      const untouched = await submitBeforeStockFell(w.actors.sellerA, '1');
      const order = expectParsed(
        await readAs(w.actors.manager, untouched.id),
        200,
        staffOrderSchema,
      );
      expect(order.items[0]?.allocations).toEqual([]);
    });

    it("the accountant's outbox row has the sale; the warehouse's and the customer's do not", async () => {
      const id = await splitOrder('CASH');
      const rows = await t.prisma.notificationOutbox.findMany({
        where: { orderId: id, type: { in: ['ORDER_MANAGER_APPROVED', 'ORDER_READY_TO_PREPARE'] } },
      });
      const accountant = rows.find((row) => row.recipientRole === 'ACCOUNTANT');
      expect(accountant?.payload).toMatchObject({
        paymentMethod: 'CASH',
        paymentPlan: 'FULL',
        orderLineCount: 1,
        orderLines: [
          {
            productCode: 'P-1',
            quantity: '4.000',
            supplies: [
              { supplyRef: '77343', partyNumber: 'P-7', quantity: '3.000' },
              { supplyRef: '34343', partyNumber: null, quantity: '1.000' },
            ],
          },
        ],
      });
      expect(JSON.stringify(accountant?.payload)).not.toMatch(COST_WORDS);
      const others = await t.prisma.notificationOutbox.findMany({
        where: { orderId: id, NOT: { recipientRole: 'ACCOUNTANT' } },
      });
      for (const row of others) {
        expect(JSON.stringify(row.payload)).not.toMatch(/orderLines|supplyRef|paymentMethod/);
      }
    });
  });

  describe('stock read models', () => {
    it('the stock page shows total, held and available; the Excel export shows available', async () => {
      await t.prisma.priceReference.updateMany({ data: { removedAt: null } });
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      await t.prisma.stockCache.update({
        where: { productId: w.products.p1 },
        data: { quantity: '5' },
      });
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('3'));
      expect((await approve(order.id)).status).toBe(200);

      const page = expectParsed(
        await call(COST_ROUTES.stockOverview, { actor: w.actors.manager }),
        200,
        stockOverviewResponseSchema,
      );
      expect(page.items.find((i) => i.productId === w.products.p1)).toMatchObject({
        stockQuantity: '5.000',
        heldQuantity: '3.000',
        availableQuantity: '2.000',
      });
      expect(page.items.find((i) => i.productId === w.products.p2)).toMatchObject({
        heldQuantity: '0.000',
        availableQuantity: '0.000',
      });
      const inStock = expectParsed(
        await call(COST_ROUTES.stockOverview, {
          actor: w.actors.manager,
          query: { inStock: 'true' },
        }),
        200,
        stockOverviewResponseSchema,
      );
      expect(inStock.items.map((i) => i.productId)).toEqual([w.products.p1]);

      // Available never goes below zero: the sheet may already show this order's shipment.
      await sheetSays(w.products.p1, 'R1', '1', OLD);
      await t.prisma.stockCache.update({
        where: { productId: w.products.p1 },
        data: { quantity: '1' },
      });
      const low = expectParsed(
        await call(COST_ROUTES.stockOverview, { actor: w.actors.manager }),
        200,
        stockOverviewResponseSchema,
      );
      expect(low.items.find((i) => i.productId === w.products.p1)).toMatchObject({
        stockQuantity: '1.000',
        availableQuantity: '0.000',
      });
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      // What the Excel export reads (price-list-export.service.ts).
      const available = await t
        .get(SupplyAllocationService)
        .availableFrom(new Map([[w.products.p1, new Prisma.Decimal('5')]]));
      expect(available.get(w.products.p1)?.toFixed(3)).toBe('2.000');
    });
  });

  describe('whole pieces and legacy fractional lines', () => {
    it('250.5 available and 251 wanted says short by one, and approve says the same', async () => {
      await sheetSays(w.products.p1, 'R1', '250.5', OLD);
      const order = await submitBeforeStockFell(w.actors.sellerA, '251');
      const view = await preview(order.id);
      expect(view.feasible).toBe(false);
      expect(view.items[0]).toMatchObject({ shortQuantity: '1.000' });
      expect(view.items[0]?.lines[0]?.freeQuantity).toBe('250.000');
      expect(view.items[0]?.fifo.map((r) => r.quantity)).toEqual(['250.000']);
      const reply = await approve(order.id);
      expectError(reply, 409, 'CONFLICT', 'STOCK_INSUFFICIENT');
      expect(await activeHolds(order.id)).toEqual([]);
    });

    it('0.5 + 0.5 is not a piece: insufficient, and the plan can still be sent', async () => {
      await sheetSays(w.products.p1, 'R1', '0.5', OLD);
      await sheetSays(w.products.p1, 'R2', '0.5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      const view = await preview(order.id);
      expect(view.feasible).toBe(false);
      expect(view.items[0]?.fifo).toEqual([]);
      const reply = await approve(order.id);
      expectError(reply, 409, 'CONFLICT', 'STOCK_INSUFFICIENT');
    });

    it('a whole line on a fractional supply line holds whole pieces and is approved', async () => {
      await sheetSays(w.products.p1, 'R1', '250.5', OLD);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('250'));
      expect((await approve(order.id)).status).toBe(200);
      expect((await activeHolds(order.id))[0]?.quantity.toFixed(3)).toBe('250.000');
    });

    it('a manual plan cannot hold a fraction for a whole line', async () => {
      await sheetSays(w.products.p1, 'R1', '5.5', OLD);
      await sheetSays(w.products.p1, 'R2', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('2'));
      const view = await preview(order.id);
      const item = view.items[0];
      const reply = await approve(order.id, {
        allocationMode: 'MANUAL',
        allocations: (item?.lines ?? []).map((l) => ({
          orderItemId: item?.orderItemId,
          supplyLineId: l.supplyLineId,
          quantity: l.deliveryRef === 'R1' ? '1.5' : '0.5',
        })),
      });
      expect(reply.status).toBe(422);
      expect(await activeHolds(order.id)).toEqual([]);
    });

    it.each(['FIFO', 'MANUAL'] as const)(
      'a legacy line of 1.5 can still be approved (%s)',
      async (mode) => {
        await sheetSays(w.products.p1, 'R1', '1', OLD);
        await sheetSays(w.products.p1, 'R2', '5', NEW);
        const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
        // A line from before the whole-number rule: the CHECK is NOT VALID, so such rows stay, and a
        // test can only make one the way the old rows came about, with the CHECK not there yet.
        await t.prisma.$transaction([
          t.prisma.$executeRaw`ALTER TABLE order_items DROP CONSTRAINT order_items_quantity_whole`,
          t.prisma.$executeRaw`
            UPDATE order_items SET quantity = 1.5, line_total = round(1.5 * unit_price, 2)
            WHERE order_id = ${order.id}::uuid`,
          t.prisma.$executeRaw`
            UPDATE orders SET total_amount = round(1.5 * total_amount, 2), row_version = row_version + 1
            WHERE id = ${order.id}::uuid`,
          t.prisma.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`,
          t.prisma.$executeRaw`
            ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_whole
            CHECK (quantity = trunc(quantity)) NOT VALID`,
        ]);
        const view = await preview(order.id);
        expect(view.feasible).toBe(true);
        const lineOf = (ref: string): string | undefined =>
          view.items[0]?.lines.find((l) => l.deliveryRef === ref)?.supplyLineId;
        const rows =
          mode === 'FIFO'
            ? fifoRows(view)
            : [
                {
                  orderItemId: view.items[0]?.orderItemId,
                  supplyLineId: lineOf('R1'),
                  quantity: '0.5',
                },
                {
                  orderItemId: view.items[0]?.orderItemId,
                  supplyLineId: lineOf('R2'),
                  quantity: '1',
                },
              ];
        const reply = await approve(order.id, { allocationMode: mode, allocations: rows });
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        const held = (await activeHolds(order.id)).map((h) => h.quantity.toFixed(3)).sort();
        expect(held).toEqual(['0.500', '1.000']);
      },
    );
  });

  describe('available counts each live line on its own', () => {
    /** Line A is fully held by an approved order, line B has 5 free. */
    async function fullyHeldLineBesideAFreeOne(): Promise<{ lineA: string; orderId: string }> {
      await sheetSays(w.products.p1, 'A', '10', OLD);
      await sheetSays(w.products.p1, 'B', '5', NEW);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('10'));
      const line = await t.prisma.priceReference.findFirstOrThrow({
        where: { productId: w.products.p1, deliveryRef: 'A' },
      });
      const approved = await approve(order.id);
      expect(approved.status).toBe(200);
      expect((await activeHolds(order.id))[0]?.priceReferenceId).toBe(line.id);
      return { lineA: line.id, orderId: order.id };
    }

    async function stockRow(inStock?: 'true' | 'false') {
      const page = expectParsed(
        await call(COST_ROUTES.stockOverview, {
          actor: w.actors.manager,
          ...(inStock === undefined ? {} : { query: { inStock } }),
        }),
        200,
        stockOverviewResponseSchema,
      );
      return page.items.find((i) => i.productId === w.products.p1);
    }

    async function expectPlannerAgrees(available: string): Promise<void> {
      const next = await submitOrder(w, w.actors.sellerA, onlyP1('5'));
      const plan = await preview(next.id);
      const free = plan.items[0]?.lines.reduce((sum, l) => sum + Number(l.freeQuantity), 0);
      expect(free?.toFixed(3)).toBe(available);
      expect(plan.feasible).toBe(true);
    }

    it.each([
      ['removed', { removedAt: new Date(), removedBy: 'test' }, '5', '5.000'],
      ['lowered to 3', { availableQuantity: new Prisma.Decimal('3') }, '8', '8.000'],
    ])(
      'line A %s: the product still shows B, and the hold above Jami',
      async (_label, change, stock, total) => {
        const { lineA } = await fullyHeldLineBesideAFreeOne();
        await t.prisma.priceReference.update({ where: { id: lineA }, data: change });
        await t.prisma.stockCache.update({
          where: { productId: w.products.p1 },
          data: { quantity: stock },
        });

        expect(await stockRow()).toMatchObject({
          stockQuantity: total,
          heldQuantity: '10.000',
          availableQuantity: '5.000',
        });
        expect((await stockRow('true'))?.productId).toBe(w.products.p1);
        expect(await stockRow('false')).toBeUndefined();
        const excel = await t
          .get(SupplyAllocationService)
          .availableFrom(new Map([[w.products.p1, new Prisma.Decimal(stock)]]));
        expect(excel.get(w.products.p1)?.toFixed(3)).toBe('5.000');
        await expectPlannerAgrees('5.000');
      },
    );

    it('a line held beyond its quantity does not eat the free room of another', async () => {
      const { lineA } = await fullyHeldLineBesideAFreeOne();
      await t.prisma.priceReference.update({
        where: { id: lineA },
        data: { availableQuantity: new Prisma.Decimal('0') },
      });
      expect((await stockRow())?.availableQuantity).toBe('5.000');
    });

    it('a product whose every line is held is not in stock', async () => {
      await fullyHeldLineBesideAFreeOne();
      const next = await submitOrder(w, w.actors.sellerA, onlyP1('5'));
      expect((await approve(next.id)).status).toBe(200);
      expect(await stockRow()).toMatchObject({ availableQuantity: '0.000' });
      expect(await stockRow('true')).toBeUndefined();
    });
  });

  describe('the table itself (restricted role)', () => {
    async function oneHold(): Promise<string> {
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      expect((await approve(order.id)).status).toBe(200);
      return (await activeHolds(order.id))[0]?.id ?? '';
    }

    it('refuses a delete and a change of anything but the ending columns', async () => {
      const id = await oneHold();
      await expect(t.prisma.orderAllocation.delete({ where: { id } })).rejects.toThrow();
      await expect(
        t.prisma.orderAllocation.update({ where: { id }, data: { quantity: '9' } }),
      ).rejects.toThrow();
    });

    it('ends a hold once; an ended row cannot be voided or ended again', async () => {
      const id = await oneHold();
      const at = new Date('2026-10-21T00:00:00Z');
      await t.prisma.orderAllocation.update({ where: { id }, data: { holdEndedAt: at } });
      await expect(
        t.prisma.orderAllocation.update({
          where: { id },
          data: { holdEndedAt: new Date('2026-10-22T00:00:00Z') },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.orderAllocation.update({
          where: { id },
          data: { voidedAt: at, voidedBy: w.ids.manager },
        }),
      ).rejects.toThrow();
    });

    it('voids once and never again', async () => {
      const id = await oneHold();
      const at = new Date('2026-10-21T00:00:00Z');
      await t.prisma.orderAllocation.update({
        where: { id },
        data: { voidedAt: at, voidedBy: w.ids.manager },
      });
      await expect(
        t.prisma.orderAllocation.update({
          where: { id },
          data: { voidedAt: new Date('2026-10-22T00:00:00Z'), voidedBy: w.ids.manager2 },
        }),
      ).rejects.toThrow();
    });

    it('refuses a row whose line belongs to another product', async () => {
      const line = await stockUp(t.prisma, w.products.p2, '5', {
        deliveredAt: OLD,
        deliveryRef: 'R2',
      });
      await sheetSays(w.products.p1, 'R1', '5', OLD);
      const order = await submitOrder(w, w.actors.sellerA, onlyP1('1'));
      await expect(
        t.prisma.orderAllocation.create({
          data: {
            orderId: order.id,
            orderItemId: order.items[0]?.id ?? '',
            productId: w.products.p1,
            priceReferenceId: line,
            quantity: '1',
            createdBy: w.ids.manager,
            createdAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });
  });
});
