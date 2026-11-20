import { customerPriceListResponseSchema } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import type { ProductView } from '../../catalog/index.js';
import type { PriceListView } from '../pricing.types.js';
import { toCustomerPriceListResponse, toStaffPriceListResponse } from './pricing.response.js';

const product: ProductView = {
  id: 'p1',
  productCode: 'APPLE-1',
  category: '  Фрукты ',
  categoryId: null,
  trackingType: 'NONE',
  markingRequired: false,
  codeRuleConfigured: false,
  isActive: true,
  codeGenerated: false,
  mergedIntoProductId: null,
  brandId: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  translations: [
    { lang: 'UZ', name: 'Olma', description: 'internal text' },
    { lang: 'RU', name: 'Яблоко', description: null },
  ],
};

const list: PriceListView = {
  version: {
    id: 'v1',
    number: 7,
    status: 'PUBLISHED',
    publishedAt: new Date('2026-10-20T08:00:00Z'),
    publishedBy: 'staff-user-1',
    note: 'internal note',
    source: 'MANUAL',
    createdAt: new Date('2026-10-19T08:00:00Z'),
  },
  items: [
    {
      product,
      basePrice: new Prisma.Decimal('1690000.1'),
      deferredPrice: null,
      rrp: null,
      wholesalePrice: null,
      wholesaleDeferredPrice: null,
      alifPrice: null,
      alifDeferredPrice: null,
      currency: 'UZS',
      uzs: {
        basePrice: new Prisma.Decimal('1690000.1'),
        deferredPrice: null,
        rrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        alifPrice: null,
        alifDeferredPrice: null,
      },
      usd: null,
    },
  ],
  usdRate: null,
  priceTier: null,
};

describe('customer DTO name and unit', () => {
  it('is the one common name (UZ, then RU, then EN, then the code) and the piece unit', () => {
    expect(toCustomerPriceListResponse(list, new Map()).items[0]).toMatchObject({
      name: 'Olma',
      unit: 'PIECE',
    });
    const sheetOnly = {
      ...list,
      items: [
        {
          ...list.items[0]!,
          product: {
            ...product,
            translations: [{ lang: 'RU' as const, name: 'X', description: null }],
          },
        },
      ],
    };
    expect(toCustomerPriceListResponse(sheetOnly, new Map()).items[0]?.name).toBe('X');
    const nameless = {
      ...list,
      items: [{ ...list.items[0]!, product: { ...product, translations: [] } }],
    };
    expect(toCustomerPriceListResponse(nameless, new Map()).items[0]?.name).toBe('APPLE-1');
  });
});

