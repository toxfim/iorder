import { describe, expect, it } from 'vitest';
import { pageSlice, pageWindow } from './pagination';
import {
  brandOptions,
  isNewDelivery,
  matchesBrand,
  matchesPreset,
  NEW_DELIVERY_DAYS,
  sortStock,
  type PresetItem,
} from './stock-views';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

const item = (overrides: Partial<PresetItem> = {}): PresetItem => ({
  isPriced: true,
  availableQuantity: '30.000',
  latestDelivery: { deliveredAt: daysAgo(20) },
  ...overrides,
});

describe('Qoldiq ready views', () => {
  it('"unpriced" keeps only products outside the published list', () => {
    expect(matchesPreset(item({ isPriced: false }), 'unpriced', NOW)).toBe(true);
    expect(matchesPreset(item(), 'unpriced', NOW)).toBe(false);
  });

  it('"out" is an exact zero only; an unknown stock is neither out nor low', () => {
    expect(matchesPreset(item({ availableQuantity: '0.000' }), 'out', NOW)).toBe(true);
    expect(matchesPreset(item({ availableQuantity: null }), 'out', NOW)).toBe(false);
    expect(matchesPreset(item({ availableQuantity: null }), 'low', NOW)).toBe(false);
  });

  it('"low" is above zero and below the low-stock line', () => {
    expect(matchesPreset(item({ availableQuantity: '3.000' }), 'low', NOW)).toBe(true);
    expect(matchesPreset(item({ availableQuantity: '0.000' }), 'low', NOW)).toBe(false);
    expect(matchesPreset(item({ availableQuantity: '500.000' }), 'low', NOW)).toBe(false);
  });

  it('"new" is a delivery within the last days, never one without a date', () => {
    expect(isNewDelivery(item({ latestDelivery: { deliveredAt: daysAgo(1) } }), NOW)).toBe(true);
    expect(
      isNewDelivery(item({ latestDelivery: { deliveredAt: daysAgo(NEW_DELIVERY_DAYS) } }), NOW),
    ).toBe(true);
    expect(
      isNewDelivery(item({ latestDelivery: { deliveredAt: daysAgo(NEW_DELIVERY_DAYS + 1) } }), NOW),
    ).toBe(false);
    expect(isNewDelivery(item({ latestDelivery: null }), NOW)).toBe(false);
    expect(isNewDelivery(item({ latestDelivery: { deliveredAt: 'soon' } }), NOW)).toBe(false);
  });

  it('"all" keeps everything', () => {
    expect(matchesPreset(item({ availableQuantity: null, latestDelivery: null }), 'all', NOW)).toBe(
      true,
    );
  });
});

describe('Qoldiq brand filter', () => {
  it('counts the named brands by name and leaves products without one out of the options', () => {
    expect(brandOptions(['Xiaomi', null, 'Huawei', 'Xiaomi'])).toEqual([
      { value: 'Huawei', label: 'Huawei', count: 1 },
      { value: 'Xiaomi', label: 'Xiaomi', count: 2 },
    ]);
  });

  it('passes every product for "all" and the exact brand otherwise', () => {
    expect(matchesBrand(null, 'all')).toBe(true);
    expect(matchesBrand('Xiaomi', 'Xiaomi')).toBe(true);
    expect(matchesBrand(null, 'Xiaomi')).toBe(false);
  });
});

describe('Qoldiq sort', () => {
  const rows = [
    { productCode: 'B', name: 'Banan', availableQuantity: '5.000', latestDelivery: null },
    {
      productCode: 'A',
      name: 'Olma',
      availableQuantity: null,
      latestDelivery: { deliveredAt: daysAgo(2) },
    },
    {
      productCode: 'C',
      name: 'Anor',
      availableQuantity: '12.500',
      latestDelivery: { deliveredAt: daysAgo(9) },
    },
  ];
  const codes = (sorted: readonly { productCode: string }[]): string[] =>
    sorted.map((r) => r.productCode);
  const nameOf = (r: (typeof rows)[number]): string => r.name;

  it('newest supply first, rows without a delivery last', () => {
    expect(codes(sortStock(rows, 'latest', nameOf))).toEqual(['A', 'C', 'B']);
  });

  it('most available first, an unknown stock last', () => {
    expect(codes(sortStock(rows, 'available', nameOf))).toEqual(['C', 'B', 'A']);
  });

  it('by name', () => {
    expect(codes(sortStock(rows, 'name', nameOf))).toEqual(['C', 'B', 'A']);
  });

  it('never changes the list it was given', () => {
    sortStock(rows, 'name', nameOf);
    expect(codes(rows)).toEqual(['B', 'A', 'C']);
  });
});

describe('client pages', () => {
  it('slices and clamps a page past the end to the last one', () => {
    expect(pageSlice(248, 0, 25)).toEqual({ page: 0, pages: 10, start: 0, end: 25 });
    expect(pageSlice(248, 99, 25)).toEqual({ page: 9, pages: 10, start: 225, end: 248 });
    expect(pageSlice(0, 3, 25)).toEqual({ page: 0, pages: 1, start: 0, end: 0 });
  });

  it('shows first, last and neighbours, with a gap only when more than one page is skipped', () => {
    const labels = (page: number, pages: number): string[] =>
      pageWindow(page, pages).map((i) => (i.kind === 'gap' ? '…' : String(i.page + 1)));
    expect(labels(0, 10)).toEqual(['1', '2', '…', '10']);
    expect(labels(4, 10)).toEqual(['1', '…', '4', '5', '6', '…', '10']);
    expect(labels(2, 10)).toEqual(['1', '2', '3', '4', '…', '10']);
    expect(labels(0, 1)).toEqual(['1']);
  });
});
