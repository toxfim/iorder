import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { GENERATED_PRODUCT_CODE_PATTERN, customerPriceListResponseSchema } from '@iorder/shared';
import {
  COST_ROUTES,
  MANUAL_PRODUCT_ROUTES,
  createManualProductResponseSchema,
  manualProductCheckResponseSchema,
  mergePreviewResponseSchema,
  mergeProductResponseSchema,
  priceImportConfirmResponseSchema,
  priceImportPreviewResponseSchema,
  staffPriceListWithRateResponseSchema,
  staffProductDetailResponseSchema,
  unpricedProductsResponseSchema,
  type PriceImportPreviewResponse,
} from '@iorder/shared/staff-cost';
import {
  STAFF_ORDER_ROUTES,
  STAFF_PICKING_ROUTES,
  allocationPreviewSchema,
  pickingResponseSchema,
  staffOrderSchema,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { CatalogModule, CatalogService } from '../src/modules/catalog/index.js';
import { ManualProductsModule } from '../src/modules/manual-products/index.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { CartService } from '../src/modules/orders/cart.service.js';
import {
  PriceReferenceService,
  PricingModule,
  PricingService,
  SupplyRemovalService,
} from '../src/modules/pricing/index.js';
import { UsdRateService } from '../src/modules/pricing/usd-rate/usd-rate.service.js';
import {
  FakeDeliveryCostSource,
  FixtureRowSelection,
  fixtureLine,
  fixtureTable,
  type FixtureLine,
} from '../src/modules/sheets-sync/fake-delivery-cost-source.js';
import { SheetSyncRunRepository } from '../src/modules/sheets-sync/sheet-sync-run.repository.js';
import { SheetsSyncModule } from '../src/modules/sheets-sync/sheets-sync.module.js';
import { SheetsSyncService } from '../src/modules/sheets-sync/sheets-sync.service.js';
import {
  findForbiddenKeys,
  findStaffOnlyFieldsInCustomerPriceList,
  stripStaffPriceTier,
  stripStaffRateSnapshot,
} from './support/forbidden-fields.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
} from './support/identity-fixtures.js';
import { caller, expectError, expectParsed } from './support/orders-http.js';
import { createWorld, fillCart, orderAt, submitOrder, type World } from './support/orders-world.js';
import { resetCatalogPricingAudit, resetIdentity, resetOrders } from './support/test-db.js';
import { getRestrictedRoleUrl } from './support/test-env.js';
import {
  ACCOUNTANT,
  MANAGER,
  SHOP_OWNER,
  WAREHOUSE,
  createTestApp,
  type TestApp,
} from './support/test-app.js';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

const UZ_HEADERS = ['Tovar ID', 'Mahsulot', 'Brend', 'Kategoriya', 'Цена $', 'Отсрочка $', 'RRP $'];
/** The template before the category and RRP columns [C, 2026-11-09]. */
const OLD_UZ_HEADERS = ['Tovar ID', 'Mahsulot', 'Brend', 'Цена $', 'Отсрочка $'];

/** An .xlsx with the given header row and data rows (cells as the owner would type them). */
async function workbook(headers: readonly unknown[], rows: readonly unknown[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Import');
  sheet.addRow([...headers]);
  for (const row of rows) sheet.addRow([...row]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** The header row and data rows of the first sheet of an .xlsx, as plain values. */
async function readWorkbook(bytes: ArrayBuffer): Promise<unknown[][]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error('no sheet');
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    rows.push(UZ_HEADERS.map((_, index) => row.getCell(index + 1).value ?? null));
  });
  return rows;
}

