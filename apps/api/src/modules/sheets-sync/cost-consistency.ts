import { Prisma } from '../../generated/prisma/client.js';

/**
 * How far `cost_uzs` may be from `cost_usd * usd_rate_used` before the sync reports a mismatch:
 * 0.5% relative. The sheet shows USD costs rounded to cents, so rounding alone moves the UZS
 * figure by up to $0.005 / cost, which is under 0.5% for any item costing more than $1;
 * typing errors (a wrong rate, a missing digit) move it by far more. The ONE place to tune it.
 *
 * Who owns the number (the sheet's UZS figure or our own product) is an open product decision,
 * so a mismatch is REPORTED, never rejected, and the stored value is the one the sheet gave.
 */
export const COST_UZS_RELATIVE_TOLERANCE = new Prisma.Decimal('0.005');

export interface ConsistencyCheck {
  consistent: boolean;
  /**
   * Signed percentage by which the stored UZS cost differs from USD x rate (positive = UZS is
   * higher), two decimals. null when USD x rate is zero, so no ratio exists. Never a cost value.
   */
  differencePercent: string | null;
}

export function checkCostUzs(row: {
  costUsd: Prisma.Decimal;
  usdRateUsed: Prisma.Decimal;
  costUzs: Prisma.Decimal;
}): ConsistencyCheck {
  const expected = row.costUsd.mul(row.usdRateUsed);
  if (expected.isZero()) {
    return { consistent: row.costUzs.isZero(), differencePercent: null };
  }
  const relative = row.costUzs.minus(expected).div(expected);
  return {
    consistent: relative.abs().lessThanOrEqualTo(COST_UZS_RELATIVE_TOLERANCE),
    differencePercent: relative.mul(100).toFixed(2),
  };
}
