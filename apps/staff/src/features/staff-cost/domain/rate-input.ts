import { usdRateStringSchema } from '@iorder/shared/staff-cost';
import { toScaled } from './decimal';

/** Same plausibility band the api applies to the Central Bank rate (so'm per US dollar). */
export const USD_RATE_PLAUSIBLE_MIN = 5_000;
export const USD_RATE_PLAUSIBLE_MAX = 30_000;
/** A new manual rate that differs from the current one by more than this needs a confirmation. */
export const USD_RATE_MAX_CHANGE_PERCENT = 25;

const RATE_SCALE = 4;
const RATE_UNIT = 10n ** BigInt(RATE_SCALE);

// "12650", "12650.5"
const PLAIN = /^\d+(?:\.\d+)?$/;
// Thousands grouped by spaces (incl. NBSP / narrow NBSP from Telegram and spreadsheets) or by
// commas, en-US style: "12 650", "12,650", "12,650.50". Groups of exactly three digits only.
const GROUPED_SPACE = /^\d{1,3}(?:\s\d{3})+(?:\.\d+)?$/;
const GROUPED_COMMA = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

export type RateInputResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'empty' | 'invalid' | 'ambiguous' };

/**
 * Turns what a person typed into the wire format and checks it with the SAME schema as the api
 * (`usdRateStringSchema`: positive, at most 4 fraction digits). The dot is the only decimal
 * separator; a comma is accepted only as a thousands separator. "12,65" could mean 12.65 or
 * 12 650, so it is rejected instead of guessed (the real rate is about twelve thousand).
 */
export function parseRateInput(raw: string): RateInputResult {
  const typed = raw.trim();
  if (typed === '') return { ok: false, reason: 'empty' };
  let candidate: string;
  if (PLAIN.test(typed)) candidate = typed;
  else if (GROUPED_SPACE.test(typed)) candidate = typed.replace(/\s/g, '');
  else if (GROUPED_COMMA.test(typed)) candidate = typed.replace(/,/g, '');
  else return { ok: false, reason: typed.includes(',') ? 'ambiguous' : 'invalid' };
  const parsed = usdRateStringSchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid' };
}

export type RateAssessment = 'ok' | 'outsideBand' | 'bigChange';

/** Whether a valid new rate needs a second look before it is saved (decimal strings, bigint). */
export function assessRate(next: string, current: string | null): RateAssessment {
  const value = toScaled(next, RATE_SCALE);
  const min = BigInt(USD_RATE_PLAUSIBLE_MIN) * RATE_UNIT;
  const max = BigInt(USD_RATE_PLAUSIBLE_MAX) * RATE_UNIT;
  if (value < min || value > max) return 'outsideBand';
  if (current === null) return 'ok';
  const old = toScaled(current, RATE_SCALE);
  if (old === 0n) return 'ok';
  const delta = value > old ? value - old : old - value;
  return delta * 100n > old * BigInt(USD_RATE_MAX_CHANGE_PERCENT) ? 'bigChange' : 'ok';
}

/** `12650.0000` -> `12650` for an input: no dead zeros, a dot for the fraction. */
export function rateToInput(rate: string): string {
  const [integer = '0', fraction = ''] = rate.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? integer : `${integer}.${trimmed}`;
}
