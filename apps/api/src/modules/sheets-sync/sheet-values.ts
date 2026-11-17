import { businessMidnightUtc, businessTimeToUtc } from '../../common/clock/business-time.js';

// ALL knowledge about how the sheet WRITES numbers and dates lives in this module (and its test).
// The formats below are CONFIRMED from the real sheet (inspected read-only on 2026-10-21):
//   * numbers: the en-US locale. The comma is the THOUSANDS separator and the dot the DECIMAL
//     separator: `35`, `12.34`, `12,650` (twelve thousand six hundred fifty), `1,690,000`.
//   * «Дата»: `DD/MM/YYYY HH:MM:SS` (day first, slashes, 24-hour time with seconds), written in
//     Tashkent local time.
// Everything is strict: a cell that does not match is rejected, never guessed.
//
// Cells arrive as TEXT, exactly as a sheet shows them (the Sheets API returns formatted strings).
// A JSON number is not accepted: a float would already have lost the digits we must keep.

/** The number locale of the real sheet (confirmed 2026-10-21): comma groups thousands, dot is decimal. */
export const SHEET_NUMBER_LOCALE = 'en-US' as const;

// Plain digits, or digits grouped by commas in threes (the first group has 1-3 digits). No leading
// zeros ("007"), no spaces, no sign, no exponent. The decimal part is any number of digits; the
// column's digit limits are enforced by the row schema (rejected, never rounded).
const PLAIN_NUMBER = /^(0|[1-9]\d*)(\.\d+)?$/;
const GROUPED_NUMBER = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;

// What may surround a value: space, tab, CR, LF, no-break and thin spaces.
const OUTER_WHITESPACE = /^[ \t\r\n\u00a0\u2009\u202f]+|[ \t\r\n\u00a0\u2009\u202f]+$/g;

/**
 * A non-negative decimal as a canonical string with a dot ("1690000.50"), or null. Accepted
 * (en-US): `35`, `12.34`, `0.5`, `12650`, `12,650`, `1,690,000`, `1,690,000.5`. Rejected: a comma
 * used as the decimal mark (`12,5`), misplaced grouping (`12,65`, `1,6900`, `,500`), spaces
 * inside (`1 690 000`), a sign (negatives are a row error), an exponent, a currency symbol, a
 * trailing or leading separator, an empty cell. Outer whitespace is ignored.
 */
export function parseSheetNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(OUTER_WHITESPACE, '');
  if (!PLAIN_NUMBER.test(text) && !GROUPED_NUMBER.test(text)) return null;
  return text.replace(/,/g, '');
}

const SHEET_TIMESTAMP = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * `DD/MM/YYYY HH:MM:SS` as the exact instant of that Asia/Tashkent wall-clock time, or null. Day
 * first, slashes, two-digit fields, a four-digit year, 24-hour time with seconds. A date without a
 * time, a two-digit year, another separator, hour 24, an impossible date or a month > 12 is
 * rejected.
 */
export function parseSheetDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const match = SHEET_TIMESTAMP.exec(raw.replace(OUTER_WHITESPACE, ''));
  if (!match) return null;
  const [day, month, year, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return businessTimeToUtc(year, month, day, hour, minute, second);
}

// Plausibility window for a delivery date. A typo such as 01.10.2062 would otherwise become the
// permanent "latest" cost. The bounds live here, next to the parser.
export const EARLIEST_DELIVERY_DATE = businessMidnightUtc(2000, 1, 1) as Date;
/** A delivery may be dated at most this many days after "now" (clock skew, an early entry). */
export const MAX_DELIVERY_DAYS_AHEAD = 2;

/** True for a date from 2000-01-01 (Tashkent) up to now + MAX_DELIVERY_DAYS_AHEAD days. */
export function isPlausibleDeliveryDate(date: Date, now: Date): boolean {
  const latest = now.getTime() + MAX_DELIVERY_DAYS_AHEAD * 24 * 60 * 60 * 1000;
  return date.getTime() >= EARLIEST_DELIVERY_DATE.getTime() && date.getTime() <= latest;
}

/** The longest supplier text a stored report keeps; a longer one is cut with an ellipsis. */
export const STORED_SUPPLIER_MAX_LENGTH = 200;

/**
 * A skipped row is never validated, so its supplier cell can be arbitrarily long. The stored
 * report keeps at most STORED_SUPPLIER_MAX_LENGTH characters (code points, never half a pair),
 * the last one being the ellipsis marker when the text was cut.
 */
export function capStoredSupplier(supplier: string): string {
  const points = [...supplier];
  return points.length <= STORED_SUPPLIER_MAX_LENGTH
    ? supplier
    : `${points.slice(0, STORED_SUPPLIER_MAX_LENGTH - 1).join('')}\u2026`;
}

/** Header and text cells: trimmed, inner whitespace collapsed (non-breaking spaces included). */
export function normalizeSheetText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
  return text === '' ? null : text;
}
