import { describe, expect, it } from 'vitest';
import { microsToMoney, usdToMicros, usdToUzs, uzsToUsd, uzsToUsdExact } from './money';

describe('uzsToUsd and usdToUzs (fake backends only; the server owns the real figures)', () => {
  it('rounds to cents, half up, with a rate of up to 4 decimals', () => {
    expect(uzsToUsd('3750.50', '12000.0000')).toBe('0.31');
    expect(uzsToUsd('60', '12000')).toBe('0.01');
    expect(uzsToUsd('59.99', '12000')).toBe('0.00');
    expect(uzsToUsd('27000000', '12650.5')).toBe('2134.30');
  });

  it("rounds to whole so'm, half up", () => {
    expect(usdToUzs('0.31', '12000.0000')).toBe('3720.00');
    expect(usdToUzs('0.01', '12345.5')).toBe('123.00');
    expect(usdToUzs('0.05', '10')).toBe('1.00');
    expect(usdToUzs('0.00', '12000')).toBe('0.00');
  });

  it('refuses what is not a rate', () => {
    expect(() => uzsToUsd('1', '1.23456')).toThrow(RangeError);
    expect(() => usdToUzs('1', 'abc')).toThrow(RangeError);
  });

  it('keeps the debt figure at six decimals, half up', () => {
    expect(uzsToUsdExact('15000', '12650')).toBe('1.185771');
    expect(uzsToUsdExact('30000', '12650.0000')).toBe('2.371542');
    expect(uzsToUsdExact('0.01', '20000')).toBe('0.000001');
  });

  it('reads USD of up to six decimals and shows it at two, half up', () => {
    expect(usdToMicros('2.371542')).toBe(2_371_542n);
    expect(usdToMicros('100')).toBe(100_000_000n);
    expect(microsToMoney(2_371_542n)).toBe('2.37');
    expect(microsToMoney(5_000n)).toBe('0.01');
    expect(microsToMoney(4_999n)).toBe('0.00');
    expect(() => usdToMicros('1.2345678')).toThrow(RangeError);
  });
});
