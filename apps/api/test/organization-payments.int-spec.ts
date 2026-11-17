import { CUSTOMER_BALANCE_ROUTES, customerBalanceResponseSchema } from '@iorder/shared';
import {
  ORGANIZATION_PAYMENT_ROUTES,
  organizationBalanceResponseSchema,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
} from '../src/common/errors/domain-errors.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { assertCustomerSafe, caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, orderAt, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// Organization payments ([C] 2026-10-26) on a real PostgreSQL: the debt is per organization
// (received orders minus payments, in USD), only the manager records, only the admin corrects, the
// orders' PAID / UNPAID follows the payments oldest received first. The USD rules themselves
// (frozen rate, so'm payments) are in usd-debt.int-spec.

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('organization payments (real PostgreSQL)', () => {
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

  const pay = (amount: string, actor: Actor = w.actors.manager, org: string = w.orgA) =>
    w.payments.recordPayment(actor, org, { amount, currency: 'USD', paidOn: '2026-10-20' });
  const usdOf = async (id: string): Promise<Prisma.Decimal> =>
    (await w.prisma.order.findUniqueOrThrow({ where: { id } })).totalUsd;
  const paymentStatus = async (id: string): Promise<string> =>
    (await w.prisma.order.findUniqueOrThrow({ where: { id } })).paymentStatus;

  it("the manager's example: two received orders, one payment for the organization", async () => {
    const first = await orderAt(w, 'RECEIVED');
    const second = await orderAt(w, 'RECEIVED');
    const firstUsd = await usdOf(first.id);
    const total = firstUsd.plus(await usdOf(second.id));
    // Covers the first order and part of the second.
    const amount = firstUsd.plus('0.10').toFixed(2);

    t.clock.set(new Date('2026-10-20T11:00:00Z'));
    const balance = await pay(amount);

    expect(balance.receivedTotal.toFixed(2)).toBe(total.toFixed(2));
    expect(balance.amountDue.toFixed(2)).toBe(total.minus(amount).toFixed(2));
    expect(balance.overpaid.toFixed(2)).toBe('0.00');
    expect(await paymentStatus(first.id)).toBe('PAID');
    expect(await paymentStatus(second.id)).toBe('UNPAID');

    const event = await w.prisma.orderEvent.findFirstOrThrow({
      where: { orderId: first.id, eventType: 'PAYMENT_STATUS_CHANGED' },
    });
    expect(event).toMatchObject({
      actorUserId: w.ids.manager,
      actorRole: 'MANAGER',
      payload: { before: { paymentStatus: 'UNPAID' }, after: { paymentStatus: 'PAID' } },
    });
    const audit = await w.prisma.auditLog.findFirstOrThrow({
      where: { action: 'ORGANIZATION_PAYMENT_RECORDED' },
    });
    expect(audit).toMatchObject({
      actorUserId: w.ids.manager,
      entityType: 'ORGANIZATION_PAYMENT',
      diff: {
        amount: { from: null, to: amount },
        currency: { from: null, to: 'USD' },
        amountUsd: { from: null, to: `${amount}0000` },
        paidOn: { from: null, to: '2026-10-20' },
      },
    });
  });

  it('only RECEIVED orders are owed; an overpayment is kept and pays an order on receipt', async () => {
    const delivered = await orderAt(w, 'DELIVERED');
    const balance = await pay('100000.00');
    expect(balance.receivedTotal.toFixed(2)).toBe('0.00');
    expect(balance.overpaid.toFixed(2)).toBe('100000.00');
    expect(await paymentStatus(delivered.id)).toBe('UNPAID');

    // The customer confirms receipt: the order joins the debt and the credit covers it at once.
    await w.step(w.actors.sellerA, delivered.id, { to: 'RECEIVED' });
    expect(await paymentStatus(delivered.id)).toBe('PAID');
    const event = await w.prisma.orderEvent.findFirstOrThrow({
      where: { orderId: delivered.id, eventType: 'PAYMENT_STATUS_CHANGED' },
    });
    expect(event).toMatchObject({ actorUserId: w.ids.sellerA, actorRole: 'SELLER' });
    const row = await w.prisma.order.findUniqueOrThrow({ where: { id: delivered.id } });
    expect(row.receivedAt).not.toBeNull();
  });

  it('only the manager records; only the admin corrects or voids', async () => {
    for (const actor of [
      w.actors.admin,
      w.actors.accountant,
      w.actors.warehouse,
      w.actors.driver,
      w.actors.ownerA,
      w.actors.sellerA,
    ]) {
      expect(await failure(pay('1.00', actor))).toBeInstanceOf(ForbiddenError);
    }
    const balance = await pay('10.00');
    const paymentId = balance.payments[0]!.id;
    for (const actor of [w.actors.manager, w.actors.accountant, w.actors.ownerA]) {
      expect(
        await failure(w.payments.correctPayment(actor, paymentId, { amount: '5.00', reason: 'x' })),
      ).toBeInstanceOf(ForbiddenError);
      expect(
        await failure(w.payments.voidPayment(actor, paymentId, { reason: 'x' })),
      ).toBeInstanceOf(ForbiddenError);
    }
    // The accountant may look [P].
    expect((await w.payments.getBalance(w.actors.accountant, w.orgA)).paidTotal.toFixed(2)).toBe(
      '10.00',
    );
  });

  it('the admin corrects a wrong amount and voids a payment; the orders follow; a void is final', async () => {
    const order = await orderAt(w, 'RECEIVED');
    const full = (await usdOf(order.id)).toFixed(2);
    const recorded = await pay('0.01');
    const paymentId = recorded.payments[0]!.id;
    expect(await paymentStatus(order.id)).toBe('UNPAID');

    const corrected = await w.payments.correctPayment(w.actors.admin, paymentId, {
      amount: full,
      reason: 'typed 1 instead of the real amount',
    });
    expect(corrected.amountDue.toFixed(2)).toBe('0.00');
    expect(await paymentStatus(order.id)).toBe('PAID');
    expect(
      await w.prisma.auditLog.findFirstOrThrow({
        where: { action: 'ORGANIZATION_PAYMENT_CORRECTED' },
      }),
    ).toMatchObject({
      actorUserId: w.ids.admin,
      diff: {
        amount: { from: '0.01', to: full },
        amountUsd: { from: '0.010000', to: `${full}0000` },
        reason: { from: null, to: 'typed 1 instead of the real amount' },
      },
    });

    const voided = await w.payments.voidPayment(w.actors.admin, paymentId, { reason: 'duplicate' });
    expect(voided.paidTotal.toFixed(2)).toBe('0.00');
    expect(voided.payments[0]).toMatchObject({ voidReason: 'duplicate' });
    expect(await paymentStatus(order.id)).toBe('UNPAID');

    const again = await failure(
      w.payments.correctPayment(w.actors.admin, paymentId, { amount: '2.00', reason: 'x' }),
    );
    expect(again).toBeInstanceOf(ConflictError);
    expect(again).toMatchObject({ reason: 'PAYMENT_VOIDED' });
  });

  it('validates: positive decimal string, a past or today Tashkent day, never a future one', async () => {
    // 2026-10-20T20:00Z is already 2026-10-21 in Tashkent.
    t.clock.set(new Date('2026-10-20T20:00:00Z'));
    await w.payments.recordPayment(w.actors.manager, w.orgA, {
      amount: '1.00',
      currency: 'USD',
      paidOn: '2026-10-21',
    });
    await w.payments.recordPayment(w.actors.manager, w.orgA, {
      amount: '1.00',
      currency: 'USD',
      paidOn: '2025-01-31',
    });
    for (const command of [
      { amount: '1.00', currency: 'USD', paidOn: '2026-10-22' },
      { amount: '0', currency: 'USD', paidOn: '2026-10-20' },
      { amount: 5, currency: 'USD', paidOn: '2026-10-20' },
      { amount: '1.005', currency: 'USD', paidOn: '2026-10-20' },
      { amount: '1.00', currency: 'USD', paidOn: '20.10.2026' },
      { amount: '1.00', currency: 'USD', paidOn: '2026-10-20', comment: '   ' },
      { amount: '1.00', paidOn: '2026-10-20' },
      { amount: '1.00', currency: 'EUR', paidOn: '2026-10-20' },
    ]) {
      expect(
        await failure(w.payments.recordPayment(w.actors.manager, w.orgA, command as never)),
        JSON.stringify(command),
      ).toBeInstanceOf(InputValidationError);
    }
  });

  it('isolation: each organization owes only its own orders; customers see only their amount', async () => {
    await orderAt(w, 'RECEIVED');
    // orderAt receives as the shop owner of A; organization B's seller confirms its own order.
    const deliveredB = await orderAt(w, 'DELIVERED', { placedBy: w.actors.sellerB });
    await w.step(w.actors.sellerB, deliveredB.id, { to: 'RECEIVED' });
    await pay('100.00', w.actors.manager, w.orgB);

    const replyA = await call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor: w.actors.ownerA });
    const balanceA = expectParsed(replyA, 200, customerBalanceResponseSchema);
    assertCustomerSafe(replyA.body, w);
    // 3750.50 so'm is 0.312542 USD at the order's rate; back in whole so'm at the current rate.
    expect(balanceA).toEqual({ amountDue: '3751.00', currency: 'UZS' });

    const staffA = await w.payments.getBalance(w.actors.manager, w.orgA);
    expect(staffA.paidTotal.toFixed(2)).toBe('0.00');
    const replyB = await call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor: w.actors.sellerB });
    expect(expectParsed(replyB, 200, customerBalanceResponseSchema).amountDue).not.toBe(
      balanceA.amountDue,
    );

    // Staff have no "own" balance. A staff member on the customer route is the staff viewer
    // ([C] 2026-11-09, it used to be 403): zero, although both organizations owe money, and the
    // warehouse, who never sees money, is still turned away. Customers cannot reach the staff routes.
    const viewerReply = await call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor: w.actors.manager });
    expect(expectParsed(viewerReply, 200, customerBalanceResponseSchema)).toEqual({
      amountDue: '0.00',
      currency: 'UZS',
    });
    expect(
      (await call(CUSTOMER_BALANCE_ROUTES.getBalance, { actor: w.actors.warehouse })).status,
    ).toBe(403);
    expect(
      (
        await call(ORGANIZATION_PAYMENT_ROUTES.getBalance, {
          actor: w.actors.ownerA,
          params: { id: w.orgA },
        })
      ).status,
    ).toBe(403);
  });

  it('HTTP: the staff routes, the roles and the strict response', async () => {
    const recorded = await call(ORGANIZATION_PAYMENT_ROUTES.recordPayment, {
      actor: w.actors.manager,
      params: { id: w.orgA },
      body: { amount: '250000.00', currency: 'USD', paidOn: '2026-10-19', comment: 'naqd' },
    });
    const balance = expectParsed(recorded, 201, organizationBalanceResponseSchema);
    expect(balance.payments).toHaveLength(1);
    expect(balance.payments[0]).toMatchObject({
      amount: '250000.00',
      paidOn: '2026-10-19',
      comment: 'naqd',
      voidedAt: null,
    });

    for (const actor of [w.actors.warehouse, w.actors.driver]) {
      expect(
        (await call(ORGANIZATION_PAYMENT_ROUTES.getBalance, { actor, params: { id: w.orgA } }))
          .status,
      ).toBe(403);
    }
    expectError(
      await call(ORGANIZATION_PAYMENT_ROUTES.getBalance, {
        actor: w.actors.manager,
        params: { id: '01900000-0000-7000-8000-000000000000' },
      }),
      404,
      'NOT_FOUND',
    );
    const voided = await call(ORGANIZATION_PAYMENT_ROUTES.voidPayment, {
      actor: w.actors.admin,
      params: { id: balance.payments[0]!.id },
      body: { reason: 'wrong organization' },
    });
    expect(expectParsed(voided, 200, organizationBalanceResponseSchema).paidTotal).toBe('0.00');
  });

  it('concurrent payments and a receipt at the same time all count, and the statuses agree', async () => {
    const first = await orderAt(w, 'RECEIVED');
    const delivered = await orderAt(w, 'DELIVERED');
    const firstUsd = await usdOf(first.id);
    const half = firstUsd.dividedBy(2).toFixed(2);
    const rest = firstUsd
      .minus(half)
      .plus(await usdOf(delivered.id))
      .toFixed(2);
    await Promise.all([
      pay(half),
      pay(rest),
      w.step(w.actors.sellerA, delivered.id, { to: 'RECEIVED' }),
    ]);
    const balance = await w.payments.getBalance(w.actors.manager, w.orgA);
    expect(balance.amountDue.toFixed(2)).toBe('0.00');
    expect(await paymentStatus(first.id)).toBe('PAID');
    expect(await paymentStatus(delivered.id)).toBe('PAID');
  });

  it('the database never deletes a payment and never changes its origin or a void', async () => {
    const balance = await pay('5.00');
    const id = balance.payments[0]!.id;
    await expect(w.prisma.organizationPayment.delete({ where: { id } })).rejects.toThrow();
    await expect(
      w.prisma.organizationPayment.update({ where: { id }, data: { recordedBy: w.ids.admin } }),
    ).rejects.toThrow();
    await w.payments.voidPayment(w.actors.admin, id, { reason: 'test' });
    await expect(
      w.prisma.organizationPayment.update({ where: { id }, data: { comment: 'later' } }),
    ).rejects.toThrow();
  });
});
