import { isMoney } from '@core/lib/money';

const MINUTE_MS = 60_000;

/** A total that can be compared; anything else sorts last (see `hasSortValue` of a column). */
export function hasValidTotal(value: string | null): value is string {
  return value !== null && isMoney(value);
}

/**
 * Whole minutes since an order was submitted. null when the instant is not a date or lies in the
 * future (clock skew): the screen then shows nothing instead of a made-up "under a minute".
 */
export function orderAgeMinutes(submittedAt: string, now: Date): number | null {
  const since = Date.parse(submittedAt);
  if (!Number.isFinite(since)) return null;
  const elapsed = now.getTime() - since;
  return elapsed < 0 ? null : Math.floor(elapsed / MINUTE_MS);
}
