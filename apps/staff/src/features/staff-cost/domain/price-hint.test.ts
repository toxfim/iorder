import { describe, expect, it } from 'vitest';
import { formatTenthsPercent, priceHint, splitByActive } from './price-hint';

describe('price hint', () => {
  it('computes markup and margin of a USD price against the USD cost, one decimal', () => {
    const hint = priceHint('100', '86.9000');
    expect(hint).toEqual({ markupTenths: 151n, marginTenths: 131n, belowCost: false });
  });

  it('compares at the cost precision (4 fraction digits), with no display rounding', () => {
    expect(priceHint('85.00', '84.9950')?.markupTenths).toBe(0n);
    expect(priceHint('85.00', '85.0001')?.belowCost).toBe(true);
  });

  it('flags a price below the cost, and not one equal to it', () => {
    expect(priceHint('80', '86.9000')?.belowCost).toBe(true);
    expect(priceHint('86.90', '86.9000')?.belowCost).toBe(false);
    expect(priceHint('86.90', '86.9000')?.markupTenths).toBe(0n);
  });

  it('rounds half away from zero, with no floating point', () => {
    // 0.25 % -> 3 tenths, -0.25 % -> -3 tenths
    expect(priceHint('100.25', '100.00')?.markupTenths).toBe(3n);
    expect(priceHint('99.75', '100.00')?.markupTenths).toBe(-3n);
    // large amounts stay exact
    expect(priceHint('99999999999999.99', '1')?.markupTenths).toBe(99999999999998990n);
  });

  it('has nothing to say without a valid price or without a usable cost', () => {
    expect(priceHint('', '100.00')).toBeNull();
    expect(priceHint('abc', '100.00')).toBeNull();
    expect(priceHint('1000', null)).toBeNull();
    expect(priceHint('1000', '0.0000')).toBeNull();
    expect(priceHint('0', '100.00')).toBeNull();
  });
});

describe('formatTenthsPercent', () => {
  it('shows one decimal with the locale separator and an explicit sign', () => {
    expect(formatTenthsPercent(151n, ',')).toBe('+15,1%');
    expect(formatTenthsPercent(-137n, '.')).toBe('-13.7%');
    expect(formatTenthsPercent(0n, ',')).toBe('0,0%');
    expect(formatTenthsPercent(5n, ',')).toBe('+0,5%');
    expect(formatTenthsPercent(-5n, ',')).toBe('-0,5%');
  });
});

describe('splitByActive', () => {
  it('separates inactive products and keeps the order', () => {
    const items = [
      { id: 1, isActive: true },
      { id: 2, isActive: false },
      { id: 3, isActive: true },
    ];
    const { active, inactive } = splitByActive(items);
    expect(active.map((i) => i.id)).toEqual([1, 3]);
    expect(inactive.map((i) => i.id)).toEqual([2]);
  });
});
