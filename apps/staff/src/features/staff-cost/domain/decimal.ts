// Fixed-point helpers for the cost screens (hard rule 1: never a float). Contract decimals are
// strings with a fixed number of fraction digits: quantity 3, USD cost and rate 4, so'm 2.

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** `"128.5000"` with scale 4 -> `1285000n`. Extra fraction digits are an error, not rounded. */
export function toScaled(value: string, scale: number): bigint {
  const match = DECIMAL.exec(value);
  if (!match) throw new RangeError(`Not a decimal string: ${value}`);
  const fraction = match[2] ?? '';
  if (fraction.length > scale) throw new RangeError(`More than ${scale} fraction digits: ${value}`);
  return (
    BigInt(match[1] ?? '0') * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0')
  );
}

export function fromScaled(value: bigint, scale: number): string {
  const unit = 10n ** BigInt(scale);
  const fraction = (value % unit).toString().padStart(scale, '0');
  return `${value / unit}.${fraction}`;
}

/** USD cost x rate = so'm with two fraction digits, rounded half up (4 + 4 digits -> 2). */
export function usdToUzs(costUsd: string, rate: string): string {
  const product = toScaled(costUsd, 4) * toScaled(rate, 4); // 8 fraction digits
  const cents = (product + 500_000n) / 1_000_000n;
  return fromScaled(cents, 2);
}

/**
 * A so'm amount derived from a USD cost, rounded half up to whole so'm. DISPLAY ONLY: the wire
 * and every calculation keep the exact two-digit value; nobody counts tiyin on a cost label.
 */
export function roundUzsForDisplay(uzs: string): string {
  const match = DECIMAL.exec(uzs);
  if (!match) throw new RangeError(`Not a decimal string: ${uzs}`);
  const whole = BigInt(match[1] ?? '0');
  const firstFractionDigit = match[2]?.[0] ?? '0';
  return (firstFractionDigit >= '5' ? whole + 1n : whole).toString();
}

export function addQuantities(values: readonly string[]): string {
  return fromScaled(
    values.reduce((sum, value) => sum + toScaled(value, 3), 0n),
    3,
  );
}

/** Below this many pieces the stock dot is amber (docs/private/design/v1/specs.md: "kam qoldiq" < 20). */
export const LOW_STOCK_BELOW = 20;

export type StockLevel = 'unknown' | 'out' | 'low' | 'ok';

/** Green / amber / red of the stock dot; `unknown` when the product has no stock aggregate. */
export function stockLevel(quantity: string | null): StockLevel {
  if (quantity === null) return 'unknown';
  const thousandths = toScaled(quantity, 3);
  if (thousandths === 0n) return 'out';
  return thousandths < BigInt(LOW_STOCK_BELOW) * 1000n ? 'low' : 'ok';
}

/** Decimal string comparison for 3-digit quantities. */
export function isPositiveQuantity(quantity: string | null): boolean {
  return quantity !== null && toScaled(quantity, 3) > 0n;
}
