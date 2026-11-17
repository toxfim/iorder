import { priceHistoryResponseSchema, type PublishChangesRequest } from '@iorder/shared';
import {
  createManualProductResponseSchema,
  mergeProductResponseSchema,
  priceImportConfirmResponseSchema,
  priceImportPreviewResponseSchema,
  publishChangesWithRateResponseSchema,
  staffPriceListWithRateResponseSchema,
  staffProductDetailListResponseSchema,
  staffVersionListWithRateResponseSchema,
  staffVersionWithRateResponseSchema,
} from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { createFakePriceBackend, type FakeScenario } from './fake-price-backend';

function setup(scenario: FakeScenario = 'ready') {
  let current = scenario;
  const backend = createFakePriceBackend({
    scenario: () => current,
    now: () => new Date('2026-10-20T10:00:00.000Z'),
  });
  return { ...backend, setScenario: (next: FakeScenario) => (current = next) };
}

type Backend = ReturnType<typeof setup>;

async function productByCode(backend: Pick<Backend, 'catalogApi'>, productCode: string) {
  const found = (await backend.catalogApi.listProducts()).items.find(
    (p) => p.productCode === productCode,
  );
  if (!found) throw new Error(`fixture ${productCode} missing`);
  return found;
}

/** A request against the published version (v14), with only the given parts filled in. */
function changes(parts: Partial<PublishChangesRequest>): PublishChangesRequest {
  return { baseVersionNumber: 14, upserts: [], removedProductIds: [], ...parts };
}

async function failureOf(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e,
  );
}

describe('fake price backend: reads match the shared contract', () => {
  it('serves schema-valid responses', async () => {
    const { pricingApi, catalogApi } = setup();
    const current = await pricingApi.getCurrent();
    expect(staffPriceListWithRateResponseSchema.safeParse(current).success).toBe(true);
    expect(current.version).toMatchObject({ number: 14, status: 'PUBLISHED' });

    const versions = await pricingApi.listVersions();
    expect(staffVersionListWithRateResponseSchema.safeParse(versions).success).toBe(true);
    expect(versions.items.map((v) => v.number)).toEqual([14, 13, 12]);

    const products = await catalogApi.listProducts();
    expect(staffProductDetailListResponseSchema.safeParse(products).success).toBe(true);

    const first = current.items[0];
    if (!first) throw new Error('fixture has no items');
    const history = await pricingApi.getPriceHistory(first.productId);
    expect(priceHistoryResponseSchema.safeParse(history).success).toBe(true);
  });

  it('derives price history from the published versions, including added products', async () => {
    const { pricingApi, catalogApi } = setup();
    const list = await catalogApi.listProducts();
    const holder = list.items.find((p) => p.productCode === '10488');
    const charger = list.items.find((p) => p.productCode === '10483');
    if (!holder || !charger) throw new Error('fixture missing');

    const added = await pricingApi.getPriceHistory(holder.id);
    expect(added.entries).toHaveLength(1);
    expect(added.entries[0]).toMatchObject({
      versionNumber: 13,
      oldPrice: null,
      // The so'm seeds are kept in USD at the fake rate 12 650 (990 000 so'm -> $78.26).
      newPrice: '78.26',
    });

    const dropped = await pricingApi.getPriceHistory(charger.id);
    expect(dropped.entries.map((e) => [e.versionNumber, e.oldPrice, e.newPrice])).toEqual([
      [12, null, '11.78'],
      [14, '11.78', '11.46'],
    ]);
  });
});

