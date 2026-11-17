import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '@core/lib/http-client';
import { createHttpCatalogApi } from './catalog-api';

// CONTRACT test. The payloads are shaped exactly like the real API's staff product responses
// (the api catalog integration tests pin them): `category` is always present (null until a
// delivery is known), `unit` is always PIECE and `name` is the common product name. If the API
// contract moves, update this test together with the schemas the web parses with.
const ID = '44444444-4444-4444-8444-444444444444';
const FROM_SHEET = {
  id: ID,
  productCode: 'SHEET-1',
  name: 'Телефон',
  unit: 'PIECE',
  category: 'Telefonlar',
  categoryId: null,
  trackingType: 'NONE',
  markingRequired: false,
  codeRuleConfigured: false,
  isActive: true,
  codeGenerated: false,
  mergedIntoProductId: null,
  translations: [{ lang: 'RU', name: 'Телефон', description: null }],
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
};
const MANUAL = {
  ...FROM_SHEET,
  id: '55555555-5555-4555-8555-555555555555',
  category: null,
};

function apiFor(body: unknown) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  return createHttpCatalogApi(createHttpClient({ baseUrl: 'https://api.test', fetchImpl }));
}

describe('catalog API contract: staff product with category, common name and piece unit', () => {
  it('parses the product list', async () => {
    const list = await apiFor({ items: [FROM_SHEET, MANUAL] }).listProducts();
    expect(list.items[0]?.unit).toBe('PIECE');
    expect(list.items[0]?.name).toBe('Телефон');
    expect(list.items[0]?.category).toBe('Telefonlar');
    expect(list.items[1]?.category).toBeNull();
  });

  it('parses get, create and update', async () => {
    expect((await apiFor(FROM_SHEET).getProduct(ID)).codeRuleConfigured).toBe(false);
    const created = await apiFor(MANUAL).createProduct({ productCode: 'SHEET-1', name: 'Телефон' });
    expect(created.category).toBeNull();
    const updated = await apiFor(FROM_SHEET).updateProduct(ID, { name: 'Telefon' });
    expect(updated.category).toBe('Telefonlar');
  });

  it('rejects a null unit (the old sheet-product shape)', async () => {
    await expect(apiFor({ ...FROM_SHEET, unit: null }).getProduct(ID)).rejects.toThrow();
  });

  it('rejects a payload without category (the old shape)', async () => {
    const { category: _category, ...old } = FROM_SHEET;
    void _category;
    await expect(apiFor(old).getProduct(ID)).rejects.toThrow();
  });
});

const CATEGORY = {
  id: '66666666-6666-4666-8666-666666666666',
  name: 'Telefonlar',
  trackingTypeDefault: 'IMEI',
  markingRequiredDefault: true,
  isActive: true,
  productCount: 7,
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
};

function recordingApi(body: unknown) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  const api = createHttpCatalogApi(createHttpClient({ baseUrl: 'https://api.test', fetchImpl }));
  const call = (): [string, RequestInit] =>
    fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return { api, call };
}

describe('catalog API contract: product categories and the code rule', () => {
  it('lists, creates and updates categories on PRODUCT_TRACKING_ROUTES', async () => {
    const list = recordingApi({ items: [CATEGORY] });
    expect((await list.api.listCategories()).items[0]?.productCount).toBe(7);
    expect(list.call()[0]).toBe('https://api.test/staff/product-categories');

    const create = recordingApi(CATEGORY);
    await create.api.createCategory({
      name: 'Telefonlar',
      trackingTypeDefault: 'IMEI',
      markingRequiredDefault: true,
    });
    expect(create.call()[1].method).toBe('POST');
    expect(JSON.parse(String(create.call()[1].body))).toEqual({
      name: 'Telefonlar',
      trackingTypeDefault: 'IMEI',
      markingRequiredDefault: true,
    });

    const update = recordingApi({ ...CATEGORY, isActive: false });
    expect((await update.api.updateCategory(CATEGORY.id, { isActive: false })).isActive).toBe(
      false,
    );
    expect(update.call()[0]).toBe(`https://api.test/staff/product-categories/${CATEGORY.id}`);
    expect(update.call()[1].method).toBe('PATCH');
  });

  it('lists the sheet categories without a type and creates several categories at once', async () => {
    const sheet = recordingApi({
      items: [
        {
          name: 'Audio',
          productCount: 3,
          suggestedTrackingType: 'SERIAL',
          suggestedMarkingRequired: false,
        },
      ],
    });
    expect((await sheet.api.listSheetCategories()).items).toEqual([
      {
        name: 'Audio',
        productCount: 3,
        suggestedTrackingType: 'SERIAL',
        suggestedMarkingRequired: false,
      },
    ]);
    expect(sheet.call()[0]).toBe('https://api.test/staff/product-categories/sheet');

    const bulk = recordingApi({ items: [CATEGORY] });
    const items = [
      { name: 'Telefonlar', trackingTypeDefault: 'IMEI', markingRequiredDefault: true },
    ] as const;
    expect((await bulk.api.createCategories({ items: [...items] })).items).toHaveLength(1);
    expect(bulk.call()[0]).toBe('https://api.test/staff/product-categories/bulk');
    expect(bulk.call()[1].method).toBe('POST');
    expect(JSON.parse(String(bulk.call()[1].body))).toEqual({ items });
  });

  it('saves the product rule with PUT /staff/products/:id/tracking', async () => {
    const tracked = {
      ...FROM_SHEET,
      categoryId: CATEGORY.id,
      trackingType: 'IMEI',
      markingRequired: true,
    };
    const { api, call } = recordingApi(tracked);
    const saved = await api.updateProductTracking(ID, {
      categoryId: CATEGORY.id,
      trackingType: 'IMEI',
      markingRequired: true,
    });
    expect(saved.trackingType).toBe('IMEI');
    expect(call()[0]).toBe(`https://api.test/staff/products/${ID}/tracking`);
    expect(call()[1].method).toBe('PUT');
  });

  it('rejects a category with an unknown tracking type', async () => {
    await expect(
      recordingApi({ items: [{ ...CATEGORY, trackingTypeDefault: 'RFID' }] }).api.listCategories(),
    ).rejects.toThrow();
  });
});
