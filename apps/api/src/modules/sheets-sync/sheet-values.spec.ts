import { describe, expect, it } from 'vitest';
import {
  capStoredSupplier,
  EARLIEST_DELIVERY_DATE,
  isPlausibleDeliveryDate,
  MAX_DELIVERY_DAYS_AHEAD,
  normalizeSheetText,
  parseSheetDate,
  parseSheetNumber,
  SHEET_NUMBER_LOCALE,
} from './sheet-values.js';

describe('parseSheetNumber (en-US: comma groups thousands, dot is the decimal mark)', () => {
  it('names the confirmed locale', () => {
    expect(SHEET_NUMBER_LOCALE).toBe('en-US');
  });

  it.each([
    ['35', '35'],
    ['0', '0'],
    ['12.34', '12.34'],
    ['0.5', '0.5'],
    ['0.0001', '0.0001'],
    ['12650', '12650'],
    ['1690000.5', '1690000.5'],
    ['12,650', '12650'], // the real rate cell: twelve thousand six hundred fifty
    ['1,500', '1500'], // fifteen hundred, never 1.5
    ['1,690,000', '1690000'],
    ['1,690,000.5', '1690000.5'],
    ['999,999', '999999'],
    ['12,650.5000', '12650.5000'],
    ['  12.5  ', '12.5'], // outer whitespace is ignored
    ['12.5\r\n', '12.5'],
    ['\n12.5', '12.5'],
    ['\t12.5\t', '12.5'],
    ['\u00a012\u00a0', '12'],
    ['\u200912.5\u2009', '12.5'],
  ])('accepts %j as %s', (raw, expected) => {
    expect(parseSheetNumber(raw)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['a JSON number (float)', 1690000.5],
    ['an integer JSON number', 12],
    ['null', null],
    ['undefined', undefined],
    ['a minus sign (negatives are a row error)', '-5'],
    ['a plus sign', '+5'],
    ['an exponent', '1e3'],
    ['a currency symbol', '$12.50'],
    ['a trailing unit', '12.50 $'],
    ['a comma used as the decimal mark', '12,5'],
    ['a comma decimal with many digits', '0,5'],
    ['misplaced grouping: two digits after the comma', '12,65'],
    ['misplaced grouping: four digits after the comma', '1,6900'],
    ['a fraction written with a comma after a dot', '1.690,50'],
    ['grouping inside the fraction', '1.234,567'],
    ['a first group of four digits', '1234,567'],
    ['spaces as thousands separators', '1 690 000'],
    ['a no-break space as thousands separator', '1\u00a0690\u00a0000'],
    ['two decimal points', '1.2.3'],
    ['a trailing comma', '12,'],
    ['a leading comma', ',500'],
    ['a trailing dot', '12.'],
    ['a leading dot', '.5'],
    ['text', 'abc'],
    ['leading zeros', '007'],
    ['leading zero with grouping', '01,500'],
    ['an inner tab', '1\t690'],
    ['a double comma', '1,,500'],
  ])('rejects %s', (_name, raw) => {
    expect(parseSheetNumber(raw)).toBeNull();
  });
});

describe('parseSheetDate (DD/MM/YYYY HH:MM:SS, Asia/Tashkent wall clock)', () => {
  it('reads the real timestamp as the exact instant', () => {
    expect(parseSheetDate('20/10/2026 09:15:00')?.toISOString()).toBe('2026-10-20T04:15:00.000Z');
    expect(parseSheetDate('20/10/2026 09:15:42')?.toISOString()).toBe('2026-10-20T04:15:42.000Z');
    expect(parseSheetDate(' 12/10/2026 00:00:00 ')?.toISOString()).toBe('2026-10-11T19:00:00.000Z');
    expect(parseSheetDate('29/02/2024 23:59:59')?.toISOString()).toBe('2024-02-29T18:59:59.000Z');
  });

  it('is day first: 03/04/2026 is 3 April, not 4 March', () => {
    expect(parseSheetDate('03/04/2026 10:00:00')?.toISOString()).toBe('2026-04-03T05:00:00.000Z');
  });

  it('treats the time as 24-hour', () => {
    expect(parseSheetDate('20/10/2026 21:00:00')?.toISOString()).toBe('2026-10-20T16:00:00.000Z');
  });

  it('keeps the supplier-boundary instants exact', () => {
    expect(parseSheetDate('31/08/2026 23:59:59')?.toISOString()).toBe('2026-08-31T18:59:59.000Z');
    expect(parseSheetDate('01/09/2026 00:00:00')?.toISOString()).toBe('2026-08-31T19:00:00.000Z');
  });

  it.each([
    ['an impossible day', '31/02/2026 10:00:00'],
    ['month 13', '10/13/2026 10:00:00'],
    ['day 00', '00/10/2026 10:00:00'],
    ['not a leap year', '29/02/2025 10:00:00'],
    ['hour 24', '20/10/2026 24:00:00'],
    ['minute 60', '20/10/2026 10:60:00'],
    ['second 60', '20/10/2026 10:00:60'],
    ['a date without a time', '20/10/2026'],
    ['a time without seconds', '20/10/2026 09:15'],
    ['the old dotted shape', '20.10.2026 09:15:00'],
    ['an ISO timestamp', '2026-10-20 09:15:00'],
    ['an ISO date', '2026-10-20'],
    ['a two-digit year', '20/10/26 09:15:00'],
    ['a one-digit day', '2/10/2026 09:15:00'],
    ['a 12-hour clock marker', '20/10/2026 09:15:00 PM'],
    ['a T separator', '20/10/2026T09:15:00'],
    ['empty', ''],
    ['text', 'yesterday'],
    ['a number (spreadsheet serial)', 46266],
    ['null', null],
    ['a Date object', new Date()],
  ])('rejects %s', (_name, raw) => {
    expect(parseSheetDate(raw)).toBeNull();
  });
});

describe('normalizeSheetText', () => {
  it('trims and collapses inner whitespace, non-breaking spaces included', () => {
    expect(normalizeSheetText('  Beta   system\u00a0tm  fbs ')).toBe('Beta system tm fbs');
    expect(normalizeSheetText('Факт кол-во')).toBe('Факт кол-во');
  });
  it('returns null for blank or non-text cells', () => {
    expect(normalizeSheetText('   ')).toBeNull();
    expect(normalizeSheetText(5)).toBeNull();
    expect(normalizeSheetText(undefined)).toBeNull();
  });
});

describe('isPlausibleDeliveryDate', () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const at = (timestamp: string): Date => parseSheetDate(timestamp)!;

  it('has the documented bounds', () => {
    expect(EARLIEST_DELIVERY_DATE.toISOString()).toBe('1999-12-31T19:00:00.000Z'); // 2000-01-01 Tashkent
    expect(MAX_DELIVERY_DAYS_AHEAD).toBe(2);
  });

  it('accepts dates from 2000-01-01 up to now + 2 days', () => {
    expect(isPlausibleDeliveryDate(at('01/01/2000 00:00:00'), now)).toBe(true);
    expect(isPlausibleDeliveryDate(at('12/10/2026 09:15:00'), now)).toBe(true);
    expect(isPlausibleDeliveryDate(at('20/10/2026 09:15:00'), now)).toBe(true);
    expect(isPlausibleDeliveryDate(at('22/10/2026 09:15:00'), now)).toBe(true);
  });

  it('rejects typos: before 2000 and more than two days ahead', () => {
    expect(isPlausibleDeliveryDate(at('31/12/1999 23:59:59'), now)).toBe(false);
    expect(isPlausibleDeliveryDate(at('01/01/0200 00:00:00'), now)).toBe(false);
    expect(isPlausibleDeliveryDate(at('01/10/2062 09:15:00'), now)).toBe(false);
    expect(isPlausibleDeliveryDate(at('23/10/2026 09:15:00'), now)).toBe(false);
  });

  it('follows the clock it is given (a fake Clock moves the window)', () => {
    const later = new Date('2062-10-01T00:00:00Z');
    expect(isPlausibleDeliveryDate(at('01/10/2062 09:15:00'), later)).toBe(true);
    expect(isPlausibleDeliveryDate(at('01/10/2062 09:15:00'), now)).toBe(false);
  });
});

describe('capStoredSupplier', () => {
  it('keeps a text of up to 200 characters as it is', () => {
    const exact = 'a'.repeat(200);
    expect(capStoredSupplier(exact)).toBe(exact);
    expect(capStoredSupplier('alpha trade import')).toBe('alpha trade import');
  });

  it('cuts a longer text to 200 characters ending with an ellipsis marker', () => {
    const capped = capStoredSupplier('a'.repeat(201));
    expect([...capped]).toHaveLength(200);
    expect(capped).toBe(`${'a'.repeat(199)}…`);
  });

  it('never splits a surrogate pair', () => {
    const capped = capStoredSupplier('\u{1F600}'.repeat(300));
    expect([...capped]).toHaveLength(200);
    expect(capped.endsWith('\u{1F600}…')).toBe(true);
  });
});
