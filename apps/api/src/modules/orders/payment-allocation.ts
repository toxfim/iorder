import { USD_SETTLED_UNDER, type PaymentStatus } from '@iorder/shared';
import { Prisma } from '../../generated/prisma/client.js';

// The organization's debt and the orders' PAID / UNPAID ([C] 2026-10-26). PURE.
// Payments belong to the organization, not to an order: they cover its RECEIVED orders oldest
// first. An order is PAID only when the money left after every older order covers it in full; the
// first order it does not cover takes the rest, so it and every newer order stay UNPAID. Every
// figure here is USD (owner rule): an order at its rate from submit, a payment at its USD value.
// A difference under half a cent is settled [P]: see USD_SETTLED_UNDER.

export interface ReceivedOrderForAllocation {
  id: string;
  totalUsd: Prisma.Decimal;
  paymentStatus: PaymentStatus;
}

export interface OrganizationBalance {
  receivedTotal: Prisma.Decimal;
  paidTotal: Prisma.Decimal;
  /** receivedTotal - paidTotal, never below zero; zero when under half a cent. */
  amountDue: Prisma.Decimal;
  /** paidTotal - receivedTotal, never below zero; zero when under half a cent. */
  overpaid: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const SETTLED_UNDER = new Prisma.Decimal(USD_SETTLED_UNDER);

export function balanceOf(
  receivedTotal: Prisma.Decimal,
  paidTotal: Prisma.Decimal,
): OrganizationBalance {
  const difference = receivedTotal.minus(paidTotal);
  const settled = difference.abs().lessThan(SETTLED_UNDER);
  return {
    receivedTotal,
    paidTotal,
    amountDue: !settled && difference.isPositive() ? difference : ZERO,
    overpaid: !settled && difference.isNegative() ? difference.negated() : ZERO,
  };
}

/**
 * The orders whose payment status must change, given the received orders OLDEST FIRST and the
 * organization's paid total, both in USD. The walk stops at the first order not covered, and an order
 * is covered only by money really left for it: an order worth almost nothing is never PAID without a
 * payment, nor ahead of an older UNPAID one. The money left may go a little below zero after a settled
 * order, which carries the shortfall over, so the tolerance is one half cent in all, not one per order.
 */
export function allocatePayments(
  ordersOldestFirst: readonly ReceivedOrderForAllocation[],
  paidTotal: Prisma.Decimal,
): { id: string; from: PaymentStatus; to: PaymentStatus }[] {
  let left = paidTotal;
  let walking = true;
  const changes: { id: string; from: PaymentStatus; to: PaymentStatus }[] = [];
  for (const order of ordersOldestFirst) {
    walking =
      walking && left.greaterThan(ZERO) && order.totalUsd.minus(left).lessThan(SETTLED_UNDER);
    if (walking) left = left.minus(order.totalUsd);
    const next: PaymentStatus = walking ? 'PAID' : 'UNPAID';
    if (next !== order.paymentStatus) {
      changes.push({ id: order.id, from: order.paymentStatus, to: next });
    }
  }
  return changes;
}