describe('customer DTO', () => {
  const dto = toCustomerPriceListResponse(list, new Map());

  it('is an explicit allow-list: no staff metadata, no descriptions, no status', () => {
    expect(Object.keys(dto).sort()).toEqual(['items', 'version']);
    expect(Object.keys(dto.version).sort()).toEqual(['number', 'publishedAt']);
    expect(Object.keys(dto.items[0]!).sort()).toEqual(
      [
        'deferredPrice',
        'category',
        'currency',
        'imageLargeUrl',
        'imageUrl',
        'name',
        'orderableStock',
        'price',
        'productId',
        'productCode',
        'rrp',
        'unit',
      ].sort(),
    );
    const text = JSON.stringify(dto);
    expect(text).not.toContain('staff-user-1');
    expect(text).not.toContain('internal');
  });

  it('carries the category as the one allow-listed label: trimmed, null when blank or missing', () => {
    expect(dto.items[0]?.category).toBe('Фрукты');
    for (const category of [null, '', '   ']) {
      const one = toCustomerPriceListResponse(
        {
          ...list,
          items: [{ ...list.items[0]!, product: { ...product, category } }],
        },
        new Map(),
      );
      expect(one.items[0]?.category).toBeNull();
    }
    const long = toCustomerPriceListResponse(
      {
        ...list,
        items: [
          {
            ...list.items[0]!,
            product: {
              ...product,
              id: '019a0000-0000-7000-8000-000000000001',
              category: 'x'.repeat(300),
            },
          },
        ],
      },
      new Map(),
    );
    expect(long.items[0]?.category).toHaveLength(200);
    customerPriceListResponseSchema.parse(long);
  });

  describe('category label cleanup', () => {
    const label = (category: string): string | null => {
      const one = toCustomerPriceListResponse(
        {
          ...list,
          items: [
            {
              ...list.items[0]!,
              product: { ...product, id: '019a0000-0000-7000-8000-000000000001', category },
            },
          ],
        },
        new Map(),
      );
      customerPriceListResponseSchema.parse(one);
      return one.items[0]?.category ?? null;
    };

    it('collapses runs of whitespace and control characters to one space', () => {
      expect(label('Кабели \t\n  и \u0007 зарядки')).toBe('Кабели и зарядки');
      expect(label('\n\t\u0000')).toBeNull();
    });

    it('does not cut an emoji in half at the 200 limit and trims after the cut', () => {
      const emoji = label(`${'a'.repeat(199)}\u{1F600}`);
      expect(emoji).toBe('a'.repeat(199));
      expect(emoji).not.toMatch(/[\uD800-\uDFFF]/);
      // An emoji that fits entirely is kept.
      expect(label(`${'a'.repeat(198)}\u{1F600}`)).toBe(`${'a'.repeat(198)}\u{1F600}`);
      // The cut ends on a space: it is trimmed away.
      expect(label(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199));
    });
  });

  it('keeps cost, supplier, rate and every stock field but the one figure out of the items', () => {
    // The one allowed stock key (owner decision 2026-11-09) is taken out first, so any OTHER
    // stock-like name still fails.
    const text = JSON.stringify(dto).toLowerCase().replaceAll('"orderablestock"', '""');
    for (const word of ['cost', 'supplier', 'rate', 'stock', 'margin', 'purchase', 'usd']) {
      expect(text, word).not.toContain(word);
    }
  });

  it('carries the stock figure as whole pieces: 0 when out of stock, null without a figure', () => {
    expect(dto.items[0]?.orderableStock).toBeNull();
    const other = { ...product, id: '019a0000-0000-7000-8000-000000000002', productCode: 'PEAR-1' };
    const gone = { ...product, id: '019a0000-0000-7000-8000-000000000003', productCode: 'PLUM-1' };
    const withStock = toCustomerPriceListResponse(
      {
        ...list,
        items: [
          list.items[0]!,
          { ...list.items[0]!, product: other },
          { ...list.items[0]!, product: gone },
        ],
      },
      new Map(),
      new Map([
        [product.id, new Prisma.Decimal('45.000')],
        [gone.id, new Prisma.Decimal('0')],
      ]),
    );
    expect(withStock.items.map((item) => [item.productCode, item.orderableStock])).toEqual([
      ['APPLE-1', 45],
      ['PEAR-1', null],
      ['PLUM-1', 0],
    ]);
  });

  it('gives the primary photo URLs (thumb and large) of a product that has one, null otherwise', () => {
    const imageId = '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b';
    const withPhoto = toCustomerPriceListResponse(list, new Map([[product.id, imageId]]));
    expect(withPhoto.items[0]).toMatchObject({
      imageUrl: `/api/media/product-images/${imageId}/thumb`,
      imageLargeUrl: `/api/media/product-images/${imageId}/large`,
    });
    expect(dto.items[0]).toMatchObject({ imageUrl: null, imageLargeUrl: null });
  });

  it('serializes money as an exact decimal string', () => {
    expect(dto.items[0]).toMatchObject({ price: '1690000.10', currency: 'UZS', name: 'Olma' });
  });

  it('carries the recommended retail price as an exact decimal string, null when there is none', () => {
    expect(dto.items[0]?.rrp).toBeNull();
    const withRrp = toCustomerPriceListResponse(
      {
        ...list,
        items: [
          {
            ...list.items[0]!,
            product: { ...product, id: '019a0000-0000-7000-8000-000000000001' },
            rrp: new Prisma.Decimal('1990000.5'),
          },
        ],
      },
      new Map(),
    );
    expect(withRrp.items[0]?.rrp).toBe('1990000.50');
    // The strict customer schema accepts the field (and nothing next to it).
    customerPriceListResponseSchema.parse(withRrp);
  });
});

