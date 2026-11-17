import { describe, expect, it } from 'vitest';
import { matchesSupplier, SUPPLIER_ALL, supplierOptions } from './supplier-filter';

describe('supplier filter', () => {
  it('keeps every product for "all" and a product with any line of the chosen supplier', () => {
    expect(matchesSupplier([], SUPPLIER_ALL)).toBe(true);
    expect(matchesSupplier(['Delta Import', 'alpha trade import'], 'alpha trade import')).toBe(
      true,
    );
    expect(matchesSupplier(['Delta Import'], 'Samsung Trading (North)')).toBe(false);
    // A product without a live line (a staff-added one) is never under a supplier.
    expect(matchesSupplier([], 'Delta Import')).toBe(false);
  });

  it('lists each supplier once, by name, with the number of products it keeps', () => {
    expect(
      supplierOptions([
        ['alpha trade import', 'TV Gamma Import'],
        ['alpha trade import'],
        [],
        ['Delta Import', 'Delta Import'],
      ]),
    ).toEqual([
      { value: 'Delta Import', label: 'Delta Import', count: 1 },
      { value: 'TV Gamma Import', label: 'TV Gamma Import', count: 1 },
      { value: 'alpha trade import', label: 'alpha trade import', count: 2 },
    ]);
  });
});
