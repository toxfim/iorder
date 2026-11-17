import { describe, expect, it } from 'vitest';
import { findSupplierRule, SUPPLIER_RULES } from './supplier-filter.js';

describe('SUPPLIER_RULES configuration', () => {
  it('is exactly the suppliers the product owner selected, all dates, in one place', () => {
    expect(SUPPLIER_RULES).toEqual([
      { supplier: 'alpha trade import' },
      { supplier: 'Beta system tm fbs' },
      { supplier: 'TV Gamma Import' },
      { supplier: 'Delta Import' },
      { supplier: 'Samsung Trading (North)' },
    ]);
  });
});

describe('findSupplierRule: exact full-value match', () => {
  it.each([
    ['alpha trade import', 'alpha trade import'],
    ['Beta system tm fbs', 'Beta system tm fbs'],
    ['  alpha   trade    import  ', 'alpha trade import'], // trimmed, inner whitespace collapsed
    ['alpha\u00a0trade\u00a0import', 'alpha trade import'], // non-breaking spaces
    ['ALPHA TRADE IMPORT', 'alpha trade import'], // case-insensitive (real casing unverified)
    ['beta SYSTEM tm FBS', 'Beta system tm fbs'],
    ['TV Gamma Import', 'TV Gamma Import'], // the sheet's own spelling (checked 2026-11-10)
    ['TV Gamma Import', 'TV Gamma Import'],
    ['Delta Import', 'Delta Import'], // the sheet's own spelling (sync report 2026-11-13)
    ['Samsung Trading (North)', 'Samsung Trading (North)'],
    ['Samsung  Trading (North)', 'Samsung Trading (North)'],
  ])('selects %j', (cell, expected) => {
    expect(findSupplierRule(cell)?.supplier).toBe(expected);
  });

  it.each([
    ['a trailing number (partial match)', 'alpha trade import 2'],
    ['a prefix', 'new alpha trade import'],
    ['a truncated name', 'alpha trade'],
    ['the other rule with a suffix', 'Beta system tm fbs ltd'],
    ['an unrelated supplier', 'Some Other Supplier'],
    ['another Xiaomi supplier of the sheet', 'Zillion Xiaomi dubai bristol'],
    ['a TV rule truncated', 'TV Xiaomi'],
    ['Samsung without the person', 'Samsung Trading'],
    ['another Huawei-like supplier of the sheet', 'Hua Fa Honor Дистр'],
    ['an empty cell', ''],
    ['whitespace only', '   '],
    ['a non-text cell', 42],
    ['an undefined cell', undefined],
    ['a null cell', null],
    ['a different spelling', 'eco-xiaomi-import'],
  ])('does not select %s', (_name, cell) => {
    expect(findSupplierRule(cell)).toBeNull();
  });
});
