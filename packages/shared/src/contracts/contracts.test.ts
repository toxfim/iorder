import { describe, expect, it } from 'vitest';
import {
  CATALOG_ROUTES,
  CONFLICT_REASONS,
  PRICING_ROUTES,
  buildPath,
  createDraftRequestSchema,
  createDraftResponseSchema,
  createProductRequestSchema,
  customerPriceListQuerySchema,
  customerPriceListResponseSchema,
  errorBodySchema,
  moneyStringSchema,
  priceHistoryResponseSchema,
  publishResponseSchema,
  staffPriceListResponseSchema,
  staffProductListResponseSchema,
  staffProductResponseSchema,
  staffVersionListResponseSchema,
  staffVersionResponseSchema,
  updateDraftRequestSchema,
  updateProductRequestSchema,
  upsertItemsRequestSchema,
} from '../index.js';

const id = '019a0000-0000-7000-8000-000000000001';
const id2 = '019a0000-0000-7000-8000-000000000002';
const at = '2026-10-20T08:00:00.000Z';

const version = {
  id,
  number: 3,
  status: 'PUBLISHED',
  note: null,
  source: 'MANUAL',
  createdAt: at,
  publishedAt: at,
  publishedBy: 'Aziza Y.',
  publishedByUserId: '00000000-0000-7000-8000-000000000001',
};

const product = {
  id,
  productCode: 'APPLE',
  name: 'Olma',
  unit: 'PIECE',
  isActive: true,
  codeGenerated: false,
  mergedIntoProductId: null,
  translations: [{ lang: 'UZ', name: 'Olma', description: null }],
  createdAt: at,
  updatedAt: at,
};

const customerList = {
  version: { number: 3, publishedAt: at },
  items: [
    {
      productId: id,
      productCode: 'APPLE',
      unit: 'box',
      name: 'Olma',
      price: '1690000.10',
      deferredPrice: '1650000.00' as string | null,
      rrp: '1990000.00' as string | null,
      orderableStock: 45 as number | null,
      currency: 'UZS',
      category: 'Фрукты' as string | null,
      imageUrl: null as string | null,
      imageLargeUrl: null as string | null,
    },
  ],
};

const staffList = {
  version,
  items: [
    {
      productId: id,
      productCode: 'APPLE',
      unit: 'box',
      isActive: true,
      codeGenerated: false,
      sheetMatch: null,
      names: [{ lang: 'RU', name: 'Яблоко' }],
      basePrice: '133.60',
      deferredPrice: null,
      rrp: '149.90' as string | null,
      wholesalePrice: '120.00' as string | null,
      wholesaleDeferredPrice: null as string | null,
      alifPrice: null as string | null,
      alifDeferredPrice: null as string | null,
      currency: 'USD',
      uzs: { basePrice: '1690040.00', deferredPrice: null },
      brand: 'Xiaomi' as string | null,
      lastChange: {
        versionNumber: 3,
        changedAt: '2026-11-19T09:41:00.000Z',
        changedBy: 'Dilnoza' as string | null,
      } as { versionNumber: number; changedAt: string; changedBy: string | null } | null,
      imageUrl: null,
      imageLargeUrl: null,
    },
  ],
};

