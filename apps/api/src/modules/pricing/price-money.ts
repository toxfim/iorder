import { PRICE_PATTERN } from '@iorder/shared';
import { Prisma } from '../../generated/prisma/client.js';

// Hard rule 1: money is never a float. Prices cross the API as decimal STRINGS and become
// Prisma.Decimal (arbitrary precision) immediately. The format rules (PRICE_PATTERN: DECIMAL(18,2),
// no rounding, no sign/exponent/separators) are defined once in @iorder/shared.

/** Returns the price, or null when the text is not a valid positive price. */
export function parsePrice(input: string): Prisma.Decimal | null {
  if (!PRICE_PATTERN.test(input)) return null;
  const value = new Prisma.Decimal(input);
  return value.greaterThan(0) ? value : null;
}

/**
 * A list price in UZS. A UZS item is already in UZS; a USD item [owner 2026-10-29] is converted
 * with `usdRate` and rounded to whole so'm, half up (owner 2026-10-29, "× kurs, butun so'm").
 * null = a USD price while no rate is known.
 */
export function toUzs(
  amount: Prisma.Decimal,
  currency: string,
  usdRate: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (currency === 'UZS') return amount;
  if (currency !== 'USD') throw new Error(`Unknown price list currency ${currency}`);
  if (usdRate === null) return null;
  return amount.times(usdRate).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * A list price in USD: a USD item as is, an older UZS item divided by `usdRate` (cents, half up, a
 * price is never shown with more). null = a UZS price while no rate is known.
 */
export function toUsd(
  amount: Prisma.Decimal,
  currency: string,
  usdRate: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (currency === 'USD') return amount;
  if (currency !== 'UZS') throw new Error(`Unknown price list currency ${currency}`);
  if (usdRate === null) return null;
  return dividedHalfUp(amount, usdRate, 2);
}

// Default Decimal division keeps 20 significant digits. Rounding that result again could decide a
// half unit wrongly on a large amount, and a database CHECK recomputes the same figure.
const ExactDecimal = Prisma.Decimal.clone({ precision: 60 });

function dividedHalfUp(
  amount: Prisma.Decimal,
  usdRate: Prisma.Decimal,
  decimals: number,
): Prisma.Decimal {
  const exact = new ExactDecimal(amount.toString()).dividedBy(usdRate.toString());
  return new Prisma.Decimal(
    exact.toDecimalPlaces(decimals, Prisma.Decimal.ROUND_HALF_UP).toFixed(decimals),
  );
}

/**
 * A so'm amount in debt USD: round(amount / rate, 6), half up [P]. Six decimals so that so'm amounts
 * converted one by one still add up to the conversion of their sum, within USD_SETTLED_UNDER. The
 * ONE conversion behind a so'm-priced order line and a so'm payment's USD value; the database CHECK
 * `organization_payments_usd_value_exact` recomputes it with round(numeric, 6).
 */
export function uzsToUsd(amount: Prisma.Decimal, usdRate: Prisma.Decimal): Prisma.Decimal {
  return dividedHalfUp(amount, usdRate, 6);
}

/** Canonical API form: always two fraction digits, never exponent notation. */
export function formatMoney(value: Prisma.Decimal): string {
  return value.toFixed(2);
}
