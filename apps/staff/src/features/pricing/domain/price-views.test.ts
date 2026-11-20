import { describe, expect, it } from 'vitest';
import {
  isPricePreset,
  isPriceSort,
  isPriceType,
  matchesPreset,
  matchesPriceType,
  sortPrices,
  type PricePreset,
  type PriceViewItem,
} from './price-views';

const item = (overrides: Partial<PriceViewItem> = {}): PriceViewItem => ({
  codeGenerated: false,
  wholesalePrice: '9.00',
  alifPrice: null,
  belowCost: false,
  ...overrides,
});

describe('ready views', () => {
  it('keeps everything on "all" and one task per other view', () => {
    const byOrder = item({ codeGenerated: true });
    const noWholesale = item({ wholesalePrice: null });
    const below = item({ belowCost: true });
    const plain = item();
    const all = [byOrder, noWholesale, below, plain];
    const pick = (preset: PricePreset) => all.filter((i) => matchesPreset(i, preset));
    expect(pick('all')).toEqual(all);
    expect(pick('byOrder')).toEqual([byOrder]);
    expect(pick('noWholesale')).toEqual([noWholesale]);
    expect(pick('belowCost')).toEqual([below]);
  });

  it('accepts only known values from the address', () => {
    expect(isPricePreset('belowCost')).toBe(true);
    expect(isPricePreset('unpriced')).toBe(false);
    expect(isPriceType('hasAlif')).toBe(true);
    expect(isPriceType('x')).toBe(false);
    expect(isPriceSort('markup')).toBe(true);
    expect(isPriceSort('latest')).toBe(false);
  });
});

describe('price type', () => {
  it('tells standard-only, wholesale and Alif products apart', () => {
    const standard = item({ wholesalePrice: null, alifPrice: null });
    const wholesale = item({ wholesalePrice: '9.00', alifPrice: null });
    const alif = item({ wholesalePrice: null, alifPrice: '11.00' });
    const all = [standard, wholesale, alif];
    expect(all.filter((i) => matchesPriceType(i, 'all'))).toEqual(all);
    expect(all.filter((i) => matchesPriceType(i, 'standardOnly'))).toEqual([standard]);
    expect(all.filter((i) => matchesPriceType(i, 'hasWholesale'))).toEqual([wholesale]);
    expect(all.filter((i) => matchesPriceType(i, 'hasAlif'))).toEqual([alif]);
  });
});

describe('sort', () => {
  const row = (
    productCode: string,
    usdPrice: string | null,
    markupTenths: bigint | null,
    changedAt: string | null,
  ) => ({ productCode, usdPrice, markupTenths, changedAt, name: `N-${productCode}` });
  const rows = [
    row('C', '10.00', 50n, '2026-11-18T09:00:00Z'),
    row('A', '120.50', -32n, '2026-11-19T09:00:00Z'),
    row('B', null, null, null),
    row('D', '10.00', 133n, '2026-11-18T09:00:00Z'),
  ];
  const codes = (sorted: readonly { productCode: string }[]) => sorted.map((r) => r.productCode);
  const nameOf = (r: { name: string }) => r.name;

  it('puts the latest change first, unknown last, ties by code', () => {
    expect(codes(sortPrices(rows, 'changed', nameOf))).toEqual(['A', 'C', 'D', 'B']);
  });

  it('puts the highest price first, cents compared exactly', () => {
    expect(codes(sortPrices(rows, 'price', nameOf))).toEqual(['A', 'C', 'D', 'B']);
  });

  it('puts the lowest markup first (below cost on top), unknown last', () => {
    expect(codes(sortPrices(rows, 'markup', nameOf))).toEqual(['A', 'C', 'D', 'B']);
  });

  it('sorts by name and never changes the input', () => {
    const before = codes(rows);
    expect(codes(sortPrices(rows, 'name', nameOf))).toEqual(['A', 'B', 'C', 'D']);
    expect(codes(rows)).toEqual(before);
  });
});
