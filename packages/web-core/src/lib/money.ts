// Decimal money as strings, computed with bigint cents (CLAUDE.md hard rule 1: never float).
// UZS has two fraction digits in the contract. Inputs here are contract money strings such as
// "1690000.00" or "1690000".

const MONEY = /^(\d+)(?:\.(\d{1,2}))?$/;

/** True for a contract money string (non-negative, at most two decimals); `toCents` accepts exactly these. */
export function isMoney(value: string): boolean {
  return MONEY.test(value);
}

export function toCents(value: string): bigint {
  const match = MONEY.exec(value);
  if (!match) throw new RangeError(`Not a money string: ${value}`);
  return BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${abs / 100n}.${fraction}`;
}

export function sumMoney(values: readonly string[]): string {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0n));
}

/** `unitPrice x quantity` for a whole-number quantity. */
export function multiplyMoney(unitPrice: string, quantity: number): string {
  if (!Number.isInteger(quantity) || quantity < 0)
    throw new RangeError('Quantity must be a whole number');
  return fromCents(toCents(unitPrice) * BigInt(quantity));
}

/** Average per item, rounded half up to the cent. */
export function averageMoney(total: string, count: number): string {
  if (count <= 0) return fromCents(0n);
  const divisor = BigInt(count);
  return fromCents((toCents(total) * 2n + divisor) / (divisor * 2n));
}

/**
 * `27,8 mln` (`27.8 mln` with a dot separator): millions of so'm with one decimal (half up),
 * without a float.
 */
export function formatMillions(value: string, unit: string, decimalSeparator = ','): string {
  const tenths = (toCents(value) + 5_000_000n) / 10_000_000n;
  return `${tenths / 10n}${decimalSeparator}${tenths % 10n} ${unit}`;
}

/** Percent change `(total - previous) / previous` with one decimal, as `+8,3%` / `-2,0%`. */
export function formatPercentChange(
  total: string,
  previous: string,
  decimalSeparator = ',',
): { text: string; positive: boolean } {
  const base = toCents(previous);
  if (base === 0n) return { text: `0${decimalSeparator}0%`, positive: true };
  const delta = toCents(total) - base;
  const negative = delta < 0n;
  const abs = negative ? -delta : delta;
  // tenths of a percent, rounded half up
  const tenths = (abs * 1000n * 2n + base) / (base * 2n);
  const text = `${negative ? '-' : '+'}${tenths / 10n}${decimalSeparator}${tenths % 10n}%`;
  return { text, positive: !negative };
}

const RATE = /^(\d+)(?:\.(\d{1,4}))?$/;

/** A USD rate (at most 4 decimals) in ten-thousandths. */
function rateUnits(rate: string): bigint {
  const match = RATE.exec(rate);
  if (!match) throw new RangeError(`Not a rate: ${rate}`);
  return BigInt(match[1] ?? '0') * 10_000n + BigInt((match[2] ?? '').padEnd(4, '0') || '0');
}

/**
 * So'm to USD: round(amount / rate, 2), half up. The server owns the real figures; the fake backends
 * use this to answer like it, and the payment form to preview what the manager typed.
 */
export function uzsToUsd(uzs: string, rate: string): string {
  const units = rateUnits(rate);
  return fromCents((toCents(uzs) * 10_000n * 2n + units) / (units * 2n));
}

/** The debt figure: round(amount / rate, 6), half up, as the server stores it. Fake backends only. */
export function uzsToUsdExact(uzs: string, rate: string): string {
  const units = rateUnits(rate);
  // so'm / rate x 10^6, from cents (so'm x 10^2) and ten-thousandths of a rate (rate x 10^4).
  const micros = (toCents(uzs) * 100_000_000n * 2n + units) / (units * 2n);
  return microsToUsdExact(micros);
}

/** Millionths of a dollar as a six-decimal string. Fake backends only. */
export function microsToUsdExact(micros: bigint): string {
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}

const USD_EXACT = /^(\d+)(?:\.(\d{1,6}))?$/;

/** USD of up to six decimals in millionths, for adding up without a float. Fake backends only. */
export function usdToMicros(usd: string): bigint {
  const match = USD_EXACT.exec(usd);
  if (!match) throw new RangeError(`Not a USD figure: ${usd}`);
  return BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
}

/** Millionths of a dollar as a two-decimal contract money string, half up. Fake backends only. */
export function microsToMoney(micros: bigint): string {
  return fromCents((micros + 5_000n) / 10_000n);
}

/** USD to whole so'm, half up (the server's rule for customers' figures). */
export function usdToUzs(usd: string, rate: string): string {
  const parts = 10_000_000_000n; // millionths of a dollar x ten-thousandths of a rate
  return fromCents(((usdToMicros(usd) * rateUnits(rate) * 2n + parts) / (parts * 2n)) * 100n);
}

/** Compare two money strings without parsing them as numbers. */
export function compareMoney(a: string, b: string): number {
  const x = toCents(a);
  const y = toCents(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
