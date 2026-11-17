import { fromCents, toCents } from './money';

// Order quantities travel as decimal STRINGS with at most 3 fraction digits (never a float, hard
// rule 1). Arithmetic runs on bigint thousandths. The server is the source of truth for every
// total; these helpers only preview a draft before it is saved.

const QUANTITY = /^(\d+)(?:\.(\d{1,3}))?$/;

export function toMilli(quantity: string): bigint {
  const match = QUANTITY.exec(quantity);
  if (!match) throw new RangeError(`Not a quantity string: ${quantity}`);
  return BigInt(match[1] ?? '0') * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0');
}

/** `10500` -> `10.5`, `10000` -> `10`: no trailing zeros, as a request body wants it. */
export function fromMilli(milli: bigint): string {
  if (milli < 0n) throw new RangeError('A quantity cannot be negative');
  const fraction = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${milli / 1000n}${fraction ? `.${fraction}` : ''}`;
}

/** The same value in the one canonical spelling, so `10.0` and `10` compare equal. */
export const normalizeQuantity = (quantity: string): string => fromMilli(toMilli(quantity));

export const isSameQuantity = (a: string, b: string): boolean => toMilli(a) === toMilli(b);

/** `quantity + delta` in whole units; a result of zero or less is `null` (the line is removed). */
export function stepQuantity(quantity: string, delta: number): string | null {
  const next = toMilli(quantity) + BigInt(delta) * 1000n;
  return next > 0n ? fromMilli(next) : null;
}

/** `unitPrice x quantity`, rounded half up to the cent like the server's line total. */
export function lineTotal(unitPrice: string, quantity: string): string {
  const product = toCents(unitPrice) * toMilli(quantity);
  return fromCents((product + 500n) / 1000n);
}
