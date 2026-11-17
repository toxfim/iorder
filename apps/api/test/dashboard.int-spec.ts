import { STAFF_DASHBOARD_ROUTES, staffDashboardSummarySchema } from '@iorder/shared/staff-orders';
import type { StaffDashboardSummary } from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { DashboardModule } from '../src/modules/dashboard/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { UsdRateService } from '../src/modules/pricing/index.js';
import { SheetSyncRunRepository } from '../src/modules/sheets-sync/sheet-sync-run.repository.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
import { caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { makeOrganization } from './support/identity-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetOrders } from './support/test-db.js';

const MONEY_WORDS = /amount|total|price|currency|cost|usd|uzs|margin|sum|paid|payment|rate\b/i;

describe('GET /staff/dashboard/summary (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule, DashboardModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });

  // The clock is 2026-10-20T08:00Z = 13:00 in Tashkent, so "today" is 19 Oct 19:00Z to 20 Oct 19:00Z.
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
    await seed();
  });

  async function seed(): Promise<void> {
    const { actors } = w;
    await orderAt(w, 'SUBMITTED'); // 1
    // Submitted yesterday at 23:00 local (the order identity, submitted_at included, is immutable).
    t.clock.set(new Date('2026-10-19T18:00:00Z'));
    await orderAt(w, 'SUBMITTED');
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    await orderAt(w, 'MANAGER_APPROVED');
    await orderAt(w, 'ACCOUNTING_CLEARED');
    const skipped = await submitOrder(w);
    await w.step(actors.manager, skipped.id, { to: 'MANAGER_APPROVED', skipAccounting: true });
    await orderAt(w, 'RELEASED');
    await orderAt(w, 'DELIVERED'); // unpaid
    const received = await orderAt(w, 'RECEIVED');
    await t.prisma.order.update({ where: { id: received.id }, data: { paymentStatus: 'PAID' } });
    await orderAt(w, 'REJECTED');
    await orderAt(w, 'CANCELLED', { cancelAfter: 'ACCOUNTING_CLEARED' });

    await makeOrganization(w.prisma, { name: 'Waiting group', status: 'INACTIVE' });
    await t.get(UsdRateService).setUsdRate(actors.manager, new Prisma.Decimal('12650.5'));
    await t.get(SheetSyncRunRepository).insertAndPrune({
      startedAt: new Date('2026-10-20T06:00:00Z'),
      finishedAt: new Date('2026-10-20T06:00:05Z'),
      status: 'OK',
      trigger: 'MANUAL',
      counts: {
        rowsRead: 1,
        created: 0,
        updated: 0,
        unchanged: 1,
        rejected: 0,
        skippedRows: 0,
        staleRefs: 0,
        mismatches: 0,
        createdProducts: 0,
        removalsRequested: 0,
        removalsDismissed: 0,
        reappearedAfterRemoval: 0,
      },
      rejectedRows: [],
      skippedSuppliers: [],
      createdProducts: [],
      pendingRemovalRequests: 0,
      costMismatches: [],
      errorCode: null,
    });
  }

  const read = async (actor: Actor): Promise<StaffDashboardSummary> =>
    expectParsed(
      await call(STAFF_DASHBOARD_ROUTES.summary, { actor }),
      200,
      staffDashboardSummarySchema,
    );
  const rawBody = async (actor: Actor): Promise<Record<string, unknown>> => {
    const reply = await call(STAFF_DASHBOARD_ROUTES.summary, { actor });
    expect(reply.status).toBe(200);
    return reply.body as Record<string, unknown>;
  };
  const queueCounts = (summary: StaffDashboardSummary): Record<string, number> =>
    Object.fromEntries(summary.queues.map((q) => [q.key, q.count]));

  it('401 without an actor and 403 for customers', async () => {
    expect((await call(STAFF_DASHBOARD_ROUTES.summary)).status).toBe(401);
    for (const actor of [w.actors.ownerA, w.actors.sellerA, w.actors.sellerB]) {
      expectError(await call(STAFF_DASHBOARD_ROUTES.summary, { actor }), 403, 'FORBIDDEN');
    }
  });

  it('manager: every status, every section, correct figures', async () => {
    const s = await read(w.actors.manager);
    expect(s.businessDate).toBe('2026-10-20');
    expect(s.generatedAt).toBe('2026-10-20T08:00:00.000Z');
    expect(s.ordersByStatus).toEqual({
      SUBMITTED: 2,
      MANAGER_APPROVED: 1,
      ACCOUNTING_CLEARED: 2,
      RELEASED: 1,
      DELIVERED: 1,
      RECEIVED: 1,
      REJECTED: 1,
      CANCELLED: 1,
    });
    expect(queueCounts(s)).toEqual({
      AWAITING_MANAGER: 2,
      AWAITING_ACCOUNTING: 1,
      TO_RELEASE: 2,
      TO_DELIVER: 1,
    });
    // The oldest order entered SUBMITTED at 23:00 local the day before: 14 hours = 840 minutes.
    expect(s.queues[0]).toEqual({
      key: 'AWAITING_MANAGER',
      count: 2,
      oldestWaitingSince: '2026-10-19T18:00:00.000Z',
      oldestAgeMinutes: 840,
    });
    // 7 orders today that are neither rejected nor cancelled, 3750.50 each; the old one is out.
    expect(s.today).toEqual({ count: 7, totalAmount: '26253.50', currency: 'UZS' });
    expect(s.unpaidDeliveredCount).toBe(1);
    expect(s.organizationsAwaitingActivationCount).toBe(1);
    expect(s.unpricedProductsCount).toBe(1);
    expect(s.lastSheetSync).toEqual({
      status: 'OK',
      startedAt: '2026-10-20T06:00:00.000Z',
      finishedAt: '2026-10-20T06:00:05.000Z',
    });
    expect(s.usdRate).toEqual({ rate: '12650.5000', source: 'MANUAL', rateDate: null });
  });

  it('queue age counts from entering the current status, not from the submission', async () => {
    await resetOrders(t.prisma);
    t.clock.set(new Date('2026-10-17T08:00:00Z')); // submitted three days ago
    const order = await submitOrder(w);
    t.clock.set(new Date('2026-10-17T09:00:00Z'));
    await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
    t.clock.set(new Date('2026-10-20T07:55:00Z')); // cleared five minutes before the read
    await w.step(w.actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' });
    t.clock.set(new Date('2026-10-20T08:00:00Z'));

    const queue = (await read(w.actors.warehouse)).queues.find((q) => q.key === 'TO_RELEASE');
    expect(queue).toEqual({
      key: 'TO_RELEASE',
      count: 1,
      oldestWaitingSince: '2026-10-20T07:55:00.000Z',
      oldestAgeMinutes: 5,
    });
  });

  describe('SKIPPED_ACCOUNTING_TO_REVIEW (provisional, manager question Q14)', () => {
    const skippedQueue = async (): Promise<{ count: number; age: number | null } | undefined> => {
      const q = (await read(w.actors.accountant)).queues.find(
        (item) => item.key === 'SKIPPED_ACCOUNTING_TO_REVIEW',
      );
      return q === undefined ? undefined : { count: q.count, age: q.oldestAgeMinutes };
    };

    async function skippedOrderId(): Promise<string> {
      const row = await t.prisma.order.findFirstOrThrow({
        where: { accountingMode: 'SKIPPED_BY_MANAGER' },
        select: { id: true },
      });
      return row.id;
    }

    it('counts from the moment the manager skipped accounting', async () => {
      expect(await skippedQueue()).toEqual({ count: 1, age: 0 });
    });

    it('drops an order an accountant has reviewed', async () => {
      await t.prisma.order.update({
        where: { id: await skippedOrderId() },
        data: { accountingReviewedAt: new Date(), accountingReviewedBy: w.ids.accountant },
      });
      expect(await skippedQueue()).toEqual({ count: 0, age: null });
    });

    it('excludes cancelled and received orders but keeps a delivered one', async () => {
      const id = await skippedOrderId();
      await w.step(w.actors.warehouse, id, {
        to: 'RELEASED',
        driverUserId: w.ids.driver,
      });
      await w.step(w.actors.driver, id, { to: 'DELIVERED' });
      expect((await skippedQueue())?.count).toBe(1);
      await w.step(w.actors.ownerA, id, { to: 'RECEIVED' });
      expect((await skippedQueue())?.count).toBe(0);
    });

    it('excludes a cancelled order', async () => {
      await w.step(w.actors.manager, await skippedOrderId(), {
        to: 'CANCELLED',
        reason: 'customer asked',
      });
      expect((await skippedQueue())?.count).toBe(0);
    });
  });

  it('admin sees the management figures like the manager', async () => {
    const s = await read(w.actors.admin);
    expect(s.today?.count).toBe(7);
    expect(s.organizationsAwaitingActivationCount).toBe(1);
    expect(s.unpricedProductsCount).toBe(1);
    expect(s.lastSheetSync?.status).toBe('OK');
    expect(s.usdRate?.rate).toBe('12650.5000');
    expect(queueCounts(s).AWAITING_MANAGER).toBe(2);
  });

  it('accountant: accounting queues, money and payment, the rate; no management sections', async () => {
    const s = await read(w.actors.accountant);
    expect(queueCounts(s)).toEqual({ AWAITING_ACCOUNTING: 1, SKIPPED_ACCOUNTING_TO_REVIEW: 1 });
    expect(s.today?.count).toBe(7);
    expect(s.unpaidDeliveredCount).toBe(1);
    expect(s.usdRate?.rate).toBe('12650.5000');
    expect(Object.keys(await rawBody(w.actors.accountant)).sort()).toEqual(
      [
        'businessDate',
        'generatedAt',
        'ordersByStatus',
        'queues',
        'today',
        'unpaidDeliveredCount',
        'usdRate',
      ].sort(),
    );
  });

  it('warehouse: its own orders and queues, and no money key at all', async () => {
    const s = await read(w.actors.warehouse);
    // Approved orders and later ([C] 2026-10-30), plus closed ones that had been approved; never
    // SUBMITTED or one refused before approval.
    expect(s.ordersByStatus).toEqual({
      SUBMITTED: 0,
      MANAGER_APPROVED: 1,
      ACCOUNTING_CLEARED: 2,
      RELEASED: 1,
      DELIVERED: 1,
      RECEIVED: 1,
      REJECTED: 0,
      CANCELLED: 1,
    });
    expect(queueCounts(s)).toEqual({ TO_PREPARE: 1, TO_RELEASE: 2, TO_DELIVER: 1, TO_RETURN: 1 });
    const body = await rawBody(w.actors.warehouse);
    expect(Object.keys(body).sort()).toEqual([
      'businessDate',
      'generatedAt',
      'ordersByStatus',
      'queues',
    ]);
    expect(JSON.stringify(body)).not.toMatch(MONEY_WORDS);
  });

  it('driver: only the assigned deliveries, and no money key at all', async () => {
    const s = await read(w.actors.driver);
    expect(s.ordersByStatus).toMatchObject({
      RELEASED: 1,
      DELIVERED: 1,
      RECEIVED: 1,
      SUBMITTED: 0,
    });
    expect(queueCounts(s)).toEqual({ TO_DELIVER: 1 });
    const body = await rawBody(w.actors.driver);
    expect(Object.keys(body).sort()).toEqual([
      'businessDate',
      'generatedAt',
      'ordersByStatus',
      'queues',
    ]);
    expect(JSON.stringify(body)).not.toMatch(MONEY_WORDS);

    // Another driver was assigned nothing, so sees nothing.
    const other = await read(w.actors.driver2);
    expect(Object.values(other.ordersByStatus).every((n) => n === 0)).toBe(true);
    expect(queueCounts(other)).toEqual({ TO_DELIVER: 0 });
  });

  it('no role receives cost, supplier or stock data (the rate is the one allowed rate field)', async () => {
    for (const role of ['manager', 'admin', 'accountant', 'warehouse', 'driver'] as const) {
      const { generatedAt, usdRate, ...rest } = await rawBody(w.actors[role]);
      void generatedAt;
      void usdRate;
      expect(findForbiddenKeys(rest), role).toEqual([]);
    }
  });

  it('a staff member with several roles gets the union of the sections', async () => {
    const both: Actor = { ...w.actors.warehouse, staffRoles: ['WAREHOUSE_MANAGER', 'ACCOUNTANT'] };
    const s = await read(both);
    expect(s.today).toBeDefined();
    expect(queueCounts(s)).toEqual({
      AWAITING_ACCOUNTING: 1,
      SKIPPED_ACCOUNTING_TO_REVIEW: 1,
      TO_PREPARE: 1,
      TO_RELEASE: 2,
      TO_DELIVER: 1,
      TO_RETURN: 1,
    });
  });

  it('"today" follows the Tashkent day: the last millisecond and the first of the next day', async () => {
    t.clock.set(new Date('2026-10-20T18:59:59.999Z'));
    const before = await read(w.actors.manager);
    expect(before.businessDate).toBe('2026-10-20');
    expect(before.today?.count).toBe(7);

    t.clock.set(new Date('2026-10-20T19:00:00.000Z'));
    const after = await read(w.actors.manager);
    expect(after.businessDate).toBe('2026-10-21');
    expect(after.today).toEqual({ count: 0, totalAmount: '0.00', currency: 'UZS' });
  });

  it('empty system: zeros, no sheet run and no rate yet are null, not missing', async () => {
    await t.prisma.sheetSyncRun.deleteMany();
    await t.prisma.appSetting.deleteMany();
    await resetOrders(t.prisma);
    const s = await read(w.actors.manager);
    expect(s.lastSheetSync).toBeNull();
    expect(s.usdRate).toBeNull();
    expect(s.today).toEqual({ count: 0, totalAmount: '0.00', currency: 'UZS' });
    expect(s.queues.every((q) => q.count === 0 && q.oldestAgeMinutes === null)).toBe(true);
  });
});
