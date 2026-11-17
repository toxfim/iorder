import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import type { ProductView } from '../catalog/index.js';
import { formatAmount } from './order-lines.js';
import {
  orderabilityProblem,
  priceItems,
  repriceForPlan,
  unitPriceForPlan,
  type PriceBook,
  lineUsd,
  orderTotalUsd,
} from './order-pricing.js';

const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

function product(id: string, code: string, isActive = true): ProductView {
  return {
    id,
    productCode: code,
    category: null,
    categoryId: null,
    trackingType: 'NONE',
    markingRequired: false,
    codeRuleConfigured: false,
    isActive,
    codeGenerated: false,
    mergedIntoProductId: null,
    brandId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    translations: [
      { lang: 'UZ', name: `${code} uz`, description: null },
      { lang: 'RU', name: `${code} ru`, description: null },
    ],
  };
}

const book: PriceBook = {
  versionId: 'v1',
  versionNumber: 7,
  priceTier: 'STANDARD',
  usdRate: null,
  entries: new Map([
    [
      'p-b',
      {
        product: product('p-b', 'B-2'),
        unitPrice: dec('1200.00'),
        deferredUnitPrice: null,
        fullUnitPriceUsd: null,
        deferredUnitPriceUsd: null,
        rrp: null,
      },
    ],
    [
      'p-a',
      {
        product: product('p-a', 'A-1'),
        unitPrice: dec('1500.50'),
        deferredUnitPrice: null,
        fullUnitPriceUsd: null,
        deferredUnitPriceUsd: null,
        rrp: null,
      },
    ],
    [
      'p-x',
      {
        product: product('p-x', 'X-9', false),
        unitPrice: dec('10.00'),
        deferredUnitPrice: null,
        fullUnitPriceUsd: null,
        deferredUnitPriceUsd: null,
        rrp: null,
      },
    ],
  ]),
};

describe('priceItems', () => {
  it('snapshots code, the common name, the piece unit, unit price and exact line totals', () => {
    const result = priceItems(
      book,
      [
        { productId: 'p-b', quantity: dec('2.5') },
        { productId: 'p-a', quantity: dec('3') },
      ],
      'FULL',
    );
    expect(result.unorderableProductIds).toEqual([]);
    expect(result.lines.map((l) => [l.productCode, l.name, l.unit])).toEqual([
      ['A-1', 'A-1 uz', 'PIECE'],
      ['B-2', 'B-2 uz', 'PIECE'],
    ]);
    // 3 x 1500.50 = 4501.50 ; 2.5 x 1200.00 = 3000.00
    expect(result.lines.map((l) => formatAmount(l.lineTotal))).toEqual(['4501.50', '3000.00']);
    expect(formatAmount(result.total)).toBe('7501.50');
  });

  it('the recommended retail price never reaches a snapshot line or a total', () => {
    const items = [{ productId: 'p-a', quantity: dec('3') }];
    const entry = book.entries.get('p-a');
    if (!entry) throw new Error('fixture');
    // The same product with an RRP far above the sale price.
    const withRrp: PriceBook = {
      ...book,
      entries: new Map([['p-a', { ...entry, rrp: dec('9999.00') }]]),
    };
    for (const plan of ['FULL', 'DEFERRED'] as const) {
      const priced = priceItems(withRrp, items, plan);
      expect(priced).toEqual(priceItems(book, items, plan));
      expect(priced.lines.every((line) => !('rrp' in line))).toBe(true);
    }
  });

  it('uses the sheet (RU) name while there is no staff-entered name', () => {
    const sheetOnly = { ...product('p-s', 'S-1'), translations: [] as ProductView['translations'] };
    sheetOnly.translations.push({ lang: 'RU', name: 'Товар', description: null });
    const result = priceItems(
      {
        ...book,
        entries: new Map([
          [
            'p-s',
            {
              product: sheetOnly,
              unitPrice: dec('5.00'),
              deferredUnitPrice: null,
              fullUnitPriceUsd: null,
              deferredUnitPriceUsd: null,
              rrp: null,
            },
          ],
        ]),
      },
      [{ productId: 'p-s', quantity: dec('1') }],
      'FULL',
    );
    expect(result.lines[0]).toMatchObject({ name: 'Товар', unit: 'PIECE' });
  });

  it('reports unknown, unpriced and inactive products instead of pricing them', () => {
    const result = priceItems(
      book,
      [
        { productId: 'p-a', quantity: dec('1') },
        { productId: 'p-x', quantity: dec('1') },
        { productId: 'p-missing', quantity: dec('1') },
      ],
      'FULL',
    );
    expect(result.unorderableProductIds).toEqual(['p-x', 'p-missing']);
    expect(result.lines).toHaveLength(1);
  });

  it('classifies why a product cannot be ordered (the unit can no longer be missing)', () => {
    expect(orderabilityProblem(product('a', 'A'))).toBeNull();
    expect(orderabilityProblem(product('a', 'A', false))).toBe('INACTIVE');
    expect(orderabilityProblem({ ...product('a', ' '), translations: [] })).toBe('INCOMPLETE');
    // A product without any translation is still orderable: the snapshot name is its code.
    expect(orderabilityProblem({ ...product('a', 'A'), translations: [] })).toBeNull();
  });

  it('prices an empty cart at zero', () => {
    const result = priceItems(book, [], 'FULL');
    expect(result.lines).toEqual([]);
    expect(formatAmount(result.total)).toBe('0.00');
  });
});

