import { createHash } from 'node:crypto';
import { customerPriceListResponseSchema } from '@iorder/shared';
import {
  staffProductDetailListResponseSchema,
  staffPriceListWithRateResponseSchema,
  staffProductDetailResponseSchema,
  stockOverviewResponseSchema,
  unpricedProductsResponseSchema,
} from '@iorder/shared/staff-cost';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { CatalogModule, CatalogService } from '../src/modules/catalog/index.js';
import {
  PriceListExportService,
  PriceReferenceService,
  PricingModule,
  SupplyRemovalService,
} from '../src/modules/pricing/index.js';
import {
  FakeDeliveryCostSource,
  FixtureRowSelection,
  fixtureLine,
  fixtureTable,
  type FixtureLine,
} from '../src/modules/sheets-sync/fake-delivery-cost-source.js';
import { UsdRateService } from '../src/modules/pricing/usd-rate/usd-rate.service.js';
import { SheetSyncRunRepository } from '../src/modules/sheets-sync/sheet-sync-run.repository.js';
import { SheetsSyncModule } from '../src/modules/sheets-sync/sheets-sync.module.js';
import { SheetsSyncService } from '../src/modules/sheets-sync/sheets-sync.service.js';
import {
  findStaffOnlyFields,
  findStaffOnlyFieldsInCustomerPriceList,
} from './support/forbidden-fields.js';
import { recordSql } from './support/sql-counter.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import {
  ACCOUNTANT,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SELLER,
  SHOP_OWNER,
  WAREHOUSE,
  type TestApp,
} from './support/test-app.js';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

