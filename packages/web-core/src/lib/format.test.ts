import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decimalSeparatorFor,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatTime,
} from './format';

describe('decimal separator per language', () => {
  it('is a comma in uz and ru and a dot in en', () => {
    expect(decimalSeparatorFor('uz')).toBe(',');
    expect(decimalSeparatorFor('ru')).toBe(',');
    expect(decimalSeparatorFor('en')).toBe('.');
    expect(decimalSeparatorFor('EN')).toBe('.');
  });

  it('formatNumber takes the separator as an option and defaults to a comma', () => {
    expect(formatNumber('3.10', { decimalSeparator: '.' })).toBe('3.1');
    expect(formatNumber('1690000.5', { decimalSeparator: '.' })).toBe('1 690 000.5');
    expect(formatNumber('1690000.5')).toBe('1 690 000,5');
  });

  it('format.ts starts without a byte order mark', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/format.ts'), 'utf8');
    expect(source.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('formatNumber / formatMoney', () => {
  it('groups thousands with a plain space', () => {
    expect(formatMoney('1690000')).toBe('1 690 000');
    expect(formatMoney('999')).toBe('999');
    expect(formatMoney('1000')).toBe('1 000');
    expect(formatMoney('0')).toBe('0');
  });

  it('never emits NBSP or narrow NBSP', () => {
    const formatted = formatMoney('12650000');
    expect(formatted).toBe('12 650 000');
    expect(formatted.includes(String.fromCharCode(0xa0))).toBe(false);
    expect(formatted.includes(String.fromCharCode(0x202f))).toBe(false);
  });

  it('uses a comma as the decimal separator and drops trailing zeros', () => {
    expect(formatNumber('3.1')).toBe('3,1');
    expect(formatNumber('1690000.50')).toBe('1 690 000,5');
    expect(formatNumber('1690000.00')).toBe('1 690 000');
  });

  it('pads the fraction when asked', () => {
    expect(formatNumber('12650', { minFractionDigits: 2 })).toBe('12 650,00');
    expect(formatNumber('1.5', { minFractionDigits: 2 })).toBe('1,50');
  });

  it('accepts bigint', () => {
    expect(formatMoney(9007199254740993n)).toBe('9 007 199 254 740 993');
  });

  it('is exact beyond the float safe range (no float arithmetic)', () => {
    expect(formatMoney('9007199254740993')).toBe('9 007 199 254 740 993');
    expect(formatNumber('0.1234567890123456789')).toBe('0,1234567890123456789');
  });

  it('handles negatives and never prints -0', () => {
    expect(formatMoney('-1500')).toBe('-1 500');
    expect(formatNumber('-0.00')).toBe('0');
  });

  it('rejects malformed input instead of showing a wrong amount', () => {
    expect(() => formatMoney('12,5')).toThrow(RangeError);
    expect(() => formatMoney('1e6')).toThrow(RangeError);
    expect(() => formatMoney('')).toThrow(RangeError);
    expect(() => formatMoney('NaN')).toThrow(RangeError);
  });
});

describe('date and time', () => {
  // 2026-10-19T03:30:00Z is 08:30 in Asia/Tashkent (UTC+5, no DST).
  const utc = '2026-10-19T03:30:00Z';

  it('formats DD.MM.YYYY and HH:MM in Asia/Tashkent', () => {
    expect(formatDate(utc)).toBe('19.10.2026');
    expect(formatTime(utc)).toBe('08:30');
    expect(formatDateTime(utc)).toBe('19.10.2026 08:30');
  });

  it('rolls the date over at the business-time midnight, not at UTC midnight', () => {
    expect(formatDate('2026-10-19T20:00:00Z')).toBe('20.10.2026');
    expect(formatTime('2026-10-19T19:00:00Z')).toBe('00:00');
  });

  it('accepts Date and epoch values and an explicit zone', () => {
    expect(formatTime(new Date(utc))).toBe('08:30');
    expect(formatTime(Date.parse(utc), 'UTC')).toBe('03:30');
  });

  it('accepts explicit offsets', () => {
    expect(formatTime('2026-10-19T08:30:00+05:00')).toBe('08:30');
    expect(formatTime('2026-10-19T08:30:00.123+0500')).toBe('08:30');
  });

  it('rejects zone-less strings instead of parsing them in the local zone', () => {
    expect(() => formatDate('2026-10-19T08:30:00')).toThrow(RangeError);
    expect(() => formatDate('2026-10-19')).toThrow(RangeError);
  });

  it('rejects invalid dates', () => {
    expect(() => formatDate('not a date')).toThrow(RangeError);
  });
});