// PricingModule first: the same order as AppModule (see StaffStockController).
describe('staff-added products without a sheet code (real PostgreSQL)', () => {
  let t: TestApp;
  let xiaomiId: string;

  beforeAll(async () => {
    t = await createTestApp([
      PricingModule,
      CatalogModule,
      SheetsSyncModule,
      OrdersModule,
      ManualProductsModule,
    ]);
    await t.prisma.$connect();
    xiaomiId = (await t.prisma.brand.findUniqueOrThrow({ where: { nameKey: 'xiaomi' } })).id;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(new Date('2026-11-09T08:00:00Z'));
    await resetOrders(t.prisma);
    await resetCatalogPricingAudit(t.prisma);
    await t.prisma.appSetting.deleteMany({ where: { key: 'usd_rate' } });
    await t.get(UsdRateService).setUsdRate(MANAGER, new Prisma.Decimal('12000'));
  });

  const call = async (
    method: string,
    path: string,
    actor: Actor | undefined = MANAGER,
    body?: unknown,
  ): Promise<{ status: number; body: Body }> => {
    const r = await t.request(method, path, { ...(actor ? { actor } : {}), body });
    return { status: r.status, body: (r.body ?? {}) as Body };
  };

  const sheetProduct = async (code: string, name: string): Promise<string> =>
    (
      await t.prisma.product.create({
        data: { productCode: code, translations: { create: [{ lang: 'RU', name }] } },
      })
    ).id;

  const publishedNumber = async (): Promise<number | null> =>
    (await t.prisma.priceListVersion.findFirst({ where: { status: 'PUBLISHED' } }))?.number ?? null;

  const publishedItems = async (): Promise<
    Map<string, { base: string; deferred: string | null }>
  > => {
    const version = await t.prisma.priceListVersion.findFirstOrThrow({
      where: { status: 'PUBLISHED' },
      include: { items: true },
    });
    return new Map(
      version.items.map((item) => [
        item.productId,
        { base: item.basePrice.toFixed(2), deferred: item.deferredPrice?.toFixed(2) ?? null },
      ]),
    );
  };

  /** Creates a manual product through the endpoint and returns its id and code. */
  const createManual = async (
    name: string,
    basePrice: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ productId: string; productCode: string }> => {
    const r = await call('POST', MANUAL_PRODUCT_ROUTES.createManualProduct.path, MANAGER, {
      baseVersionNumber: await publishedNumber(),
      name,
      basePrice,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const parsed = createManualProductResponseSchema.parse(r.body);
    return { productId: parsed.productId, productCode: parsed.productCode };
  };

  /** The RRP of every item of the published list (null = none). */
  const publishedRrps = async (): Promise<Map<string, string | null>> => {
    const version = await t.prisma.priceListVersion.findFirstOrThrow({
      where: { status: 'PUBLISHED' },
      include: { items: true },
    });
    return new Map(version.items.map((item) => [item.productId, item.rrp?.toFixed(2) ?? null]));
  };

  /** Publishes the current list plus these prices (the staff save). */
  const price = async (
    upserts: {
      productId: string;
      basePrice: string;
      deferredPrice?: string | null;
      rrp?: string | null;
      wholesalePrice?: string | null;
      alifPrice?: string | null;
      alifDeferredPrice?: string | null;
    }[],
  ): Promise<void> => {
    const r = await call('POST', '/staff/price-list/publish', MANAGER, {
      baseVersionNumber: await publishedNumber(),
      upserts: upserts.map((u) => ({ deferredPrice: null, ...u })),
      removedProductIds: [],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  const upload = async (
    bytes: Buffer,
    actor: Actor = MANAGER,
  ): Promise<{ status: number; body: Body }> => {
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), 'import.xlsx');
    const response = await fetch(
      `http://127.0.0.1:${port}${MANUAL_PRODUCT_ROUTES.priceImportPreview.path}`,
      { method: 'POST', headers: { 'x-test-actor': JSON.stringify(actor) }, body: form },
    );
    return { status: response.status, body: (await response.json()) as Body };
  };

  const counts = async (): Promise<Record<string, number>> => ({
    products: await t.prisma.product.count(),
    versions: await t.prisma.priceListVersion.count(),
    items: await t.prisma.priceListItem.count(),
    audit: await t.prisma.auditLog.count(),
    translations: await t.prisma.productTranslation.count(),
  });

  describe('POST /staff/products/manual', () => {
    it('creates the product with a generated code and publishes the next version atomically', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00' }]);

      // Version numbers come from a sequence the reset does not restart: compare to the base.
      const base = await publishedNumber();
      const r = await call('POST', MANUAL_PRODUCT_ROUTES.createManualProduct.path, MANAGER, {
        baseVersionNumber: base,
        name: 'Quloqchin X',
        brandId: xiaomiId,
        category: ' Quloqchinlar ',
        basePrice: '12.50',
        deferredPrice: '13.00',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const created = createManualProductResponseSchema.parse(r.body);
      expect(created.productCode).toMatch(GENERATED_PRODUCT_CODE_PATTERN);
      expect(created.version).toMatchObject({ number: (base ?? 0) + 1, status: 'PUBLISHED' });
      expect(findForbiddenKeys(stripStaffRateSnapshot(r.body))).toEqual([]);

      const product = await t.prisma.product.findUniqueOrThrow({
        where: { id: created.productId },
        include: { translations: true },
      });
      expect(product).toMatchObject({
        codeGenerated: true,
        mergedIntoProductId: null,
        brandId: xiaomiId,
        category: 'Quloqchinlar',
        isActive: true,
        unit: 'PIECE',
      });
      expect(product.translations).toEqual([
        expect.objectContaining({ lang: 'UZ', name: 'Quloqchin X' }),
      ]);
      await expect(t.prisma.stockCache.count()).resolves.toBe(0);
      expect(await publishedItems()).toEqual(
        new Map([
          [kb, { base: '5.00', deferred: null }],
          [created.productId, { base: '12.50', deferred: '13.00' }],
        ]),
      );
      const audit = await t.prisma.auditLog.findMany({
        where: { entityId: created.productId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual(['PRODUCT_CREATED']);
      expect(audit[0]?.diff).toMatchObject({
        codeGenerated: { from: null, to: true },
        brandId: { from: null, to: xiaomiId },
        category: { from: null, to: 'Quloqchinlar' },
        productCode: { from: null, to: created.productCode },
      });

      // Staff see the flag; the customer list shows the product like any other, cost-free.
      const staff = expectParsed(
        await t.request('GET', '/staff/price-list/current', { actor: MANAGER }),
        200,
        staffPriceListWithRateResponseSchema,
      );
      expect(staff.items.map((i) => [i.productCode, i.codeGenerated, i.sheetMatch])).toEqual([
        [created.productCode, true, null],
        ['KB-15', false, null],
      ]);
      const detail = expectParsed(
        await t.request('GET', `/staff/products/${created.productId}`, { actor: MANAGER }),
        200,
        staffProductDetailResponseSchema,
      );
      expect(detail).toMatchObject({ codeGenerated: true, mergedIntoProductId: null });

      const customer = await t.request('GET', '/price-list/current', { actor: SHOP_OWNER });
      const list = expectParsed(customer, 200, customerPriceListResponseSchema);
      expect(list.items.map((i) => [i.productCode, i.category])).toEqual([
        [created.productCode, 'Quloqchinlar'],
        ['KB-15', null],
      ]);
      expect(findForbiddenKeys(customer.body)).toEqual([]);
      expect(findStaffOnlyFieldsInCustomerPriceList(customer.body)).toEqual([]);
      expect(JSON.stringify(customer.body)).not.toContain('codeGenerated');
    });

    it('is refused for a stale base version, an unknown brand and other roles; nothing is written', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00' }]);
      const before = await counts();
      const base = await publishedNumber();

      const stale = await call('POST', MANUAL_PRODUCT_ROUTES.createManualProduct.path, MANAGER, {
        baseVersionNumber: null,
        name: 'X',
        basePrice: '1.00',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({
        reason: 'PRICE_LIST_CHANGED',
        details: { currentVersionNumber: base },
      });

      const brand = await call('POST', MANUAL_PRODUCT_ROUTES.createManualProduct.path, MANAGER, {
        baseVersionNumber: base,
        name: 'X',
        brandId: '019a0000-0000-7000-8000-000000000000',
        basePrice: '1.00',
      });
      expect(brand.status).toBe(404);
      expect(brand.body.error.details).toEqual({ reason: 'UNKNOWN_BRAND' });

      for (const actor of [ACCOUNTANT, SHOP_OWNER]) {
        const r = await call('POST', MANUAL_PRODUCT_ROUTES.createManualProduct.path, actor, {
          baseVersionNumber: base,
          name: 'X',
          basePrice: '1.00',
        });
        expect(r.status).toBe(403);
      }
      expect(
        (await t.request('POST', MANUAL_PRODUCT_ROUTES.createManualProduct.path, { body: {} }))
          .status,
      ).toBe(401);
      expect(await counts()).toEqual(before);
    });

    it('the explicit create refuses the reserved IO- prefix (any case)', async () => {
      for (const productCode of ['IO-000001', 'io-15', 'Io-x']) {
        const r = await call('POST', '/staff/products', MANAGER, { productCode, name: 'X' });
        expect(r.status, productCode).toBe(409);
        expect(r.body.error.reason).toBe('RESERVED_PRODUCT_CODE_PREFIX');
      }
      await expect(t.prisma.product.count()).resolves.toBe(0);
    });
  });

  describe('POST /staff/products/:id/merge', () => {
    it("keeps the target's tier prices the source does not have [review 2026-11-12]", async () => {
      const kb = await sheetProduct('KB-16', 'Кабель 2');
      await price([
        { productId: kb, basePrice: '5.00', alifPrice: '4.00', alifDeferredPrice: '4.50' },
      ]);
      const manual = await createManual('Kabel Lightning', '7.00', {});
      await price([{ productId: manual.productId, basePrice: '7.00', wholesalePrice: '6.00' }]);
      const r = await call('POST', `/staff/products/${manual.productId}/merge`, MANAGER, {
        baseVersionNumber: await publishedNumber(),
        targetProductId: kb,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const kbItem = await t.prisma.priceListItem.findFirstOrThrow({
        where: { productId: kb, version: { status: 'PUBLISHED' } },
      });
      // The source's own prices win; the Alif pair it lacks stays the target's.
      expect(kbItem.basePrice.toFixed(2)).toBe('7.00');
      expect(kbItem.wholesalePrice?.toFixed(2)).toBe('6.00');
      expect(kbItem.alifPrice?.toFixed(2)).toBe('4.00');
      expect(kbItem.alifDeferredPrice?.toFixed(2)).toBe('4.50');
    });

    it('moves price, brand, name, photos and cart lines; the source becomes inactive and merged', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      const other = await sheetProduct('OTHER-1', 'Другое');
      await price([
        { productId: kb, basePrice: '5.00', rrp: '6.00' },
        { productId: other, basePrice: '1.00', rrp: '2.50' },
      ]);
      const manual = await createManual('Kabel USB-C', '12.50', {
        brandId: xiaomiId,
        deferredPrice: '13.00',
      });
      // The form has no RRP field: a new product starts without one, the price dialog sets it.
      expect((await publishedRrps()).get(manual.productId)).toBeNull();
      await price([
        {
          productId: manual.productId,
          basePrice: '12.50',
          deferredPrice: '13.00',
          rrp: '19.90',
          wholesalePrice: '11.00',
        },
      ]);
      // Photos on both sides; the target's primary wins.
      const image = (productId: string, isPrimary: boolean, sha: string) =>
        t.prisma.productImage.create({
          data: {
            productId,
            isPrimary,
            sha256: sha.repeat(64).slice(0, 64),
            originalContentType: 'image/jpeg',
            width: 10,
            height: 10,
            byteSize: 100,
            uploadedBy: 'user-manager',
            createdAt: t.clock.now(),
          },
          select: { id: true },
        });
      const sourcePrimary = await image(manual.productId, true, 'a');
      const sourceOther = await image(manual.productId, false, 'b');
      const targetPrimary = await image(kb, true, 'c');
      // Open carts: one with both products, one with the source only.
      await resetIdentity(t.prisma);
      const org = await makeOrganization(t.prisma, { name: 'Shop' });
      const both = await makeUser(t.prisma, { name: 'Both', phone: '+998700000001' });
      const onlySource = await makeUser(t.prisma, { name: 'Only', phone: '+998700000002' });
      await makeMember(t.prisma, org.id, both.id, 'SHOP_OWNER');
      await makeMember(t.prisma, org.id, onlySource.id, 'SELLER');
      const carts = t.get(CartService);
      const bothActor = customerActor(both.id, org.id, 'SHOP_OWNER');
      const onlyActor = customerActor(onlySource.id, org.id, 'SELLER');
      await carts.setItemQuantity(bothActor, kb, '3');
      await carts.setItemQuantity(bothActor, manual.productId, '2');
      await carts.setItemQuantity(onlyActor, manual.productId, '4');

      const base = await publishedNumber();
      const r = await call('POST', `/staff/products/${manual.productId}/merge`, MANAGER, {
        baseVersionNumber: base,
        targetProductId: kb,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const merged = mergeProductResponseSchema.parse(r.body);
      expect(merged).toMatchObject({ sourceProductId: manual.productId, targetProductId: kb });
      expect(merged.version?.number).toBe((base ?? 0) + 1);

      // The source's prices win on the target; the source left the list.
      expect(await publishedItems()).toEqual(
        new Map([
          [kb, { base: '12.50', deferred: '13.00' }],
          [other, { base: '1.00', deferred: null }],
        ]),
      );
      // The RRP moves with the prices (the source's wins); an untouched item keeps its own.
      expect(await publishedRrps()).toEqual(
        new Map([
          [kb, '19.90'],
          [other, '2.50'],
        ]),
      );
      // The wholesale tier moves too [C, 2026-11-11].
      const kbItem = await t.prisma.priceListItem.findFirstOrThrow({
        where: { productId: kb, version: { status: 'PUBLISHED' } },
      });
      expect(kbItem.wholesalePrice?.toFixed(2)).toBe('11.00');
      const source = await t.prisma.product.findUniqueOrThrow({ where: { id: manual.productId } });
      expect(source).toMatchObject({
        isActive: false,
        mergedIntoProductId: kb,
        codeGenerated: true,
      });
      const target = await t.prisma.product.findUniqueOrThrow({
        where: { id: kb },
        include: { translations: { orderBy: { lang: 'asc' } } },
      });
      expect(target.brandId).toBe(xiaomiId);
      expect(target.translations.map((x) => [x.lang, x.name]).sort()).toEqual([
        ['RU', 'Кабель'],
        ['UZ', 'Kabel USB-C'],
      ]);
      // All three were created at the same fake instant, so they are compared by id, not in order.
      const images = new Map(
        (await t.prisma.productImage.findMany()).map((i) => [
          i.id,
          [i.productId, i.isPrimary, i.removedAt === null],
        ]),
      );
      expect(images).toEqual(
        new Map([
          [sourcePrimary.id, [kb, false, true]],
          [sourceOther.id, [kb, false, true]],
          [targetPrimary.id, [kb, true, true]],
        ]),
      );
      const cartLines = await t.prisma.cartItem.findMany({ orderBy: { quantity: 'asc' } });
      expect(cartLines.map((l) => [l.productId, l.quantity.toFixed(0)])).toEqual([
        [kb, '4'],
        [kb, '5'],
      ]);
      const audit = await t.prisma.auditLog.findMany({
        where: { action: { in: ['PRODUCT_MERGED', 'PRODUCT_MERGE_RECEIVED'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => [a.action, a.entityId])).toEqual([
        ['PRODUCT_MERGED', manual.productId],
        ['PRODUCT_MERGE_RECEIVED', kb],
      ]);
      expect(audit[0]?.diff).toMatchObject({
        isActive: { from: true, to: false },
        mergedIntoProductId: { from: null, to: kb },
        movedPriceItem: { from: null, to: true },
        movedBrand: { from: null, to: true },
        movedName: { from: null, to: true },
        movedImageCount: { from: null, to: 2 },
        movedCartLineCount: { from: null, to: 2 },
      });
      expect(audit[1]?.diff).toMatchObject({
        brandId: { from: null, to: xiaomiId },
        name: { from: null, to: 'Kabel USB-C' },
      });

      // Gone from the unpriced list; a second merge and a reactivation are refused.
      const unpriced = expectParsed(
        await t.request(COST_ROUTES.unpricedProducts.method, COST_ROUTES.unpricedProducts.path, {
          actor: MANAGER,
        }),
        200,
        unpricedProductsResponseSchema,
      );
      expect(unpriced.items.map((i) => i.productId)).not.toContain(manual.productId);
      const again = await call('POST', `/staff/products/${manual.productId}/merge`, MANAGER, {
        baseVersionNumber: await publishedNumber(),
        targetProductId: other,
      });
      expect(again.body.error).toMatchObject({ reason: 'PRODUCT_ALREADY_MERGED' });
      const revive = await call('PATCH', `/staff/products/${manual.productId}`, MANAGER, {
        isActive: true,
      });
      expect(revive.body.error).toMatchObject({ reason: 'PRODUCT_ALREADY_MERGED' });
    });

    it('an unpriced source publishes nothing (version null); the rules name their reasons', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      const inactive = await sheetProduct('OLD-1', 'Старое');
      await t.prisma.product.update({ where: { id: inactive }, data: { isActive: false } });
      await price([{ productId: kb, basePrice: '5.00' }]);
      const manual = await createManual('Manual A', '2.00');
      const manual2 = await createManual('Manual B', '3.00');
      // Take the source out of the list first (the staff "remove" save).
      const removed = await call('POST', '/staff/price-list/publish', MANAGER, {
        baseVersionNumber: await publishedNumber(),
        upserts: [],
        removedProductIds: [manual.productId],
      });
      expect(removed.status).toBe(200);
      const versionsBefore = await t.prisma.priceListVersion.count();
      const base = await publishedNumber();

      const merge = (sourceId: string, targetProductId: string) =>
        call('POST', `/staff/products/${sourceId}/merge`, MANAGER, {
          baseVersionNumber: base,
          targetProductId,
        });
      expect((await merge(kb, manual.productId)).body.error).toMatchObject({
        reason: 'NOT_GENERATED_CODE',
      });
      expect((await merge(manual.productId, manual2.productId)).body.error).toMatchObject({
        reason: 'TARGET_IS_GENERATED',
      });
      expect((await merge(manual.productId, inactive)).body.error).toMatchObject({
        reason: 'INACTIVE_PRODUCT',
      });
      expect((await merge(manual.productId, manual.productId)).status).toBe(409);
      const missing = await merge(manual.productId, '019a0000-0000-7000-8000-000000000000');
      expect(missing.status).toBe(404);

      const ok = await merge(manual.productId, kb);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(mergeProductResponseSchema.parse(ok.body).version).toBeNull();
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(versionsBefore);
      expect(await publishedItems()).toEqual(
        new Map([
          [kb, { base: '5.00', deferred: null }],
          [manual2.productId, { base: '3.00', deferred: null }],
        ]),
      );
    });
  });

  describe('GET /staff/products/manual/check', () => {
    const check = (name: string, actor: Actor = MANAGER) =>
      call(
        'GET',
        `${MANUAL_PRODUCT_ROUTES.checkManualProduct.path}?name=${encodeURIComponent(name)}`,
        actor,
      );

    it('ranks the alike active products (exact, spacing, containment) with their priced flag; writes nothing', async () => {
      const exact = await sheetProduct('KB-15', 'Buds 3 Pro');
      await sheetProduct('KB-16', 'Redmi Buds 3 Pro Black');
      await sheetProduct('X-1', 'Kabel USB-C');
      const inactive = await sheetProduct('OLD-1', 'Buds 3 Pro');
      await t.prisma.product.update({ where: { id: inactive }, data: { isActive: false } });
      await price([{ productId: exact, basePrice: '5.00' }]);
      const compact = await createManual('Buds3 Pro', '2.00');
      const before = await counts();

      const r = await check('buds 3  pro');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const parsed = manualProductCheckResponseSchema.parse(r.body);
      expect(parsed.similar.map((s) => [s.productCode, s.name, s.priced, s.codeGenerated])).toEqual(
        [
          ['KB-15', 'Buds 3 Pro', true, false],
          [compact.productCode, 'Buds3 Pro', true, true],
          ['KB-16', 'Redmi Buds 3 Pro Black', false, false],
        ],
      );
      expect(parsed.brandFound).toBeNull();
      expect(findForbiddenKeys(r.body)).toEqual([]);

      // A sub-brand in the name resolves to its parent; the typed text itself is not searched for.
      const branded = manualProductCheckResponseSchema.parse((await check('Redmi Note 14')).body);
      expect(branded).toEqual({ similar: [], brandFound: { id: xiaomiId, name: 'Xiaomi' } });
      expect(manualProductCheckResponseSchema.parse((await check('---')).body).similar).toEqual([]);

      expect(await counts()).toEqual(before);
      expect((await call('GET', MANUAL_PRODUCT_ROUTES.checkManualProduct.path)).status).toBe(422);
      expect((await check('Buds 3 Pro', ACCOUNTANT)).status).toBe(403);
    });
  });

  describe('GET /staff/products/:id/merge-preview', () => {
    const preview = (sourceId: string, targetProductId: string, actor: Actor = MANAGER) =>
      call(
        'GET',
        `/staff/products/${sourceId}/merge-preview?targetProductId=${targetProductId}`,
        actor,
      );

    /** The target's stock aggregate and one live delivery line with a cost. */
    const stockAndCost = async (productId: string): Promise<void> => {
      await t.prisma.stockCache.create({
        data: { productId, quantity: new Prisma.Decimal('250.5'), syncedAt: t.clock.now() },
      });
      await t.prisma.priceReference.create({
        data: {
          productId,
          deliveryRef: '10001',
          supplier: 'secret supplier',
          purchaseMethod: 'Import',
          category: 'Кабели',
          deliveredQuantity: new Prisma.Decimal('1000'),
          availableQuantity: new Prisma.Decimal('250.5'),
          costUsd: new Prisma.Decimal('1.5'),
          usdRateUsed: new Prisma.Decimal('12650'),
          costUzs: new Prisma.Decimal('18975'),
          deliveredAt: new Date('2026-10-20T05:00:00Z'),
          syncedAt: new Date('2026-10-20T05:00:00Z'),
        },
      });
    };

    it('shows both sides, what moves, the target stock and cost, and the version the merge would publish', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00' }]);
      await stockAndCost(kb);
      const manual = await createManual('Kabel USB-C', '12.50', {
        brandId: xiaomiId,
        deferredPrice: '13.00',
      });
      await t.prisma.productImage.create({
        data: {
          productId: manual.productId,
          isPrimary: true,
          sha256: 'a'.repeat(64),
          originalContentType: 'image/jpeg',
          width: 10,
          height: 10,
          byteSize: 100,
          uploadedBy: 'user-manager',
          createdAt: t.clock.now(),
        },
      });
      await resetIdentity(t.prisma);
      const org = await makeOrganization(t.prisma, { name: 'Shop' });
      const owner = await makeUser(t.prisma, { name: 'Owner', phone: '+998700000001' });
      const seller = await makeUser(t.prisma, { name: 'Seller', phone: '+998700000002' });
      await makeMember(t.prisma, org.id, owner.id, 'SHOP_OWNER');
      await makeMember(t.prisma, org.id, seller.id, 'SELLER');
      const carts = t.get(CartService);
      await carts.setItemQuantity(
        customerActor(owner.id, org.id, 'SHOP_OWNER'),
        manual.productId,
        '2',
      );
      await carts.setItemQuantity(
        customerActor(seller.id, org.id, 'SELLER'),
        manual.productId,
        '4',
      );
      await carts.setItemQuantity(customerActor(seller.id, org.id, 'SELLER'), kb, '1');
      const before = await counts();
      const base = await publishedNumber();

      const r = await preview(manual.productId, kb);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(mergePreviewResponseSchema.parse(r.body)).toEqual({
        source: {
          productId: manual.productId,
          productCode: manual.productCode,
          name: 'Kabel USB-C',
          brandName: 'Xiaomi',
          basePrice: '12.50',
          deferredPrice: '13.00',
          imageCount: 1,
          cartLineCount: 2,
        },
        target: {
          productId: kb,
          productCode: 'KB-15',
          name: 'Кабель',
          brandName: null,
          basePrice: '5.00',
          deferredPrice: null,
          stockQuantity: '250.500',
          costUsd: '1.5000',
        },
        nextVersionNumber: (base ?? 0) + 1,
      });
      expect(JSON.stringify(r.body)).not.toContain('secret supplier');
      expect(await counts()).toEqual(before);
      expect((await preview(manual.productId, kb, ACCOUNTANT)).status).toBe(403);
    });

    it('names the merge rules before the confirm; an unpriced source would publish nothing', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      const other = await sheetProduct('OTHER-1', 'Другое');
      const inactive = await sheetProduct('OLD-1', 'Старое');
      await t.prisma.product.update({ where: { id: inactive }, data: { isActive: false } });
      await price([{ productId: kb, basePrice: '5.00' }]);
      const manual = await createManual('Manual A', '2.00');
      const manual2 = await createManual('Manual B', '3.00');
      const removed = await call('POST', '/staff/price-list/publish', MANAGER, {
        baseVersionNumber: await publishedNumber(),
        upserts: [],
        removedProductIds: [manual.productId],
      });
      expect(removed.status).toBe(200);

      const reason = async (sourceId: string, targetId: string): Promise<unknown> =>
        (await preview(sourceId, targetId)).body.error?.reason;
      expect(await reason(kb, manual.productId)).toBe('NOT_GENERATED_CODE');
      expect(await reason(manual.productId, manual2.productId)).toBe('TARGET_IS_GENERATED');
      expect(await reason(manual.productId, inactive)).toBe('INACTIVE_PRODUCT');
      expect((await preview(manual.productId, manual.productId)).status).toBe(409);
      expect((await preview(manual.productId, '019a0000-0000-7000-8000-000000000000')).status).toBe(
        404,
      );
      expect((await call('GET', `/staff/products/${manual.productId}/merge-preview`)).status).toBe(
        422,
      );

      const unpriced = mergePreviewResponseSchema.parse((await preview(manual.productId, kb)).body);
      expect(unpriced.source).toMatchObject({
        basePrice: null,
        deferredPrice: null,
        imageCount: 0,
      });
      expect(unpriced.target).toMatchObject({ stockQuantity: null, costUsd: null });
      expect(unpriced.nextVersionNumber).toBeNull();

      const merged = await call('POST', `/staff/products/${manual.productId}/merge`, MANAGER, {
        baseVersionNumber: await publishedNumber(),
        targetProductId: kb,
      });
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
      expect(await reason(manual.productId, other)).toBe('PRODUCT_ALREADY_MERGED');
    });

    it('the latest cost is read only for an actor who may view cost (the DTO then carries null)', async () => {
      // Every role that may open the preview today may also view cost, so the null path is proven
      // at the pricing module's method and in the DTO unit test (manual-products.response.spec).
      const kb = await sheetProduct('KB-15', 'Кабель');
      await stockAndCost(kb);
      const costs = t.get(PriceReferenceService);
      expect([...(await costs.latestCostUsd(MANAGER, [kb]))]).toEqual([
        [kb, new Prisma.Decimal('1.5')],
      ]);
      expect((await costs.latestCostUsd(WAREHOUSE, [kb])).size).toBe(0);
    });
  });

  describe('sheetMatch in the staff price list', () => {
    it('names the active sheet product with the same name for a generated-code item, null otherwise', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель USB-C');
      const twin = await sheetProduct('KB-16', 'кабель usb c');
      await t.prisma.product.update({ where: { id: twin }, data: { isActive: false } });
      await price([{ productId: kb, basePrice: '5.00' }]);
      const matched = await createManual('КАБЕЛЬ  USB C', '1.00');
      const alone = await createManual('Quloqchin', '2.00');
      await createManual('Quloqchin', '3.00');

      const staff = expectParsed(
        await t.request('GET', '/staff/price-list/current', { actor: MANAGER }),
        200,
        staffPriceListWithRateResponseSchema,
      );
      const byId = new Map(staff.items.map((item) => [item.productId, item.sheetMatch]));
      expect(byId.get(matched.productId)).toEqual({
        productId: kb,
        productCode: 'KB-15',
        name: 'Кабель USB-C',
      });
      // Another generated-code product of the same name is no sheet product; an inactive twin neither.
      expect(byId.get(alone.productId)).toBeNull();
      expect(byId.get(kb)).toBeNull();
      expect(staff.items.filter((item) => item.sheetMatch !== null)).toHaveLength(1);

      const version = expectParsed(
        await t.request('GET', `/staff/price-list/versions/${staff.version.id}`, {
          actor: MANAGER,
        }),
        200,
        staffPriceListWithRateResponseSchema,
      );
      expect(
        version.items.find((item) => item.productId === matched.productId)?.sheetMatch,
      ).toEqual(byId.get(matched.productId));

      const customer = await t.request('GET', '/price-list/current', { actor: SHOP_OWNER });
      expectParsed(customer, 200, customerPriceListResponseSchema);
      expect(JSON.stringify(customer.body)).not.toContain('sheetMatch');
    });
  });

  describe('price list import', () => {
    it('the empty template is the header row only, under its own file name', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00' }]);
      await createManual('Beta', '2.00');
      const { port } = t.app.getHttpServer().address() as AddressInfo;
      const file = await fetch(
        `http://127.0.0.1:${port}${MANUAL_PRODUCT_ROUTES.priceImportTemplate.path}?kind=empty`,
        { headers: { 'x-test-actor': JSON.stringify(MANAGER) } },
      );
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toBe(
        'attachment; filename="iorder-import-template-empty-2026-11-09.xlsx"',
      );
      expect(await readWorkbook(await file.arrayBuffer())).toEqual([UZ_HEADERS]);
      expect(
        (
          await t.request('GET', `${MANUAL_PRODUCT_ROUTES.priceImportTemplate.path}?kind=bogus`, {
            actor: MANAGER,
          })
        ).status,
      ).toBe(422);
    });

    it('the template lists the generated-code products of the list, by name, with brand, category and prices', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00' }]);
      const b = await createManual('Beta', '2.00', { deferredPrice: '2.50', category: 'Kabellar' });
      await price([
        { productId: b.productId, basePrice: '2.00', deferredPrice: '2.50', rrp: '3.9' },
      ]);
      const a = await createManual('Alfa Xiaomi', '1.00');
      await createManual('Unpriced later', '9.00');
      const last = await t.prisma.product.findFirstOrThrow({
        where: { codeGenerated: true, translations: { some: { name: 'Unpriced later' } } },
      });
      const removed = await call('POST', '/staff/price-list/publish', MANAGER, {
        baseVersionNumber: await publishedNumber(),
        upserts: [],
        removedProductIds: [last.id],
      });
      expect(removed.status).toBe(200);

      // The file is binary, so it is fetched directly (the test request helper parses JSON).
      const { port } = t.app.getHttpServer().address() as AddressInfo;
      const file = await fetch(
        `http://127.0.0.1:${port}${MANUAL_PRODUCT_ROUTES.priceImportTemplate.path}`,
        {
          headers: { 'x-test-actor': JSON.stringify(MANAGER) },
        },
      );
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toBe(
        'attachment; filename="iorder-import-template-2026-11-09.xlsx"',
      );
      const rows = await readWorkbook(await file.arrayBuffer());
      expect(rows).toEqual([
        UZ_HEADERS,
        [a.productCode, 'Alfa Xiaomi', 'Xiaomi', null, 1, null, null],
        [b.productCode, 'Beta', null, 'Kabellar', 2, 2.5, 3.9],
      ]);
      // What was downloaded goes straight back: every row is UNCHANGED, the RRP included.
      const roundTrip = await upload(
        await workbook(
          UZ_HEADERS,
          rows.slice(1).map((row) => [...row]),
        ),
      );
      expect(roundTrip.status, JSON.stringify(roundTrip.body)).toBe(200);
      expect(roundTrip.body.rows.map((row: Body) => [row.status, row.rrp, row.currentRrp])).toEqual(
        [
          ['UNCHANGED', null, null],
          ['UNCHANGED', '3.90', '3.90'],
        ],
      );
      expect(
        (
          await t.request('GET', MANUAL_PRODUCT_ROUTES.priceImportTemplate.path, {
            actor: ACCOUNTANT,
          })
        ).status,
      ).toBe(403);
    });

    it('the preview judges every row and writes nothing', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00', rrp: '6.00' }]);
      const gen = await createManual('Quloqchin', '12.00', { category: 'Audio' });
      const before = await counts();

      const bytes = await workbook(UZ_HEADERS, [
        // A sheet product's name cell is ignored: an empty one is no error, the stored name shows.
        // Its category cell is ignored too, and its empty RRP cell removes the RRP it has.
        ['kb-15', null, null, 'Boshqa', '7,5', null, null],
        [null, 'Yangi mahsulot', ' xiaomi ', ' Kabellar ', 3, 3.5, '4,9'],
        [gen.productCode, 'Quloqchin Pro', null, 'Yangi kategoriya', 12, null, null],
        ['NOPE-1', 'Nobody', null, null, 1, null, null],
        [null, 'Brandless', 'Nokia', null, 1, null, null],
        [null, '  ', null, null, 'abc', null, null],
        [null, 'RRP xato', null, 'x'.repeat(201), 1, null, 'abc'],
      ]);
      const r = await upload(bytes);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const preview: PriceImportPreviewResponse = priceImportPreviewResponseSchema.parse(r.body);
      expect(preview.baseVersionNumber).toBe(await publishedNumber());
      expect(preview.summary).toEqual({
        newCount: 1,
        priceChangedCount: 1,
        unchangedCount: 1,
        errorCount: 4,
      });
      expect(
        preview.rows.map((row) => [row.rowNumber, row.status, row.issues, row.warnings]),
      ).toEqual([
        [2, 'PRICE_CHANGED', [], []],
        [3, 'NEW', [], ['CODE_WILL_BE_GENERATED']],
        [4, 'UNCHANGED', [], []],
        [5, 'ERROR', ['UNKNOWN_PRODUCT_CODE'], []],
        [6, 'ERROR', ['UNKNOWN_BRAND'], ['CODE_WILL_BE_GENERATED']],
        [7, 'ERROR', ['NAME_MISSING', 'PRICE_INVALID'], ['CODE_WILL_BE_GENERATED']],
        [8, 'ERROR', ['RRP_INVALID', 'CATEGORY_TOO_LONG'], ['CODE_WILL_BE_GENERATED']],
      ]);
      expect(preview.rows[0]).toMatchObject({
        productId: kb,
        codeGenerated: false,
        name: 'Кабель',
        basePrice: '7.50',
        currentBasePrice: '5.00',
        currentDeferredPrice: null,
        rrp: null,
        currentRrp: '6.00',
      });
      expect(preview.rows[2]).toMatchObject({ productId: gen.productId, codeGenerated: true });
      // The category shown is the one that will be stored: a new product's, never an existing one's.
      expect(preview.rows.slice(0, 3).map((row) => [row.category, row.rrp])).toEqual([
        [null, null],
        ['Kabellar', '4.90'],
        [null, null],
      ]);
      // The staff import carries the selling price tier [C, 2026-11-11]; nothing cost-like.
      expect(findForbiddenKeys(stripStaffPriceTier(r.body))).toEqual([]);
      expect(await counts()).toEqual(before);
    });

    it('refuses a file that is not the template', async () => {
      const notXlsx = await upload(Buffer.from('hello'));
      expect(notXlsx.status).toBe(422);
      expect(notXlsx.body.error).toMatchObject({
        code: 'PRICE_IMPORT_FILE_INVALID',
        details: { reason: 'FILE_NOT_XLSX' },
      });
      const headers = await upload(await workbook(['Tovar ID', 'Narx'], [['A', 1]]));
      expect(headers.body.error.details).toEqual({ reason: 'FILE_HEADERS_INVALID' });
      const empty = await upload(
        await workbook(UZ_HEADERS, [[null, null, null, null, null, null, null]]),
      );
      expect(empty.body.error.details).toEqual({ reason: 'FILE_EMPTY' });
      // A file of the older five-column template is refused whole: its rows are never read.
      const old = await upload(await workbook(OLD_UZ_HEADERS, [['KB-15', 'x', null, 1, null]]));
      expect(old.status).toBe(422);
      expect(old.body.error.details).toEqual({ reason: 'FILE_HEADERS_INVALID' });
      expect(
        (
          await upload(
            await workbook(UZ_HEADERS, [['A', 'x', null, null, 1, null, null]]),
            ACCOUNTANT,
          )
        ).status,
      ).toBe(403);
    });

    it('the confirm creates, renames and re-prices in one version; a bad row or a stale base writes nothing', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      await price([{ productId: kb, basePrice: '5.00' }]);
      const gen = await createManual('Quloqchin', '12.00', { category: 'Audio' });
      await price([{ productId: gen.productId, basePrice: '12.00', rrp: '15.00' }]);
      const before = await counts();

      const rows = [
        {
          productCode: 'KB-15',
          name: 'ignored',
          brandName: null,
          // An existing product keeps its category (here: none); the cell is not stored.
          category: 'Ignored',
          basePrice: '7.50',
          deferredPrice: null,
          rrp: '9.90',
        },
        {
          productCode: null,
          name: 'Yangi mahsulot',
          brandName: 'Xiaomi',
          category: 'Kabellar',
          basePrice: '3.00',
          deferredPrice: '3.50',
          rrp: '4.90',
        },
        {
          productCode: gen.productCode,
          name: 'Quloqchin Pro',
          brandName: null,
          category: 'Ignored too',
          basePrice: '12.00',
          deferredPrice: null,
          rrp: '15.00',
        },
      ];
      const base = await publishedNumber();
      const stale = await call('POST', MANUAL_PRODUCT_ROUTES.priceImportConfirm.path, MANAGER, {
        baseVersionNumber: null,
        rows,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.reason).toBe('PRICE_LIST_CHANGED');
      const bad = await call('POST', MANUAL_PRODUCT_ROUTES.priceImportConfirm.path, MANAGER, {
        baseVersionNumber: base,
        rows: [...rows, { productCode: 'NOPE-1', name: 'x', basePrice: '1.00' }],
      });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatchObject({
        code: 'IMPORT_ROWS_INVALID',
        details: { rows: [{ index: 3, issues: ['UNKNOWN_PRODUCT_CODE'] }] },
      });
      expect(await counts()).toEqual(before);

      const ok = await call('POST', MANUAL_PRODUCT_ROUTES.priceImportConfirm.path, MANAGER, {
        baseVersionNumber: base,
        rows,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const confirmed = priceImportConfirmResponseSchema.parse(ok.body);
      expect(confirmed).toMatchObject({ createdCount: 1, updatedCount: 1, unchangedCount: 1 });
      expect(confirmed.version).toMatchObject({ number: (base ?? 0) + 1, status: 'PUBLISHED' });
      const created = await t.prisma.product.findFirstOrThrow({
        where: { translations: { some: { name: 'Yangi mahsulot' } } },
      });
      expect(created).toMatchObject({
        codeGenerated: true,
        brandId: xiaomiId,
        category: 'Kabellar',
      });
      expect(created.productCode).toMatch(GENERATED_PRODUCT_CODE_PATTERN);
      // No existing product's category changed, sheet product or staff-added.
      await expect(
        t.prisma.product.findMany({
          where: { id: { in: [kb, gen.productId] } },
          select: { category: true },
          orderBy: { productCode: 'asc' },
        }),
      ).resolves.toEqual([{ category: 'Audio' }, { category: null }]);
      expect(await publishedRrps()).toEqual(
        new Map([
          [kb, '9.90'],
          [created.id, '4.90'],
          [gen.productId, '15.00'],
        ]),
      );
      // The RRPs are in the publish's audit row, before and after; an unchanged one is not.
      const publishAudit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: confirmed.version.id },
      });
      const diff = publishAudit.diff as Record<string, unknown>;
      expect(diff[`item.${kb}.rrp`]).toEqual({ from: null, to: '9.90' });
      expect(diff[`item.${created.id}.rrp`]).toEqual({ from: null, to: '4.90' });
      expect(diff[`item.${gen.productId}.rrp`]).toBeUndefined();
      const createdAudit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRODUCT_CREATED', entityId: created.id },
      });
      expect(createdAudit.diff).toMatchObject({ category: { from: null, to: 'Kabellar' } });

      // Customers browse the new product by its category and see its RRP in so'm (x 12000).
      const customer = await t.request('GET', '/price-list/current', { actor: SHOP_OWNER });
      const list = expectParsed(customer, 200, customerPriceListResponseSchema);
      expect(list.items.find((item) => item.productId === created.id)).toMatchObject({
        category: 'Kabellar',
        price: '36000.00',
        rrp: '58800.00',
      });
      expect(findForbiddenKeys(customer.body)).toEqual([]);
      expect(findStaffOnlyFieldsInCustomerPriceList(customer.body)).toEqual([]);

      expect(await publishedItems()).toEqual(
        new Map([
          [kb, { base: '7.50', deferred: null }],
          [created.id, { base: '3.00', deferred: '3.50' }],
          [gen.productId, { base: '12.00', deferred: null }],
        ]),
      );
      const renamed = await t.prisma.productTranslation.findUniqueOrThrow({
        where: { productId_lang: { productId: gen.productId, lang: 'UZ' } },
      });
      expect(renamed.name).toBe('Quloqchin Pro');
      // The sheet product keeps its name; the rename and the publish are in the audit log.
      await expect(
        t.prisma.productTranslation.findMany({ where: { productId: kb } }),
      ).resolves.toEqual([expect.objectContaining({ lang: 'RU', name: 'Кабель' })]);
      const actions = (await t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
        (a) => a.action,
      );
      expect(actions.slice(-5)).toEqual(
        expect.arrayContaining(['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRICE_LIST_PUBLISHED']),
      );

      // A later file with an empty RRP cell removes the RRP, and the audit row says from what.
      const cleared = await call('POST', MANUAL_PRODUCT_ROUTES.priceImportConfirm.path, MANAGER, {
        baseVersionNumber: confirmed.version.number,
        rows: [{ productCode: 'KB-15', name: 'x', basePrice: '7.50' }],
      });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(cleared.body).toMatchObject({ createdCount: 0, updatedCount: 1, unchangedCount: 0 });
      expect((await publishedRrps()).get(kb)).toBeNull();
      const clearedAudit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: cleared.body.version.id },
      });
      expect((clearedAudit.diff as Record<string, unknown>)[`item.${kb}.rrp`]).toEqual({
        from: '9.90',
        to: null,
      });
    });
  });

  describe('the reserved prefix and the merge at the database', () => {
    const sync = async (lines: FixtureLine[]) =>
      new SheetsSyncService(
        new FakeDeliveryCostSource(fixtureTable(lines)),
        t.get(CatalogService),
        t.get(PriceReferenceService),
        t.clock,
        t.get(SupplyRemovalService),
        t.get(SheetSyncRunRepository),
        new FixtureRowSelection(),
      ).syncCostReference();

    it('the sheet sync reports an IO- «Товар_ID» as a row error and creates no product for it', async () => {
      const report = await sync([
        fixtureLine('IO-000777', 'D-1', '01.11.2026'),
        fixtureLine('io-1', 'D-1', '01.11.2026'),
        fixtureLine('OK-1', 'D-1', '01.11.2026'),
      ]);
      expect(report.created).toBe(1);
      expect(
        report.rejected.map((r) => [r.index, r.issues[0]?.path, r.issues[0]?.message]),
      ).toEqual([
        [0, 'Товар_ID', 'Product code prefix IO- is reserved'],
        [1, 'Товар_ID', 'Product code prefix IO- is reserved'],
      ]);
      const codes = (await t.prisma.product.findMany()).map((p) => p.productCode);
      expect(codes).toEqual(['OK-1']);
    });

    it('the CHECK constraints tie the IO- prefix to code_generated and a merge to inactivity', async () => {
      const insert = (code: string, generated: boolean) =>
        t.prisma.$executeRaw`
          INSERT INTO products (id, product_code, code_generated) VALUES (gen_random_uuid(), ${code}, ${generated})`;
      await expect(insert('IO-000999', false)).rejects.toThrow(/products_generated_code_prefix/);
      await expect(insert('io-9', false)).rejects.toThrow(/products_generated_code_prefix/);
      await expect(insert('ABC-1', true)).rejects.toThrow(/products_generated_code_prefix/);
      await expect(insert('IO-000001', true)).resolves.toBe(1);
      const kb = await sheetProduct('KB-15', 'Кабель');
      const generated = await t.prisma.product.findUniqueOrThrow({
        where: { productCode: 'IO-000001' },
      });
      await expect(
        t.prisma
          .$executeRaw`UPDATE products SET merged_into_id = ${kb}::uuid WHERE id = ${generated.id}::uuid`,
      ).rejects.toThrow(/products_merged_into_check/);
      await expect(
        t.prisma
          .$executeRaw`UPDATE products SET merged_into_id = ${generated.id}::uuid, is_active = false WHERE id = ${generated.id}::uuid`,
      ).rejects.toThrow(/products_merged_into_check/);
      await expect(
        t.prisma
          .$executeRaw`UPDATE products SET merged_into_id = ${kb}::uuid, is_active = false WHERE id = ${generated.id}::uuid`,
      ).resolves.toBe(1);
    });

    it('the application role takes generated codes from the sequence and moves a merged photo only', async () => {
      const kb = await sheetProduct('KB-15', 'Кабель');
      const other = await sheetProduct('OTHER-1', 'Другое');
      const manual = await createManual('Manual', '1.00');
      const image = await t.prisma.productImage.create({
        data: {
          productId: manual.productId,
          isPrimary: false,
          sha256: 'a'.repeat(64),
          originalContentType: 'image/jpeg',
          width: 1,
          height: 1,
          byteSize: 1,
          uploadedBy: 'user-manager',
          createdAt: t.clock.now(),
        },
      });
      const app = new pg.Client({ connectionString: getRestrictedRoleUrl() });
      await app.connect();
      try {
        const next = await app.query<{ n: string }>(
          `SELECT nextval('product_generated_code_seq') AS n`,
        );
        expect(Number(next.rows[0]?.n)).toBeGreaterThan(0);
        // Not merged yet: the photo may not leave its product.
        await expect(
          app.query('UPDATE product_images SET product_id = $1 WHERE id = $2', [kb, image.id]),
        ).rejects.toThrow(/may move only to the product its owner was merged into/);
        await t.prisma.product.update({
          where: { id: manual.productId },
          data: { isActive: false, mergedIntoProductId: kb },
        });
        await expect(
          app.query('UPDATE product_images SET product_id = $1 WHERE id = $2', [other, image.id]),
        ).rejects.toThrow(/may move only to the product its owner was merged into/);
        const moved = await app.query('UPDATE product_images SET product_id = $1 WHERE id = $2', [
          kb,
          image.id,
        ]);
        expect(moved.rowCount).toBe(1);
      } finally {
        await app.end();
      }
    });
  });
});

describe('orders with a product outside the plan (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([PricingModule, CatalogModule, OrdersModule, ManualProductsModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
  });

  /** A manual product priced in the world's list (a new published version). */
  async function manualProduct(name: string, basePrice: string): Promise<string> {
    const current = await t.get(PricingService).findPublishedVersion();
    const r = await call(MANUAL_PRODUCT_ROUTES.createManualProduct, {
      actor: w.actors.manager,
      body: { baseVersionNumber: current?.number ?? null, name, basePrice },
    });
    return expectParsed(r, 201, createManualProductResponseSchema).productId;
  }

  it('approves an order with a manual line without a hold for it; the preview says stock is not tracked', async () => {
    const manual = await manualProduct('Quloqchin', '2.00');
    const order = await submitOrder(w, w.actors.sellerA, {
      items: [
        [w.products.p1, '2'],
        [manual, '3'],
      ],
    });
    const preview = expectParsed(
      await call(STAFF_ORDER_ROUTES.getAllocationPreview, {
        actor: w.actors.manager,
        params: { id: order.id },
      }),
      200,
      allocationPreviewSchema,
    );
    expect(preview.feasible).toBe(true);
    const manualItem = preview.items.find((i) => i.productId === manual);
    expect(manualItem).toMatchObject({
      stockTracked: false,
      lines: [],
      fifo: [],
      current: [],
      shortQuantity: '0.000',
    });
    expect(preview.items.find((i) => i.productId === w.products.p1)).toMatchObject({
      stockTracked: true,
    });

    const approved = await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
    expect(approved.status).toBe('MANAGER_APPROVED');
    const holds = await t.prisma.orderAllocation.findMany({ where: { orderId: order.id } });
    expect(holds.map((h) => h.productId)).toEqual([w.products.p1]);

    const staff = expectParsed(
      await call(STAFF_ORDER_ROUTES.getOrder, {
        actor: w.actors.manager,
        params: { id: order.id },
      }),
      200,
      staffOrderSchema,
    );
    expect(staff.items.map((i) => [i.productId, i.stockTracked])).toEqual(
      expect.arrayContaining([
        [manual, false],
        [w.products.p1, true],
      ]),
    );
    await w.step(w.actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' });
    const picking = expectParsed(
      await call(STAFF_PICKING_ROUTES.getPicking, {
        actor: w.actors.warehouse,
        params: { id: order.id },
      }),
      200,
      pickingResponseSchema,
    );
    expect(picking.lines.find((l) => l.productId === manual)).toMatchObject({
      stockTracked: false,
      allocations: [],
    });
  });

  it('an order of only manual lines is approved with an empty plan', async () => {
    const manual = await manualProduct('Quloqchin', '2.00');
    const order = await submitOrder(w, w.actors.sellerA, { items: [[manual, '3']] });
    const reply = await call(STAFF_ORDER_ROUTES.approveOrder, {
      actor: w.actors.manager,
      params: { id: order.id },
      body: {
        paymentMethod: 'CASH',
        allocationMode: 'FIFO',
        allocations: [],
        expectedRowVersion: order.rowVersion,
      },
    });
    expect(expectParsed(reply, 200, staffOrderSchema).status).toBe('MANAGER_APPROVED');
    await expect(t.prisma.orderAllocation.count({ where: { orderId: order.id } })).resolves.toBe(0);
  });

  it('a merge leaves old order snapshots alone', async () => {
    const manual = await manualProduct('Quloqchin', '2.00');
    const order = await orderAt(w, 'MANAGER_APPROVED', { items: [[manual, '3']] });
    const current = await t.get(PricingService).findPublishedVersion();
    const merged = await call(MANUAL_PRODUCT_ROUTES.mergeProduct, {
      actor: w.actors.manager,
      params: { id: manual },
      body: { baseVersionNumber: current?.number ?? null, targetProductId: w.products.p3 },
    });
    expectParsed(merged, 200, mergeProductResponseSchema);
    const items = await t.prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items.map((i) => [i.productId, i.productCodeSnapshot.startsWith('IO-')])).toEqual([
      [manual, true],
    ]);
    // The merged product is inactive, so it cannot be put in a cart any more; the target can.
    await expect(fillCart(w, w.actors.sellerA, [[manual, '1']])).rejects.toMatchObject({
      reason: 'PRODUCT_NOT_ORDERABLE',
    });
    await fillCart(w, w.actors.sellerA, [[w.products.p3, '1']]);
    expectError(
      await call(MANUAL_PRODUCT_ROUTES.mergeProduct, {
        actor: w.actors.manager,
        params: { id: manual },
        body: { baseVersionNumber: null, targetProductId: w.products.p3 },
      }),
      409,
      'CONFLICT',
      'PRODUCT_ALREADY_MERGED',
    );
  });
});