// PricingModule first: the same order as AppModule (see StaffStockController).
describe('products created from the sheet, unpriced and stock lists (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([PricingModule, CatalogModule, SheetsSyncModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    await resetCatalogPricingAudit(t.prisma);
    // Prices are entered in USD; customers only see a USD price once a rate exists.
    await t.prisma.appSetting.deleteMany({ where: { key: 'usd_rate' } });
    await t.get(UsdRateService).setUsdRate(MANAGER, new Prisma.Decimal('12000'));
  });

  const call = async (
    method: string,
    path: string,
    actor = MANAGER,
    body?: unknown,
  ): Promise<{ status: number; body: Body }> => {
    const r = await t.request(method, path, { actor, body });
    return { status: r.status, body: (r.body ?? {}) as Body };
  };

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

  const productByCode = (productCode: string) =>
    t.prisma.product.findUniqueOrThrow({ where: { productCode }, include: { translations: true } });

  /** Publishes a list with exactly these products priced. */
  const publish = async (productIds: string[]): Promise<void> => {
    const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
    const put = await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
      items: productIds.map((productId) => ({ productId, basePrice: '10.00' })),
    });
    expect(put.status).toBe(200);
    expect((await call('POST', `/staff/price-list/drafts/${draft}/publish`)).status).toBe(200);
  };

  const pricedApple = async (): Promise<string> =>
    (
      await t.prisma.product.create({
        data: {
          productCode: 'APPLE',
          unit: 'box',
          translations: { create: [{ lang: 'UZ', name: 'Olma' }] },
        },
      })
    ).id;

  describe('creation from the sheet', () => {
    it('creates an active product with the sheet name (RU), the piece unit, no price; reports the code', async () => {
      const report = await sync([
        fixtureLine('SHEET-1', 'R-1', '10.10.2026', { productName: 'Телефон Один' }),
      ]);
      expect(report.createdProducts).toEqual(['SHEET-1']);
      const product = await productByCode('SHEET-1');
      expect(product).toMatchObject({
        isActive: true,
        unit: 'PIECE',
        category: 'Смартфоны',
        codeRuleConfigured: false,
      });
      expect(product.translations.map((x) => [x.lang, x.name])).toEqual([['RU', 'Телефон Один']]);
      await expect(t.prisma.priceListItem.count()).resolves.toBe(0);
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_PRODUCT_CREATED' },
      });
      expect(audit).toMatchObject({
        actorUserId: null,
        entityType: 'PRODUCT',
        entityId: product.id,
      });
    });

    it('is idempotent and never duplicates a product that differs only in letter case', async () => {
      await sync([fixtureLine('Sheet-Case', 'R-1', '10.10.2026')]);
      const second = await sync([fixtureLine('sheet-case', 'R-2', '11.10.2026')]);
      expect(second.createdProducts).toEqual([]);
      await expect(t.prisma.product.count()).resolves.toBe(1);
      expect((await productByCode('Sheet-Case')).productCode).toBe('Sheet-Case');
    });

    it('rejects a code that fails the product code rule as a row error; no product, no delivery', async () => {
      const report = await sync([
        fixtureLine('not a valid code!', 'R-1', '10.10.2026'),
        fixtureLine('GOOD-1', 'R-2', '10.10.2026'),
      ]);
      expect(report.createdProducts).toEqual(['GOOD-1']);
      expect(report.rejected).toHaveLength(1);
      expect(report.rejected[0]).toMatchObject({ index: 0, issues: [{ path: 'Товар_ID' }] });
      expect(report.rejected[0]?.productCode).toBeUndefined();
      await expect(t.prisma.product.count()).resolves.toBe(1);
      await expect(t.prisma.priceReference.count()).resolves.toBe(1);
    });

    it('a failing chunk creates no product (product and lines commit together)', async () => {
      const original = t
        .get(PriceReferenceService)
        .availableTotals.bind(t.get(PriceReferenceService));
      vi.spyOn(t.get(PriceReferenceService), 'availableTotals').mockImplementation(
        async (tx, ids) => {
          await original(tx, ids);
          throw new Error('forced failure');
        },
      );
      await expect(sync([fixtureLine('GHOST-1', 'R-1', '10.10.2026')])).rejects.toThrow();
      await expect(t.prisma.product.count()).resolves.toBe(0);
      await expect(t.prisma.priceReference.count()).resolves.toBe(0);
    });
  });

  describe('invisible to customers', () => {
    it('is absent from the customer price list, also after a publish that does not include it', async () => {
      const apple = await pricedApple();
      await sync([fixtureLine('SHEET-1', 'R-1', '10.10.2026')]);
      await publish([apple]);

      for (const actor of [SHOP_OWNER, SELLER]) {
        const response = await call('GET', '/price-list/current', actor);
        expect(response.status).toBe(200);
        const parsed = customerPriceListResponseSchema.parse(response.body);
        expect(parsed.items.map((i) => i.productCode)).toEqual(['APPLE']);
        expect(JSON.stringify(response.body)).not.toContain('SHEET-1');
        expect(findStaffOnlyFieldsInCustomerPriceList(response.body)).toEqual([]);
      }
      // Customers cannot reach any staff product route either.
      for (const path of ['/staff/products', '/staff/products/unpriced', '/staff/stock']) {
        expect((await call('GET', path, SHOP_OWNER)).status, path).toBe(403);
      }
    });
  });

  describe('category on the customer price list (owner decision 2026-10-23)', () => {
    const makeProduct = async (
      productCode: string,
      name: string,
      category: string | null,
    ): Promise<string> =>
      (
        await t.prisma.product.create({
          data: {
            productCode,
            unit: 'dona',
            category,
            translations: { create: [{ lang: 'UZ', name }] },
          },
        })
      ).id;

    it('carries the raw category (or null) on the items and nothing else staff-only', async () => {
      await publish([
        await makeProduct('CAT-A', 'Telefon', 'Смартфоны'),
        await makeProduct('CAT-B', 'Stul', null),
      ]);
      for (const actor of [SHOP_OWNER, SELLER]) {
        const response = await call('GET', '/price-list/current', actor);
        expect(response.status).toBe(200);
        const parsed = customerPriceListResponseSchema.parse(response.body);
        expect(parsed.items.map((i) => [i.productCode, i.category]).sort()).toEqual([
          ['CAT-A', 'Смартфоны'],
          ['CAT-B', null],
        ]);
        expect(findStaffOnlyFieldsInCustomerPriceList(response.body)).toEqual([]);
        // The generic scan still reports the category and the stock figure here, proving they
        // are allowed only through the price-list-specific helper and only on the items.
        expect(findStaffOnlyFields(response.body)).toEqual([
          '$.items[0].orderableStock',
          '$.items[0].category',
          '$.items[1].orderableStock',
          '$.items[1].category',
        ]);
        // `orderableStock` is the one stock key a customer may get (owner decision 2026-11-09): it
        // is taken out first, so any OTHER stock-like name still fails.
        const text = JSON.stringify(response.body)
          .toLowerCase()
          .replaceAll('"orderablestock"', '""');
        for (const word of ['supplier', 'stock', 'cost', 'usd', 'purchase', 'margin', 'rate']) {
          expect(text, word).not.toContain(word);
        }
      }
    });

    it('is not reachable on any staff route for a customer (403) and the staff list is unchanged', async () => {
      await publish([await makeProduct('CAT-A', 'Telefon', 'Смартфоны')]);
      for (const path of ['/staff/products', '/staff/price-list/current', '/staff/stock']) {
        const denied = await call('GET', path, SHOP_OWNER);
        expect(denied.status, path).toBe(403);
        expect(JSON.stringify(denied.body), path).not.toContain('Смартфоны');
      }
      const staff = await call('GET', '/staff/price-list/current', MANAGER);
      expect(JSON.stringify(staff.body)).not.toContain('Смартфоны');
    });

    it('sorts the Excel export by category (no category last) then name and adds the column', async () => {
      // No brand is found in these names, so all four land on the last ("other") sheet.
      await publish([
        await makeProduct('X-1', 'Zeta', 'Смартфоны'),
        await makeProduct('X-2', 'Alfa', null),
        await makeProduct('X-3', 'Beta', 'Аксессуары'),
        await makeProduct('X-4', 'Alfa2', 'Смартфоны'),
      ]);
      const exported = await t.get(PriceListExportService).buildCurrent('RU');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(exported.data) as unknown as ArrayBuffer);
      expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Прочее']);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.getRow(2).values).toEqual([
        undefined,
        'Категория',
        'ID товара',
        'Фото',
        'Товар',
        'Остаток',
        'Цена $',
        'Отсрочка $',
      ]);
      const rows = [3, 4, 5, 6].map((r) => [
        sheet.getCell(`A${r}`).value,
        sheet.getCell(`B${r}`).value,
        sheet.getCell(`D${r}`).value,
      ]);
      expect(rows).toEqual([
        ['Аксессуары', 'X-3', 'Beta'],
        ['Смартфоны', 'X-4', 'Alfa2'],
        ['Смартфоны', 'X-1', 'Zeta'],
        ['', 'X-2', 'Alfa'],
      ]);
    });
  });

  describe('unit and the price list (pieces only, owner 2026-10-28)', () => {
    it('a product created from the sheet is priced and ordered by the piece without entering a unit', async () => {
      await sync([fixtureLine('SHEET-1', 'R-1', '10.10.2026')]);
      const product = await productByCode('SHEET-1');
      const detail = staffProductDetailResponseSchema.parse(
        (await call('GET', `/staff/products/${product.id}`)).body,
      );
      expect(detail).toMatchObject({ unit: 'PIECE', category: 'Смартфоны' });

      const published = await call('POST', '/staff/price-list/publish', MANAGER, {
        baseVersionNumber: null,
        upserts: [{ productId: product.id, basePrice: '10.00' }],
      });
      expect(published.status).toBe(200);
      const customer = customerPriceListResponseSchema.parse(
        (await call('GET', '/price-list/current', SHOP_OWNER)).body,
      );
      expect(customer.items).toMatchObject([{ productCode: 'SHEET-1', unit: 'PIECE' }]);
    });

    it('an older product whose stored unit is NULL is priced too, also by raw SQL', async () => {
      const legacy = await t.prisma.product.create({ data: { productCode: 'NO-UNIT-1' } });
      await t.prisma.$executeRaw`UPDATE products SET unit = NULL WHERE id = ${legacy.id}::uuid`;
      const published = await call('POST', '/staff/price-list/publish', MANAGER, {
        baseVersionNumber: null,
        upserts: [{ productId: legacy.id, basePrice: '5.00' }],
      });
      expect(published.status).toBe(200);
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await t.prisma.priceListItem.create({
        data: { versionId: draft, productId: legacy.id, basePrice: new Prisma.Decimal('6.00') },
      });
      const staff = staffProductDetailResponseSchema.parse(
        (await call('GET', `/staff/products/${legacy.id}`)).body,
      );
      expect(staff.unit).toBe('PIECE');
    });

    it('one common name: renaming a sheet product keeps its RU row, and every language sees the new name', async () => {
      await sync([fixtureLine('SHEET-1', 'R-1', '10.10.2026', { productName: 'Телефон Один' })]);
      const product = await productByCode('SHEET-1');
      const before = staffProductDetailResponseSchema.parse(
        (await call('GET', `/staff/products/${product.id}`)).body,
      );
      expect(before.name).toBe('Телефон Один');

      const renamed = await call('PATCH', `/staff/products/${product.id}`, MANAGER, {
        name: 'Telefon Bir',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'Telefon Bir' });
      expect(
        (await productByCode('SHEET-1')).translations.map((x) => [x.lang, x.name]).sort(),
      ).toEqual([
        ['RU', 'Телефон Один'],
        ['UZ', 'Telefon Bir'],
      ]);

      await call('POST', '/staff/price-list/publish', MANAGER, {
        baseVersionNumber: null,
        upserts: [{ productId: product.id, basePrice: '10.00' }],
      });
      for (const lang of ['UZ', 'RU', 'EN']) {
        const list = customerPriceListResponseSchema.parse(
          (await call('GET', `/price-list/current?lang=${lang}`, SHOP_OWNER)).body,
        );
        expect(
          list.items.map((i) => i.name),
          lang,
        ).toEqual(['Telefon Bir']);
      }
      // A later sync does not change the staff-entered name.
      await sync([fixtureLine('SHEET-1', 'R-2', '11.10.2026', { productName: 'Другое имя' })]);
      expect(
        staffProductDetailResponseSchema.parse(
          (await call('GET', `/staff/products/${product.id}`)).body,
        ).name,
      ).toBe('Telefon Bir');
    });

    it('a new product gets the piece unit from the database default; a blank unit is still refused', async () => {
      const created = await t.prisma.product.create({ data: { productCode: 'DEFAULT-UNIT' } });
      expect((await t.prisma.product.findUniqueOrThrow({ where: { id: created.id } })).unit).toBe(
        'PIECE',
      );
      await expect(
        t.prisma.product.create({ data: { productCode: 'BLANK-UNIT', unit: '  ' } }),
      ).rejects.toThrow();
    });
  });

  describe('category', () => {
    it('follows the latest delivery line (newest date; a tie goes to the larger delivery ref)', async () => {
      await sync([
        fixtureLine('CAT-1', 'R-1', '01.10.2026', { category: 'Old' }),
        fixtureLine('CAT-1', 'R-2', '05.10.2026', { category: 'New' }),
        fixtureLine('CAT-2', 'A', '05.10.2026', { category: 'CatA' }),
        fixtureLine('CAT-2', 'B', '05.10.2026', { category: 'CatB' }),
      ]);
      expect((await productByCode('CAT-1')).category).toBe('New');
      expect((await productByCode('CAT-2')).category).toBe('CatB');
    });

    it('a changed category is written and audited with before and after; an unchanged one is not', async () => {
      await sync([fixtureLine('CAT-1', 'R-1', '01.10.2026', { category: 'Old' })]);
      const product = await productByCode('CAT-1');
      const audits = () =>
        t.prisma.auditLog.findMany({
          where: { action: 'SHEET_SYNC_PRODUCT_CATEGORY_CHANGED', entityId: product.id },
          orderBy: { createdAt: 'asc' },
        });
      expect((await audits()).map((a) => a.diff)).toEqual([
        { category: { from: null, to: 'Old' } },
      ]);

      await sync([fixtureLine('CAT-1', 'R-1', '01.10.2026', { category: 'Old' })]);
      expect(await audits()).toHaveLength(1);

      const report = await sync([
        fixtureLine('CAT-1', 'R-1', '01.10.2026', { category: 'Old' }),
        fixtureLine('CAT-1', 'R-2', '09.10.2026', { category: 'Newer' }),
      ]);
      expect(report.categoriesChanged).toBe(1);
      expect((await audits()).map((a) => a.diff)).toEqual([
        { category: { from: null, to: 'Old' } },
        { category: { from: 'Old', to: 'Newer' } },
      ]);
      expect((await audits()).every((a) => a.actorUserId === null)).toBe(true);
    });

    it('is in the staff product DTOs and filters the staff list by exact category', async () => {
      await sync([
        fixtureLine('P-PHONE', 'R-1', '01.10.2026', { category: 'Смартфоны' }),
        fixtureLine('P-TAB', 'R-2', '01.10.2026', { category: 'Планшеты' }),
      ]);
      const all = staffProductDetailListResponseSchema.parse(
        (await call('GET', '/staff/products')).body,
      );
      expect(all.items.map((p) => [p.productCode, p.category, p.unit])).toEqual([
        ['P-PHONE', 'Смартфоны', 'PIECE'],
        ['P-TAB', 'Планшеты', 'PIECE'],
      ]);
      const filtered = staffProductDetailListResponseSchema.parse(
        (await call('GET', `/staff/products?category=${encodeURIComponent('Планшеты')}`)).body,
      );
      expect(filtered.items.map((p) => p.productCode)).toEqual(['P-TAB']);
      const none = staffProductDetailListResponseSchema.parse(
        (await call('GET', '/staff/products?category=%D0%9F')).body,
      );
      expect(none.items).toEqual([]);
    });
  });

  describe('GET /staff/products/unpriced', () => {
    it('lists products with no price in the published list, with delivery summary and draft flag', async () => {
      const apple = await pricedApple();
      await sync([
        fixtureLine('SHEET-1', 'R-1', '10.10.2026', { category: 'Смартфоны', productName: 'Один' }),
        fixtureLine('SHEET-1', 'R-2', '12.10.2026', { category: 'Смартфоны', costUsd: '20' }),
        fixtureLine('SHEET-2', 'R-3', '11.10.2026', { category: 'Планшеты', productName: 'Два' }),
        fixtureLine('APPLE', 'R-4', '11.10.2026'),
      ]);
      await publish([apple]);
      // SHEET-2 gets a price in the open draft only.
      const sheet2 = await productByCode('SHEET-2');
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: sheet2.id, basePrice: '9.00' }],
      });

      const response = await call('GET', '/staff/products/unpriced');
      expect(response.status).toBe(200);
      const parsed = unpricedProductsResponseSchema.parse(response.body);
      expect(parsed.items.map((i) => i.productCode)).toEqual(['SHEET-1', 'SHEET-2']);
      const [one, two] = parsed.items;
      expect(one).toMatchObject({
        names: [{ lang: 'RU', name: 'Один' }],
        unit: 'PIECE',
        isActive: true,
        category: 'Смартфоны',
        stockQuantity: '501.000',
        hasDraftPrice: false,
      });
      // The newest delivery (R-2, 12.10) with its supplier and costs.
      expect(one?.latestDelivery).toMatchObject({
        supplier: 'alpha trade import',
        costUsd: '20.0000',
        costUzs: '253000.00',
      });
      expect(two).toMatchObject({ unit: 'PIECE', hasDraftPrice: true });
      expect(parsed.categories).toEqual([
        { category: 'Планшеты', count: 1 },
        { category: 'Смартфоны', count: 1 },
      ]);
      expect(parsed.uncategorizedCount).toBe(0);
    });

    it('filters by exact category and by search; the category counts ignore the category filter', async () => {
      await sync([
        fixtureLine('SHEET-1', 'R-1', '10.10.2026', { category: 'Смартфоны', productName: 'Один' }),
        fixtureLine('SHEET-2', 'R-2', '10.10.2026', { category: 'Планшеты', productName: 'Два' }),
        fixtureLine('OTHER-3', 'R-3', '10.10.2026', { category: 'Планшеты', productName: 'Три' }),
      ]);
      const byCategory = unpricedProductsResponseSchema.parse(
        (await call('GET', `/staff/products/unpriced?category=${encodeURIComponent('Планшеты')}`))
          .body,
      );
      expect(byCategory.items.map((i) => i.productCode)).toEqual(['OTHER-3', 'SHEET-2']);
      expect(byCategory.categories).toHaveLength(2);

      const bySearch = unpricedProductsResponseSchema.parse(
        (await call('GET', '/staff/products/unpriced?search=sheet')).body,
      );
      expect(bySearch.items.map((i) => i.productCode)).toEqual(['SHEET-1', 'SHEET-2']);
      expect(bySearch.categories.reduce((n, c) => n + c.count, 0)).toBe(2);

      const byName = unpricedProductsResponseSchema.parse(
        (await call('GET', `/staff/products/unpriced?search=${encodeURIComponent('три')}`)).body,
      );
      expect(byName.items.map((i) => i.productCode)).toEqual(['OTHER-3']);
    });

    it('counts a product without any delivery as uncategorized and lists it with no delivery', async () => {
      await pricedApple();
      await t.prisma.product.create({ data: { productCode: 'NO-CAT', unit: 'box' } });
      const parsed = unpricedProductsResponseSchema.parse(
        (await call('GET', '/staff/products/unpriced')).body,
      );
      // No published list at all: every product is unpriced.
      expect(parsed.items.map((i) => i.productCode)).toEqual(['APPLE', 'NO-CAT']);
      expect(parsed.items.every((i) => i.latestDelivery === null && i.stockQuantity === null)).toBe(
        true,
      );
      expect(parsed.uncategorizedCount).toBe(2);
      expect(parsed.categories).toEqual([]);
    });

    it('sends a fixed number of SQL statements whatever the number of products', async () => {
      await sync([fixtureLine('SHEET-1', 'R-1', '10.10.2026')]);
      const small = await recordSql(t.prisma, async () => {
        expect((await call('GET', '/staff/products/unpriced')).status).toBe(200);
      });

      await sync(
        Array.from({ length: 60 }, (_, i) =>
          fixtureLine(`MANY-${String(i).padStart(3, '0')}`, `M-${i}`, '10.10.2026'),
        ),
      );
      let body: Body = {};
      const large = await recordSql(t.prisma, async () => {
        body = (await call('GET', '/staff/products/unpriced')).body;
      });
      expect(unpricedProductsResponseSchema.parse(body).items).toHaveLength(61);
      expect(small.length).toBeGreaterThan(0);
      expect(large.length).toBe(small.length);
    });
  });

  describe('GET /staff/stock', () => {
    it('lists products with a stock aggregate or deliveries, with priced flag and delivery count', async () => {
      const apple = await pricedApple();
      await sync([
        fixtureLine('APPLE', 'R-1', '10.10.2026', { availableQuantity: '0' }),
        fixtureLine('SHEET-1', 'R-2', '10.10.2026'),
        fixtureLine('SHEET-1', 'R-3', '11.10.2026'),
      ]);
      await publish([apple]);
      // Stock without deliveries still counts; a product with neither is absent.
      const stockOnly = await t.prisma.product.create({
        data: { productCode: 'STOCK-ONLY', unit: 'box' },
      });
      await t.prisma.stockCache.create({
        data: { productId: stockOnly.id, quantity: new Prisma.Decimal('7'), syncedAt: new Date() },
      });
      await t.prisma.product.create({ data: { productCode: 'NOTHING', unit: 'box' } });

      const response = await call('GET', '/staff/stock');
      expect(response.status).toBe(200);
      const parsed = stockOverviewResponseSchema.parse(response.body);
      expect(parsed.items.map((i) => i.productCode)).toEqual(['APPLE', 'SHEET-1', 'STOCK-ONLY']);
      const byCode = Object.fromEntries(parsed.items.map((i) => [i.productCode, i]));
      expect(byCode.APPLE).toMatchObject({
        isPriced: true,
        stockQuantity: '0.000',
        deliveryCount: 1,
        unit: 'PIECE',
      });
      expect(byCode['SHEET-1']).toMatchObject({
        isPriced: false,
        stockQuantity: '501.000',
        deliveryCount: 2,
        unit: 'PIECE',
        category: 'Смартфоны',
      });
      expect(byCode['STOCK-ONLY']).toMatchObject({
        stockQuantity: '7.000',
        deliveryCount: 0,
        latestDelivery: null,
        suppliers: [],
      });
      // The distinct suppliers of the live lines (the staff supplier filter, 2026-11-13).
      expect(byCode['SHEET-1']?.suppliers).toEqual(['alpha trade import']);
      expect(byCode['SHEET-1']?.latestDelivery?.deliveredAt).toBe('2026-10-11T04:15:00.000Z');
    });

    it('gives the primary photo URLs on stock, unpriced and staff price list rows', async () => {
      const apple = await pricedApple();
      await sync([
        fixtureLine('APPLE', 'R-1', '10.10.2026'),
        fixtureLine('SHEET-1', 'R-2', '10.10.2026'),
        fixtureLine('SHEET-2', 'R-3', '10.10.2026'),
      ]);
      await publish([apple]);
      const sheet1 = await productByCode('SHEET-1');
      const sheet2 = await productByCode('SHEET-2');
      const photo = (productId: string, isPrimary: boolean, removed = false) =>
        t.prisma.productImage.create({
          data: {
            productId,
            isPrimary,
            sha256: createHash('sha256').update(`${productId}${isPrimary}${removed}`).digest('hex'),
            originalContentType: 'image/jpeg',
            width: 400,
            height: 300,
            byteSize: 1000,
            uploadedBy: MANAGER.userId,
            createdAt: new Date(),
            removedAt: removed ? new Date() : null,
            removedBy: removed ? MANAGER.userId : null,
          },
        });
      const applePhoto = await photo(apple, true);
      await photo(apple, false);
      const sheetPhoto = await photo(sheet1.id, true);
      // A removed photo (no longer primary) and a live non-primary one give no row photo: removal
      // never promotes another photo.
      await photo(sheet2.id, false, true);
      await photo(sheet2.id, false);

      const urls = (id: string) => ({
        imageUrl: `/api/media/product-images/${id}/thumb`,
        imageLargeUrl: `/api/media/product-images/${id}/large`,
      });
      const none = { imageUrl: null, imageLargeUrl: null };

      const stock = stockOverviewResponseSchema.parse((await call('GET', '/staff/stock')).body);
      const byCode = Object.fromEntries(stock.items.map((i) => [i.productCode, i]));
      expect(byCode.APPLE).toMatchObject(urls(applePhoto.id));
      expect(byCode['SHEET-1']).toMatchObject(urls(sheetPhoto.id));
      expect(byCode['SHEET-2']).toMatchObject(none);

      const unpriced = unpricedProductsResponseSchema.parse(
        (await call('GET', '/staff/products/unpriced')).body,
      );
      expect(unpriced.items.map((i) => [i.productCode, i.imageUrl])).toEqual([
        ['SHEET-1', urls(sheetPhoto.id).imageUrl],
        ['SHEET-2', null],
      ]);

      const list = staffPriceListWithRateResponseSchema.parse(
        (await call('GET', '/staff/price-list/current')).body,
      );
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ productCode: 'APPLE', ...urls(applePhoto.id) });

      // The customer list carries the same two URLs (catalog photo grid), nothing else of a photo.
      for (const actor of [SHOP_OWNER, SELLER]) {
        const customer = await call('GET', '/price-list/current', actor);
        expect(customer.status).toBe(200);
        const parsed = customerPriceListResponseSchema.parse(customer.body);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0]).toMatchObject({ productCode: 'APPLE', ...urls(applePhoto.id) });
        for (const word of ['sha256', 'uploadedBy', 'sourceUrl', 'byteSize']) {
          expect(JSON.stringify(customer.body)).not.toContain(word);
        }
      }
    });

    it('filters by inStock, category and search', async () => {
      await sync([
        fixtureLine('IN-1', 'R-1', '10.10.2026', { category: 'Смартфоны' }),
        fixtureLine('OUT-1', 'R-2', '10.10.2026', {
          category: 'Смартфоны',
          availableQuantity: '0',
        }),
        fixtureLine('IN-2', 'R-3', '10.10.2026', { category: 'Планшеты' }),
      ]);
      const get = async (query: string) =>
        stockOverviewResponseSchema.parse((await call('GET', `/staff/stock${query}`)).body);
      expect((await get('?inStock=true')).items.map((i) => i.productCode)).toEqual([
        'IN-1',
        'IN-2',
      ]);
      expect((await get('?inStock=false')).items.map((i) => i.productCode)).toEqual(['OUT-1']);
      const tablets = await get(`?category=${encodeURIComponent('Планшеты')}`);
      expect(tablets.items.map((i) => i.productCode)).toEqual(['IN-2']);
      expect(tablets.categories).toEqual([
        { category: 'Планшеты', count: 1 },
        { category: 'Смартфоны', count: 2 },
      ]);
      expect((await get('?search=out')).items.map((i) => i.productCode)).toEqual(['OUT-1']);
      expect((await call('GET', '/staff/stock?inStock=maybe')).status).toBe(422);
    });

    it('sends a fixed number of SQL statements whatever the number of products', async () => {
      await sync([fixtureLine('SHEET-1', 'R-1', '10.10.2026')]);
      const small = await recordSql(t.prisma, async () => {
        expect((await call('GET', '/staff/stock')).status).toBe(200);
      });

      await sync(
        Array.from({ length: 60 }, (_, i) =>
          fixtureLine(`MANY-${String(i).padStart(3, '0')}`, `M-${i}`, '10.10.2026'),
        ),
      );
      let body: Body = {};
      const large = await recordSql(t.prisma, async () => {
        body = (await call('GET', '/staff/stock')).body;
      });
      expect(stockOverviewResponseSchema.parse(body).items).toHaveLength(61);
      expect(small.length).toBeGreaterThan(0);
      expect(large.length).toBe(small.length);
    });
  });

  describe('permissions', () => {
    const paths = ['/staff/products/unpriced', '/staff/stock'];

    it('401 without an actor on both endpoints', async () => {
      for (const path of paths) expect((await t.request('GET', path)).status, path).toBe(401);
    });

    it('200 for manager, accountant and admin; 403 for customers, warehouse and driver', async () => {
      for (const path of paths) {
        for (const actor of [MANAGER, ACCOUNTANT, ADMIN]) {
          expect((await call('GET', path, actor)).status, `${actor.userId} ${path}`).toBe(200);
        }
        for (const actor of [SHOP_OWNER, SELLER, WAREHOUSE, DRIVER]) {
          expect((await call('GET', path, actor)).status, `${actor.userId} ${path}`).toBe(403);
        }
      }
    });

    it('rejects unknown and invalid query parameters (strict)', async () => {
      expect((await call('GET', '/staff/products/unpriced?foo=1')).status).toBe(422);
      expect((await call('GET', '/staff/stock?foo=1')).status).toBe(422);
      expect((await call('GET', '/staff/products/unpriced?category=')).status).toBe(422);
    });

    it('registers /staff/products/unpriced before /staff/products/:id (a non-UUID id still answers 422)', async () => {
      expect((await call('GET', '/staff/products/unpriced')).status).toBe(200);
      expect((await call('GET', '/staff/products/not-a-uuid')).status).toBe(422);
    });
  });
});
