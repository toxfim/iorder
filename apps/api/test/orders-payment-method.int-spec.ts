import { ORDER_ROUTES } from '@iorder/shared';
import { staffOrderSchema, STAFF_ORDER_ROUTES } from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { caller, expectError, expectParsed, type Reply } from './support/orders-http.js';
import { createWorld, fifoPlanOf, orderAt, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// [C] 2026-10-24: the manager MUST choose the payment method (CASH "Naqd" / OFFICIAL) when
// approving, may change it later while the order is approved and alive, and only manager and
// accountant see it.
describe('order payment method (real PostgreSQL)', () => {
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

  const row = (orderId: string) => t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const approve = async (orderId: string, body: Record<string, unknown>): Promise<Reply> =>
    call(STAFF_ORDER_ROUTES.approveOrder, {
      actor: w.actors.manager,
      params: { id: orderId },
      body: {
        expectedRowVersion: (await row(orderId)).rowVersion,
        ...(await fifoPlanOf(w.orders, w.actors.manager, orderId)),
        ...body,
      },
    });
  const setMethod = (actor: Actor, orderId: string, paymentMethod: string): Promise<Reply> =>
    call(STAFF_ORDER_ROUTES.setPaymentMethod, {
      actor,
      params: { id: orderId },
      body: { paymentMethod },
    });
  const methodEvents = (orderId: string) =>
    t.prisma.orderEvent.findMany({
      where: { orderId, eventType: 'PAYMENT_METHOD_CHANGED' },
      orderBy: { seq: 'asc' },
    });

  describe('approval', () => {
    it('is refused without a payment method and the order stays SUBMITTED', async () => {
      const order = await orderAt(w, 'SUBMITTED');
      expectError(await approve(order.id, {}), 422, 'VALIDATION_FAILED');
      expectError(await approve(order.id, { paymentMethod: 'CARD' }), 422, 'VALIDATION_FAILED');
      const stored = await row(order.id);
      expect([stored.status, stored.paymentMethod]).toEqual(['SUBMITTED', null]);
    });

    it.each([
      ['OFFICIAL', false, 'MANAGER_APPROVED'],
      ['CASH', true, 'ACCOUNTING_CLEARED'],
    ] as const)(
      'stores %s (skip accounting: %s) and records it in the approval event',
      async (paymentMethod, skipAccounting, status) => {
        const order = await orderAt(w, 'SUBMITTED');
        const reply = await approve(order.id, { paymentMethod, skipAccounting });
        const body = expectParsed(reply, 200, staffOrderSchema);
        expect(body.status).toBe(status);
        expect(body.detail === 'FULL' && body.paymentMethod).toBe(paymentMethod);
        expect((await row(order.id)).paymentMethod).toBe(paymentMethod);
        const approval = await t.prisma.orderEvent.findFirstOrThrow({
          where: { orderId: order.id, toStatus: 'MANAGER_APPROVED' },
        });
        expect(approval.payload).toMatchObject({
          before: { paymentMethod: null },
          after: { paymentMethod },
        });
      },
    );
  });

  describe('visibility', () => {
    it('manager and accountant see it; admin, warehouse, driver and the customer never do', async () => {
      const order = await orderAt(w, 'RELEASED');
      const read = (actor: Actor): Promise<Reply> =>
        call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id: order.id } });
      for (const actor of [w.actors.manager, w.actors.accountant]) {
        const body = expectParsed(await read(actor), 200, staffOrderSchema);
        expect(body.detail === 'FULL' && body.paymentMethod).toBe('CASH');
      }
      for (const actor of [w.actors.admin, w.actors.warehouse, w.actors.driver]) {
        const reply = await read(actor);
        expect(reply.status).toBe(200);
        expect(JSON.stringify(reply.body)).not.toMatch(/paymentMethod|"CASH"|"OFFICIAL"/);
      }
      const customer = await call(ORDER_ROUTES.getOrder, {
        actor: w.actors.ownerA,
        params: { id: order.id },
      });
      expect(customer.status).toBe(200);
      expect(JSON.stringify(customer.body)).not.toMatch(/paymentMethod|"CASH"|"OFFICIAL"/);
    });
  });

  describe('change after approval', () => {
    it('the manager changes it: one event and one audit row; the same value writes nothing', async () => {
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      const before = await row(order.id);
      const body = expectParsed(
        await setMethod(w.actors.manager, order.id, 'OFFICIAL'),
        200,
        staffOrderSchema,
      );
      expect(body.detail === 'FULL' && body.paymentMethod).toBe('OFFICIAL');
      const after = await row(order.id);
      expect([after.paymentMethod, after.status, after.rowVersion]).toEqual([
        'OFFICIAL',
        before.status,
        before.rowVersion,
      ]);
      const events = await methodEvents(order.id);
      expect(events.map((e) => [e.actorRole, e.payload])).toEqual([
        ['MANAGER', { before: { paymentMethod: 'CASH' }, after: { paymentMethod: 'OFFICIAL' } }],
      ]);
      expect(
        await t.prisma.auditLog.count({
          where: { entityId: order.id, action: 'ORDER_PAYMENT_METHOD_CHANGED' },
        }),
      ).toBe(1);

      expect((await setMethod(w.actors.manager, order.id, 'OFFICIAL')).status).toBe(200);
      expect(await methodEvents(order.id)).toHaveLength(1);
    });

    it.each(['accountant', 'admin', 'warehouse', 'driver'] as const)(
      '%s may not change it (403)',
      async (role) => {
        const order = await orderAt(w, 'MANAGER_APPROVED');
        expectError(await setMethod(w.actors[role], order.id, 'OFFICIAL'), 403, 'FORBIDDEN');
        expect((await row(order.id)).paymentMethod).toBe('CASH');
      },
    );

    it('a customer may not change it', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      const reply = await setMethod(w.actors.ownerA, order.id, 'OFFICIAL');
      expect([401, 403]).toContain(reply.status);
      expect((await row(order.id)).paymentMethod).toBe('CASH');
    });

    it.each([
      ['SUBMITTED', undefined],
      ['REJECTED', undefined],
      ['CANCELLED', 'ACCOUNTING_CLEARED'],
    ] as const)('is refused on a %s order (409)', async (status, cancelAfter) => {
      const order = await orderAt(w, status, cancelAfter === undefined ? {} : { cancelAfter });
      expectError(
        await setMethod(w.actors.manager, order.id, 'OFFICIAL'),
        409,
        'CONFLICT',
        'PAYMENT_METHOD_NOT_CHANGEABLE',
      );
      expect(await methodEvents(order.id)).toHaveLength(0);
    });

    it('validates the body (422)', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      expectError(await setMethod(w.actors.manager, order.id, 'CARD'), 422, 'VALIDATION_FAILED');
    });
  });
});