describe('payment plan pricing', () => {
  const plans: PriceBook = {
    versionId: 'v2',
    versionNumber: 8,
    priceTier: 'STANDARD',
    usdRate: null,
    entries: new Map([
      [
        'with',
        {
          product: product('with', 'A-1'),
          unitPrice: dec('100.00'),
          deferredUnitPrice: dec('120.50'),
          fullUnitPriceUsd: null,
          deferredUnitPriceUsd: null,
          rrp: null,
        },
      ],
      [
        'also',
        {
          product: product('also', 'B-2'),
          unitPrice: dec('10.00'),
          deferredUnitPrice: dec('11.00'),
          fullUnitPriceUsd: null,
          deferredUnitPriceUsd: null,
          rrp: null,
        },
      ],
      [
        'none',
        {
          product: product('none', 'C-3'),
          unitPrice: dec('50.00'),
          deferredUnitPrice: null,
          fullUnitPriceUsd: null,
          deferredUnitPriceUsd: null,
          rrp: null,
        },
      ],
    ]),
  };
  const two = [
    { productId: 'with', quantity: dec('2') },
    { productId: 'also', quantity: dec('1') },
  ];

  it('FULL charges the sale price and still snapshots both prices', () => {
    const result = priceItems(plans, two, 'FULL');
    expect(formatAmount(result.total)).toBe('210.00');
    expect(result.lines[0]).toMatchObject({
      unitPrice: dec('100.00'),
      fullUnitPrice: dec('100.00'),
      deferredUnitPrice: dec('120.50'),
    });
    expect(result.missingDeferredProductIds).toEqual([]);
  });

  it('DEFERRED charges the deferred price and still snapshots both prices', () => {
    const result = priceItems(plans, two, 'DEFERRED');
    expect(formatAmount(result.total)).toBe('252.00');
    expect(result.lines[0]).toMatchObject({
      unitPrice: dec('120.50'),
      lineTotal: dec('241.00'),
      fullUnitPrice: dec('100.00'),
    });
  });

  it('DEFERRED never guesses a missing price: the product is reported instead', () => {
    const result = priceItems(
      plans,
      [...two, { productId: 'none', quantity: dec('1') }],
      'DEFERRED',
    );
    expect(result.missingDeferredProductIds).toEqual(['none']);
    expect(result.lines.map((line) => line.productId)).not.toContain('none');
  });

  it('FULL does not need a deferred price', () => {
    const result = priceItems(plans, [{ productId: 'none', quantity: dec('2') }], 'FULL');
    expect(result.missingDeferredProductIds).toEqual([]);
    expect(formatAmount(result.total)).toBe('100.00');
    expect(result.lines[0]?.deferredUnitPrice).toBeNull();
  });

  it('picks the snapshot of the plan', () => {
    const prices = { fullUnitPrice: dec('5.00'), deferredUnitPrice: dec('6.00') };
    expect(unitPriceForPlan(prices, 'FULL')).toEqual(dec('5.00'));
    expect(unitPriceForPlan(prices, 'DEFERRED')).toEqual(dec('6.00'));
    expect(unitPriceForPlan({ ...prices, deferredUnitPrice: null }, 'DEFERRED')).toBeNull();
  });

  const orderLine = (id: string, quantity: string, full: string, deferred: string | null) => ({
    id,
    productId: id,
    quantity: dec(quantity),
    fullUnitPrice: dec(full),
    deferredUnitPrice: deferred === null ? null : dec(deferred),
  });

  it('reprices an order from its own snapshots, in both directions', () => {
    const lines = [orderLine('a', '3', '100.00', '110.25'), orderLine('b', '1', '7.50', '8.00')];
    const deferred = repriceForPlan(lines, 'DEFERRED');
    expect(formatAmount(deferred.total)).toBe('338.75');
    expect(deferred.lines.map((line) => formatAmount(line.lineTotal))).toEqual(['330.75', '8.00']);
    const full = repriceForPlan(lines, 'FULL');
    expect(formatAmount(full.total)).toBe('307.50');
    expect(full.lines.map((line) => formatAmount(line.unitPrice))).toEqual(['100.00', '7.50']);
  });

  it('refuses DEFERRED when a line of the order has no deferred snapshot', () => {
    const result = repriceForPlan(
      [orderLine('a', '1', '100.00', '110.00'), orderLine('old', '1', '50.00', null)],
      'DEFERRED',
    );
    expect(result.missingDeferredProductIds).toEqual(['old']);
  });
});

