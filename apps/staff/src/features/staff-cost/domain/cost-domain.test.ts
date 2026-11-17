import { STAFF_ROLES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { canEditPrices, canViewCost } from '@/features/staff-shell/price-access';
import { addQuantities, roundUzsForDisplay, stockLevel, toScaled, usdToUzs } from './decimal';

describe('fixed-point helpers', () => {
  it("multiplies USD by the rate to so'm rounding half up, never through a float", () => {
    expect(usdToUzs('128.5000', '12650.0000')).toBe('1625525.00');
    // 0.1 + 0.2 style traps: 1.1 USD x 12650.5 = 13915.55 exactly
    expect(usdToUzs('1.1000', '12650.5000')).toBe('13915.55');
    // half up at the third fraction digit: 0.0001 x 12650.5 = 1.26505 -> 1.27
    expect(usdToUzs('0.0001', '12650.5000')).toBe('1.27');
    expect(usdToUzs('0.0000', '12650.0000')).toBe('0.00');
  });

  it("rounds so'm derived from a cost to whole so'm for display, half up", () => {
    expect(roundUzsForDisplay('1625525.00')).toBe('1625525');
    expect(roundUzsForDisplay('1625525.49')).toBe('1625525');
    expect(roundUzsForDisplay('1625525.50')).toBe('1625526');
    expect(roundUzsForDisplay('1625525.99')).toBe('1625526');
    expect(roundUzsForDisplay('0.5')).toBe('1');
    expect(roundUzsForDisplay('7')).toBe('7');
    expect(() => roundUzsForDisplay('12,5')).toThrow(RangeError);
    // The exact value is untouched: only the label is rounded.
    expect(usdToUzs('1.0001', '12650.5000')).toBe('12651.77');
  });

  it('adds quantities with three fraction digits', () => {
    expect(addQuantities(['420.000', '180.000', '0.500'])).toBe('600.500');
    expect(addQuantities([])).toBe('0.000');
  });

  it('rejects malformed decimals and too many fraction digits instead of rounding', () => {
    expect(() => toScaled('1,5', 3)).toThrow(RangeError);
    expect(() => toScaled('1.2345', 3)).toThrow(RangeError);
    expect(() => toScaled('-1.000', 3)).toThrow(RangeError);
  });

  it('maps stock to the v1 dot colours: zero red, below 20 amber, otherwise green', () => {
    expect(stockLevel(null)).toBe('unknown');
    expect(stockLevel('0.000')).toBe('out');
    expect(stockLevel('0.500')).toBe('low');
    expect(stockLevel('19.999')).toBe('low');
    expect(stockLevel('20.000')).toBe('ok');
    expect(stockLevel('1500.000')).toBe('ok');
  });
});

describe('who may view and change cost (UI convenience only)', () => {
  it('manager, accountant, admin and purchasing manager view; only manager and admin change', () => {
    const viewers = STAFF_ROLES.filter((role) => canViewCost([role]));
    expect(viewers).toEqual(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'PURCHASING_MANAGER']);
    const editors = STAFF_ROLES.filter((role) => canEditPrices([role]));
    expect(editors).toEqual(['ADMIN', 'MANAGER']);
  });

  it('a person with several roles gets the union', () => {
    expect(canViewCost(['DRIVER', 'ACCOUNTANT'])).toBe(true);
    expect(canEditPrices(['DRIVER', 'ACCOUNTANT'])).toBe(false);
    expect(canViewCost([])).toBe(false);
  });
});
