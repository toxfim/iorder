import { describe, expect, it } from 'vitest';
import {
  businessInstant,
  businessParts,
  isSameBusinessDay,
  shiftBusinessDays,
} from './business-clock';
import {
  averageMoney,
  compareMoney,
  formatMillions,
  formatPercentChange,
  fromCents,
  multiplyMoney,
  sumMoney,
  toCents,
} from './money';

describe('money (bigint cents, never float)', () => {
  it('converts and sums exactly', () => {
    expect(toCents('1690000')).toBe(169000000n);
    expect(toCents('0.5')).toBe(50n);
    expect(fromCents(169000000n)).toBe('1690000.00');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney([])).toBe('0.00');
  });

  it('multiplies by whole quantities without rounding errors', () => {
    expect(multiplyMoney('1690000.00', 10)).toBe('16900000.00');
    expect(multiplyMoney('0.10', 3)).toBe('0.30');
    expect(multiplyMoney('9999999999999999.99', 2)).toBe('19999999999999999.98');
    expect(() => multiplyMoney('1.00', 1.5)).toThrow(RangeError);
  });

  it('averages half up to the cent', () => {
    expect(averageMoney('100.00', 3)).toBe('33.33');
    expect(averageMoney('100.01', 2)).toBe('50.01');
    expect(averageMoney('5.00', 0)).toBe('0.00');
  });

  it('formats millions and percent changes like the design (27,8 mln, +8,3%)', () => {
    expect(formatMillions('639000000.00', 'mln')).toBe('639,0 mln');
    expect(formatMillions(averageMoney('639000000.00', 23), 'mln')).toBe('27,8 mln');
    expect(formatPercentChange('639000000.00', '590200000.00')).toEqual({
      text: '+8,3%',
      positive: true,
    });
    expect(formatPercentChange('90.00', '100.00')).toEqual({ text: '-10,0%', positive: false });
  });

  it('uses the given decimal separator for millions and percent changes', () => {
    expect(formatMillions('639000000.00', 'mln', '.')).toBe('639.0 mln');
    expect(formatPercentChange('639000000.00', '590200000.00', '.')).toEqual({
      text: '+8.3%',
      positive: true,
    });
    expect(formatPercentChange('5.00', '0.00', '.')).toEqual({ text: '0.0%', positive: true });
    expect(formatPercentChange('5.00', '0.00')).toEqual({ text: '0,0%', positive: true });
  });

  it('compares money by value', () => {
    expect(compareMoney('10.5', '10.50')).toBe(0);
    expect(compareMoney('9.99', '10')).toBe(-1);
    expect(() => toCents('abc')).toThrow(RangeError);
  });
});

describe('business clock (Asia/Tashkent)', () => {
  it('reads the Tashkent calendar of a UTC instant', () => {
    // 19:30 UTC is already the next day in Tashkent (UTC+5).
    const parts = businessParts('2026-10-19T19:30:00.000Z');
    expect(parts).toMatchObject({
      year: 2026,
      month: 10,
      day: 20,
      hour: 0,
      minute: 30,
      weekday: 2,
    });
    expect(isSameBusinessDay('2026-10-19T18:59:00.000Z', '2026-10-19T00:10:00.000Z')).toBe(true);
    expect(isSameBusinessDay('2026-10-19T19:30:00.000Z', '2026-10-19T08:00:00.000Z')).toBe(false);
  });

  it('builds the UTC instant of a Tashkent wall time and shifts days', () => {
    const instant = businessInstant({ year: 2026, month: 10, day: 19 }, 9, 12);
    expect(instant.toISOString()).toBe('2026-10-19T04:12:00.000Z');
    expect(shiftBusinessDays(instant, 2).toISOString()).toBe('2026-10-17T04:12:00.000Z');
    expect(shiftBusinessDays(instant, -1).toISOString()).toBe('2026-10-20T04:12:00.000Z');
  });
});
