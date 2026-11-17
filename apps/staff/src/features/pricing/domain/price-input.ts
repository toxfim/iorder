import { moneyStringSchema, type MoneyString } from '@iorder/shared';

// Whitespace people type or paste as thousands separators ("1 690 000"). The whitespace
// class also covers the NBSP and narrow NBSP that Telegram and spreadsheets produce.
const SPACES = /\s/g;

/**
 * Turns what a person typed into the wire format candidate: no grouping spaces, a decimal comma
 * becomes a dot. It never rounds or reinterprets digits; whether the result is a valid price is
 * decided by the shared schema only.
 */
export function normalizePriceInput(raw: string): string {
  return raw.replace(SPACES, '').replace(',', '.');
}

export type PriceInputIssue = 'empty' | 'invalid';

export type PriceInputResult =
  | { readonly ok: true; readonly value: MoneyString }
  | { readonly ok: false; readonly reason: PriceInputIssue };

/** Client-side check with the SAME rule as the api (`moneyStringSchema` from @iorder/shared). */
export function parsePriceInput(raw: string): PriceInputResult {
  const candidate = normalizePriceInput(raw);
  if (candidate === '') return { ok: false, reason: 'empty' };
  const parsed = moneyStringSchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid' };
}

/** `1690000` and `1690000.5` both become two-fraction-digit strings, like the api responds. */
export function canonicalMoney(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  return `${integer}.${fraction.padEnd(2, '0')}`;
}

/** String comparison only: money is never converted to a float. */
export function sameMoney(a: string, b: string): boolean {
  return canonicalMoney(a) === canonicalMoney(b);
}

/** `1690000.50` -> `1690000,5` for an input: no grouping spaces, comma decimal, no dead zeros. */
export function toInputValue(price: string): string {
  const [integer = '', fraction = ''] = canonicalMoney(price).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? integer : `${integer},${trimmed}`;
}
