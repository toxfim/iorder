import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ALL,
  CATEGORY_NONE,
  buildCategoryOptions,
  categoryTabId,
  countCategories,
  countsFromResponse,
  filterByCategory,
  matchesCategory,
  searchCategoryOptions,
} from './category-filter';
import { toCostRows, toSupplyLines } from './cost-view';
import {
  USD_RATE_PLAUSIBLE_MAX,
  USD_RATE_PLAUSIBLE_MIN,
  assessRate,
  parseRateInput,
  rateToInput,
} from './rate-input';

const LABELS = { all: 'Hammasi', none: 'Kategoriyasiz' };

describe('category filter', () => {
  it('matches All, No category and one category without confusing a category called "all"', () => {
    expect(matchesCategory('Telefonlar', CATEGORY_ALL)).toBe(true);
    expect(matchesCategory(null, CATEGORY_ALL)).toBe(true);
    expect(matchesCategory(null, CATEGORY_NONE)).toBe(true);
    expect(matchesCategory('Telefonlar', CATEGORY_NONE)).toBe(false);
    expect(matchesCategory('Telefonlar', categoryTabId('Telefonlar'))).toBe(true);
    expect(matchesCategory('Audio', categoryTabId('Telefonlar'))).toBe(false);
    expect(matchesCategory(null, categoryTabId('Telefonlar'))).toBe(false);
    // A category literally named "all" or "none" only matches its own tab id.
    expect(matchesCategory('none', CATEGORY_NONE)).toBe(false);
    expect(matchesCategory('all', categoryTabId('all'))).toBe(true);
    expect(categoryTabId('all')).not.toBe(CATEGORY_ALL);
  });

  it('counts per category in code unit order, with the uncategorized apart', () => {
    const items = [
      { category: 'b' },
      { category: 'a' },
      { category: 'b' },
      { category: null },
      { category: 'B' },
    ];
    expect(countCategories(items)).toEqual({
      total: 5,
      uncategorized: 1,
      // Upper case sorts before lower case: code unit order, not locale order.
      categories: [
        { category: 'B', count: 1 },
        { category: 'a', count: 1 },
        { category: 'b', count: 2 },
      ],
    });
    expect(filterByCategory(items, categoryTabId('b'))).toHaveLength(2);
    expect(filterByCategory(items, CATEGORY_NONE)).toEqual([{ category: null }]);
  });

  it("takes the endpoint's counts as they are", () => {
    expect(
      countsFromResponse({
        categories: [
          { category: 'Audio', count: 3 },
          { category: 'Telefonlar', count: 4 },
        ],
        uncategorizedCount: 2,
      }),
    ).toEqual({
      total: 9,
      uncategorized: 2,
      categories: [
        { category: 'Audio', count: 3 },
        { category: 'Telefonlar', count: 4 },
      ],
    });
  });

  it('builds the dropdown options: categories with products first, empty ones after, no "all"', () => {
    const counts = countCategories([{ category: 'Telefonlar' }, { category: null }]);
    const options = buildCategoryOptions(counts, LABELS, ['Audio', 'Kabel']);
    expect(options.map((o) => [o.id, o.count])).toEqual([
      ['c:Telefonlar', 1],
      [CATEGORY_NONE, 1],
      ['c:Audio', 0],
      ['c:Kabel', 0],
    ]);
    // "No category" also stays when only the other list has such products.
    const known = buildCategoryOptions(countCategories([{ category: 'Audio' }]), LABELS, [], true);
    expect(known.map((o) => o.id)).toEqual(['c:Audio', CATEGORY_NONE]);
  });

  it('searches the options by label, ignoring case and outer spaces', () => {
    const options = buildCategoryOptions(
      countCategories([{ category: 'Telefonlar' }, { category: 'Televizorlar' }]),
      LABELS,
      ['Audio'],
    );
    expect(searchCategoryOptions(options, '  TELE ').map((o) => o.label)).toEqual([
      'Telefonlar',
      'Televizorlar',
    ]);
    expect(searchCategoryOptions(options, '')).toHaveLength(3);
    expect(searchCategoryOptions(options, 'xyz')).toEqual([]);
  });
});

