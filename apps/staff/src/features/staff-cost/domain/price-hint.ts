import { canonicalMoney, parsePriceInput } from '@/features/pricing/domain/price-input';
import { toScaled } from './decimal';

export interface PriceHint {
  /** (price - cost) / cost, in tenths of a percent (123n = 12.3 %). */
  readonly markupTenths: bigint;
  /** (price - cost) / price, in tenths of a percent. */
  readonly marginTenths: bigint;
  readonly belowCost: boolean;
}

/** Divides rounding half away from zero; `denominator` is positive. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude + denominator / 2n) / denominator;
  return negative ? -quotient : quotient;
}

/**
 * Information next to a selling price being typed: markup and margin against the latest delivery
 * cost. Both are USD [owner 2026-10-29: prices are entered in USD; the cost is the sheet's USD
 * purchase price], so no rate is involved. It is only a hint, never a rule: nothing is blocked.
 * Null while the input is not a valid price or the product has no (or a zero) cost to compare with.
 */
export function priceHint(rawPriceUsd: string, latestCostUsd: string | null): PriceHint | null {
  if (latestCostUsd === null) return null;
  const parsed = parsePriceInput(rawPriceUsd);
  if (!parsed.ok) return null;
  // Both at the cost's scale (4 fraction digits); a price has at most 2.
  const cost = toScaled(latestCostUsd, 4);
  const price = toScaled(canonicalMoney(parsed.value), 4);
  if (cost === 0n || price === 0n) return null;
  const difference = price - cost;
  return {
    markupTenths: divideRounded(difference * 1000n, cost),
    marginTenths: divideRounded(difference * 1000n, price),
    belowCost: price < cost,
  };
}

/** `123n` -> `+12,3%`, `-50n` -> `-5,0%` (one decimal, the locale's separator). */
export function formatTenthsPercent(tenths: bigint, decimalSeparator: string): string {
  const negative = tenths < 0n;
  const magnitude = negative ? -tenths : tenths;
  const sign = negative ? '-' : tenths > 0n ? '+' : '';
  return `${sign}${magnitude / 10n}${decimalSeparator}${magnitude % 10n}%`;
}

/** Inactive products cannot be sold: they are listed apart, not as work to do. */
export function splitByActive<T extends { readonly isActive: boolean }>(
  items: readonly T[],
): { readonly active: T[]; readonly inactive: T[] } {
  return {
    active: items.filter((item) => item.isActive),
    inactive: items.filter((item) => !item.isActive),
  };
}
