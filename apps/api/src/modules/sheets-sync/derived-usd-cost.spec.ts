import { describe, expect, it } from 'vitest';
import { collectSheetRates, nearestSheetRate, withDerivedUsdCost } from './derived-usd-cost.js';
import { SHEET_COLUMNS as C, type SheetRecord } from './sheet-columns.js';
import { parseSheetDate } from './sheet-values.js';

const NOW = new Date('2026-11-04T08:00:00Z');
const at = (timestamp: string): Date => parseSheetDate(timestamp)!;

const record = (deliveredAt: string, rate: string, overrides: Partial<SheetRecord> = {}) =>
  ({
    [C.deliveredAt]: deliveredAt,
    [C.usdRateUsed]: rate,
    [C.costUsd]: '10',
    [C.costUzs]: '120,000',
    ...overrides,
  }) as SheetRecord;

describe('collectSheetRates', () => {
  it('keeps every row with a plausible date and a positive rate, whoever the supplier is', () => {
    const rates = collectSheetRates(
      [
        record('25/09/2026 12:00:00', '11,850', { [C.supplier]: 'Someone we never store' }),
        record('25/09/2026 13:00:00', ''),
        record('25/09/2026 13:00:00', '0'),
        record('25/09/2026 13:00:00', 'n/a'),
        record('not a date', '12,000'),
        record('01/10/2062 09:00:00', '12,000'), // a typo'd future date
      ],
      NOW,
    );
    expect(rates).toEqual([{ at: at('25/09/2026 12:00:00').getTime(), rate: '11850' }]);
  });
});

describe('nearestSheetRate', () => {
  const rate = (timestamp: string, value: string) => ({ at: at(timestamp).getTime(), rate: value });

  it('takes the rate closest in time, before or after', () => {
    const rates = [rate('24/09/2026 09:00:00', '11838'), rate('25/09/2026 14:00:00', '11850')];
    expect(nearestSheetRate(rates, at('25/09/2026 13:09:12'))).toBe('11850');
    expect(nearestSheetRate(rates, at('24/09/2026 10:00:00'))).toBe('11838');
  });

  it('a tie goes to the earlier row: that rate was already known on the delivery day', () => {
    const rates = [rate('25/09/2026 14:00:00', '12000'), rate('25/09/2026 12:00:00', '11850')];
    expect(nearestSheetRate(rates, at('25/09/2026 13:00:00'))).toBe('11850');
  });

  it('rates of one instant: the lowest, whatever the row order, so a re-read never flips it', () => {
    const one = [rate('25/09/2026 13:00:00', '12000'), rate('25/09/2026 13:00:00', '11850')];
    const two = [...one].reverse();
    expect(nearestSheetRate(one, at('25/09/2026 13:09:12'))).toBe('11850');
    expect(nearestSheetRate(two, at('25/09/2026 13:09:12'))).toBe('11850');
  });

  it('no rate in the sheet: null', () => {
    expect(nearestSheetRate([], at('25/09/2026 13:09:12'))).toBeNull();
  });
});

describe('withDerivedUsdCost', () => {
  const rates = [{ at: at('25/09/2026 12:00:00').getTime(), rate: '12000' }];
  const blank = record('25/09/2026 13:09:12', '', { [C.costUsd]: '', [C.costUzs]: '1,185,000' });

  it('fills USD = UZS / nearest rate and the rate used, with fixed-point rounding', () => {
    const filled = withDerivedUsdCost(blank, rates);
    expect(filled[C.costUsd]).toBe('98.7500');
    expect(filled[C.usdRateUsed]).toBe('12000');
    // The input row is not changed.
    expect(blank[C.costUsd]).toBe('');
  });

  it('rounds half up at four digits, never through a float', () => {
    const filled = withDerivedUsdCost({ ...blank, [C.costUzs]: '100,000' }, [
      { at: rates[0]!.at, rate: '3' },
    ]);
    expect(filled[C.costUsd]).toBe('33333.3333');
  });

  it.each([
    ['USD is filled in', { [C.costUsd]: '98.75' }],
    ['the row has its own rate', { [C.usdRateUsed]: '11,850' }],
    ['UZS is empty', { [C.costUzs]: '' }],
    ['UZS is zero', { [C.costUzs]: '0' }],
    ['UZS is not a number', { [C.costUzs]: 'x' }],
    ['the date is unparsable', { [C.deliveredAt]: '25.09.2026' }],
  ])('leaves the row untouched when %s', (_name, overrides) => {
    const row = { ...blank, ...overrides };
    expect(withDerivedUsdCost(row, rates)).toBe(row);
  });

  it('leaves the row untouched when the sheet holds no rate', () => {
    expect(withDerivedUsdCost(blank, [])).toBe(blank);
  });
});