describe('moneyStringSchema', () => {
  it.each(['1', '0.01', '10.5', '1690000.10', '9999999999999999.99'])('accepts %s', (v) => {
    expect(moneyStringSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    1690000.1,
    10,
    null,
    '0',
    '0.00',
    '-1.00',
    '10.001',
    '1e3',
    '1,000.00',
    '007',
    '+5',
    ' 5 ',
    '',
    '5.',
    '10000000000000000',
    'NaN',
  ])('rejects %j (JSON numbers are floats)', (v) => {
    expect(moneyStringSchema.safeParse(v).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('parse valid payloads and apply defaults', () => {
    expect(createDraftRequestSchema.parse({})).toEqual({ copyFromCurrent: false, note: null });
    expect(updateDraftRequestSchema.parse({ note: ' x ' })).toEqual({ note: 'x' });
    expect(customerPriceListQuerySchema.parse({})).toEqual({ lang: 'UZ' });
    expect(customerPriceListQuerySchema.parse({ lang: 'RU' })).toEqual({ lang: 'RU' });
    expect(createProductRequestSchema.parse({ productCode: ' A-1 ', name: 'Olma' })).toEqual({
      productCode: 'A-1',
      name: 'Olma',
    });
    expect(updateProductRequestSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(
      upsertItemsRequestSchema.parse({ items: [{ productId: id, basePrice: '10.50' }] }),
    ).toEqual({ items: [{ productId: id, basePrice: '10.50', deferredPrice: null, rrp: null }] });
    expect(
      upsertItemsRequestSchema.parse({
        items: [{ productId: id, basePrice: '10.50', deferredPrice: '10.00', rrp: '14.90' }],
      }),
    ).toEqual({
      items: [{ productId: id, basePrice: '10.50', deferredPrice: '10.00', rrp: '14.90' }],
    });
    // The RRP is money like the other prices: a JSON number or a zero is refused.
    for (const rrp of [14.9, '0', '14.999']) {
      expect(
        upsertItemsRequestSchema.safeParse({ items: [{ productId: id, basePrice: '1', rrp }] })
          .success,
      ).toBe(false);
    }
  });

  it('reject JSON numbers for money', () => {
    expect(
      upsertItemsRequestSchema.safeParse({ items: [{ productId: id, basePrice: 10.5 }] }).success,
    ).toBe(false);
  });

  it('reject unknown and cost-like fields instead of dropping them silently', () => {
    expect(
      upsertItemsRequestSchema.safeParse({
        items: [{ productId: id, basePrice: '1.00', purchasePrice: '0.50' }],
      }).success,
    ).toBe(false);
    expect(
      createProductRequestSchema.safeParse({ productCode: 'A', name: 'x', supplier: 'ACME' })
        .success,
    ).toBe(false);
    expect(createDraftRequestSchema.safeParse({ markup: 5 }).success).toBe(false);
    expect(updateProductRequestSchema.safeParse({ productCode: 'B' }).success).toBe(false);
  });

  it('reject bad shapes', () => {
    expect(upsertItemsRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      upsertItemsRequestSchema.safeParse({
        items: [
          { productId: id, basePrice: '1.00' },
          { productId: id, basePrice: '2.00' },
        ],
      }).success,
    ).toBe(false);
    expect(
      upsertItemsRequestSchema.safeParse({
        items: Array.from({ length: 501 }, (_, i) => ({
          productId: `019a0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
          basePrice: '1.00',
        })),
      }).success,
    ).toBe(false);
    expect(updateProductRequestSchema.safeParse({}).success).toBe(false);
    expect(customerPriceListQuerySchema.safeParse({ lang: 'DE' }).success).toBe(false);
    expect(createProductRequestSchema.safeParse({ productCode: 'A', name: '' }).success).toBe(
      false,
    );
  });
});

describe('response schemas', () => {
  it('parse valid payloads', () => {
    expect(customerPriceListResponseSchema.safeParse(customerList).success).toBe(true);
    expect(staffPriceListResponseSchema.safeParse(staffList).success).toBe(true);
    expect(staffVersionResponseSchema.safeParse(version).success).toBe(true);
    expect(publishResponseSchema.safeParse(version).success).toBe(true);
    expect(
      staffVersionListResponseSchema.safeParse({ items: [{ ...version, itemCount: 2 }] }).success,
    ).toBe(true);
    expect(staffProductResponseSchema.safeParse(product).success).toBe(true);
    expect(staffProductListResponseSchema.safeParse({ items: [product] }).success).toBe(true);
    expect(
      priceHistoryResponseSchema.safeParse({
        productId: id,
        productCode: 'APPLE',
        entries: [
          {
            versionId: id2,
            versionNumber: 2,
            publishedAt: at,
            publishedBy: 'Aziza Y.',
            publishedByUserId: '00000000-0000-7000-8000-000000000001',
            source: 'SHEET_IMPORT',
            oldPrice: null,
            newPrice: '100.00',
            oldDeferredPrice: null,
            newDeferredPrice: '95.00',
            oldRrp: null,
            newRrp: '129.00',
            oldCurrency: 'UZS',
            currency: 'USD',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('create-draft response carries a required skippedInactiveCount', () => {
    expect(
      createDraftResponseSchema.safeParse({ ...version, skippedInactiveCount: 0 }).success,
    ).toBe(true);
    expect(createDraftResponseSchema.safeParse(version).success).toBe(false);
    expect(
      createDraftResponseSchema.safeParse({ ...version, skippedInactiveCount: -1 }).success,
    ).toBe(false);
    expect(
      createDraftResponseSchema.safeParse({ ...version, skippedInactiveCount: 1, extra: 1 })
        .success,
    ).toBe(false);
    expect(PRICING_ROUTES.currentDraft).toEqual({
      method: 'GET',
      path: '/staff/price-list/drafts/current',
    });
  });

  it('customer DTO is a strict allow-list: an extra or cost-like key fails to parse', () => {
    const withTopLevel = { ...customerList, purchasePrice: '1.00' };
    const withItemKey = {
      ...customerList,
      items: [{ ...customerList.items[0], supplier: 'ACME', margin: '5.00' }],
    };
    const withVersionKey = {
      ...customerList,
      version: { ...customerList.version, publishedBy: 'Aziza Y.' },
    };
    for (const leaked of [withTopLevel, withItemKey, withVersionKey]) {
      expect(customerPriceListResponseSchema.safeParse(leaked).success).toBe(false);
    }
  });

  it('customer DTO rejects a numeric price and a non-UZS currency', () => {
    const item = customerList.items[0];
    expect(
      customerPriceListResponseSchema.safeParse({
        ...customerList,
        items: [{ ...item, price: 10 }],
      }).success,
    ).toBe(false);
    expect(
      customerPriceListResponseSchema.safeParse({
        ...customerList,
        items: [{ ...item, currency: 'USD' }],
      }).success,
    ).toBe(false);
  });

  it('customer DTO category: a trimmed label or null, required, bounded, nothing else', () => {
    const item = customerList.items[0];
    const parse = (category: unknown, extra: object = {}) =>
      customerPriceListResponseSchema.safeParse({
        ...customerList,
        items: [{ ...item, category, ...extra }],
      });
    expect(parse('Смартфоны').success).toBe(true);
    expect(parse(null).success).toBe(true);
    expect(parse('x'.repeat(200)).success).toBe(true);
    expect(parse('x'.repeat(201)).success).toBe(false);
    expect(parse('').success).toBe(false);
    expect(parse(5).success).toBe(false);
    // Trimmed on parse; a blank label is not a category.
    expect(parse('  Кабели ').data?.items[0]?.category).toBe('Кабели');
    expect(parse('   ').success).toBe(false);
    // Missing is not "no category": the server always sends the key.
    expect(
      customerPriceListResponseSchema.safeParse({
        ...customerList,
        items: [Object.fromEntries(Object.entries(item!).filter(([key]) => key !== 'category'))],
      }).success,
    ).toBe(false);
    // Still strict: category is the only new key.
    expect(parse('A', { supplier: 'ACME' }).success).toBe(false);
  });

  it('customer DTO stock figure: a whole number of pieces (0 = out of stock) or null, always present', () => {
    const item = customerList.items[0]!;
    const parse = (orderableStock: unknown) =>
      customerPriceListResponseSchema.safeParse({
        ...customerList,
        items: [{ ...item, orderableStock }],
      });
    expect(parse(45).success).toBe(true);
    // null = no figure and no cap (unknown or untracked stock). Zero is a figure of its own: the
    // product is tracked and nothing is left, so it cannot be ordered.
    expect(parse(null).success).toBe(true);
    expect(parse(0).success).toBe(true);
    for (const wrong of [-1, 1.5, '45', '45.000', '0'])
      expect(parse(wrong).success, String(wrong)).toBe(false);
    const withoutFigure = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== 'orderableStock'),
    );
    expect(
      customerPriceListResponseSchema.safeParse({ ...customerList, items: [withoutFigure] })
        .success,
    ).toBe(false);
  });

  it('customer DTO photo: thumb and large URLs, both present, null without a photo', () => {
    const item = customerList.items[0]!;
    const parse = (extra: object) =>
      customerPriceListResponseSchema.safeParse({
        ...customerList,
        items: [{ ...item, ...extra }],
      });
    const imageUrl = '/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/thumb';
    const imageLargeUrl = '/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/large';
    expect(parse({ imageUrl, imageLargeUrl }).success).toBe(true);
    expect(parse({ imageUrl: null, imageLargeUrl: null }).success).toBe(true);
    const withoutThumb = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== 'imageUrl'),
    );
    expect(
      customerPriceListResponseSchema.safeParse({ ...customerList, items: [withoutThumb] }).success,
    ).toBe(false);
  });

  it('staff DTOs are strict too', () => {
    expect(
      staffPriceListResponseSchema.safeParse({ ...staffList, landedCost: '1.00' }).success,
    ).toBe(false);
    expect(staffVersionResponseSchema.safeParse({ ...version, status: 'LIVE' }).success).toBe(
      false,
    );
  });
});

describe('error body', () => {
  it('accepts the api error shape with and without details', () => {
    expect(errorBodySchema.safeParse({ error: { code: 'CONFLICT', message: 'x' } }).success).toBe(
      true,
    );
    expect(
      errorBodySchema.safeParse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: [{ path: 'items.0.basePrice', message: 'bad' }],
        },
      }).success,
    ).toBe(true);
    expect(errorBodySchema.safeParse({ error: { message: 'no code' } }).success).toBe(false);
  });

  it('allows a machine-readable reason on CONFLICT only, from the exported list', () => {
    for (const reason of CONFLICT_REASONS) {
      expect(
        errorBodySchema.safeParse({ error: { code: 'CONFLICT', message: 'x', reason } }).success,
        reason,
      ).toBe(true);
    }
    expect(
      errorBodySchema.safeParse({ error: { code: 'CONFLICT', message: 'x', reason: 'MADE_UP' } })
        .success,
    ).toBe(false);
    expect(
      errorBodySchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'x', reason: 'EMPTY_DRAFT' },
      }).success,
    ).toBe(false);
    expect(
      errorBodySchema.safeParse({
        error: {
          code: 'CONFLICT',
          message: 'x',
          reason: 'INACTIVE_PRODUCT_IN_DRAFT',
          details: { productIds: ['p1'] },
        },
      }).success,
    ).toBe(true);
  });

  it('lists exactly the reasons the services raise (update with the code that raises one)', () => {
    expect([...CONFLICT_REASONS].sort()).toEqual(
      [
        'ANOTHER_VERSION_PUBLISHED',
        'CONTACT_REQUIRED',
        'DRAFT_ALREADY_OPEN',
        'DRAFT_NOT_OPEN',
        'DUPLICATE_PRODUCT_CODE',
        'EMPTY_CART',
        'EMPTY_DRAFT',
        'IDEMPOTENCY_KEY_REUSED',
        'ILLEGAL_ORDER_TRANSITION',
        'INACTIVE_PRODUCT',
        'INACTIVE_PRODUCT_IN_DRAFT',
        'INVALID_VERSION_TRANSITION',
        'LAST_ADMIN',
        'NO_PUBLISHED_VERSION',
        'ORDERING_ORGANIZATION_INACTIVE',
        'ORDER_CHANGED',
        'ORDER_NOT_EDITABLE',
        'PLACER_NOT_MEMBER',
        'PAYMENT_METHOD_NOT_CHANGEABLE',
        'PAYMENT_PLAN_NOT_CHANGEABLE',
        'DEFERRED_PRICE_UNAVAILABLE',
        'PAYMENT_PLAN_WINDOW_ENDED',
        'CART_TOTAL_CHANGED',
        'CURRENCY_CONVERSION_UNAVAILABLE',
        'PRODUCT_NOT_ORDERABLE',
        'STOCK_LIMIT_EXCEEDED',
        'REMOVAL_REQUEST_NOT_PENDING',
        'TELEGRAM_ID_REQUIRED',
        'ORGANIZATION_NOT_LINKED',
        'ORGANIZATION_ALREADY_LINKED',
        'PERSON_ORGANIZATION',
        'ORGANIZATION_ARCHIVED',
        'BOT_NOT_CONFIGURED',
        'VERSION_NOT_DRAFT',
        'UNIT_CODE_DUPLICATE',
        'UNIT_CODE_NOT_REQUIRED',
        'UNIT_CODES_NOT_EDITABLE',
        'GOODS_RETURN_NOT_PENDING',
        'UNIT_CODES_INCOMPLETE',
        'ALLOCATION_CHANGED',
        'STOCK_INSUFFICIENT',
        'SUPPLY_PARTY_CONFLICT',
        'SUPPLY_PARTY_CHANGED',
        'SUPPLY_NOT_AVAILABLE',
        'ALLOCATION_NOT_CHANGEABLE',
        'DUPLICATE_CATEGORY_NAME',
        'DUPLICATE_BRAND_NAME',
        'CATEGORY_ARCHIVED',
        'PAYMENT_VOIDED',
        'PRICE_LIST_CHANGED',
        'EMPTY_PRICE_LIST',
        'SHEET_SYNC_QUEUE_UNAVAILABLE',
        'PRODUCT_IMAGE_DUPLICATE',
        'PRIMARY_IMAGE_EXISTS',
        'RESERVED_PRODUCT_CODE_PREFIX',
        'NOT_GENERATED_CODE',
        'TARGET_IS_GENERATED',
        'PRODUCT_ALREADY_MERGED',
        'STAFF_ORDERING_DISABLED',
      ].sort(),
    );
  });
});

describe('route table', () => {
  const all = [...Object.values(CATALOG_ROUTES), ...Object.values(PRICING_ROUTES)];

  it('has no duplicate method + path', () => {
    const keys = all.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('builds paths and encodes parameters', () => {
    expect(buildPath(PRICING_ROUTES.publishDraft, { id })).toBe(
      `/staff/price-list/drafts/${id}/publish`,
    );
    expect(buildPath(PRICING_ROUTES.removeDraftItem, { id, productId: id2 })).toBe(
      `/staff/price-list/drafts/${id}/items/${id2}`,
    );
    expect(buildPath(PRICING_ROUTES.currentPriceList)).toBe('/price-list/current');
    expect(buildPath(CATALOG_ROUTES.getProduct, { id: 'a/b' })).toBe('/staff/products/a%2Fb');
    expect(() => buildPath(PRICING_ROUTES.publishDraft)).toThrow(/Missing path parameter/);
  });
});