describe('fake price backend: publishing changes (no drafts)', () => {
  it('publishes the changes as a new version: archives v14, keeps one PUBLISHED, applies upserts and removals', async () => {
    const backend = setup();
    const { pricingApi } = backend;
    const before = await pricingApi.getCurrent();
    const cable = await productByCode(backend, '10482');
    const charger = await productByCode(backend, '10483');
    const tablet = await productByCode(backend, '10494'); // not priced yet

    const published = await pricingApi.publishChanges(
      changes({
        upserts: [
          { productId: cable.id, basePrice: '1234.5', deferredPrice: null, rrp: null },
          { productId: tablet.id, basePrice: '2500000', deferredPrice: null, rrp: null },
        ],
        removedProductIds: [charger.id],
      }),
    );
    expect(publishChangesWithRateResponseSchema.safeParse(published).success).toBe(true);
    // The extra key keeps the plain version schema from accepting it, like the api's response.
    expect(staffVersionWithRateResponseSchema.safeParse(published).success).toBe(false);
    expect(published).toMatchObject({
      number: 15,
      status: 'PUBLISHED',
      publishedAt: '2026-10-20T10:00:00.000Z',
      // 10493 is inactive and was in v14: dropped and counted.
      skippedInactiveCount: 1,
    });

    const versions = await pricingApi.listVersions();
    expect(versions.items.filter((v) => v.status === 'PUBLISHED').map((v) => v.number)).toEqual([
      15,
    ]);
    expect(versions.items.find((v) => v.number === 14)?.status).toBe('ARCHIVED');

    const current = await pricingApi.getCurrent();
    const price = (id: string): string | undefined =>
      current.items.find((i) => i.productId === id)?.basePrice;
    expect(price(cable.id)).toBe('1234.50'); // padded to two decimals
    expect(price(tablet.id)).toBe('2500000.00');
    expect(price(charger.id)).toBeUndefined();
    expect(current.items.some((i) => !i.isActive)).toBe(false);
    // Everything else carried over untouched: 17 - 1 inactive - 1 removed + 1 added.
    expect(current.items).toHaveLength(before.items.length - 1);
    // The archived version is immutable: v14 still shows the old prices.
    const archived = await pricingApi.getVersion(before.version.id);
    expect(archived.items.find((i) => i.productId === cable.id)?.basePrice).toBe('2.53');
  });

  it('keeps the RRP like the other prices: carried over, replaced by an upsert, in the history', async () => {
    const backend = setup();
    const { pricingApi } = backend;
    const cable = await productByCode(backend, '10482');
    const charger = await productByCode(backend, '10483');
    const rrpOf = async (id: string): Promise<string | null | undefined> =>
      (await pricingApi.getCurrent()).items.find((i) => i.productId === id)?.rrp;
    expect(await rrpOf(cable.id)).toBeNull();

    await pricingApi.publishChanges(
      changes({
        upserts: [{ productId: cable.id, basePrice: '2.53', deferredPrice: null, rrp: '3.9' }],
      }),
    );
    expect(await rrpOf(cable.id)).toBe('3.90');
    // Another product's publish leaves it alone.
    await pricingApi.publishChanges(
      changes({
        baseVersionNumber: 15,
        upserts: [{ productId: charger.id, basePrice: '9', deferredPrice: null, rrp: null }],
      }),
    );
    expect(await rrpOf(cable.id)).toBe('3.90');
    // An upsert replaces the whole item: no RRP in it removes the RRP.
    await pricingApi.publishChanges(
      changes({
        baseVersionNumber: 16,
        upserts: [{ productId: cable.id, basePrice: '2.53', deferredPrice: null, rrp: null }],
      }),
    );
    expect(await rrpOf(cable.id)).toBeNull();
    const history = await pricingApi.getPriceHistory(cable.id);
    expect(priceHistoryResponseSchema.safeParse(history).success).toBe(true);
    expect(history.entries.slice(-2).map((e) => [e.versionNumber, e.oldRrp, e.newRrp])).toEqual([
      [15, null, '3.90'],
      [17, '3.90', null],
    ]);
  });

  it('extends the price history with the new version', async () => {
    const backend = setup();
    const cable = await productByCode(backend, '10482');
    await backend.pricingApi.publishChanges(
      changes({
        upserts: [{ productId: cable.id, basePrice: '33000', deferredPrice: null, rrp: null }],
      }),
    );
    const history = await backend.pricingApi.getPriceHistory(cable.id);
    expect(history.entries.at(-1)).toMatchObject({
      versionNumber: 15,
      oldPrice: '2.53',
      newPrice: '33000.00',
      publishedAt: '2026-10-20T10:00:00.000Z',
    });
  });

  it('refuses a stale base version: PRICE_LIST_CHANGED names the current one, nothing changes', async () => {
    const backend = setup();
    const cable = await productByCode(backend, '10482');
    const error = await failureOf(
      backend.pricingApi.publishChanges(
        changes({
          baseVersionNumber: 13,
          upserts: [{ productId: cable.id, basePrice: '1', deferredPrice: null, rrp: null }],
        }),
      ),
    );
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBe('PRICE_LIST_CHANGED');
    expect((error as ApiConflictError).details).toEqual({ currentVersionNumber: 14 });
    expect((await backend.pricingApi.getCurrent()).version.number).toBe(14);
  });

  it('answers 404 with the ids for an unknown product', async () => {
    const backend = setup();
    const unknown = '99999999-9999-4999-8999-999999999999';
    const error = await failureOf(
      backend.pricingApi.publishChanges(
        changes({
          upserts: [{ productId: unknown, basePrice: '5', deferredPrice: null, rrp: null }],
        }),
      ),
    );
    expect(error).toBeInstanceOf(ApiNotFoundError);
    expect((error as ApiNotFoundError).details).toEqual({ productIds: [unknown] });
  });

  it('refuses an inactive product (INACTIVE_PRODUCT) all or nothing; a unitless sheet product is priced', async () => {
    const backend = setup();
    const { pricingApi } = backend;
    const before = await pricingApi.getCurrent();
    const old = await productByCode(backend, '10493'); // inactive
    const unitless = await productByCode(backend, '10521'); // created from the sheet, no unit
    const cable = await productByCode(backend, '10482');

    const inactive = await failureOf(
      pricingApi.publishChanges(
        changes({
          upserts: [
            { productId: cable.id, basePrice: '1.00', deferredPrice: null, rrp: null },
            { productId: old.id, basePrice: '2.00', deferredPrice: null, rrp: null },
          ],
        }),
      ),
    );
    expect(inactive).toBeInstanceOf(ApiConflictError);
    expect((inactive as ApiConflictError).reason).toBe('INACTIVE_PRODUCT');
    expect((inactive as ApiConflictError).details).toEqual({ productIds: [old.id] });

    // Every check ran before the first write: the list is exactly as it was.
    expect(await pricingApi.getCurrent()).toEqual(before);

    // Pieces only: a product without a stored unit needs no unit before pricing.
    await expect(
      pricingApi.publishChanges(
        changes({
          upserts: [{ productId: unitless.id, basePrice: '2.00', deferredPrice: null, rrp: null }],
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses to leave the list empty (EMPTY_PRICE_LIST)', async () => {
    const backend = setup();
    const current = await backend.pricingApi.getCurrent();
    const error = await failureOf(
      backend.pricingApi.publishChanges(
        changes({ removedProductIds: current.items.map((i) => i.productId) }),
      ),
    );
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBe('EMPTY_PRICE_LIST');
    expect((await backend.pricingApi.getCurrent()).version.number).toBe(14);
  });

  it('answers 422 through the shared schema: an invalid price (with the request path), an upsert that is also removed, an empty request', async () => {
    const backend = setup();
    const cable = await productByCode(backend, '10482');

    const badPrice = await failureOf(
      backend.pricingApi.publishChanges(
        changes({
          upserts: [{ productId: cable.id, basePrice: '12.345', deferredPrice: null, rrp: null }],
        }),
      ),
    );
    expect(badPrice).toBeInstanceOf(ApiValidationError);
    expect((badPrice as ApiValidationError).issues[0]?.path).toBe('upserts.0.basePrice');

    const overlap = await failureOf(
      backend.pricingApi.publishChanges(
        changes({
          upserts: [{ productId: cable.id, basePrice: '1', deferredPrice: null, rrp: null }],
          removedProductIds: [cable.id],
        }),
      ),
    );
    expect(overlap).toBeInstanceOf(ApiValidationError);

    const empty = await failureOf(backend.pricingApi.publishChanges(changes({})));
    expect(empty).toBeInstanceOf(ApiValidationError);
    expect((await backend.pricingApi.getCurrent()).version.number).toBe(14);
  });
});

describe('fake price backend: catalog', () => {
  it('stores the product code as entered (trimmed) and detects duplicates ignoring case', async () => {
    const { catalogApi } = setup();
    const created = await catalogApi.createProduct({
      productCode: '  HONOR-X7C-MidnightBlack ',
      name: 'Test',
    });
    expect(created.productCode).toBe('HONOR-X7C-MidnightBlack');
    for (const other of ['honor-x7c-midnightblack', 'HONOR-X7C-MIDNIGHTBLACK']) {
      await expect(
        catalogApi.createProduct({ productCode: other, name: 'Test' }),
      ).rejects.toBeInstanceOf(ApiConflictError);
    }
    // A fixture code with stray spaces is the same code.
    await expect(
      catalogApi.createProduct({ productCode: ' 10490 ', name: 'Test' }),
    ).rejects.toBeInstanceOf(ApiConflictError);
  });

  it('rejects a code with characters outside the shared rule with a 422 on productCode', async () => {
    const { catalogApi } = setup();
    for (const bad of ['AB CD', 'Товар-1', '-ABC', 'X'.repeat(65), '']) {
      const error = await catalogApi
        .createProduct({ productCode: bad, name: 'Test' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiValidationError);
      expect((error as ApiValidationError).issues[0]?.path).toBe('productCode');
    }
  });

  it('updates the common name and activity without touching the product code', async () => {
    const { catalogApi } = setup();
    const target = (await catalogApi.listProducts()).items[0];
    if (!target) throw new Error('fixture missing');
    const updated = await catalogApi.updateProduct(target.id, { name: 'Renamed', isActive: false });
    expect(updated).toMatchObject({
      productCode: target.productCode,
      name: 'Renamed',
      unit: 'PIECE',
      isActive: false,
    });
  });

  it('DUPLICATE_PRODUCT_CODE is the 409 reason, like the api', async () => {
    const { catalogApi } = setup();
    const error = await failureOf(
      catalogApi.createProduct({
        productCode: '10491',
        name: 'x',
      }),
    );
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBe('DUPLICATE_PRODUCT_CODE');
  });
});

describe('fake price backend: dev scenarios', () => {
  it('simulates denied, error and empty reads', async () => {
    const { pricingApi, setScenario } = setup('denied');
    await expect(pricingApi.getCurrent()).rejects.toBeInstanceOf(PermissionDeniedError);
    setScenario('error');
    await expect(pricingApi.getCurrent()).rejects.toThrow(/simulated failure/);
    setScenario('empty');
    await expect(pricingApi.getCurrent()).rejects.toBeInstanceOf(ApiNotFoundError);
    expect((await pricingApi.listVersions()).items).toEqual([]);
  });
});

describe('fake price backend: staff-added products without a sheet code', () => {
  const BRANDS = [
    { id: '00000000-0000-4000-8000-0000000000b1', name: 'Anker' },
    { id: '00000000-0000-4000-8000-0000000000b2', name: 'Baseus' },
  ];
  const withBrands = () =>
    createFakePriceBackend({
      now: () => new Date('2026-11-09T10:00:00.000Z'),
      brands: () => BRANDS,
    });
  const manual = (parts: {
    baseVersionNumber: number;
    name?: string;
    brandId?: string | null;
  }) => ({
    name: 'Demo kabel',
    brandId: null,
    category: null,
    basePrice: '3.5',
    deferredPrice: null,
    ...parts,
  });

  it('creates a product with the next generated code and publishes its price as a new version', async () => {
    const { pricingApi, catalogApi } = withBrands();
    const first = await pricingApi.createManualProduct(
      manual({ baseVersionNumber: 14, brandId: BRANDS[1]?.id ?? null }),
    );
    expect(createManualProductResponseSchema.safeParse(first).success).toBe(true);
    expect(first.productCode).toBe('IO-000001');
    expect(first.version).toMatchObject({ number: 15, status: 'PUBLISHED' });

    const second = await pricingApi.createManualProduct(
      manual({ baseVersionNumber: 15, name: 'Demo adapter' }),
    );
    expect(second.productCode).toBe('IO-000002');

    const current = await pricingApi.getCurrent();
    expect(current.version.number).toBe(16);
    const row = current.items.find((i) => i.productId === first.productId);
    expect(row).toMatchObject({ productCode: 'IO-000001', codeGenerated: true, basePrice: '3.50' });
    const product = (await catalogApi.listProducts()).items.find((p) => p.id === first.productId);
    expect(product).toMatchObject({
      codeGenerated: true,
      mergedIntoProductId: null,
      isActive: true,
    });
    expect(product?.translations.map((t) => t.name)).toEqual(['Demo kabel']);
  });

  it('refuses a stale base (409 PRICE_LIST_CHANGED) and an unknown brand (404, details.reason UNKNOWN_BRAND) without writing', async () => {
    const { pricingApi } = withBrands();
    const stale = await failureOf(
      pricingApi.createManualProduct(manual({ baseVersionNumber: 13 })),
    );
    expect(stale).toBeInstanceOf(ApiConflictError);
    expect((stale as ApiConflictError).reason).toBe('PRICE_LIST_CHANGED');

    const unknown = await failureOf(
      pricingApi.createManualProduct(
        manual({ baseVersionNumber: 14, brandId: '00000000-0000-4000-8000-00000000dead' }),
      ),
    );
    expect(unknown).toBeInstanceOf(ApiNotFoundError);
    expect((unknown as ApiNotFoundError).code).toBe('NOT_FOUND');
    expect((unknown as ApiNotFoundError).details).toEqual({ reason: 'UNKNOWN_BRAND' });
    expect((await pricingApi.getCurrent()).version.number).toBe(14);
    // The sequence was not spent on a refused product.
    const ok = await pricingApi.createManualProduct(manual({ baseVersionNumber: 14 }));
    expect(ok.productCode).toBe('IO-000001');
  });

  it('merges a generated product into a sheet product: the price moves, the source leaves and is deactivated', async () => {
    const backend = withBrands();
    const { pricingApi, catalogApi } = backend;
    const created = await pricingApi.createManualProduct({
      ...manual({ baseVersionNumber: 14, brandId: BRANDS[0]?.id ?? null }),
      basePrice: '150',
      deferredPrice: '160',
    });
    const tablet = await productByCode(backend, '10494'); // a sheet product without a price
    const merged = await pricingApi.mergeProduct(created.productId, {
      baseVersionNumber: 15,
      targetProductId: tablet.id,
    });
    expect(mergeProductResponseSchema.safeParse(merged).success).toBe(true);
    expect(merged.version?.number).toBe(16);

    const current = await pricingApi.getCurrent();
    expect(current.items.some((i) => i.productId === created.productId)).toBe(false);
    expect(current.items.find((i) => i.productId === tablet.id)).toMatchObject({
      basePrice: '150.00',
      deferredPrice: '160.00',
      codeGenerated: false,
    });
    const source = await catalogApi.getProduct(created.productId);
    expect(source).toMatchObject({ isActive: false, mergedIntoProductId: tablet.id });
    expect(backend.view.stockTracked(created.productCode)).toBe(false);
    expect(backend.view.stockTracked('10494')).toBe(true);
  });

  it('a merge without a listed price republishes nothing, and the wrong products are refused', async () => {
    const backend = withBrands();
    const { pricingApi } = backend;
    const created = await pricingApi.createManualProduct(manual({ baseVersionNumber: 14 }));
    // Removed from the list first: the merge then has no price to move.
    await pricingApi.publishChanges({
      baseVersionNumber: 15,
      upserts: [],
      removedProductIds: [created.productId],
    });
    const cable = await productByCode(backend, '10482');
    const sheetSource = await failureOf(
      pricingApi.mergeProduct(cable.id, { baseVersionNumber: 16, targetProductId: cable.id }),
    );
    expect((sheetSource as ApiConflictError).reason).toBe('NOT_GENERATED_CODE');
    const generatedTarget = await failureOf(
      pricingApi.mergeProduct(created.productId, {
        baseVersionNumber: 16,
        targetProductId: created.productId,
      }),
    );
    expect((generatedTarget as ApiConflictError).reason).toBe('TARGET_IS_GENERATED');

    const merged = await pricingApi.mergeProduct(created.productId, {
      baseVersionNumber: 16,
      targetProductId: cable.id,
    });
    expect(merged.version).toBeNull();
    expect((await pricingApi.getCurrent()).version.number).toBe(16);
    const again = await failureOf(
      pricingApi.mergeProduct(created.productId, {
        baseVersionNumber: 16,
        targetProductId: cable.id,
      }),
    );
    expect((again as ApiConflictError).reason).toBe('PRODUCT_ALREADY_MERGED');
  });

  it('previews a canned file with every row kind and refuses a file that is not an .xlsx', async () => {
    const { pricingApi } = withBrands();
    const preview = await pricingApi.importPreview(new File(['x'], 'narxlar.xlsx'));
    expect(priceImportPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(preview.baseVersionNumber).toBe(14);
    expect(preview.rows.map((r) => r.status)).toEqual([
      'PRICE_CHANGED',
      'UNCHANGED',
      'NEW',
      'NEW',
      'ERROR',
      'ERROR',
    ]);
    expect(preview.summary).toEqual({
      newCount: 2,
      priceChangedCount: 1,
      unchangedCount: 1,
      errorCount: 2,
    });
    const refused = await failureOf(pricingApi.importPreview(new File(['x'], 'narxlar.csv')));
    expect(refused).toBeInstanceOf(ApiValidationError);
    expect((refused as ApiValidationError).code).toBe('PRICE_IMPORT_FILE_INVALID');
    expect((refused as ApiValidationError).details).toEqual({ reason: 'FILE_NOT_XLSX' });
  });

  it('confirms the importable rows in one new version and refuses a bad row set without writing', async () => {
    const backend = withBrands();
    const { pricingApi } = backend;
    const preview = await pricingApi.importPreview(new File(['x'], 'narxlar.xlsx'));
    const rows = preview.rows
      .filter((r) => r.status !== 'ERROR' && r.basePrice !== null)
      .map((r) => ({
        productCode: r.productCode,
        name: r.name,
        brandName: r.brandName,
        category: r.category,
        basePrice: r.basePrice ?? '0',
        deferredPrice: r.deferredPrice,
        rrp: r.rrp,
      }));

    const invalid = await failureOf(
      pricingApi.importConfirm({
        baseVersionNumber: 14,
        rows: [
          ...rows,
          {
            productCode: '99999',
            name: 'x',
            brandName: 'Nobody',
            category: null,
            basePrice: '1',
            deferredPrice: null,
            rrp: null,
          },
        ],
      }),
    );
    expect(invalid).toBeInstanceOf(ApiValidationError);
    expect((invalid as ApiValidationError).code).toBe('IMPORT_ROWS_INVALID');
    expect((invalid as ApiValidationError).details).toEqual({
      rows: [{ index: rows.length, issues: ['UNKNOWN_BRAND', 'UNKNOWN_PRODUCT_CODE'] }],
    });
    expect((await pricingApi.getCurrent()).version.number).toBe(14);

    const done = await pricingApi.importConfirm({ baseVersionNumber: 14, rows });
    expect(priceImportConfirmResponseSchema.safeParse(done).success).toBe(true);
    expect(done).toMatchObject({ createdCount: 2, updatedCount: 1, unchangedCount: 1 });
    expect(done.version.number).toBe(15);
    const current = await pricingApi.getCurrent();
    expect(current.items.filter((i) => i.codeGenerated).map((i) => i.productCode)).toEqual([
      'IO-000001',
      'IO-000002',
    ]);
    // The changed row raised the first priced product by one dollar.
    const cable = await productByCode(backend, '10482');
    expect(current.items.find((i) => i.productId === cable.id)?.basePrice).toBe(
      preview.rows[0]?.basePrice,
    );
    expect(preview.rows[0]?.currentBasePrice).not.toBe(preview.rows[0]?.basePrice);
    // The RRP of the changed row is stored, and the new product got the row's category.
    expect(current.items.find((i) => i.productId === cable.id)?.rrp).toBe(preview.rows[0]?.rrp);
    const created = current.items.find((i) => i.productCode === 'IO-000001');
    expect(created?.rrp).toBe('24.90');
    expect((await backend.catalogApi.getProduct(created?.productId ?? '')).category).toBe(
      'Powerbanklar',
    );
  });

  it('serves the import template as a file listing the generated-code products', async () => {
    const { pricingApi } = withBrands();
    await pricingApi.createManualProduct(
      manual({ baseVersionNumber: 14, brandId: BRANDS[0]?.id ?? null }),
    );
    const file = await pricingApi.downloadImportTemplate('filled');
    expect(file.fileName).toMatch(/demo/);
    const template = await file.blob.text();
    expect(template).toContain(
      '"Tovar ID","Nomi","Brend","Kategoriya","Цена $","Отсрочка $","RRP $"',
    );
    expect(template).toContain('"IO-000001","Demo kabel","Anker","","3.50","",""');
    // The empty template is the header only.
    const empty = await pricingApi.downloadImportTemplate('empty');
    expect((await empty.blob.text()).trim().split('\r\n')).toHaveLength(1);
  });
});
