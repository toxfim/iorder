import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import {
  fitsMoney,
  formatAmount,
  formatQuantity,
  lineTotal,
  parseQuantity,
  sumAmounts,
} from './order-lines.js';

const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('lineTotal (hand-calculated)', () => {
  it.each([
    ['3', '1500.00', '4500.00'],
    ['2.5', '1200.00', '3000.00'],
    ['0.001', '1000.00', '1.00'],
    // 0.333 x 100.10 = 33.3333 -> 33.33
    ['0.333', '100.10', '33.33'],
    // 1.5 x 0.01 = 0.015 -> half up -> 0.02 (not banker's rounding, not float 0.01499999)
    ['1.5', '0.01', '0.02'],
    // 0.5 x 0.01 = 0.005 -> 0.01
    ['0.5', '0.01', '0.01'],
    ['999999.999', '9999999.99', '9999999980000.00'],
  ])('%s x %s = %s', (quantity, price, expected) => {
    expect(formatAmount(lineTotal(dec(quantity), dec(price)))).toBe(expected);
  });

  it('is exact where binary floating point is not', () => {
    // 0.1 + 0.2 style trap: 3 x 0.10 must be exactly 0.30
    expect(formatAmount(lineTotal(dec('3'), dec('0.10')))).toBe('0.30');
    const sum = sumAmounts([dec('0.10'), dec('0.20')]);
    expect(formatAmount(sum)).toBe('0.30');
  });
});

describe('sumAmounts', () => {
  it('sums to zero for no lines and adds exactly otherwise', () => {
    expect(formatAmount(sumAmounts([]))).toBe('0.00');
    expect(formatAmount(sumAmounts([dec('4500.00'), dec('3000.00'), dec('1.00')]))).toBe('7501.00');
  });
});

describe('parseQuantity', () => {
  it.each(['1', '10', '2.000', '999999', '000001'])('accepts %s', (text) => {
    expect(parseQuantity(text)).not.toBeNull();
  });

  it.each([
    '0',
    '0.000',
    '0.5',
    '2.250',
    '999999.999',
    '-1',
    '+1',
    '1.2345',
    '1e3',
    '1,5',
    ' 1',
    '',
    '.5',
    '5.',
    'abc',
    '1000000',
    '1000000.000',
    'NaN',
    'Infinity',
  ])('rejects %j', (text) => {
    expect(parseQuantity(text)).toBeNull();
  });

  it('formats with three decimals', () => {
    expect(formatQuantity(dec('2.5'))).toBe('2.500');
  });
});

describe('fitsMoney', () => {
  it('accepts the DECIMAL(18,2) maximum and nothing above', () => {
    expect(fitsMoney(dec('9999999999999999.99'))).toBe(true);
    expect(fitsMoney(dec('10000000000000000.00'))).toBe(false);
  });
});