describe('staff DTO', () => {
  it('includes version metadata and every name, money as string', () => {
    const dto = toStaffPriceListResponse(
      list,
      new Map(),
      new Map([['staff-user-1', 'Aziza Yusupova']]),
      new Map(),
    );
    expect(dto.version).toMatchObject({
      note: 'internal note',
      publishedBy: 'Aziza Yusupova',
      publishedByUserId: 'staff-user-1',
      status: 'PUBLISHED',
    });
    expect(dto.items[0]).toMatchObject({ basePrice: '1690000.10', rrp: null, isActive: true });
    expect(dto.items[0]?.names).toHaveLength(2);
    const withRrp = toStaffPriceListResponse(
      { ...list, items: [{ ...list.items[0]!, rrp: new Prisma.Decimal('149.9') }] },
      new Map(),
      new Map(),
      new Map(),
    );
    expect(withRrp.items[0]?.rrp).toBe('149.90');
    expect(JSON.stringify(dto)).not.toContain('Фрукты');
  });

  it('never shows a stored actor id when the person has no name', () => {
    const dto = toStaffPriceListResponse(list, new Map(), new Map(), new Map());
    expect(dto.version).toMatchObject({ publishedBy: null, publishedByUserId: null });
    expect(JSON.stringify(dto)).not.toContain('staff-user-1');
  });

  it('gives the brand and the last price change with a name, never the stored actor id', () => {
    const productId = list.items[0]!.product.id;
    const at = new Date('2026-11-19T09:41:00Z');
    const dto = toStaffPriceListResponse(
      list,
      new Map(),
      new Map([['staff-user-1', 'Aziza Yusupova']]),
      new Map(),
      {
        brands: new Map([[productId, 'Xiaomi']]),
        lastChanges: new Map([
          [productId, { versionNumber: 7, publishedAt: at, publishedBy: 'staff-user-1' }],
        ]),
      },
    );
    expect(dto.items[0]).toMatchObject({
      brand: 'Xiaomi',
      lastChange: { versionNumber: 7, changedAt: at.toISOString(), changedBy: 'Aziza Yusupova' },
    });
    const unnamed = toStaffPriceListResponse(list, new Map(), new Map(), new Map(), {
      brands: new Map(),
      lastChanges: new Map([
        [productId, { versionNumber: 7, publishedAt: at, publishedBy: 'staff-user-1' }],
      ]),
    });
    expect(unnamed.items[0]).toMatchObject({ brand: null, lastChange: { changedBy: null } });
    expect(JSON.stringify(unnamed)).not.toContain('staff-user-1');
    // Outside the current list (a version, a draft): neither is known.
    expect(toStaffPriceListResponse(list, new Map(), new Map(), new Map()).items[0]).toMatchObject({
      brand: null,
      lastChange: null,
    });
  });

  it('gives the primary photo URLs of a product that has one, null otherwise', () => {
    const productId = list.items[0]!.product.id;
    const imageId = '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b';
    const withPhoto = toStaffPriceListResponse(
      list,
      new Map([[productId, imageId]]),
      new Map(),
      new Map(),
    );
    expect(withPhoto.items[0]).toMatchObject({
      imageUrl: `/api/media/product-images/${imageId}/thumb`,
      imageLargeUrl: `/api/media/product-images/${imageId}/large`,
    });
    const without = toStaffPriceListResponse(list, new Map(), new Map(), new Map());
    expect(without.items[0]).toMatchObject({ imageUrl: null, imageLargeUrl: null });
  });

  it('names the sheet product of a generated-code item only; a sheet item is always null', () => {
    const generated: ProductView = {
      ...product,
      id: 'g1',
      productCode: 'IO-000001',
      codeGenerated: true,
      translations: [{ lang: 'UZ', name: 'Olma', description: null }],
    };
    const both: PriceListView = {
      ...list,
      items: [list.items[0]!, { ...list.items[0]!, product: generated }],
    };
    const match = { productId: 'p1', productCode: 'APPLE-1', name: 'Olma', extra: 'never' };
    const matches = new Map([
      ['g1', match],
      ['p1', match],
    ]);
    const dto = toStaffPriceListResponse(both, new Map(), new Map(), matches);
    expect(dto.items.map((item) => item.sheetMatch)).toEqual([
      null,
      { productId: 'p1', productCode: 'APPLE-1', name: 'Olma' },
    ]);
    expect(toStaffPriceListResponse(both, new Map(), new Map(), new Map()).items[1]).toMatchObject({
      sheetMatch: null,
    });
  });
});
