import { moneyStringSchema } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalMoney,
  normalizePriceInput,
  parsePriceInput,
  sameMoney,
  toInputValue,
} from './price-input';

describe('price input', () => {
  it('accepts typed formats and agrees with the shared moneyStringSchema', () => {
    const samples = ['1690000', '1 690 000', '1690000,5', '1690000.50', '0.5', '12 650'];
    for (const raw of samples) {
      const result = parsePriceInput(raw);
      expect(result.ok).toBe(true);
      expect(moneyStringSchema.safeParse(normalizePriceInput(raw)).success).toBe(true);
    }
  });

  it('rejects what the contract rejects instead of repairing it', () => {
    const samples = ['0', '0.00', '-5', '1e5', '12.345', '007', 'abc', '1.', '.5', '1,2,3'];
    for (const raw of samples) {
      expect(parsePriceInput(raw)).toEqual({ ok: false, reason: 'invalid' });
      expect(moneyStringSchema.safeParse(normalizePriceInput(raw)).success).toBe(false);
    }
    expect(parsePriceInput('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('compares money as strings with two fraction digits', () => {
    expect(canonicalMoney('1690000')).toBe('1690000.00');
    expect(canonicalMoney('3.5')).toBe('3.50');
    expect(sameMoney('1690000', '1690000.00')).toBe(true);
    expect(sameMoney('1690000.10', '1690000.1')).toBe(true);
    expect(sameMoney('1690000.01', '1690000.1')).toBe(false);
  });

  it('keeps 16 integer digits exact (no float round trip)', () => {
    const big = '9999999999999999.99';
    expect(parsePriceInput(big)).toEqual({ ok: true, value: big });
    expect(sameMoney(big, '9999999999999999.98')).toBe(false);
  });

  it('shows a stored price in an input without grouping or dead zeros', () => {
    expect(toInputValue('1690000.00')).toBe('1690000');
    expect(toInputValue('1690000.50')).toBe('1690000,5');
    expect(parsePriceInput(toInputValue('1690000.55'))).toEqual({ ok: true, value: '1690000.55' });
  });
});