describe('cost view models', () => {
  const summary = {
    deliveredAt: '2026-10-16T05:00:00.000Z',
    deliveryRef: 'Z-20413',
    supplier: 'Supplier A',
    costUsd: '128.5000',
    usdRateUsed: '12650.0000',
    costUzs: '1625525.00',
  };

  it('maps a cost list item to neutral fields and a stock level', () => {
    const rows = toCostRows([
      {
        productId: '33333333-3333-4333-8333-333333333333',
        latest: summary,
        recent: [summary],
        stockQuantity: '12.000',
        suppliers: ['Supplier A'],
      },
      {
        productId: '44444444-4444-4444-8444-444444444444',
        latest: null,
        recent: [],
        stockQuantity: null,
        suppliers: [],
      },
    ]);
    expect(rows.get('33333333-3333-4333-8333-333333333333')).toEqual({
      stock: '12.000',
      level: 'low',
      usd: '128.5000',
      uzs: '1625525.00',
      rate: '12650.0000',
      recent: [
        {
          date: '2026-10-16T05:00:00.000Z',
          ref: 'Z-20413',
          supplier: 'Supplier A',
          usd: '128.5000',
          rate: '12650.0000',
          uzs: '1625525.00',
        },
      ],
      suppliers: ['Supplier A'],
    });
    expect(rows.get('44444444-4444-4444-8444-444444444444')).toMatchObject({
      stock: null,
      level: 'unknown',
      usd: null,
      uzs: null,
      recent: [],
    });
  });

  it('maps the full delivery history with quantities, method and category', () => {
    const [line] = toSupplyLines([
      {
        ...summary,
        purchaseMethod: 'Import',
        category: 'Telefonlar',
        deliveredQuantity: '40.000',
        availableQuantity: '34.000',
        syncedAt: '2026-10-19T04:00:00.000Z',
      },
    ]);
    expect(line).toMatchObject({
      ref: 'Z-20413',
      delivered: '40.000',
      available: '34.000',
      method: 'Import',
      category: 'Telefonlar',
    });
  });
});

describe('USD rate input', () => {
  it('accepts plain numbers and thousands grouping by spaces or commas (en-US)', () => {
    expect(parseRateInput('12650')).toEqual({ ok: true, value: '12650' });
    expect(parseRateInput('12650.5')).toEqual({ ok: true, value: '12650.5' });
    expect(parseRateInput('12650.1234')).toEqual({ ok: true, value: '12650.1234' });
    expect(parseRateInput('12 650')).toEqual({ ok: true, value: '12650' });
    expect(parseRateInput('12 650.50')).toEqual({ ok: true, value: '12650.50' });
    expect(parseRateInput('12,650')).toEqual({ ok: true, value: '12650' });
    expect(parseRateInput('12,650.50')).toEqual({ ok: true, value: '12650.50' });
    expect(parseRateInput('1,012,650')).toEqual({ ok: true, value: '1012650' });
  });

  it('never reads a comma as a decimal mark: 12,650 is twelve thousand, not 12.65', () => {
    expect(parseRateInput('12,650')).not.toEqual({ ok: true, value: '12.650' });
    for (const ambiguous of ['12,65', '12,6500', '12 650,5', '12,5', ',650', '12,,650']) {
      expect(parseRateInput(ambiguous)).toEqual({ ok: false, reason: 'ambiguous' });
    }
  });

  it("rejects with the api's own rule: empty, zero, negative, 5 fraction digits, text", () => {
    expect(parseRateInput('   ')).toEqual({ ok: false, reason: 'empty' });
    for (const bad of ['0', '-5', '12650.12345', 'abc', '1e4', '12.650.1', '12 65', '1 2']) {
      expect(parseRateInput(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('shows a stored rate without dead zeros, with a dot the parser reads back', () => {
    expect(rateToInput('12650.0000')).toBe('12650');
    expect(rateToInput('12650.5000')).toBe('12650.5');
  });
});

describe('USD rate plausibility', () => {
  it('flags values outside the band, with decimal strings only', () => {
    expect(assessRate('12650', '12650.0000')).toBe('ok');
    expect(assessRate('5000', null)).toBe('ok');
    expect(assessRate('30000', null)).toBe('ok');
    expect(assessRate('4999.9999', null)).toBe('outsideBand');
    expect(assessRate('30000.0001', null)).toBe('outsideBand');
    expect(assessRate('12.65', '12650.0000')).toBe('outsideBand');
    expect(USD_RATE_PLAUSIBLE_MIN).toBe(5_000);
    expect(USD_RATE_PLAUSIBLE_MAX).toBe(30_000);
  });

  it('flags a change of more than 25 percent against the current rate, exactly', () => {
    expect(assessRate('15812.5', '12650.0000')).toBe('ok'); // exactly +25%
    expect(assessRate('15812.5001', '12650.0000')).toBe('bigChange');
    expect(assessRate('9487.5', '12650.0000')).toBe('ok'); // exactly -25%
    expect(assessRate('9487.4999', '12650.0000')).toBe('bigChange');
  });
});
