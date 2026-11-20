import { ORDER_ROUTES, customerOrderSchema } from '@iorder/shared';
import {
  staffOrderCountsResponseSchema,
  staffOrderListResponseSchema,
  staffOrderSchema,
  type StaffOrder,
  STAFF_ORDER_ROUTES,
} from '@iorder/shared/staff-orders';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { findForbiddenKeys, stripStaffOrderUsd } from './support/forbidden-fields.js';
import { caller, expectError, expectParsed, type Reply } from './support/orders-http.js';
import {
  createWorld,
  fifoPlanOf,
  orderAt,
  submitOrder,
  type World,
} from './support/orders-world.js';
import { createTestApp, rejectedByResolver, type TestApp } from './support/test-app.js';

type RoleName = 'manager' | 'accountant' | 'warehouse' | 'driver' | 'admin';
const STAFF: readonly RoleName[] = ['manager', 'accountant', 'warehouse', 'driver', 'admin'];

describe('staff HTTP: list, read and every action (real PostgreSQL)', () => {
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

  const version = async (orderId: string): Promise<number> =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).rowVersion;
  const statusOf = async (orderId: string): Promise<string> =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  /** A staff action with the row version the person "saw" (the current one unless given). */
  const act = async (
    route: Parameters<typeof call>[0],
    actor: Actor,
    orderId: string,
    body: Record<string, unknown> = {},
    expectedRowVersion?: number,
  ): Promise<Reply> =>
    call(route, {
      actor,
      params: { id: orderId },
      body: {
        expectedRowVersion: expectedRowVersion ?? (await version(orderId)),
        // Approval needs a payment method ([C] 2026-10-24); tests not about it send CASH.
        ...(route === STAFF_ORDER_ROUTES.approveOrder
          ? {
              paymentMethod: 'CASH',
              ...(await fifoPlanOf(w.orders, w.actors.manager, orderId)),
            }
          : {}),
        ...body,
      },
    });

  describe('audience and the role matrix', () => {
    const routes = [
      STAFF_ORDER_ROUTES.listOrders,
      STAFF_ORDER_ROUTES.getOrder,
      STAFF_ORDER_ROUTES.getOrderTimeline,
      STAFF_ORDER_ROUTES.approveOrder,
      STAFF_ORDER_ROUTES.rejectOrder,
      STAFF_ORDER_ROUTES.cancelOrder,
      STAFF_ORDER_ROUTES.accountingApproveOrder,
      STAFF_ORDER_ROUTES.accountingRejectOrder,
      STAFF_ORDER_ROUTES.releaseOrder,
      STAFF_ORDER_ROUTES.deliverOrder,
      STAFF_ORDER_ROUTES.editOrderItems,
    ];

    it.each(routes.map((r) => [`${r.method} ${r.path}`, r] as const))(
      '%s: 401 without an actor, 403 for customers (members of an organization)',
      async (_name, route) => {
        const options = {
          params: { id: randomUUID() },
          ...(route.method === 'GET' ? {} : { body: { expectedRowVersion: 1 } }),
        };
        expect((await call(route, options)).status).toBe(401);
        for (const actor of [w.actors.ownerA, w.actors.sellerA]) {
          expectError(await call(route, { ...options, actor }), 403, 'FORBIDDEN');
        }
      },
    );

    it.each(routes.map((r) => [`${r.method} ${r.path}`, r] as const))(
      '%s: 401 for a blocked staff member (the resolver turns them away)',
      async (_name, route) => {
        await t.prisma.user.update({ where: { id: w.ids.manager }, data: { status: 'BLOCKED' } });
        const reply = await call(route, {
          actor: rejectedByResolver(w.actors.manager, 'BLOCKED'),
          params: { id: randomUUID() },
          ...(route.method === 'GET' ? {} : { body: { expectedRowVersion: 1 } }),
        });
        expectError(reply, 401, 'UNAUTHENTICATED');
      },
    );

    it('staff with a stray organization membership work as staff on staff routes', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const stray: Actor = { ...w.actors.manager, membership: w.actors.sellerA.membership };
      expect(stray.membership).toBeDefined();
      const list = await call(STAFF_ORDER_ROUTES.listOrders, { actor: stray });
      expect(expectParsed(list, 200, staffOrderListResponseSchema).orders).toHaveLength(1);
      const got = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, { actor: stray, params: { id: order.id } }),
        200,
        staffOrderSchema,
      );
      expect(got.detail).toBe('FULL');
    });

    // Which staff roles pass the coarse gate of each action. Everyone else: 403 before the
    // order is even looked at.
    const gates: [(typeof routes)[number], RoleName[]][] = [
      [STAFF_ORDER_ROUTES.approveOrder, ['manager']],
      [STAFF_ORDER_ROUTES.rejectOrder, ['manager']],
      [STAFF_ORDER_ROUTES.cancelOrder, ['manager']],
      [STAFF_ORDER_ROUTES.accountingApproveOrder, ['accountant']],
      [STAFF_ORDER_ROUTES.accountingRejectOrder, ['accountant']],
      [STAFF_ORDER_ROUTES.releaseOrder, ['warehouse']],
      [STAFF_ORDER_ROUTES.deliverOrder, ['driver']],
      [STAFF_ORDER_ROUTES.editOrderItems, ['manager']],
    ];

    it.each(gates.map(([r, allowed]) => [`${r.method} ${r.path}`, r, allowed] as const))(
      '%s is closed to every other staff role',
      async (_name, route, allowed) => {
        const order = await orderAt(w, 'SUBMITTED');
        for (const role of STAFF.filter((r) => !allowed.includes(r))) {
          const reply = await call(route, {
            actor: w.actors[role],
            params: { id: order.id },
            body: { expectedRowVersion: order.rowVersion },
          });
          expect([role, reply.status], JSON.stringify(reply.body)).toEqual([role, 403]);
        }
        expect(await statusOf(order.id)).toBe('SUBMITTED');
      },
    );
  });

  describe('reading', () => {
    it('manager, accountant and admin get the FULL shape; warehouse and driver the FULFILMENT shape', async () => {
      const order = await orderAt(w, 'RELEASED');
      for (const role of ['manager', 'accountant', 'admin'] as const) {
        const got = expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrder, {
            actor: w.actors[role],
            params: { id: order.id },
          }),
          200,
          staffOrderSchema,
        );
        expect(got.detail).toBe('FULL');
      }
      for (const role of ['warehouse', 'driver'] as const) {
        const got = expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrder, {
            actor: w.actors[role],
            params: { id: order.id },
          }),
          200,
          staffOrderSchema,
        );
        expect(got.detail).toBe('FULFILMENT');
        // The type is for every role; the label (a price tier) only for the roles that see money.
        expect(got.organizationType).toBe('GROUP');
        // Strict parse already refuses extras; say it in words as well.
        const keys = Object.keys(got);
        for (const hidden of [
          'organizationLabel',
          'accounting',
          'priceListVersionId',
          'totalAmount',
          'paymentStatus',
          'placedBy',
        ]) {
          expect(keys).not.toContain(hidden);
        }
        for (const item of got.items) {
          expect(Object.keys(item).sort()).toEqual(
            [
              'id',
              'name',
              'productCode',
              'productId',
              'quantity',
              'unit',
              // A staff-added product without a sheet code is outside the plan ([C] 2026-11-09).
              'stockTracked',
              // Supply and party for the warehouse; the driver's lines do not have the field.
              ...(role === 'warehouse' ? ['allocations'] : []),
            ].sort(),
          );
        }
      }
    });

    it('the FULL view shows how the order was cleared, the placer, the driver and the price list version', async () => {
      const order = await orderAt(w, 'RELEASED');
      const got = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.manager,
          params: { id: order.id },
        }),
        200,
        staffOrderSchema,
      );
      if (got.detail !== 'FULL') throw new Error('expected the FULL shape');
      expect(got).toMatchObject({
        organizationId: w.orgA,
        organizationName: 'Alpha shop',
        organizationType: 'GROUP',
        organizationLabel: 'STANDARD',
        status: 'RELEASED',
        totalAmount: '3750.50',
        placedBy: { userId: w.ids.sellerA, fullName: 'Seller A' },
        driver: { userId: w.ids.driver, fullName: 'Driver' },
        priceListVersionId: w.versionId,
        accounting: { mode: 'APPROVED', reviewedAt: null },
      });
      expect(got.accounting.clearedAt).not.toBeNull();
    });

    it('404 (never 403) for an order the role may not see, 404 for an unknown id, 422 for a bad id', async () => {
      const early = await orderAt(w, 'SUBMITTED');
      const unassigned = await orderAt(w, 'RELEASED'); // assigned to w.ids.driver
      const rejected = await orderAt(w, 'REJECTED');
      const cancelledEarly = await orderAt(w, 'CANCELLED');
      for (const id of [early.id, rejected.id, cancelledEarly.id]) {
        for (const role of ['warehouse', 'driver'] as const) {
          expectError(
            await call(STAFF_ORDER_ROUTES.getOrder, { actor: w.actors[role], params: { id } }),
            404,
            'NOT_FOUND',
          );
          expectError(
            await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
              actor: w.actors[role],
              params: { id },
            }),
            404,
            'NOT_FOUND',
          );
        }
      }
      // Another driver is not assigned to this order.
      expectError(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.driver2,
          params: { id: unassigned.id },
        }),
        404,
        'NOT_FOUND',
      );
      expectError(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.manager,
          params: { id: randomUUID() },
        }),
        404,
        'NOT_FOUND',
      );
      expectError(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.manager,
          params: { id: 'nope' },
        }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('acting on an order the role may not see is 404 as well, and changes nothing', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      expectError(
        await act(STAFF_ORDER_ROUTES.releaseOrder, w.actors.warehouse, order.id, {
          driverUserId: w.ids.driver,
        }),
        404,
        'NOT_FOUND',
      );
      expect(await statusOf(order.id)).toBe('SUBMITTED');
    });

    it('lists with filters, search by order number, paging and the role scope', async () => {
      const submitted = await orderAt(w, 'SUBMITTED');
      const approved = await orderAt(w, 'MANAGER_APPROVED');
      const cleared = await orderAt(w, 'ACCOUNTING_CLEARED');
      const delivered = await orderAt(w, 'DELIVERED');
      const b = await submitOrder(w, w.actors.sellerB);

      const ids = (reply: Reply): string[] =>
        expectParsed(reply, 200, staffOrderListResponseSchema).orders.map((o) => o.id);
      const list = (actor: Actor, query: Record<string, unknown> = {}): Promise<Reply> =>
        call(STAFF_ORDER_ROUTES.listOrders, { actor, query });

      // The manager sees all five.
      expect(ids(await list(w.actors.manager, { limit: 100 })).sort()).toEqual(
        [submitted, approved, cleared, delivered, b].map((o) => o.id).sort(),
      );
      // Filters.
      expect(ids(await list(w.actors.manager, { status: 'SUBMITTED' })).sort()).toEqual(
        [submitted.id, b.id].sort(),
      );
      // Nothing is received or paid yet ([C] 2026-10-26: PAID follows the organization's payments;
      // the PAID filter itself is covered in orders-reads).
      expect(ids(await list(w.actors.accountant, { paymentStatus: 'PAID' }))).toEqual([]);
      expect(ids(await list(w.actors.admin, { organizationId: w.orgB }))).toEqual([b.id]);
      // The payment plan filter splits the list in two (each order has exactly one plan).
      const byPlan = async (plan: string): Promise<string[]> =>
        ids(await list(w.actors.manager, { paymentPlan: plan, limit: 100 }));
      const full = await byPlan('FULL');
      const deferred = await byPlan('DEFERRED');
      expect(full.filter((id) => deferred.includes(id))).toEqual([]);
      expect([...full, ...deferred].sort()).toEqual(
        [submitted, approved, cleared, delivered, b].map((o) => o.id).sort(),
      );
      // Search by order number: part of it, any case; a LIKE wildcard is matched literally.
      expect(
        ids(await list(w.actors.manager, { search: approved.orderNumber.toLowerCase() })),
      ).toEqual([approved.id]);
      expect(ids(await list(w.actors.manager, { search: approved.orderNumber.slice(3) }))).toEqual([
        approved.id,
      ]);
      expect(ids(await list(w.actors.manager, { search: '%' }))).toEqual([]);
      expect(ids(await list(w.actors.manager, { search: 'IO-' })).length).toBe(5);
      // The warehouse sees what the manager approved; the driver only what is assigned to them.
      expect(ids(await list(w.actors.warehouse)).sort()).toEqual(
        [approved.id, cleared.id, delivered.id].sort(),
      );
      expect(ids(await list(w.actors.driver))).toEqual([delivered.id]);
      expect(ids(await list(w.actors.driver2))).toEqual([]);
      // Paging.
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = expectParsed(
          await list(w.actors.manager, { limit: 2, ...(cursor ? { cursor } : {}) }),
          200,
          staffOrderListResponseSchema,
        );
        seen.push(...page.orders.map((o) => o.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual([b, delivered, cleared, approved, submitted].map((o) => o.id));
      // Bad queries.
      for (const query of [
        { status: 'X' },
        { limit: 101 },
        { organizationId: 'x' },
        { search: '' },
      ]) {
        expectError(await list(w.actors.manager, query), 422, 'VALIDATION_FAILED');
      }
    });

    it('lists by several statuses, by the business day and by organization or person name', async () => {
      const submitted = await orderAt(w, 'SUBMITTED');
      const cleared = await orderAt(w, 'ACCOUNTING_CLEARED');
      const rejected = await orderAt(w, 'REJECTED');
      const cancelled = await orderAt(w, 'CANCELLED');
      const b = await submitOrder(w, w.actors.sellerB);

      const ids = (reply: Reply): string[] =>
        expectParsed(reply, 200, staffOrderListResponseSchema)
          .orders.map((o) => o.id)
          .sort();
      const sorted = (...orders: { id: string }[]): string[] => orders.map((o) => o.id).sort();
      const list = (actor: Actor, query: Record<string, unknown> = {}): Promise<Reply> =>
        call(STAFF_ORDER_ROUTES.listOrders, { actor, query });
      const manager = w.actors.manager;

      // Several statuses (the closed tab); one `status` wins over them.
      expect(ids(await list(manager, { statuses: 'REJECTED,CANCELLED' }))).toEqual(
        sorted(rejected, cancelled),
      );
      expect(
        ids(await list(manager, { statuses: 'REJECTED,CANCELLED', status: 'SUBMITTED' })),
      ).toEqual(sorted(submitted, b));
      // The scope still applies: the warehouse asking for SUBMITTED gets nothing.
      expect(
        ids(await list(w.actors.warehouse, { statuses: 'SUBMITTED,ACCOUNTING_CLEARED' })),
      ).toEqual(sorted(cleared));

      // Organization name for every staff role, any letter case.
      expect(ids(await list(manager, { search: 'BETA' }))).toEqual(sorted(b));
      expect(ids(await list(w.actors.warehouse, { search: 'alpha' }))).toEqual(sorted(cleared));
      // The placer's name only for the roles that see it.
      expect(ids(await list(w.actors.accountant, { search: 'seller b' }))).toEqual(sorted(b));
      expect(ids(await list(w.actors.warehouse, { search: 'Seller A' }))).toEqual([]);
      // A LIKE wildcard in a name search is matched literally.
      expect(ids(await list(manager, { search: '_' }))).toEqual([]);

      // Today is the Asia/Tashkent day: 2026-10-20 ends at 19:00 UTC.
      expect(ids(await list(manager, { period: 'TODAY' }))).toHaveLength(5);
      t.clock.set(new Date('2026-10-20T19:00:00Z'));
      expect(ids(await list(manager, { period: 'TODAY' }))).toEqual([]);
      const tomorrow = await submitOrder(w, w.actors.sellerB);
      expect(ids(await list(manager, { period: 'TODAY', search: 'beta' }))).toEqual(
        sorted(tomorrow),
      );

      // The payment status is FULL-view only: filtering by it is refused to the others.
      for (const role of ['warehouse', 'driver'] as const) {
        expectError(await list(w.actors[role], { paymentStatus: 'UNPAID' }), 403, 'FORBIDDEN');
        expectError(await list(w.actors[role], { paymentPlan: 'FULL' }), 403, 'FORBIDDEN');
      }
      for (const query of [
        { statuses: 'X' },
        { statuses: 'SUBMITTED,' },
        { period: 'YESTERDAY' },
        { paymentPlan: 'LATER' },
      ]) {
        expectError(await list(manager, query), 422, 'VALIDATION_FAILED');
      }
    });

    it('counts per status over the same filters and the same role scope', async () => {
      await orderAt(w, 'SUBMITTED');
      await orderAt(w, 'ACCOUNTING_CLEARED');
      await orderAt(w, 'DELIVERED');
      await orderAt(w, 'CANCELLED');
      await submitOrder(w, w.actors.sellerB);

      const counts = async (actor: Actor, query: Record<string, unknown> = {}) =>
        expectParsed(
          await call(STAFF_ORDER_ROUTES.countOrders, { actor, query }),
          200,
          staffOrderCountsResponseSchema,
        ).byStatus;
      // Every test order is 3750.50 (2 x p1 + 1 x p2).
      const money = (count: number) => ({
        count,
        totalAmount: (3750.5 * count).toFixed(2),
        // 0.312542 USD an order, at its rate from submit; whole so'm at the current rate of 12000.
        totalUsd: { 1: '0.31', 2: '0.63' }[count],
        totalUzsEquivalent: { 1: '3751.00', 2: '7501.00' }[count],
      });

      const all = {
        SUBMITTED: money(2),
        ACCOUNTING_CLEARED: money(1),
        DELIVERED: money(1),
        CANCELLED: money(1),
      };
      expect(await counts(w.actors.manager)).toEqual(all);
      expect(await counts(w.actors.manager, { paymentStatus: 'UNPAID' })).toEqual(all);
      expect(await counts(w.actors.manager, { organizationId: w.orgB })).toEqual({
        SUBMITTED: money(1),
      });
      expect(await counts(w.actors.accountant, { search: 'seller b' })).toEqual({
        SUBMITTED: money(1),
      });
      // The warehouse and the driver get counts only, no money.
      expect(await counts(w.actors.warehouse)).toEqual({
        ACCOUNTING_CLEARED: { count: 1 },
        DELIVERED: { count: 1 },
      });
      expect(await counts(w.actors.driver)).toEqual({ DELIVERED: { count: 1 } });
      expect(await counts(w.actors.driver2)).toEqual({});

      // The payment plan narrows the counts like the list: the two plans add up to all of them,
      // and the filter is refused to the roles that never see the plan.
      const planCounts = async (plan: string): Promise<Record<string, number>> =>
        Object.fromEntries(
          Object.entries(await counts(w.actors.manager, { paymentPlan: plan })).map(
            ([status, value]) => [status, value.count],
          ),
        );
      const fullCounts = await planCounts('FULL');
      const deferredCounts = await planCounts('DEFERRED');
      for (const [status, value] of Object.entries(all)) {
        expect((fullCounts[status] ?? 0) + (deferredCounts[status] ?? 0)).toBe(value.count);
      }
      for (const role of ['warehouse', 'driver'] as const) {
        expectError(
          await call(STAFF_ORDER_ROUTES.countOrders, {
            actor: w.actors[role],
            query: { paymentPlan: 'FULL' },
          }),
          403,
          'FORBIDDEN',
        );
      }

      // A status set narrows the counts; grouped, the same per organization.
      const grouped = expectParsed(
        await call(STAFF_ORDER_ROUTES.countOrders, {
          actor: w.actors.manager,
          query: { statuses: 'SUBMITTED,DELIVERED', groupBy: 'ORGANIZATION' },
        }),
        200,
        staffOrderCountsResponseSchema,
      );
      expect(grouped.byStatus).toEqual({ SUBMITTED: money(2), DELIVERED: money(1) });
      expect(grouped.byOrganization).toEqual({ [w.orgA]: money(2), [w.orgB]: money(1) });
      const warehouseGrouped = expectParsed(
        await call(STAFF_ORDER_ROUTES.countOrders, {
          actor: w.actors.warehouse,
          query: { groupBy: 'ORGANIZATION' },
        }),
        200,
        staffOrderCountsResponseSchema,
      );
      expect(warehouseGrouped.byOrganization).toEqual({ [w.orgA]: { count: 2 } });
      // Without grouping there is no per-organization key at all.
      expect(
        Object.keys(
          expectParsed(
            await call(STAFF_ORDER_ROUTES.countOrders, { actor: w.actors.manager }),
            200,
            staffOrderCountsResponseSchema,
          ),
        ),
      ).toEqual(['byStatus']);

      // Who placed an order is a FULL-view filter.
      expect(await counts(w.actors.accountant, { placedByUserId: w.ids.sellerB })).toEqual({
        SUBMITTED: money(1),
      });
      expectError(
        await call(STAFF_ORDER_ROUTES.listOrders, {
          actor: w.actors.warehouse,
          query: { placedByUserId: w.ids.sellerA },
        }),
        403,
        'FORBIDDEN',
      );

      expect((await call(STAFF_ORDER_ROUTES.countOrders, {})).status).toBe(401);
      expectError(
        await call(STAFF_ORDER_ROUTES.countOrders, { actor: w.actors.ownerA }),
        403,
        'FORBIDDEN',
      );
      expectError(
        await call(STAFF_ORDER_ROUTES.countOrders, {
          actor: w.actors.warehouse,
          query: { paymentStatus: 'PAID' },
        }),
        403,
        'FORBIDDEN',
      );
      // Status and paging belong to the list, not to the counts.
      for (const query of [
        { status: 'SUBMITTED' },
        { cursor: randomUUID() },
        { limit: 5 },
        { groupBy: 'PERSON' },
      ]) {
        expectError(
          await call(STAFF_ORDER_ROUTES.countOrders, { actor: w.actors.manager, query }),
          422,
          'VALIDATION_FAILED',
        );
      }
    });

    it('no cost-like key in any staff order response', async () => {
      const order = await orderAt(w, 'RELEASED');
      for (const role of STAFF) {
        const reply = await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors[role],
          params: { id: order.id },
        });
        if (reply.status !== 200) continue;
        // Manager, accountant and admin get the order's USD facts; the fulfilment roles get none.
        const fulfilment = role === 'warehouse' || role === 'driver';
        expect(findForbiddenKeys(fulfilment ? reply.body : stripStaffOrderUsd(reply.body))).toEqual(
          [],
        );
      }
    });
  });

  describe('delivery contact', () => {
    beforeEach(async () => {
      await t.prisma.user.update({
        where: { id: w.ids.sellerA },
        data: { phone: '+998901112233' },
      });
      await t.prisma.user.update({ where: { id: w.ids.ownerA }, data: { phone: '+998904445566' } });
    });

    it('warehouse, driver, manager and admin get the organization and the member contacts; the accountant does not', async () => {
      const order = await orderAt(w, 'RELEASED');
      const contactOf = async (role: RoleName): Promise<StaffOrder['deliveryContact']> =>
        expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrder, {
            actor: w.actors[role],
            params: { id: order.id },
          }),
          200,
          staffOrderSchema,
        ).deliveryContact;

      for (const role of ['warehouse', 'driver', 'manager', 'admin'] as const) {
        expect(await contactOf(role), role).toEqual({
          organizationName: 'Alpha shop',
          contacts: [
            {
              userId: expect.any(String),
              fullName: 'Seller A',
              phone: '+998901112233',
              placedTheOrder: true,
              isShopOwner: false,
            },
            {
              userId: expect.any(String),
              fullName: 'Owner A',
              phone: '+998904445566',
              placedTheOrder: false,
              isShopOwner: true,
            },
          ],
        });
      }
      expect(await contactOf('accountant')).toBeNull();
    });

    it('is one entry when the shop owner placed the order, and absent from list rows', async () => {
      const order = await orderAt(w, 'ACCOUNTING_CLEARED', { placedBy: w.actors.ownerA });
      const got = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.warehouse,
          params: { id: order.id },
        }),
        200,
        staffOrderSchema,
      );
      expect(got.deliveryContact?.contacts).toEqual([
        {
          userId: expect.any(String),
          fullName: 'Owner A',
          phone: '+998904445566',
          placedTheOrder: true,
          isShopOwner: true,
        },
      ]);
      const list = await call(STAFF_ORDER_ROUTES.listOrders, { actor: w.actors.warehouse });
      expect(JSON.stringify(list.body)).not.toContain('+99890');
    });
  });

  describe('actions: 200 paths through the whole lifecycle', () => {
    it('approve, accounting-approve, release, deliver by their own roles, then the customer confirms', async () => {
      const order = await orderAt(w, 'SUBMITTED');

      const approved = expectParsed(
        await act(STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, order.id, {
          comment: 'called',
        }),
        200,
        staffOrderSchema,
      );
      expect(approved).toMatchObject({ status: 'MANAGER_APPROVED', rowVersion: 2 });

      const cleared = expectParsed(
        await act(STAFF_ORDER_ROUTES.accountingApproveOrder, w.actors.accountant, order.id, {
          comment: 'paid in cash',
        }),
        200,
        staffOrderSchema,
      );
      expect(cleared).toMatchObject({
        status: 'ACCOUNTING_CLEARED',
        accounting: { mode: 'APPROVED' },
      });

      const released = expectParsed(
        await act(STAFF_ORDER_ROUTES.releaseOrder, w.actors.warehouse, order.id, {
          driverUserId: w.ids.driver,
        }),
        200,
        staffOrderSchema,
      );
      expect(released).toMatchObject({
        detail: 'FULFILMENT',
        status: 'RELEASED',
        driver: { userId: w.ids.driver },
      });

      const delivered = expectParsed(
        await act(STAFF_ORDER_ROUTES.deliverOrder, w.actors.driver, order.id, {
          comment: 'left at door',
        }),
        200,
        staffOrderSchema,
      );
      expect(delivered.status).toBe('DELIVERED');

      expectParsed(
        await call(ORDER_ROUTES.receiveOrder, { actor: w.actors.ownerA, params: { id: order.id } }),
        200,
        customerOrderSchema,
      );
      const events = await t.prisma.orderEvent.findMany({
        where: { orderId: order.id },
        orderBy: { seq: 'asc' },
      });
      expect(events.map((e) => [e.actorRole, e.fromStatus, e.toStatus, e.comment])).toEqual([
        ['SELLER', null, 'SUBMITTED', null],
        ['MANAGER', 'SUBMITTED', 'MANAGER_APPROVED', 'called'],
        ['ACCOUNTANT', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'paid in cash'],
        ['WAREHOUSE_MANAGER', 'ACCOUNTING_CLEARED', 'RELEASED', null],
        ['DRIVER', 'RELEASED', 'DELIVERED', 'left at door'],
        ['SHOP_OWNER', 'DELIVERED', 'RECEIVED', null],
      ]);
    });

    it('skip accounting through HTTP: two events, the warehouse sees the order at once', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      // Before the approval the warehouse cannot see it.
      expectError(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.warehouse,
          params: { id: order.id },
        }),
        404,
        'NOT_FOUND',
      );
      const approved = expectParsed(
        await act(STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, order.id, {
          skipAccounting: true,
          comment: 'regular customer',
        }),
        200,
        staffOrderSchema,
      );
      if (approved.detail !== 'FULL') throw new Error('expected the FULL shape');
      expect(approved).toMatchObject({
        status: 'ACCOUNTING_CLEARED',
        accounting: { mode: 'SKIPPED_BY_MANAGER' },
      });
      expect(approved.accounting.clearedAt).not.toBeNull();

      const events = await t.prisma.orderEvent.findMany({
        where: { orderId: order.id, eventType: { not: 'SUBMITTED' } },
        orderBy: { seq: 'asc' },
      });
      expect(
        events.map((e) => [e.eventType, e.fromStatus, e.toStatus, e.actorRole, e.comment]),
      ).toEqual([
        ['STATUS_CHANGED', 'SUBMITTED', 'MANAGER_APPROVED', 'MANAGER', 'regular customer'],
        ['ACCOUNTING_SKIPPED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'MANAGER', null],
      ]);

      const seen = expectParsed(
        await call(STAFF_ORDER_ROUTES.getOrder, {
          actor: w.actors.warehouse,
          params: { id: order.id },
        }),
        200,
        staffOrderSchema,
      );
      expect(seen).toMatchObject({ detail: 'FULFILMENT', status: 'ACCOUNTING_CLEARED' });
      const list = expectParsed(
        await call(STAFF_ORDER_ROUTES.listOrders, { actor: w.actors.warehouse }),
        200,
        staffOrderListResponseSchema,
      );
      expect(list.orders.map((o) => o.id)).toEqual([order.id]);
      // The accountant still sees it as an order that went through.
      expect(
        expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrder, {
            actor: w.actors.accountant,
            params: { id: order.id },
          }),
          200,
          staffOrderSchema,
        ).status,
      ).toBe('ACCOUNTING_CLEARED');
    });

    it('only the manager can skip accounting', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      for (const role of ['accountant', 'admin', 'warehouse'] as const) {
        const reply = await act(STAFF_ORDER_ROUTES.approveOrder, w.actors[role], order.id, {
          skipAccounting: true,
        });
        expectError(reply, 403, 'FORBIDDEN');
      }
      expect(await statusOf(order.id)).toBe('SUBMITTED');
    });

    it('reject (manager), accounting-reject (accountant) and cancel (manager) carry the reason as written', async () => {
      const rejected = await orderAt(w, 'SUBMITTED');
      const reply = await act(STAFF_ORDER_ROUTES.rejectOrder, w.actors.manager, rejected.id, {
        reason: '  Out of stock, sorry  ',
      });
      expect(expectParsed(reply, 200, staffOrderSchema).status).toBe('REJECTED');

      const byAccountant = await orderAt(w, 'MANAGER_APPROVED');
      expect(
        expectParsed(
          await act(
            STAFF_ORDER_ROUTES.accountingRejectOrder,
            w.actors.accountant,
            byAccountant.id,
            {
              reason: 'credit limit',
            },
          ),
          200,
          staffOrderSchema,
        ).status,
      ).toBe('REJECTED');

      for (const [actor, status] of [
        [w.actors.manager, 'SUBMITTED'],
        [w.actors.manager, 'MANAGER_APPROVED'],
        [w.actors.manager, 'ACCOUNTING_CLEARED'],
      ] as const) {
        const order = await orderAt(w, status);
        const cancelled = expectParsed(
          await act(STAFF_ORDER_ROUTES.cancelOrder, actor, order.id, { reason: 'customer asked' }),
          200,
          staffOrderSchema,
        );
        expect(cancelled.status).toBe('CANCELLED');
      }
      const comments = await t.prisma.orderEvent.findMany({
        where: { toStatus: 'REJECTED' },
        orderBy: { seq: 'asc' },
      });
      expect(comments.map((e) => e.comment)).toEqual(['Out of stock, sorry', 'credit limit']);
    });

    it('admin, accountant, warehouse and driver cannot cancel: 403, nothing changes (owner rule 2026-10-22)', async () => {
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      for (const actor of [
        w.actors.admin,
        w.actors.accountant,
        w.actors.warehouse,
        w.actors.driver,
      ]) {
        expectError(
          await act(STAFF_ORDER_ROUTES.cancelOrder, actor, order.id, { reason: 'x' }),
          403,
          'FORBIDDEN',
        );
      }
      expect(await statusOf(order.id)).toBe('ACCOUNTING_CLEARED');
      expect(
        await t.prisma.orderEvent.count({ where: { orderId: order.id, toStatus: 'CANCELLED' } }),
      ).toBe(0);
    });

    it('the manager cancel needs a reason (422) and writes the event and the placer notification', async () => {
      const order = await orderAt(w, 'SUBMITTED', { placedBy: w.actors.sellerA });
      for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
        expectError(
          await act(STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, order.id, body),
          422,
          'VALIDATION_FAILED',
        );
      }
      expect(await statusOf(order.id)).toBe('SUBMITTED');
      expectParsed(
        await act(STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, order.id, {
          reason: ' Out of stock ',
        }),
        200,
        staffOrderSchema,
      );
      const event = await t.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, toStatus: 'CANCELLED' },
      });
      expect([event.actorRole, event.comment]).toEqual(['MANAGER', 'Out of stock']);
      const rows = await t.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, type: 'ORDER_CANCELLED' },
      });
      expect(rows.some((r) => r.recipientUserId === w.ids.sellerA)).toBe(true);
      expect(rows.some((r) => r.recipientKind === 'ORGANIZATION_CHAT')).toBe(true);
    });

    it('two parallel manager cancels produce exactly one transition', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const replies = await Promise.all([
        act(STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, order.id, { reason: 'a' }),
        act(STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, order.id, { reason: 'b' }),
      ]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await t.prisma.orderEvent.count({ where: { orderId: order.id, toStatus: 'CANCELLED' } }),
      ).toBe(1);
      expect(
        await t.prisma.notificationOutbox.count({
          where: { orderId: order.id, type: 'ORDER_CANCELLED', recipientKind: 'ORGANIZATION_CHAT' },
        }),
      ).toBe(1);
    });

    it('the manager edits quantities and removes a line while SUBMITTED', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const full = await w.orders.getOrderFor(w.actors.manager, order.id);
      const [first, second] = full.items;
      if (!first || !second) throw new Error('expected two lines');

      const edited = expectParsed(
        await call(STAFF_ORDER_ROUTES.editOrderItems, {
          actor: w.actors.manager,
          params: { id: order.id },
          body: {
            changes: [
              { itemId: first.id, quantity: '1' },
              { itemId: second.id, quantity: null },
            ],
            reason: 'only one in stock',
            expectedRowVersion: order.rowVersion,
          },
        }),
        200,
        staffOrderSchema,
      );
      if (edited.detail !== 'FULL') throw new Error('expected the FULL shape');
      expect(edited).toMatchObject({ totalAmount: '1500.00', itemCount: 1, rowVersion: 2 });
      expect(edited.items.map((i) => [i.productCode, i.quantity, i.lineTotal])).toEqual([
        ['P-1', '1.000', '1500.00'],
      ]);
      const event = await t.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, eventType: 'ITEMS_EDITED' },
      });
      expect(event).toMatchObject({ actorRole: 'MANAGER', comment: 'only one in stock' });
    });
  });

  describe('actions: 422', () => {
    it('every action needs expectedRowVersion', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const noVersion: [Parameters<typeof call>[0], Actor, Record<string, unknown>][] = [
        [STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, {}],
        [STAFF_ORDER_ROUTES.rejectOrder, w.actors.manager, { reason: 'no' }],
        [STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, { reason: 'no' }],
        [STAFF_ORDER_ROUTES.accountingApproveOrder, w.actors.accountant, {}],
        [STAFF_ORDER_ROUTES.accountingRejectOrder, w.actors.accountant, { reason: 'no' }],
        [STAFF_ORDER_ROUTES.releaseOrder, w.actors.warehouse, { driverUserId: w.ids.driver }],
        [STAFF_ORDER_ROUTES.deliverOrder, w.actors.driver, {}],
        [
          STAFF_ORDER_ROUTES.editOrderItems,
          w.actors.manager,
          { changes: [{ itemId: randomUUID(), quantity: '1' }] },
        ],
      ];
      for (const [route, actor, body] of noVersion) {
        const reply = await call(route, { actor, params: { id: order.id }, body });
        expect([route.path, reply.status]).toEqual([route.path, 422]);
        expect(JSON.stringify(reply.body)).toContain('expectedRowVersion');
      }
      expect(await statusOf(order.id)).toBe('SUBMITTED');
    });

    it('rejects blank reasons, unknown fields, bad versions and bad release input', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const bad: [Parameters<typeof call>[0], Actor, Record<string, unknown>][] = [
        [STAFF_ORDER_ROUTES.rejectOrder, w.actors.manager, { reason: '   ' }],
        [STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, {}],
        [STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, { skipAccounting: 'yes' }],
        [STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, { status: 'RELEASED' }],
        [STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, { expectedRowVersion: 0 }],
        [STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, { expectedRowVersion: '1' }],
        [STAFF_ORDER_ROUTES.releaseOrder, w.actors.warehouse, { driverUserId: 'x' }],
        [STAFF_ORDER_ROUTES.releaseOrder, w.actors.warehouse, {}],
        [STAFF_ORDER_ROUTES.editOrderItems, w.actors.manager, { changes: [] }],
        [
          STAFF_ORDER_ROUTES.editOrderItems,
          w.actors.manager,
          { changes: [{ itemId: 'x', quantity: '1' }] },
        ],
        [
          STAFF_ORDER_ROUTES.editOrderItems,
          w.actors.manager,
          { changes: [{ itemId: randomUUID(), quantity: 2 }] },
        ],
      ];
      for (const [route, actor, body] of bad) {
        const sent = 'expectedRowVersion' in body ? body : { expectedRowVersion: 1, ...body };
        const reply = await call(route, { actor, params: { id: order.id }, body: sent });
        expect([route.path, JSON.stringify(body), reply.status]).toEqual([
          route.path,
          JSON.stringify(body),
          422,
        ]);
        expect((reply.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('the driver must be an active user with the driver role; an unknown line is a 422', async () => {
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      for (const driverUserId of [w.ids.manager, w.ids.sellerA, randomUUID()]) {
        expectError(
          await act(STAFF_ORDER_ROUTES.releaseOrder, w.actors.warehouse, order.id, {
            driverUserId,
          }),
          422,
          'VALIDATION_FAILED',
        );
      }
      const submitted = await orderAt(w, 'SUBMITTED');
      expectError(
        await act(STAFF_ORDER_ROUTES.editOrderItems, w.actors.manager, submitted.id, {
          changes: [{ itemId: randomUUID(), quantity: '1' }],
        }),
        422,
        'VALIDATION_FAILED',
      );
      // Removing every line is refused: reject or cancel instead.
      const full = await w.orders.getOrderFor(w.actors.manager, submitted.id);
      expectError(
        await act(STAFF_ORDER_ROUTES.editOrderItems, w.actors.manager, submitted.id, {
          changes: full.items.map((item) => ({ itemId: item.id, quantity: null })),
        }),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('actions: 409', () => {
    it('a stale expectedRowVersion is ORDER_CHANGED, for every action, and nothing changes', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      await w.orders.editItems(w.actors.manager, order.id, {
        changes: [
          {
            itemId: (await w.orders.getOrderFor(w.actors.manager, order.id)).items[0]!.id,
            quantity: '3',
          },
        ],
        expectedRowVersion: order.rowVersion,
      });
      const stale = order.rowVersion;
      for (const [route, actor, body] of [
        [STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, {}],
        [STAFF_ORDER_ROUTES.rejectOrder, w.actors.manager, { reason: 'no' }],
        [STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, { reason: 'no' }],
        [
          STAFF_ORDER_ROUTES.editOrderItems,
          w.actors.manager,
          { changes: [{ itemId: randomUUID(), quantity: '1' }] },
        ],
      ] as const) {
        const error = expectError(
          await act(route, actor, order.id, body, stale),
          409,
          'CONFLICT',
          'ORDER_CHANGED',
        );
        expect(error.details).toEqual({ currentStatus: 'SUBMITTED' });
      }
      expect(await statusOf(order.id)).toBe('SUBMITTED');
    });

    it('two managers approving at once: one 200, one 409 ORDER_CHANGED, one transition recorded', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      const plan = await fifoPlanOf(w.orders, w.actors.manager, order.id);
      const replies = await Promise.all(
        [w.actors.manager, w.actors.manager2].map((actor) =>
          call(STAFF_ORDER_ROUTES.approveOrder, {
            actor,
            params: { id: order.id },
            body: {
              expectedRowVersion: order.rowVersion,
              paymentMethod: 'CASH',
              ...plan,
            },
          }),
        ),
      );
      expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = replies.find((r) => r.status === 409);
      expectError(loser!, 409, 'CONFLICT', 'ORDER_CHANGED');
      expect(
        await t.prisma.orderEvent.count({
          where: { orderId: order.id, toStatus: 'MANAGER_APPROVED' },
        }),
      ).toBe(1);
      expect(
        await t.prisma.notificationOutbox.count({
          where: { orderId: order.id, type: 'ORDER_MANAGER_APPROVED', recipientKind: 'ROLE' },
        }),
      ).toBe(1);
    });

    it('an impossible move is ILLEGAL_ORDER_TRANSITION with the statuses', async () => {
      const submitted = await orderAt(w, 'SUBMITTED');
      const error = expectError(
        await act(STAFF_ORDER_ROUTES.accountingApproveOrder, w.actors.accountant, submitted.id),
        409,
        'CONFLICT',
        'ILLEGAL_ORDER_TRANSITION',
      );
      expect(error.details).toEqual({ from: 'SUBMITTED', to: 'ACCOUNTING_CLEARED' });
      const released = await orderAt(w, 'RELEASED');
      expectError(
        await act(STAFF_ORDER_ROUTES.cancelOrder, w.actors.manager, released.id, {
          reason: 'late',
        }),
        409,
        'CONFLICT',
        'ILLEGAL_ORDER_TRANSITION',
      );
      const received = await orderAt(w, 'RECEIVED');
      expectError(
        await act(STAFF_ORDER_ROUTES.approveOrder, w.actors.manager, received.id),
        409,
        'CONFLICT',
      );
    });

    it('editing after the manager approved is ORDER_NOT_EDITABLE', async () => {
      const approved = await orderAt(w, 'MANAGER_APPROVED');
      const full = await w.orders.getOrderFor(w.actors.manager, approved.id);
      expectError(
        await act(STAFF_ORDER_ROUTES.editOrderItems, w.actors.manager, approved.id, {
          changes: [{ itemId: full.items[0]!.id, quantity: '9' }],
        }),
        409,
        'CONFLICT',
        'ORDER_NOT_EDITABLE',
      );
    });

    it('only the assigned driver can mark delivered', async () => {
      const released = await orderAt(w, 'RELEASED');
      expectError(
        await act(STAFF_ORDER_ROUTES.deliverOrder, w.actors.driver2, released.id),
        404,
        'NOT_FOUND',
      );
      expect(await statusOf(released.id)).toBe('RELEASED');
    });
  });
});
