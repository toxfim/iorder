import { BUSINESS_TIME_ZONE } from '@iorder/shared';

export interface BusinessTimeParts {
  year: number;
  month: number;
  day: number;
  /** ISO weekday: Monday = 1 ... Sunday = 7. */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAY_BY_SHORT_NAME: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

/** Wall-clock parts of an instant in Asia/Tashkent. Instants themselves stay in UTC. */
export function getBusinessTimeParts(instant: Date): BusinessTimeParts {
  const parts = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_BY_SHORT_NAME[parts.get('weekday') ?? ''];
  if (weekday === undefined) {
    throw new Error(`Unexpected weekday value: ${parts.get('weekday')}`);
  }
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    weekday,
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
  };
}

/**
 * The UTC instant of a Tashkent WALL-CLOCK time: the inverse of getBusinessTimeParts. Used for the
 * sheet's «Дата» (a timestamp written in local time). Returns null for a time that does not exist:
 * an impossible calendar date (31.02), hour > 23, minute or second > 59. Seconds count; the
 * instant is exact.
 */
export function businessTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | null {
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }
  // The offset of the zone at that moment, found from the zone's own rules (no hard-coded +05:00).
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const local = getBusinessTimeParts(new Date(naive));
  const offsetMs =
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - naive;
  const instant = new Date(naive - offsetMs + second * 1000);
  const check = getBusinessTimeParts(instant);
  const roundTrips =
    check.year === year &&
    check.month === month &&
    check.day === day &&
    check.hour === hour &&
    check.minute === minute;
  return roundTrips ? instant : null;
}

/**
 * The UTC instant at which the given calendar date STARTS in Asia/Tashkent (local 00:00), or null
 * when the date does not exist in the calendar (for example 31.02.2026).
 */
export function businessMidnightUtc(year: number, month: number, day: number): Date | null {
  return businessTimeToUtc(year, month, day, 0, 0, 0);
}

export interface BusinessDay {
  /** The calendar date in Asia/Tashkent, YYYY-MM-DD. */
  date: string;
  /** Inclusive start (local 00:00) as a UTC instant. */
  start: Date;
  /** Exclusive end (the next local 00:00) as a UTC instant. */
  end: Date;
}

/** The Asia/Tashkent calendar day an instant falls into, as a half-open UTC range. */
export function businessDayOf(instant: Date): BusinessDay {
  const { year, month, day } = getBusinessTimeParts(instant);
  // Date.UTC normalizes day overflow (31 Dec + 1 = 1 Jan), so the next date needs no calendar code.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const start = businessMidnightUtc(year, month, day);
  const end = businessMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  if (start === null || end === null) {
    throw new Error('Unreachable: the parts of a real instant are a real date');
  }
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return { date: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`, start, end };
}
