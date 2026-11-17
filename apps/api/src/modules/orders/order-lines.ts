import { Prisma } from '../../generated/prisma/client.js';

// Hard rule 1: money and quantities are exact decimals (Prisma.Decimal), never floats. Quantities
// cross the service boundary as decimal STRINGS, like prices do.

/** DECIMAL(18,3) column, but a sane business ceiling keeps line totals inside DECIMAL(18,2). */
export const MAX_QUANTITY = new Prisma.Decimal('999999');
/** DECIMAL(18,2): 16 integer digits. */
export const MAX_AMOUNT = new Prisma.Decimal('9999999999999999.99');

const QUANTITY_PATTERN = /^\d{1,6}(\.\d{1,3})?$/;

/**
 * Returns the quantity, or null when the text is not a positive WHOLE number of pieces (owner
 * 2026-10-25: no fractional quantities; `2.000` is still accepted as 2).
 */
export function parseQuantity(input: string): Prisma.Decimal | null {
  if (!QUANTITY_PATTERN.test(input)) return null;
  const value = new Prisma.Decimal(input);
  return value.isInteger() && value.greaterThan(0) && value.lessThanOrEqualTo(MAX_QUANTITY)
    ? value
    : null;
}

/** Canonical form stored and shown: always three decimals. */
export function formatQuantity(value: Prisma.Decimal): string {
  return value.toFixed(3);
}

export function formatAmount(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

/**
 * quantity x unit price, rounded half up to the currency's two decimals. The database CHECK
 * `order_items_line_total_exact` recomputes it with round(numeric, 2) (half away from zero, the
 * same for positive numbers), so the two can never disagree silently.
 */
export function lineTotal(quantity: Prisma.Decimal, unitPrice: Prisma.Decimal): Prisma.Decimal {
  return quantity.mul(unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function sumAmounts(amounts: readonly Prisma.Decimal[]): Prisma.Decimal {
  return amounts.reduce((sum, amount) => sum.plus(amount), new Prisma.Decimal(0));
}

/** True when the amount fits the DECIMAL(18,2) money columns. */
export function fitsMoney(amount: Prisma.Decimal): boolean {
  return amount.lessThanOrEqualTo(MAX_AMOUNT);
}

/** DECIMAL(18,6), the USD debt columns: 12 integer digits. */
const MAX_USD = new Prisma.Decimal('999999999999.999999');

/** True when the amount fits the DECIMAL(18,6) USD debt columns. */
export function fitsUsd(amount: Prisma.Decimal): boolean {
  return amount.lessThanOrEqualTo(MAX_USD);
}

/** A stored USD figure for the history: all six decimals, what the debt really counts. */
export function formatUsdExact(value: Prisma.Decimal): string {
  return value.toFixed(6);
}
