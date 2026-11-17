import { CUSTOMER_BALANCE_ROUTES, ORDER_ROUTES } from '@iorder/shared';
import { STAFF_ORDER_ROUTES } from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { UsdRateService } from '../src/modules/pricing/index.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { assertCustomerSafe, caller, expectError } from './support/orders-http.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// The defects an exact payment hit: USD lines from the USD snapshot, six decimals, the half cent
// tolerance [P] and the walk that stops at the first order not covered. Real PostgreSQL.

const PAID_ON = '2026-10-20';

describe('exact USD and so’m payments (real PostgreSQL)', () => {
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

  const setRate = (rate: string): Promise<unknown> =>
    t.get(UsdRateService).setUsdRate(w.actors.manager, new Prisma.Decimal(rate));
  const row = (id: string) =>
    w.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
  const paySom = (amount: string, rate: string) =>
    w.payments.recordPayment(w.actors.manager, w.orgA, {
      amount,
      currency: 'UZS',
      rate,
      paidOn: PAID_ON,
    });
  const payUsd = (amount: string) =>
    w.payments.recordPayment(w.actors.manager, w.orgA, {
      amount,
      currency: 'USD',
      paidOn: PAID_ON,
    });
  const customerAmount = async (): Promise<unknown> =>
    (await call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor: w.actors.ownerA })).body;

  describe('a line priced in USD is counted from its USD price', () => {
    beforeEach(async () => {
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1.20', [w.products.p2]: '5.25' },
        t.prisma,
        'USD',
        { [w.products.p1]: '1.30' },
      );
      await setRate('12650.55');
    });

    it('an exact USD payment settles it, though the so’m total is rounded per unit', async () => {
      const order = await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '5000']] });
      const stored = await row(order.id);
      // 1.20 x 12650.55 = 15180.66, whole so'm 15181; 5000 of them would be 6000.13 USD.
      expect(stored.totalAmount.toFixed(2)).toBe('75905000.00');
      expect(stored.totalUsd.toFixed(6)).toBe('6000.000000');
      expect(stored.items[0]?.fullUnitPriceUsd?.toFixed(2)).toBe('1.20');
      expect(stored.items[0]?.deferredUnitPriceUsd?.toFixed(2)).toBe('1.30');

      const balance = await payUsd('6000.00');
      expect((await row(order.id)).paymentStatus).toBe('PAID');
      expect(balance.amountDue.toFixed(2)).toBe('0.00');
      expect(balance.overpaid.toFixed(2)).toBe('0.00');
    });

    it('an item edit recomputes from the snapshots, never from so’m', async () => {
      const order = await submitOrder(w, w.actors.sellerA, {
        items: [
          [w.products.p1, '5000'],
          [w.products.p2, '2'],
        ],
      });
      expect((await row(order.id)).totalUsd.toFixed(6)).toBe('6010.500000');
      await setRate('20000');
      const line = order.items.find((item) => item.productId === w.products.p1);
      if (!line) throw new Error('line expected');
      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line.id, quantity: '2500' }],
      });
      expect((await row(order.id)).totalUsd.toFixed(6)).toBe('3010.500000');
      const event = await w.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, eventType: 'ITEMS_EDITED' },
      });
      expect(event.payload).toMatchObject({
        before: { totalUsd: '6010.500000' },
        after: { totalUsd: '3010.500000' },
      });
    });

    it('a plan change recomputes from the snapshots, by manager and by customer', async () => {
      const order = await submitOrder(w, w.actors.sellerA, {
        items: [[w.products.p1, '5000']],
      });
      await setRate('20000');
      await w.orders.setPaymentPlan(w.actors.manager, order.id, {
        paymentPlan: 'DEFERRED',
        expectedRowVersion: (await row(order.id)).rowVersion,
      });
      expect((await row(order.id)).totalUsd.toFixed(6)).toBe('6500.000000');
      await w.orders.changeOwnPaymentPlan(w.actors.sellerA, order.id, {
        paymentPlan: 'FULL',
        expectedRowVersion: (await row(order.id)).rowVersion,
      });
      expect((await row(order.id)).totalUsd.toFixed(6)).toBe('6000.000000');
    });

    it('the snapshots are immutable; the total keeps a sane guard', async () => {
      const order = await submitOrder(w, w.actors.sellerA, { items: [[w.products.p1, '5000']] });
      const line = (await row(order.id)).items[0];
      if (!line) throw new Error('line expected');
      await expect(
        t.prisma
          .$executeRaw`UPDATE order_items SET full_unit_price_usd = 9 WHERE id = ${line.id}::uuid`,
      ).rejects.toThrow(/price snapshots of an order line are immutable/);
      await expect(
        t.prisma
          .$executeRaw`UPDATE order_items SET deferred_unit_price_usd = NULL WHERE id = ${line.id}::uuid`,
      ).rejects.toThrow(/price snapshots of an order line are immutable/);
      await expect(
        t.prisma.$executeRaw`UPDATE orders SET total_usd = -1 WHERE id = ${order.id}::uuid`,
      ).rejects.toThrow(/orders_total_usd_sane/);
      await expect(
        t.prisma.$executeRaw`UPDATE orders SET total_usd = 1 WHERE id = ${order.id}::uuid`,
      ).rejects.toThrow(/orders_total_usd_sane/);
    });

    it('the USD snapshots never reach a customer, warehouse or driver response', async () => {
      const order = await orderAt(w, 'RELEASED', { items: [[w.products.p1, '5000']] });
      const replies = [
        await call(ORDER_ROUTES.getOrder, { actor: w.actors.ownerA, params: { id: order.id } }),
        await call(ORDER_ROUTES.listOrders, { actor: w.actors.ownerA }),
        await call(ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.ownerA,
          params: { id: order.id },
        }),
      ];
      for (const reply of replies) {
        expect(reply.status).toBe(200);
        assertCustomerSafe(reply.body, w);
        expect(JSON.stringify(reply.body)).not.toMatch(/UnitPriceUsd|totalUsd|usdRate|"6000\.0/);
      }
      for (const actor of [w.actors.warehouse, w.actors.driver]) {
        for (const reply of [
          await call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id: order.id } }),
          await call(STAFF_ORDER_ROUTES.getOrderTimeline, { actor, params: { id: order.id } }),
        ]) {
          expect(reply.status).toBe(200);
          expect(JSON.stringify(reply.body)).not.toMatch(/UnitPriceUsd|totalUsd|usdRate/);
        }
      }
    });
  });

  describe('a line priced in legacy so’m', () => {
    it('is so’m / frozen rate, with no USD snapshot, after an edit too', async () => {
      await setRate('12650');
      const order = await submitOrder(w); // 2 x 1500 + 750.50
      const stored = await row(order.id);
      expect(stored.items.every((item) => item.fullUnitPriceUsd === null)).toBe(true);
      // 3000 / 12650 = 0.237154 and 750.50 / 12650 = 0.059328, per line.
      expect(stored.totalUsd.toFixed(6)).toBe('0.296482');
      await setRate('20000');
      const line = order.items.find((item) => item.productId === w.products.p2);
      if (!line) throw new Error('line expected');
      await w.edit(w.actors.manager, order.id, { changes: [{ itemId: line.id, quantity: '2' }] });
      // 1501 / 12650 = 0.118656.
      expect((await row(order.id)).totalUsd.toFixed(6)).toBe('0.355810');
    });
  });

  describe('six decimals and the half cent', () => {
    const twoOrders = async (): Promise<[string, string]> => {
      await publishPriceList(w.pricing, { [w.products.p1]: '15000.00' }, t.prisma);
      await setRate('12650');
      const first = await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '1']] });
      const second = await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '1']] });
      return [first.id, second.id];
    };

    it('an exact so’m payment for two orders settles both: nothing due, for staff and customer', async () => {
      const [first, second] = await twoOrders();
      expect((await row(first)).totalUsd.toFixed(6)).toBe('1.185771');

      const balance = await paySom('30000.00', '12650');
      expect(balance.payments[0]?.amountUsd.toFixed(6)).toBe('2.371542');
      expect((await row(first)).paymentStatus).toBe('PAID');
      expect((await row(second)).paymentStatus).toBe('PAID');
      expect(balance.amountDue.toFixed(2)).toBe('0.00');
      expect(balance.overpaid.toFixed(2)).toBe('0.00');
      expect(await customerAmount()).toEqual({ amountDue: '0.00', currency: 'UZS' });
    });

    it('a shortfall under half a cent is settled and shows zero', async () => {
      const [, second] = await twoOrders();
      const balance = await payUsd('2.37'); // 0.001542 short
      expect((await row(second)).paymentStatus).toBe('PAID');
      expect(balance.amountDue.isZero()).toBe(true);
      expect(balance.uzsEquivalent?.amountDue.isZero()).toBe(true);
      expect(await customerAmount()).toEqual({ amountDue: '0.00', currency: 'UZS' });
    });

    it('a shortfall of a cent is a real debt', async () => {
      const [first, second] = await twoOrders();
      const balance = await payUsd('2.36'); // 0.011542 short
      expect((await row(first)).paymentStatus).toBe('PAID');
      expect((await row(second)).paymentStatus).toBe('UNPAID');
      expect(balance.amountDue.toFixed(2)).toBe('0.01');
    });

    it('a payment worth under half a cent is still refused', async () => {
      await expect(paySom('60.00', '12650')).rejects.toMatchObject({
        issues: [{ path: 'amount' }],
      });
    });
  });

  describe('an order rounding to nothing', () => {
    beforeEach(async () => {
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '15000.00', [w.products.p2]: '1.00' },
        t.prisma,
      );
      await setRate('12650');
    });

    it('is never paid without a payment', async () => {
      const tiny = await orderAt(w, 'RECEIVED', { items: [[w.products.p2, '1']] });
      expect((await row(tiny.id)).totalUsd.toFixed(6)).toBe('0.000079');
      expect((await row(tiny.id)).paymentStatus).toBe('UNPAID');
    });

    it('never gets ahead of an older unpaid order', async () => {
      const older = await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '1']] });
      const tiny = await orderAt(w, 'RECEIVED', { items: [[w.products.p2, '1']] });
      await payUsd('0.50');
      expect((await row(older.id)).paymentStatus).toBe('UNPAID');
      expect((await row(tiny.id)).paymentStatus).toBe('UNPAID');
    });

    it('is paid once real money is left for it', async () => {
      const older = await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '1']] });
      const tiny = await orderAt(w, 'RECEIVED', { items: [[w.products.p2, '1']] });
      await payUsd('5.00');
      expect((await row(older.id)).paymentStatus).toBe('PAID');
      expect((await row(tiny.id)).paymentStatus).toBe('PAID');
    });
  });

  describe('the staff counts', () => {
    const counts = (actor: World['actors']['manager']) =>
      call(STAFF_ORDER_ROUTES.countOrders, {
        actor,
        query: { statuses: ['RECEIVED'], paymentStatus: 'UNPAID', groupBy: 'ORGANIZATION' },
      });

    it('sum total_usd with the so’m equivalent at the current rate for full roles only', async () => {
      await publishPriceList(w.pricing, { [w.products.p1]: '1.20' }, t.prisma, 'USD');
      await setRate('12650.55');
      await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '5000']] });
      await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '5000']] });
      await setRate('13000');

      const expected = {
        count: 2,
        totalAmount: '151810000.00',
        totalUsd: '12000.00',
        totalUzsEquivalent: '156000000.00',
      };
      for (const actor of [w.actors.manager, w.actors.accountant, w.actors.admin]) {
        const reply = await counts(actor);
        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({
          byStatus: { RECEIVED: expected },
          byOrganization: { [w.orgA]: expected },
        });
      }
      for (const actor of [w.actors.warehouse, w.actors.driver]) {
        const reply = await call(STAFF_ORDER_ROUTES.countOrders, { actor });
        expect(reply.status).toBe(200);
        expect(JSON.stringify(reply.body)).not.toMatch(/totalUsd|totalUzsEquivalent|totalAmount/);
      }
    });

    it('stay gross unpaid orders: a partial payment does not move them, a settled order leaves', async () => {
      await publishPriceList(w.pricing, { [w.products.p1]: '1.20' }, t.prisma, 'USD');
      await setRate('12650.55');
      const order = await orderAt(w, 'RECEIVED', { items: [[w.products.p1, '5000']] });
      await payUsd('100.00');
      expect((await counts(w.actors.manager)).body).toMatchObject({
        byStatus: { RECEIVED: { count: 1, totalUsd: '6000.00' } },
      });
      await payUsd('5900.00');
      expect((await row(order.id)).paymentStatus).toBe('PAID');
      expect((await counts(w.actors.manager)).body).toEqual({ byStatus: {}, byOrganization: {} });
    });

    it('have no so’m equivalent while the rate is corrupt, and keep the USD figure', async () => {
      await orderAt(w, 'RECEIVED');
      await t.prisma.appSetting.update({
        where: { key: 'usd_rate' },
        data: { value: { rate: 'not a number' } },
      });
      expect((await counts(w.actors.manager)).body).toMatchObject({
        byStatus: { RECEIVED: { totalUsd: '0.31', totalUzsEquivalent: null } },
      });
    });
  });

  describe('the customer’s amount with a corrupt rate setting', () => {
    it('is the documented 409, not a server error', async () => {
      await orderAt(w, 'RECEIVED');
      await t.prisma.appSetting.update({
        where: { key: 'usd_rate' },
        data: { value: { rate: 'not a number' } },
      });
      const reply = await call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor: w.actors.ownerA });
      expectError(reply, 409, 'CONFLICT');
      expect(reply.body).toMatchObject({ error: { reason: 'CURRENCY_CONVERSION_UNAVAILABLE' } });
    });
  });
});
