import {
  CUSTOMER_BALANCE_ROUTES,
  ORDER_ROUTES,
  customerBalanceResponseSchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerTimelineResponseSchema,
} from '@iorder/shared';
import {
  ORGANIZATION_PAYMENT_ROUTES,
  STAFF_ORDER_ROUTES,
  organizationBalanceResponseSchema,
  staffOrderSchema,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, InputValidationError } from '../src/common/errors/domain-errors.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { UsdRateService } from '../src/modules/pricing/index.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { assertCustomerSafe, caller, expectError, expectParsed } from './support/orders-http.js';
import {
  createWorld,
  nextKey,
  orderAt,
  shownCartRequest,
  submitOrder,
  fillCart,
  type World,
} from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// The owner's USD debt on a real PostgreSQL. The world's rate setting is 12000; its order is
// 2 x 1500.00 + 1 x 750.50 = 3750.50 so'm, 0.31 USD.

const PAID_ON = '2026-10-20';

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('USD organization debt (real PostgreSQL)', () => {
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
  const row = (id: string) => w.prisma.order.findUniqueOrThrow({ where: { id } });
  const usdFacts = async (id: string): Promise<[string, string, string]> => {
    const order = await row(id);
    return [order.totalAmount.toFixed(2), order.usdRate.toFixed(4), order.totalUsd.toFixed(2)];
  };
  const paySom = (amount: string, rate: string, org: string = w.orgA) =>
    w.payments.recordPayment(w.actors.manager, org, {
      amount,
      currency: 'UZS',
      rate,
      paidOn: PAID_ON,
    });
  const payUsd = (amount: string, org: string = w.orgA) =>
    w.payments.recordPayment(w.actors.manager, org, { amount, currency: 'USD', paidOn: PAID_ON });

  describe('the rate of an order', () => {
    it('is frozen at submit: a later change of the setting moves nothing', async () => {
      const order = await submitOrder(w);
      expect(await usdFacts(order.id)).toEqual(['3750.50', '12000.0000', '0.31']);

      await setRate('15000');
      expect(await usdFacts(order.id)).toEqual(['3750.50', '12000.0000', '0.31']);

      // A new order takes the new rate.
      const later = await submitOrder(w);
      expect(await usdFacts(later.id)).toEqual(['3750.50', '15000.0000', '0.25']);
    });

    it('is the rate that priced a USD list, and is recorded in the SUBMITTED event', async () => {
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '10.00', [w.products.p2]: '5.25' },
        t.prisma,
        'USD',
      );
      await setRate('11000.50');
      const order = await submitOrder(w);
      // 2 x 110005 + 1 x 57753 (whole so'm, half up) at 11000.50 is 25.25 USD.
      expect(await usdFacts(order.id)).toEqual(['277763.00', '11000.5000', '25.25']);
      const event = await w.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, eventType: 'SUBMITTED' },
      });
      expect(event.payload).toMatchObject({
        after: { usdRate: '11000.5000', totalUsd: '25.250000' },
      });
    });

    it('recomputes the USD total with the stored rate after an item edit', async () => {
      const order = await submitOrder(w);
      await setRate('15000');
      const p1Line = order.items.find((item) => item.productId === w.products.p1);
      if (!p1Line) throw new Error('line expected');

      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: p1Line.id, quantity: '10' }],
      });

      // 10 x 1500 + 750.50 = 15750.50 at 12000 is 1.31; at the current 15000 it would be 1.05.
      expect(await usdFacts(order.id)).toEqual(['15750.50', '12000.0000', '1.31']);
      const event = await w.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, eventType: 'ITEMS_EDITED' },
      });
      expect(event.payload).toMatchObject({
        before: { totalAmount: '3750.50', totalUsd: '0.312542' },
        after: { totalAmount: '15750.50', totalUsd: '1.312542' },
      });
    });

    it('recomputes the USD total with the stored rate after a plan change, by manager and customer', async () => {
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
        t.prisma,
        'UZS',
        { [w.products.p1]: '1800.00', [w.products.p2]: '900.25' },
      );
      const order = await submitOrder(w);
      await setRate('15000');

      const current = await row(order.id);
      await w.orders.setPaymentPlan(w.actors.manager, order.id, {
        paymentPlan: 'DEFERRED',
        expectedRowVersion: current.rowVersion,
      });
      // 2 x 1800 + 900.25 = 4500.25 at 12000; at 15000 it would be 0.30.
      expect(await usdFacts(order.id)).toEqual(['4500.25', '12000.0000', '0.38']);
      const event = await w.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, eventType: 'PAYMENT_PLAN_CHANGED' },
      });
      expect(event.payload).toMatchObject({
        before: { totalUsd: '0.312542' },
        after: { totalUsd: '0.375021' },
      });

      const changed = await row(order.id);
      await w.orders.changeOwnPaymentPlan(w.actors.sellerA, order.id, {
        paymentPlan: 'FULL',
        expectedRowVersion: changed.rowVersion,
      });
      expect(await usdFacts(order.id)).toEqual(['3750.50', '12000.0000', '0.31']);
    });

    it('no write can move the frozen rate or a USD total far off its so’m total', async () => {
      const { id } = await submitOrder(w);
      await expect(
        t.prisma.$executeRaw`UPDATE orders SET usd_rate = 15000 WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/frozen at submit/);
      await expect(
        t.prisma.$executeRaw`UPDATE orders SET total_usd = 99 WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/orders_total_usd_sane/);
    });
  });

  describe('submitting without a known rate', () => {
    beforeEach(async () => {
      await t.prisma.appSetting.delete({ where: { key: 'usd_rate' } });
    });

    it('refuses an order of legacy so’m prices with a typed error; the cart stays', async () => {
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const request = await shownCartRequest(w, w.actors.sellerA, 'FULL');
      const error = await failure(
        w.orders.submitCart(w.actors.sellerA, w.orgA, nextKey(), request),
      );
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ reason: 'CURRENCY_CONVERSION_UNAVAILABLE' });
      expect(await t.prisma.order.count()).toBe(0);
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toHaveLength(1);

      expectError(
        await call(ORDER_ROUTES.submitOrder, {
          actor: w.actors.sellerA,
          key: nextKey(),
          body: request,
        }),
        409,
        'CONFLICT',
      );
    });

    it('still answers a repeated request with the order it already made', async () => {
      await setRate('12000');
      const key = nextKey();
      await fillCart(w, w.actors.sellerA, [[w.products.p1, '1']]);
      const request = await shownCartRequest(w, w.actors.sellerA, 'FULL');
      const first = await w.orders.submitCart(w.actors.sellerA, w.orgA, key, request);
      await t.prisma.appSetting.delete({ where: { key: 'usd_rate' } });
      const again = await w.orders.submitCart(w.actors.sellerA, w.orgA, key, request);
      expect(again.id).toBe(first.id);
    });
  });

  describe('payments', () => {
    it('a USD payment counts as entered and has no rate', async () => {
      const balance = await payUsd('12.50');
      expect(balance.payments[0]).toMatchObject({ currency: 'USD', rate: null });
      expect(balance.payments[0]?.amountUsd.toFixed(2)).toBe('12.50');
      expect(balance.paidTotal.toFixed(2)).toBe('12.50');
    });

    it('a so’m payment stores its own rate and the computed USD value, audited', async () => {
      const balance = await paySom('1266666.00', '12650.5');
      const payment = balance.payments[0]!;
      expect(payment.currency).toBe('UZS');
      expect(payment.amount.toFixed(2)).toBe('1266666.00');
      expect(payment.rate?.toFixed(4)).toBe('12650.5000');
      expect(payment.amountUsd.toFixed(2)).toBe('100.13');
      expect(balance.paidTotal.toFixed(2)).toBe('100.13');
      expect(
        await w.prisma.auditLog.findFirstOrThrow({
          where: { action: 'ORGANIZATION_PAYMENT_RECORDED', entityId: payment.id },
        }),
      ).toMatchObject({
        diff: {
          amount: { from: null, to: '1266666.00' },
          currency: { from: null, to: 'UZS' },
          rate: { from: null, to: '12650.5000' },
          amountUsd: { from: null, to: '100.127742' },
        },
      });
    });

    it('the current rate setting has no say over a recorded payment', async () => {
      await paySom('120000.00', '12000');
      await setRate('15000');
      const balance = await w.payments.getBalance(w.actors.manager, w.orgA);
      expect(balance.paidTotal.toFixed(2)).toBe('10.00');
    });

    it('refuses a so’m payment without a rate, with a bad rate, and a USD payment with one', async () => {
      for (const command of [
        { amount: '1000.00', currency: 'UZS', paidOn: PAID_ON },
        { amount: '1000.00', currency: 'UZS', rate: '0', paidOn: PAID_ON },
        { amount: '1000.00', currency: 'UZS', rate: '-12000', paidOn: PAID_ON },
        { amount: '1000.00', currency: 'UZS', rate: 12000, paidOn: PAID_ON },
        { amount: '1000.00', currency: 'UZS', rate: '12000.12345', paidOn: PAID_ON },
        { amount: '1000.00', currency: 'USD', rate: '12000', paidOn: PAID_ON },
      ]) {
        expect(
          await failure(w.payments.recordPayment(w.actors.manager, w.orgA, command as never)),
          JSON.stringify(command),
        ).toBeInstanceOf(InputValidationError);
      }
      expectError(
        await call(ORGANIZATION_PAYMENT_ROUTES.recordPayment, {
          actor: w.actors.manager,
          params: { id: w.orgA },
          body: { amount: '1000.00', currency: 'UZS', paidOn: PAID_ON },
        }),
        422,
        'VALIDATION_FAILED',
      );
      expect(await t.prisma.organizationPayment.count()).toBe(0);
    });

    it('refuses a so’m amount worth nothing and one too large for the column', async () => {
      for (const [amount, rate] of [
        ['1.00', '12000'],
        ['9999999999999999.99', '0.0001'],
      ] as const) {
        const error = await failure(paySom(amount, rate));
        expect(error).toBeInstanceOf(InputValidationError);
        expect(error).toMatchObject({ issues: [{ path: 'amount' }] });
      }
      expect(await t.prisma.organizationPayment.count()).toBe(0);
    });
  });

  describe('the debt and the allocation in USD', () => {
    it('each order counts at its own rate, oldest received first, whatever the current rate', async () => {
      const oldest = await orderAt(w, 'RECEIVED'); // 3750.50 at 12000 = 0.31
      await setRate('10000');
      const newer = await orderAt(w, 'RECEIVED'); // 3750.50 at 10000 = 0.38
      await setRate('20000');

      const start = await w.payments.getBalance(w.actors.manager, w.orgA);
      expect(start.receivedTotal.toFixed(2)).toBe('0.69');
      expect(start.amountDue.toFixed(2)).toBe('0.69');

      // 0.31 USD paid in so'm at a rate of its own covers exactly the oldest order.
      await paySom('3100.00', '10000');
      expect((await row(oldest.id)).paymentStatus).toBe('PAID');
      expect((await row(newer.id)).paymentStatus).toBe('UNPAID');
      const event = await w.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: oldest.id, eventType: 'PAYMENT_STATUS_CHANGED' },
      });
      expect(event).toMatchObject({ actorUserId: w.ids.manager, actorRole: 'MANAGER' });

      // One cent short of the newer order keeps it unpaid, the last cent covers it.
      const short = await payUsd('0.37');
      expect((await row(newer.id)).paymentStatus).toBe('UNPAID');
      expect(short.amountDue.toFixed(2)).toBe('0.01');
      const settled = await payUsd('0.01');
      expect((await row(newer.id)).paymentStatus).toBe('PAID');
      expect(settled.amountDue.toFixed(2)).toBe('0.00');
    });

    it('an overpayment is kept in USD and pays the next received order', async () => {
      const delivered = await orderAt(w, 'DELIVERED');
      const balance = await payUsd('10.00');
      expect(balance.overpaid.toFixed(2)).toBe('10.00');
      await w.step(w.actors.sellerA, delivered.id, { to: 'RECEIVED' });
      expect((await row(delivered.id)).paymentStatus).toBe('PAID');
      const after = await w.payments.getBalance(w.actors.manager, w.orgA);
      expect(after.overpaid.toFixed(2)).toBe('9.69');
    });

    it('a not-received order is no debt', async () => {
      await orderAt(w, 'DELIVERED');
      const balance = await w.payments.getBalance(w.actors.accountant, w.orgA);
      expect(balance.receivedTotal.toFixed(2)).toBe('0.00');
    });
  });

  describe('corrections and voids by the admin', () => {
    it('corrects the rate of a so’m payment: USD value and orders follow, with before/after', async () => {
      const order = await orderAt(w, 'RECEIVED');
      const id = (await paySom('3720.00', '12000')).payments[0]!.id;
      expect((await row(order.id)).paymentStatus).toBe('PAID');

      const corrected = await w.payments.correctPayment(w.actors.admin, id, {
        rate: '15000',
        reason: 'wrong rate',
      });
      expect(corrected.payments[0]?.amountUsd.toFixed(2)).toBe('0.25');
      expect((await row(order.id)).paymentStatus).toBe('UNPAID');
      expect(
        await w.prisma.auditLog.findFirstOrThrow({
          where: { action: 'ORGANIZATION_PAYMENT_CORRECTED', entityId: id },
        }),
      ).toMatchObject({
        actorUserId: w.ids.admin,
        diff: {
          rate: { from: '12000.0000', to: '15000.0000' },
          amountUsd: { from: '0.310000', to: '0.248000' },
          reason: { from: null, to: 'wrong rate' },
        },
      });
    });

    it('switches the currency both ways', async () => {
      const id = (await paySom('120000.00', '12000')).payments[0]!.id;
      const usd = await w.payments.correctPayment(w.actors.admin, id, {
        currency: 'USD',
        amount: '11.00',
        reason: 'was dollars',
      });
      expect(usd.payments[0]).toMatchObject({ currency: 'USD', rate: null });
      expect(usd.payments[0]?.amountUsd.toFixed(2)).toBe('11.00');

      const som = await w.payments.correctPayment(w.actors.admin, id, {
        currency: 'UZS',
        amount: '130000.00',
        rate: '13000',
        reason: 'was so’m after all',
      });
      expect(som.payments[0]?.currency).toBe('UZS');
      expect(som.payments[0]?.amountUsd.toFixed(2)).toBe('10.00');
    });

    it('a so’m amount correction keeps the stored rate', async () => {
      const id = (await paySom('120000.00', '12000')).payments[0]!.id;
      const corrected = await w.payments.correctPayment(w.actors.admin, id, {
        amount: '240000.00',
        reason: 'typo',
      });
      expect(corrected.payments[0]?.rate?.toFixed(4)).toBe('12000.0000');
      expect(corrected.payments[0]?.amountUsd.toFixed(2)).toBe('20.00');
    });

    it('refuses a correction that leaves a bad combination', async () => {
      const usdId = (await payUsd('5.00')).payments[0]!.id;
      const somId = (await paySom('120000.00', '12000')).payments[0]!.id;
      for (const [id, command] of [
        [usdId, { rate: '12000', reason: 'x' }],
        [usdId, { currency: 'UZS', reason: 'x' }],
        [somId, { currency: 'USD', rate: '12000', reason: 'x' }],
        [somId, { amount: '1.00', reason: 'x' }], // worth 0.00 USD at its rate
      ] as const) {
        expect(
          await failure(w.payments.correctPayment(w.actors.admin, id, command as never)),
          JSON.stringify(command),
        ).toBeInstanceOf(InputValidationError);
      }
    });

    it('an old payment worth under half a cent can still get its comment corrected', async () => {
      const id = (await paySom('12000.00', '12000')).payments[0]!.id;
      // As the migration leaves such a row; the service no longer records one.
      await t.prisma.organizationPayment.update({
        where: { id },
        data: { amount: new Prisma.Decimal('1.00'), amountUsd: new Prisma.Decimal('0.000083') },
      });
      const corrected = await w.payments.correctPayment(w.actors.admin, id, {
        comment: 'old row',
        reason: 'note',
      });
      expect(corrected.payments[0]?.comment).toBe('old row');
      expect(corrected.payments[0]?.amountUsd.toFixed(2)).toBe('0.00');
    });

    it('a correction that changes nothing writes nothing', async () => {
      const id = (await paySom('120000.00', '12000')).payments[0]!.id;
      await w.payments.correctPayment(w.actors.admin, id, { rate: '12000.0000', reason: 'same' });
      expect(
        await w.prisma.auditLog.count({ where: { action: 'ORGANIZATION_PAYMENT_CORRECTED' } }),
      ).toBe(0);
    });

    it('a void takes the USD value out of the debt and the orders follow', async () => {
      const order = await orderAt(w, 'RECEIVED');
      const balance = await paySom('3720.00', '12000');
      const voided = await w.payments.voidPayment(w.actors.admin, balance.payments[0]!.id, {
        reason: 'duplicate',
      });
      expect(voided.paidTotal.toFixed(2)).toBe('0.00');
      expect(voided.amountDue.toFixed(2)).toBe('0.31');
      expect((await row(order.id)).paymentStatus).toBe('UNPAID');
    });
  });

  describe('the staff balance', () => {
    it('is USD with the so’m equivalent at the current rate', async () => {
      await orderAt(w, 'RECEIVED');
      await payUsd('0.10');
      await paySom('1200.00', '12000');
      await setRate('13000');
      const reply = await call(ORGANIZATION_PAYMENT_ROUTES.getBalance, {
        actor: w.actors.accountant,
        params: { id: w.orgA },
      });
      expect(expectParsed(reply, 200, organizationBalanceResponseSchema)).toMatchObject({
        currency: 'USD',
        receivedTotal: '0.31',
        paidTotal: '0.20',
        amountDue: '0.11',
        overpaid: '0.00',
        usdRate: '13000.0000',
        uzsEquivalent: {
          receivedTotal: '4063.00',
          paidTotal: '2600.00',
          amountDue: '1463.00',
          overpaid: '0.00',
        },
        payments: [
          { currency: 'UZS', amount: '1200.00', rate: '12000.0000', amountUzs: '1200.00' },
          { currency: 'USD', amount: '0.10', rate: null, amountUsd: '0.10', amountUzs: '1300.00' },
        ],
      });
    });

    it('still shows the USD debt with no so’m figures when there is no rate', async () => {
      await orderAt(w, 'RECEIVED');
      await payUsd('0.10');
      await t.prisma.appSetting.delete({ where: { key: 'usd_rate' } });
      const balance = await w.payments.getBalance(w.actors.manager, w.orgA);
      expect(balance.amountDue.toFixed(2)).toBe('0.21');
      expect(balance.usdRate).toBeNull();
      expect(balance.uzsEquivalent).toBeNull();
      expect(balance.payments[0]?.amountUzs).toBeNull();
    });

    it('still shows the USD debt when the stored rate is corrupt', async () => {
      await orderAt(w, 'RECEIVED');
      await t.prisma.appSetting.update({
        where: { key: 'usd_rate' },
        data: { value: { rate: 'not a number' } },
      });
      const balance = await w.payments.getBalance(w.actors.manager, w.orgA);
      expect(balance.amountDue.toFixed(2)).toBe('0.31');
      expect(balance.uzsEquivalent).toBeNull();
    });
  });

  describe('what the customer gets', () => {
    const customerBalance = async (actor = w.actors.ownerA) =>
      call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor });

    it('only the so’m amount: the USD debt at the current rate, whole so’m', async () => {
      await orderAt(w, 'RECEIVED');
      const reply = await customerBalance();
      expect(expectParsed(reply, 200, customerBalanceResponseSchema)).toEqual({
        amountDue: '3751.00',
        currency: 'UZS',
      });
      assertCustomerSafe(reply.body, w);

      // The debt stays 0.312542 USD; the so'm figure follows the current rate, like the prices do.
      await setRate('13000');
      expect(expectParsed(await customerBalance(), 200, customerBalanceResponseSchema)).toEqual({
        amountDue: '4063.00',
        currency: 'UZS',
      });
    });

    it('zero when nothing is due, even without a rate; a typed refusal when it cannot be worked out', async () => {
      await t.prisma.appSetting.delete({ where: { key: 'usd_rate' } });
      expect(expectParsed(await customerBalance(), 200, customerBalanceResponseSchema)).toEqual({
        amountDue: '0.00',
        currency: 'UZS',
      });
      await setRate('12000');
      await orderAt(w, 'RECEIVED');
      await t.prisma.appSetting.delete({ where: { key: 'usd_rate' } });
      const error = await failure(w.payments.getOwnAmountDue(w.actors.ownerA));
      expect(error).toMatchObject({ reason: 'CURRENCY_CONVERSION_UNAVAILABLE' });
      expectError(await customerBalance(), 409, 'CONFLICT');
    });

    it('never another organization’s debt', async () => {
      await orderAt(w, 'RECEIVED');
      await payUsd('100.00', w.orgB);
      expect(
        expectParsed(await customerBalance(w.actors.ownerB), 200, customerBalanceResponseSchema),
      ).toEqual({ amountDue: '0.00', currency: 'UZS' });
      expect(
        expectParsed(await customerBalance(w.actors.ownerA), 200, customerBalanceResponseSchema)
          .amountDue,
      ).toBe('3751.00');
      expect(
        (
          await call(ORGANIZATION_PAYMENT_ROUTES.getBalance, {
            actor: w.actors.ownerB,
            params: { id: w.orgA },
          })
        ).status,
      ).toBe(403);
    });

    it('no customer response carries the rate or a USD figure, by key or by value', async () => {
      const received = await orderAt(w, 'RECEIVED');
      await paySom('1200.00', '12345.6789');
      const replies = [
        await call(ORDER_ROUTES.getOrder, {
          actor: w.actors.ownerA,
          params: { id: received.id },
        }),
        await call(ORDER_ROUTES.listOrders, { actor: w.actors.ownerA }),
        await call(ORDER_ROUTES.getOrderTimeline, {
          actor: w.actors.ownerA,
          params: { id: received.id },
        }),
        await customerBalance(),
      ];
      expectParsed(replies[0]!, 200, customerOrderSchema);
      expectParsed(replies[1]!, 200, customerOrderListResponseSchema);
      expectParsed(replies[2]!, 200, customerTimelineResponseSchema);
      expectParsed(replies[3]!, 200, customerBalanceResponseSchema);
      for (const reply of replies) {
        assertCustomerSafe(reply.body, w);
        const text = JSON.stringify(reply.body);
        for (const secret of ['12000.0000', '12345.6789', '"0.31"']) {
          expect(text, secret).not.toContain(secret);
        }
      }
    });

    it('the staff order detail has the USD facts for full detail roles only', async () => {
      const order = await orderAt(w, 'RELEASED');
      for (const actor of [w.actors.manager, w.actors.accountant, w.actors.admin]) {
        const body = expectParsed(
          await call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id: order.id } }),
          200,
          staffOrderSchema,
        );
        expect(body).toMatchObject({ usdRate: '12000.0000', totalUsd: '0.31' });
      }
      for (const actor of [w.actors.warehouse, w.actors.driver]) {
        const reply = await call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id: order.id } });
        expect(reply.status).toBe(200);
        expect(reply.body).not.toHaveProperty('usdRate');
        expect(reply.body).not.toHaveProperty('totalUsd');
      }
      for (const actor of [w.actors.warehouse, w.actors.driver]) {
        expect(
          (await call(ORGANIZATION_PAYMENT_ROUTES.getBalance, { actor, params: { id: w.orgA } }))
            .status,
        ).toBe(403);
      }
    });

    it('no notification payload carries a USD fact', async () => {
      await orderAt(w, 'RECEIVED');
      const messages = await w.prisma.notificationOutbox.findMany();
      expect(messages.length).toBeGreaterThan(0);
      const text = JSON.stringify(messages.map((m) => m.payload));
      expect(text).not.toMatch(/usd|12000\.0000/i);
    });
  });
});