describe('orderTotalUsd', () => {
  const usdLine = (
    quantity: string,
    total: string,
    full: string | null,
    deferred: string | null,
  ) => ({
    quantity: dec(quantity),
    lineTotal: dec(total),
    fullUnitPriceUsd: full === null ? null : dec(full),
    deferredUnitPriceUsd: deferred === null ? null : dec(deferred),
  });

  it("a USD line is quantity x the snapshot of the plan, whatever its rounded so'm total", () => {
    const line = usdLine('5000', '75905000.00', '1.20', '1.30');
    expect(lineUsd(line, 'FULL', dec('12650.55')).toFixed(6)).toBe('6000.000000');
    expect(lineUsd(line, 'DEFERRED', dec('12650.55')).toFixed(6)).toBe('6500.000000');
  });

  it("a legacy so'm line is its total at the frozen rate, six decimals half up", () => {
    expect(lineUsd(usdLine('1', '15000.00', null, null), 'FULL', dec('12650')).toFixed(6)).toBe(
      '1.185771',
    );
  });

  it("a line with a USD sale price but no USD deferred price counts its so'm total on DEFERRED", () => {
    const line = usdLine('2', '36000.00', '1.20', null);
    expect(lineUsd(line, 'DEFERRED', dec('12000')).toFixed(6)).toBe('3.000000');
  });

  it('sums a mixed order line by line', () => {
    const total = orderTotalUsd(
      [usdLine('5000', '75905000.00', '1.20', null), usdLine('1', '15000.00', null, null)],
      'FULL',
      dec('12650'),
    );
    expect(total.toFixed(6)).toBe('6001.185771');
  });
});
