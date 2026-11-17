import { BUSINESS_TIME_ZONE } from '@iorder/shared';

// The ONE place for "what day / hour is it for the business" (CLAUDE.md hard rule 9): everything
// is stored and compared in UTC, and calendar questions are answered in Asia/Tashkent here, so a
// test can inject a fake clock.

export interface Clock {
  now: () => Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface BusinessDate {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  readonly day: number;
  /** 0 = Sunday ... 6 = Saturday */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
  hourCycle: 'h23',
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Calendar fields of an instant as people in Tashkent read them. */
export function businessParts(instant: Date | string | number): BusinessDate {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function isSameBusinessDay(a: Date | string | number, b: Date | string | number): boolean {
  const x = businessParts(a);
  const y = businessParts(b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/**
 * The UTC instant at which the Tashkent wall clock shows the given date and time. The offset is
 * measured, not hard-coded, so the helper stays correct if the zone rules ever change.
 */
export function businessInstant(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const seen = businessParts(guess);
  const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  return new Date(guess - (asUtc - guess));
}

/** The same wall-clock time `days` calendar days earlier (negative: later) in Tashkent. */
export function shiftBusinessDays(instant: Date, days: number): Date {
  const p = businessParts(instant);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day - days));
  return businessInstant(
    { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() },
    p.hour,
    p.minute,
  );
}
