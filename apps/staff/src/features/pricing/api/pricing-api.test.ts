import { describe, expect, it, vi } from 'vitest';
import { ApiValidationError } from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { createHttpCatalogApi } from '@/features/catalog/api/catalog-api';
import { createHttpPricingApi } from './pricing-api';

const ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

const VERSION = {
  id: ID,
  number: 15,
  status: 'PUBLISHED',
  note: null,
  source: 'MANUAL',
  createdAt: '2026-10-19T05:00:00.000Z',
  publishedAt: '2026-10-19T08:30:00.000Z',
  publishedBy: 'Aziza Y.',
  publishedByUserId: '00000000-0000-7000-8000-00000000a001',
  usdRateSnapshot: null,
};

function setup(status: number, body?: unknown) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, pricing: createHttpPricingApi(http), catalog: createHttpCatalogApi(http) };
}

function call(fetchImpl: ReturnType<typeof setup>['fetchImpl']): [string, RequestInit] {
  const args = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return args;
}

describe('createHttpPricingApi', () => {
  it('publishes changes through POST /staff/price-list/publish with the exact body', async () => {
    const { pricing, fetchImpl } = setup(200, { ...VERSION, skippedInactiveCount: 2 });
    const request = {
      baseVersionNumber: 14,
      upserts: [{ productId: PRODUCT, basePrice: '1500.00', deferredPrice: null, rrp: '1990.00' }],
      removedProductIds: [OTHER],
    };
    const result = await pricing.publishChanges(request);
    expect(result).toMatchObject({ number: 15, status: 'PUBLISHED', skippedInactiveCount: 2 });
    const [url, init] = call(fetchImpl);
    expect(url).toBe('https://api.test/staff/price-list/publish');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('refuses a publish response without skippedInactiveCount', async () => {
    const { pricing } = setup(200, VERSION);
    await expect(
      pricing.publishChanges({ baseVersionNumber: null, upserts: [], removedProductIds: [] }),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it('reads the current list from GET /staff/price-list/current', async () => {
    const { pricing, fetchImpl } = setup(200, { version: VERSION, items: [] });
    expect((await pricing.getCurrent()).version.number).toBe(15);
    const [url, init] = call(fetchImpl);
    expect(url).toBe('https://api.test/staff/price-list/current');
    expect(init.method).toBe('GET');
  });

  it('reads price history', async () => {
    const entry = {
      versionId: ID,
      versionNumber: 14,
      publishedAt: '2026-10-19T08:30:00.000Z',
      publishedBy: 'Aziza Y.',
      publishedByUserId: '00000000-0000-7000-8000-00000000a001',
      source: 'MANUAL',
      oldPrice: '1500000.00',
      newPrice: '1690000.00',
      oldDeferredPrice: null,
      newDeferredPrice: '1650000.00',
      oldRrp: null,
      newRrp: '1990000.00',
      oldCurrency: 'UZS',
      currency: 'UZS',
    };
    const { pricing, fetchImpl } = setup(200, {
      productId: PRODUCT,
      productCode: 'KAB-1',
      entries: [entry],
    });
    const history = await pricing.getPriceHistory(PRODUCT);
    expect(history.entries[0]?.newPrice).toBe('1690000.00');
    expect(call(fetchImpl)[0]).toBe(`https://api.test/staff/products/${PRODUCT}/price-history`);
  });

  it('refuses a history entry with a float price', async () => {
    const bad = {
      productId: PRODUCT,
      productCode: 'KAB-1',
      entries: [
        {
          versionId: ID,
          versionNumber: 1,
          publishedAt: '2026-10-19T08:30:00.000Z',
          publishedBy: 'x',
          publishedByUserId: '00000000-0000-7000-8000-00000000a001',
          source: 'MANUAL',
          oldPrice: null,
          newPrice: 1690000,
          currency: 'UZS',
        },
      ],
    };
    const { pricing } = setup(200, bad);
    await expect(pricing.getPriceHistory(PRODUCT)).rejects.toThrow(/unexpected response shape/);
  });
});

describe('createHttpCatalogApi', () => {
  it('lists, creates and patches products via the route table', async () => {
    const product = {
      id: PRODUCT,
      productCode: 'KAB-1',
      name: 'Kabel',
      unit: 'PIECE',
      category: null,
      categoryId: null,
      trackingType: 'NONE',
      markingRequired: false,
      codeRuleConfigured: false,
      isActive: true,
      codeGenerated: false,
      mergedIntoProductId: null,
      translations: [{ lang: 'UZ', name: 'Kabel', description: null }],
      createdAt: '2026-10-19T08:30:00.000Z',
      updatedAt: '2026-10-19T08:30:00.000Z',
    };
    const created = setup(200, product);
    await created.catalog.createProduct({ productCode: 'KAB-1', name: 'Kabel' });
    expect(call(created.fetchImpl)[1].method).toBe('POST');
    expect(call(created.fetchImpl)[0]).toBe('https://api.test/staff/products');

    const patched = setup(200, product);
    await patched.catalog.updateProduct(PRODUCT, { isActive: false });
    expect(call(patched.fetchImpl)[1].method).toBe('PATCH');
    expect(call(patched.fetchImpl)[0]).toBe(`https://api.test/staff/products/${PRODUCT}`);

    const listed = setup(200, { items: [product] });
    expect((await listed.catalog.listProducts()).items).toHaveLength(1);
  });
});

describe('createHttpPricingApi: staff-added products', () => {
  const BRAND = '55555555-5555-4555-8555-555555555555';
  const PUBLISHED = { ...VERSION, skippedInactiveCount: 0 };

  it('creates a manual product through POST /staff/products/manual with the exact body', async () => {
    const { pricing, fetchImpl } = setup(200, {
      productId: PRODUCT,
      productCode: 'IO-000007',
      version: PUBLISHED,
    });
    const request = {
      baseVersionNumber: 14,
      name: 'Demo kabel',
      brandId: BRAND,
      category: null,
      basePrice: '3.5',
      deferredPrice: null,
    };
    const result = await pricing.createManualProduct(request);
    expect(result).toMatchObject({ productCode: 'IO-000007', version: { number: 15 } });
    const [url, init] = call(fetchImpl);
    expect(url).toBe('https://api.test/staff/products/manual');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('merges through POST /staff/products/:id/merge and accepts a null version', async () => {
    const { pricing, fetchImpl } = setup(200, {
      sourceProductId: PRODUCT,
      targetProductId: OTHER,
      version: null,
    });
    const result = await pricing.mergeProduct(PRODUCT, {
      baseVersionNumber: 14,
      targetProductId: OTHER,
    });
    expect(result.version).toBeNull();
    const [url, init] = call(fetchImpl);
    expect(url).toBe(`https://api.test/staff/products/${PRODUCT}/merge`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      baseVersionNumber: 14,
      targetProductId: OTHER,
    });
  });

  it('downloads the template as a file from GET /staff/price-list/import/template', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response('xlsx', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="template.xlsx"' },
        }),
      ),
    );
    const pricing = createHttpPricingApi(
      createHttpClient({ baseUrl: 'https://api.test', fetchImpl }),
    );
    const file = await pricing.downloadImportTemplate('empty');
    expect(file.fileName).toBe('template.xlsx');
    expect(file.blob.size).toBe(4);
    expect(call(fetchImpl)[0]).toBe('https://api.test/staff/price-list/import/template?kind=empty');
  });

  it('previews through a multipart POST with the file in the field `file`', async () => {
    const { pricing, fetchImpl } = setup(200, {
      baseVersionNumber: 14,
      rows: [],
      summary: { newCount: 0, priceChangedCount: 0, unchangedCount: 0, errorCount: 0 },
    });
    const preview = await pricing.importPreview(new File(['x'], 'narxlar.xlsx'));
    expect(preview.baseVersionNumber).toBe(14);
    const [url, init] = call(fetchImpl);
    expect(url).toBe('https://api.test/staff/price-list/import/preview');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    // The browser writes the multipart boundary itself: no JSON content type.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('confirms through POST /staff/price-list/import and parses the counts', async () => {
    const { pricing, fetchImpl } = setup(200, {
      version: PUBLISHED,
      createdCount: 2,
      updatedCount: 1,
      unchangedCount: 0,
    });
    const request = {
      baseVersionNumber: 14,
      rows: [
        {
          productCode: null,
          name: 'Demo',
          brandName: null,
          category: 'Kabellar',
          basePrice: '1',
          deferredPrice: null,
          rrp: '1.50',
        },
      ],
    };
    const result = await pricing.importConfirm(request);
    expect(result).toMatchObject({ createdCount: 2, updatedCount: 1 });
    const [url, init] = call(fetchImpl);
    expect(url).toBe('https://api.test/staff/price-list/import');
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('keeps the whole-file reason and the refused rows of a 422', async () => {
    const whole = setup(422, {
      error: { code: 'VALIDATION_FAILED', message: 'x', details: { reason: 'FILE_TOO_LARGE' } },
    });
    const refused = await whole.pricing
      .importPreview(new File(['x'], 'a.xlsx'))
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiValidationError);
    expect((refused as ApiValidationError).details).toEqual({ reason: 'FILE_TOO_LARGE' });

    const rows = setup(422, {
      error: {
        code: 'IMPORT_ROWS_INVALID',
        message: 'x',
        details: { rows: [{ index: 1, issues: ['UNKNOWN_BRAND'] }] },
      },
    });
    const invalid = await rows.pricing
      .importConfirm({ baseVersionNumber: 14, rows: [] })
      .catch((e: unknown) => e);
    expect((invalid as ApiValidationError).code).toBe('IMPORT_ROWS_INVALID');
    expect((invalid as ApiValidationError).details).toEqual({
      rows: [{ index: 1, issues: ['UNKNOWN_BRAND'] }],
    });
  });
});
