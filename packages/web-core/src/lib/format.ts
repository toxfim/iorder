// Number, money and date formatting per docs/private/design/v1/specs.md section 7.
//
// Money and quantities travel as decimal STRINGS (or bigint), never as float (CLAUDE.md hard
// rule 1). These helpers therefore group digits with string operations only: no Number(), no
// arithmetic, no Intl.NumberFormat on the amount (it would round-trip through a double).

import { BUSINESS_TIME_ZONE } from '@iorder/shared';

export type DecimalInput = string | bigint;

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Decimal separator of a UI language: a comma in Uzbek and Russian, a dot in English. */
export function decimalSeparatorFor(locale: string): ',' | '.' {
  return locale.toLowerCase() === 'en' ? '.' : ',';
}

export interface FormatNumberOptions {
  /** Pad the fraction with zeros up to this many digits. Default 0. */
  readonly minFractionDigits?: number;
  /** Default `,` (the money rule of specs.md section 7). */
  readonly decimalSeparator?: string;
}

/**
 * `1690000` -> `1 690 000`, `3.10` -> `3,1`. Thousands separator is a plain space (not NBSP),
 * the decimal separator is a comma. The value is never rounded: trailing fraction zeros are
 * dropped and every other digit is shown as given.
 */
export function formatNumber(value: DecimalInput, options: FormatNumberOptions = {}): string {
  const match = DECIMAL_PATTERN.exec(String(value));
  if (!match) {
    // Showing a wrong amount is worse than failing loudly, so malformed input is rejected.
    throw new RangeError(`Not a decimal number: ${String(value)}`);
  }
  const sign = match[1] ?? '';
  const integerPart = match[2] ?? '0';
  const fractionRaw = (match[3] ?? '').replace(/0+$/, '');
  const fraction = fractionRaw.padEnd(options.minFractionDigits ?? 0, '0');

  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const isZero = /^0*$/.test(integerPart) && fraction === '';
  return `${isZero ? '' : sign}${grouped}${fraction ? `${options.decimalSeparator ?? ','}${fraction}` : ''}`;
}

/** UZS amounts: the number only. The currency label comes from i18n (`common.currency`). */
export function formatMoney(amount: DecimalInput): string {
  return formatNumber(amount);
}

export type DateInput = Date | string | number;

// ISO 8601 with an explicit zone: `...Z` or an offset such as `+05:00`.
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;

/**
 * Timestamps from the API must be ISO 8601 strings WITH a zone (`Z` or an offset). A zone-less
 * string such as `2026-10-19T08:30:00` would be parsed in the browser's local zone, which shows
 * a different time to people in different zones, so it is rejected instead of guessed. Date
 * objects and epoch numbers are unambiguous and accepted.
 */
function toDate(input: DateInput): Date {
  if (typeof input === 'string' && !ZONED_ISO_PATTERN.test(input)) {
    throw new RangeError(`Timestamp must be ISO 8601 with a zone (Z or +hh:mm): ${input}`);
  }
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a valid date: ${String(input)}`);
  }
  return date;
}

function zonedParts(input: DateInput, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // h23 avoids the "24:00" some engines print at midnight with hour12: false.
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(toDate(input))) {
    parts[part.type] = part.value;
  }
  return parts;
}

/** `DD.MM.YYYY`. Timestamps are UTC; they are shown in the business time zone (Asia/Tashkent). */
export function formatDate(input: DateInput, timeZone: string = BUSINESS_TIME_ZONE): string {
  const p = zonedParts(input, timeZone);
  return `${p.day}.${p.month}.${p.year}`;
}

/** `HH:MM` in the business time zone. */
export function formatTime(input: DateInput, timeZone: string = BUSINESS_TIME_ZONE): string {
  const p = zonedParts(input, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function formatDateTime(input: DateInput, timeZone: string = BUSINESS_TIME_ZONE): string {
  return `${formatDate(input, timeZone)} ${formatTime(input, timeZone)}`;
}

/** `19.10`: day and month in the business time zone (v1 shows it for orders and chart labels). */
export function formatDayMonth(input: DateInput, timeZone: string = BUSINESS_TIME_ZONE): string {
  const p = zonedParts(input, timeZone);
  return `${p.day}.${p.month}`;
}

/** `19.10 · 09:12` (v1 order lists). */
export function formatShortDateTime(
  input: DateInput,
  timeZone: string = BUSINESS_TIME_ZONE,
): string {
  return `${formatDayMonth(input, timeZone)} · ${formatTime(input, timeZone)}`;
}

/** `03.2026`: month and year ("customer since"). */
export function formatMonthYear(input: DateInput, timeZone: string = BUSINESS_TIME_ZONE): string {
  const p = zonedParts(input, timeZone);
  return `${p.month}.${p.year}`;
}
