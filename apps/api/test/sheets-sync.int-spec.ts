import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/index.js';
import { CatalogModule, CatalogService } from '../src/modules/catalog/index.js';
import {
  PriceReferenceService,
  PricingModule,
  SupplyRemovalService,
  type CostDeliveryInput,
  type UpsertDeliveriesResult,
} from '../src/modules/pricing/index.js';
import { UnconfiguredDeliveryCostSource } from '../src/modules/sheets-sync/delivery-cost-source.js';
import {
  FakeDeliveryCostSource,
  FIXTURE_LINES,
  FIXTURE_RATE,
  fixtureLine,
  fixtureTable,
  type FixtureLine,
  MANY_PRODUCTS_REQUEST,
  NEGATIVE_AVAILABLE_LINE,
  rawCell,
  uzsFor,
} from '../src/modules/sheets-sync/fake-delivery-cost-source.js';
import { SheetFormatError } from '../src/modules/sheets-sync/sheet-columns.js';
import { SheetSyncRunRepository } from '../src/modules/sheets-sync/sheet-sync-run.repository.js';
import { SheetsSyncService } from '../src/modules/sheets-sync/sheets-sync.service.js';
import { SyncError } from '../src/modules/sheets-sync/sync-error.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import { createTestApp, MANAGER, type TestApp } from './support/test-app.js';

describe('sheet supplies sync with a fake source (real PostgreSQL)', () => {
  let t: TestApp;
  let source: FakeDeliveryCostSource;
  let service: SheetsSyncService;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    await resetCatalogPricingAudit(t.prisma);
    for (const productCode of ['10482', '10931']) {
      ids[productCode] = (await t.prisma.product.create({ data: { productCode, unit: 'box' } })).id;
    }
    source = new FakeDeliveryCostSource(fixtureTable(FIXTURE_LINES));
    service = new SheetsSyncService(
      source,
      t.get(CatalogService),
      t.get(PriceReferenceService),
      t.clock,
      t.get(SupplyRemovalService),
      new SheetSyncRunRepository(t.prisma),
    );
  });

  const refs = async (productCode: string): Promise<string[]> =>
    (
      await t.prisma.priceReference.findMany({
        where: { productId: ids[productCode] },
        orderBy: [{ deliveredAt: 'desc' }, { deliveryRef: 'desc' }],
      })
    ).map((r) => r.deliveryRef);

  const stockOf = async (productCode: string): Promise<string | null> =>
    (
      await t.prisma.stockCache.findUnique({ where: { productId: ids[productCode]! } })
    )?.quantity.toFixed(3) ?? null;

  const setLines = (lines: Parameters<typeof fixtureTable>[0]): void =>
    source.replaceTable(fixtureTable(lines));

  describe('basic behaviour', () => {
    it('stores the lines of the selected suppliers (three for 10482), skips the others, creates the product the sheet names', async () => {
      const report = await service.syncCostReference();
      expect(report).toMatchObject({
        rowsRead: 8,
        created: 6,
        updated: 0,
        unchanged: 0,
        rejected: [],
        staleRefs: [],
        createdProducts: ['99999'],
      });
      // Both unselected suppliers are listed, incl. the real near-miss spelling.
      expect(
        report.skippedBySupplierFilter.map((s) => [s.supplier, s.reason, s.count]).sort(),
      ).toEqual(
        [
          ['Some Other Supplier', 'SUPPLIER_NOT_SELECTED', 1],
          ['Склад Север BM Восток F114 ECO sistem', 'SUPPLIER_NOT_SELECTED', 1],
        ].sort(),
      );
      expect(await refs('10482')).toEqual(['REQ-027', 'REQ-014', 'REQ-001']);
      expect(await refs('10931')).toEqual(['REQ-021', 'REQ-020']); // equal timestamps: stable order
      await expect(t.prisma.priceReference.count()).resolves.toBe(6);
    });

    it('links a listed sheet category as marked, with history, and leaves decisions alone', async () => {
      const code = (i: number): string => FIXTURE_LINES[i]!.productCode;
      setLines([
        { ...FIXTURE_LINES[0]!, category: 'Роботы-пылесосы' },
        { ...FIXTURE_LINES[3]!, category: 'Смартфоны' },
      ]);
      await service.syncCostReference();

      const marked = await t.prisma.product.findFirstOrThrow({
        where: { productCode: code(0) },
        include: { productCategory: true },
      });
      expect(marked.markingRequired).toBe(true);
      expect(marked.trackingType).toBe('NONE');
      expect(marked.productCategory?.name).toBe('Роботы-пылесосы');
      expect(marked.productCategory?.markingRequiredDefault).toBe(true);
      const other = await t.prisma.product.findFirstOrThrow({ where: { productCode: code(3) } });
      expect(other.markingRequired).toBe(false);
      expect(other.categoryId).toBeNull();
      expect(
        await t.prisma.auditLog.count({
          where: { action: 'SHEET_SYNC_PRODUCT_CATEGORY_CREATED', actorUserId: null },
        }),
      ).toBe(1);
      expect(
        await t.prisma.auditLog.count({
          where: { action: 'SHEET_SYNC_PRODUCT_TRACKING_LINKED', entityId: marked.id },
        }),
      ).toBe(1);

      // A manager's later untick survives the next run, and the run adds no second category.
      await t.prisma.product.update({
        where: { id: marked.id },
        data: { markingRequired: false },
      });
      await service.syncCostReference();
      const again = await t.prisma.product.findUniqueOrThrow({ where: { id: marked.id } });
      expect(again.markingRequired).toBe(false);
      expect(await t.prisma.productCategory.count()).toBe(1);
    });

    it('stores supplier, purchase method and category, and reads sheet-style numbers exactly', async () => {
      setLines([
        fixtureLine('10482', 'REQ-1', '12.10.2026', {
          supplier: ' alpha  TRADE import ',
          purchaseMethod: 'Наличный  расчёт',
          category: 'Смартфоны',
          costUsd: '1234.5600',
          usdRateUsed: '12650.5000',
          costUzs: uzsFor('1234.5600', '12650.5000'),
          deliveredQuantity: '1000.5',
        }),
      ]);
      await service.syncCostReference();
      const row = await t.prisma.priceReference.findFirstOrThrow();
      expect(row).toMatchObject({
        supplier: 'alpha TRADE import', // whitespace collapsed, spelling kept
        purchaseMethod: 'Наличный расчёт',
        category: 'Смартфоны',
        deliveryRef: 'REQ-1',
      });
      expect(row.deliveredQuantity.toFixed(3)).toBe('1000.500');
      expect(row.costUsd?.toFixed(4)).toBe('1234.5600');
      expect(row.deliveredAt.toISOString()).toBe('2026-10-12T04:15:00.000Z'); // 12/10/2026 09:15:00 Tashkent
    });

    it('is idempotent: a second run changes and audits nothing', async () => {
      await service.syncCostReference();
      const audit = await t.prisma.auditLog.count();
      const before = await t.prisma.priceReference.findMany({ orderBy: { deliveryRef: 'asc' } });
      const stockBefore = await t.prisma.stockCache.findMany({ orderBy: { productId: 'asc' } });
      t.clock.set(new Date('2026-10-30T08:00:00Z'));
      const report = await service.syncCostReference();
      expect(report).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 6,
        stock: { created: 0, updated: 0, unchanged: 3 },
      });
      await expect(t.prisma.auditLog.count()).resolves.toBe(audit);
      await expect(
        t.prisma.priceReference.findMany({ orderBy: { deliveryRef: 'asc' } }),
      ).resolves.toEqual(before);
      await expect(
        t.prisma.stockCache.findMany({ orderBy: { productId: 'asc' } }),
      ).resolves.toEqual(stockBefore);
    });

    it('every sync audit row is a system action: null actor, SHEET_SYNC_* action', async () => {
      await service.syncCostReference();
      const rows = await t.prisma.auditLog.findMany();
      // six lines, three stock aggregates, one created product, three category changes
      expect(rows).toHaveLength(6 + 3 + 1 + 3);
      expect(new Set(rows.map((r) => r.actorUserId))).toEqual(new Set([null]));
      expect(new Set(rows.map((r) => r.action))).toEqual(
        new Set([
          'SHEET_SYNC_CREATED',
          'SHEET_SYNC_STOCK_CREATED',
          'SHEET_SYNC_PRODUCT_CREATED',
          'SHEET_SYNC_PRODUCT_CATEGORY_CHANGED',
        ]),
      );
      const created = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_CREATED' },
      });
      expect(Object.keys(created.diff as object)).toEqual(
        expect.arrayContaining(['supplier', 'purchaseMethod', 'category', 'availableQuantity']),
      );
    });

    it('a changed sheet value updates the line with before AND after (supplier included)', async () => {
      await service.syncCostReference();
      t.clock.set(new Date('2026-10-30T08:00:00Z'));
      setLines(
        FIXTURE_LINES.map((l) =>
          l.deliveryRef === 'REQ-027'
            ? {
                ...l,
                availableQuantity: '120.000',
                costUzs: '165000.00',
                supplier: 'Alpha Trade Import',
                category: 'Планшеты',
              }
            : l,
        ),
      );
      const report = await service.syncCostReference();
      expect(report).toMatchObject({ created: 0, updated: 1, unchanged: 5 });
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_UPDATED' },
      });
      expect(row.actorUserId).toBeNull();
      expect(row.diff).toEqual({
        supplier: { from: 'alpha trade import', to: 'Alpha Trade Import' },
        category: { from: 'Смартфоны', to: 'Планшеты' },
        availableQuantity: { from: '300.000', to: '120.000' },
        costUzs: { from: uzsFor('13.1000', FIXTURE_RATE), to: '165000.00' },
      });
    });

    it('rejects malformed rows with a report (sheet header paths only) and still syncs the good ones', async () => {
      setLines([
        FIXTURE_LINES[2]!, // good
        { ...FIXTURE_LINES[3]!, costUsd: '12,34567' }, // too many digits
        { ...FIXTURE_LINES[4]!, availableQuantity: '-1' },
        { ...FIXTURE_LINES[4]!, deliveryRef: 'X', deliveredAt: '2026-10-12' }, // wrong date format
        { ...FIXTURE_LINES[4]!, deliveryRef: 'Y', category: '' },
      ]);
      const report = await service.syncCostReference();
      expect(report).toMatchObject({ rowsRead: 5, created: 1 });
      expect(report.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
      expect(report.rejected.map((r) => r.issues[0]?.path)).toEqual([
        'Цена закупа $',
        'Доступное кол-во',
        'Дата',
        'Категория',
      ]);
      expect(JSON.stringify(report.rejected)).not.toContain('12,34567');
      await expect(t.prisma.priceReference.count()).resolves.toBe(1);
    });

    it('stores a line whose three cost cells are empty with null costs, counts its stock, and fills the costs in later', async () => {
      // Staging 2026-11-06: delivery 7347 arrived with quantities only; its costs were typed later.
      const pending = { costUsd: '', usdRateUsed: '', costUzs: '' };
      setLines([
        fixtureLine('10482', 'REQ-P', '19.10.2026', { availableQuantity: '540', ...pending }),
        fixtureLine('10931', 'REQ-Q', '19.10.2026', { costUsd: '', usdRateUsed: '' }), // broken
      ]);
      const first = await service.syncCostReference();
      expect(first).toMatchObject({ created: 1, mismatches: [] });
      expect(first.rejected.map((r) => r.issues.map((i) => [i.path, i.message]))).toEqual([
        [
          ['Цена закупа $', 'Cost cells must be all filled or all empty'],
          ['Курс на день поставки', 'Cost cells must be all filled or all empty'],
        ],
      ]);
      const stored = await t.prisma.priceReference.findFirstOrThrow({
        where: { deliveryRef: 'REQ-P' },
      });
      expect(stored).toMatchObject({ costUsd: null, usdRateUsed: null, costUzs: null });
      expect(stored.availableQuantity.toFixed(3)).toBe('540.000');
      await expect(stockOf('10482')).resolves.toBe('540.000');

      // The costs typed into the sheet later update the same line, audited from null.
      setLines([fixtureLine('10482', 'REQ-P', '19.10.2026', { availableQuantity: '540' })]);
      const second = await service.syncCostReference();
      expect(second).toMatchObject({ created: 0, updated: 1, mismatches: [] });
      const filled = await t.prisma.priceReference.findFirstOrThrow({
        where: { deliveryRef: 'REQ-P' },
      });
      expect(filled.costUsd?.toFixed(4)).toBe('12.3400');
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { entityId: filled.id, action: 'SHEET_SYNC_UPDATED' },
      });
      expect(audit.diff).toMatchObject({ costUsd: { from: null, to: '12.3400' } });
      await expect(stockOf('10482')).resolves.toBe('540.000');
    });

    it('rejects a repeated product code + delivery within one read (first wins), whatever the code case', async () => {
      setLines([
        FIXTURE_LINES[2]!,
        { ...FIXTURE_LINES[2]!, productCode: ' 10482 ', costUsd: '99' },
      ]);
      const report = await service.syncCostReference();
      expect(report.created).toBe(1);
      expect(report.rejected).toEqual([
        {
          index: 1,
          issues: [
            { path: 'deliveryRef', message: 'Duplicate productCode and deliveryRef in one read' },
          ],
          productCode: '10482',
          deliveryRef: FIXTURE_LINES[2]!.deliveryRef,
        },
      ]);
      expect((await t.prisma.priceReference.findFirstOrThrow()).costUsd?.toFixed(4)).toBe(
        '13.1000',
      );
    });

    it('matches a sheet product code in any letter case, reported with the product spelling', async () => {
      const honor = await t.prisma.product.create({
        data: { productCode: 'HONOR-X7C-6GB128GB-MidnightBlack', unit: 'box' },
      });
      setLines([
        fixtureLine('honor-x7c-6gb128gb-midnightblack', 'REQ-1', '01.10.2026'),
        fixtureLine(' HONOR-X7C-6GB128GB-MIDNIGHTBLACK ', 'REQ-2', '02.10.2026', {
          costUzs: '999999.00',
        }),
        fixtureLine('Unknown-Phone', 'REQ-3', '03.10.2026', { productName: 'Phone' }),
        fixtureLine('Honor X7C', 'REQ-4', '04.10.2026'),
      ]);
      const report = await service.syncCostReference();
      expect(report).toMatchObject({ created: 3, rejected: [{ index: 3 }] });
      expect(report.createdProducts).toEqual(['Unknown-Phone']);
      expect(report.mismatches.map((m) => m.productCode)).toEqual([
        'HONOR-X7C-6GB128GB-MidnightBlack',
      ]);
      await expect(t.prisma.priceReference.count({ where: { productId: honor.id } })).resolves.toBe(
        2,
      );
    });

    it('creates one product per code, whatever the letter case, keeping the first spelling and name', async () => {
      setLines([
        fixtureLine('abc-1', 'R-1', '01.10.2026', { productName: 'First name' }),
        fixtureLine('ABC-1', 'R-2', '02.10.2026', { productName: 'Second name' }),
        fixtureLine(' Abc-1 ', 'R-3', '03.10.2026'),
        fixtureLine('other-2', 'R-4', '04.10.2026'),
      ]);
      const report = await service.syncCostReference();
      expect(report.createdProducts).toEqual(['abc-1', 'other-2']);
      expect(report.created).toBe(4);
      const abc = await t.prisma.product.findUniqueOrThrow({
        where: { productCode: 'abc-1' },
        include: { translations: true },
      });
      expect(abc.translations).toEqual([
        expect.objectContaining({ lang: 'RU', name: 'First name' }),
      ]);
      await expect(t.prisma.priceReference.count({ where: { productId: abc.id } })).resolves.toBe(
        3,
      );
    });

    it('rejects delivery dates outside the plausibility window (typo years, far future), by the Clock', async () => {
      setLines([
        fixtureLine('10482', 'A', '01.10.2062'),
        fixtureLine('10482', 'B', '01.01.0200'),
        fixtureLine('10482', 'C', '22.10.2026'), // now + 2 days: accepted
        fixtureLine('10482', 'D', '23.10.2026'), // now + 3 days: rejected
      ]);
      const report = await service.syncCostReference();
      expect(report.rejected.map((r) => [r.index, r.issues[0]?.path])).toEqual([
        [0, 'Дата'],
        [1, 'Дата'],
        [3, 'Дата'],
      ]);
      expect(await refs('10482')).toEqual(['C']);
      // A typo'd future date can therefore never become the "latest" delivery.
      t.clock.set(new Date('2062-10-02T00:00:00Z'));
      const later = await service.syncCostReference();
      expect(later.rejected.map((r) => r.index)).toEqual([1]); // 2062 is now plausible, 0200 is not
    });

    it('reads the real en-US number shapes exactly, and rejects comma-decimals and misplaced grouping', async () => {
      setLines([
        // Real shapes: rate 12,650 is twelve thousand six hundred fifty; costs with thousands commas.
        fixtureLine('10482', 'A', '20/10/2026 09:15:00', {
          usdRateUsed: rawCell('12,650') as never,
          costUsd: rawCell('123.45') as never,
          costUzs: rawCell('1,561,542.5') as never,
          availableQuantity: rawCell('1,500') as never, // fifteen hundred, not 1.5
          deliveredQuantity: rawCell('35') as never,
        }),
        fixtureLine('10482', 'B', '20/10/2026 09:15:00', {
          usdRateUsed: rawCell('12,65') as never,
        }),
        fixtureLine('10482', 'C', '20/10/2026 09:15:00', {
          availableQuantity: rawCell('1,6900') as never,
        }),
        fixtureLine('10482', 'D', '20/10/2026 09:15:00', { costUsd: rawCell('12,5') as never }), // comma decimal
        fixtureLine('10482', 'E', '20/10/2026 09:15:00', {
          costUzs: rawCell('1 690 000') as never,
        }), // spaces
      ]);
      const report = await service.syncCostReference();
      expect(report.rejected.map((r) => [r.index, r.issues[0]?.path])).toEqual([
        [1, 'Курс на день поставки'],
        [2, 'Доступное кол-во'],
        [3, 'Цена закупа $'],
        [4, 'Цена закупа сумм'],
      ]);
      expect(await refs('10482')).toEqual(['A']);
      const stored = await t.prisma.priceReference.findFirstOrThrow({
        where: { deliveryRef: 'A' },
      });
      expect(stored.usdRateUsed?.toFixed(4)).toBe('12650.0000');
      expect(stored.availableQuantity.toFixed(3)).toBe('1500.000');
      expect(stored.costUzs?.toFixed(2)).toBe('1561542.50');
      expect(await stockOf('10482')).toBe('1500.000');
    });

    it('a negative available quantity (the real sheet has such a row) is a row error by header path, never stored', async () => {
      setLines([NEGATIVE_AVAILABLE_LINE, fixtureLine('10482', 'REQ-778', '20/10/2026 09:15:00')]);
      const report = await service.syncCostReference();
      expect(report.rejected.map((r) => [r.index, r.issues[0]?.path])).toEqual([
        [0, 'Доступное кол-во'],
      ]);
      expect(await refs('10482')).toEqual(['REQ-778']);
    });

    it('reads a request that contains many products (one request id, six products)', async () => {
      const codes = MANY_PRODUCTS_REQUEST.map((l) => l.productCode);
      await t.prisma.product.createMany({
        data: codes.map((productCode) => ({ productCode, unit: 'box' })),
      });
      setLines(MANY_PRODUCTS_REQUEST);
      const report = await service.syncCostReference();
      expect(report).toMatchObject({ created: 6, rejected: [], createdProducts: [] });
      await expect(
        t.prisma.priceReference.count({ where: { deliveryRef: 'REQ-100' } }),
      ).resolves.toBe(6);
      await expect(
        t.prisma.stockCache.count({ where: { product: { productCode: { in: codes } } } }),
      ).resolves.toBe(6);
    });

    it('stores the real timestamp format as the exact Tashkent instant (seconds included)', async () => {
      setLines([fixtureLine('10482', 'T-1', '20/10/2026 09:15:42')]);
      await service.syncCostReference();
      const row = await t.prisma.priceReference.findFirstOrThrow({ where: { deliveryRef: 'T-1' } });
      expect(row.deliveredAt.toISOString()).toBe('2026-10-20T04:15:42.000Z');
    });

    it('creates the product of an unknown code: active, RU name, no unit, no price, category, system audit', async () => {
      await service.syncCostReference();
      await expect(t.prisma.product.count()).resolves.toBe(3);
      const created = await t.prisma.product.findUniqueOrThrow({
        where: { productCode: '99999' },
        include: { translations: true },
      });
      expect(created).toMatchObject({ isActive: true, unit: 'PIECE', category: 'Смартфоны' });
      expect(created.translations).toEqual([
        expect.objectContaining({ lang: 'RU', name: 'Неизвестный товар', description: null }),
      ]);
      await expect(t.prisma.priceListItem.count()).resolves.toBe(0);
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_PRODUCT_CREATED', entityId: created.id },
      });
      expect(audit.actorUserId).toBeNull();
      expect(audit.diff).toMatchObject({
        productCode: { from: null, to: '99999' },
        'translations.RU.name': { from: null, to: 'Неизвестный товар' },
      });
    });

    it('is idempotent: a second run creates nothing and audits nothing new', async () => {
      await service.syncCostReference();
      const before = await t.prisma.auditLog.count();
      const again = await service.syncCostReference();
      expect(again.createdProducts).toEqual([]);
      await expect(t.prisma.product.count()).resolves.toBe(3);
      await expect(t.prisma.auditLog.count()).resolves.toBe(before);
    });

    it('an unconfigured source fails loudly instead of syncing nothing', async () => {
      const unconfigured = new SheetsSyncService(
        new UnconfiguredDeliveryCostSource(),
        t.get(CatalogService),
        t.get(PriceReferenceService),
        t.clock,
        t.get(SupplyRemovalService),
        new SheetSyncRunRepository(t.prisma),
      );
      await expect(unconfigured.syncCostReference()).rejects.toThrow(/No delivery cost source/);
    });

    it('syncing does not change selling prices or create price list data', async () => {
      await service.syncCostReference();
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(0);
      await expect(t.prisma.priceListItem.count()).resolves.toBe(0);
      const r = await t.request('GET', `/staff/products/${ids['10482']}/cost-reference`, {
        actor: MANAGER,
      });
      expect((r.body as { latest: { deliveryRef: string } }).latest.deliveryRef).toBe('REQ-027');
    });
  });

  describe('missing columns', () => {
    it('fail the WHOLE read with a typed error naming the headers; nothing is stored', async () => {
      source.replaceTable(
        fixtureTable(FIXTURE_LINES, { omitFields: ['costUsd', 'availableQuantity'] }),
      );
      const failure = await service.syncCostReference().then(
        () => null,
        (error: unknown) => error as SheetFormatError,
      );
      expect(failure).toBeInstanceOf(SheetFormatError);
      expect(failure?.missingHeaders).toEqual(['Цена закупа $', 'Доступное кол-во']);
      expect(failure?.message).toMatch(/Missing required columns: .*Цена закупа \$/);
      await expect(t.prisma.priceReference.count()).resolves.toBe(0);
      await expect(t.prisma.stockCache.count()).resolves.toBe(0);
    });

    it('extra columns are ignored: their contents never reach storage, audit or the report', async () => {
      const report = await service.syncCostReference();
      const everything = JSON.stringify([
        report,
        await t.prisma.priceReference.findMany(),
        await t.prisma.auditLog.findMany(),
      ]);
      expect(everything).not.toContain('must never be read');
    });
  });

  describe('supplier filter', () => {
    it('Beta system tm fbs: every date is stored, any casing', async () => {
      setLines([
        fixtureLine('10482', 'A', '27.12.2025', { supplier: 'Beta system tm fbs' }),
        fixtureLine('10482', 'B', '31/08/2026 23:59:59', { supplier: 'Beta system tm fbs' }),
        fixtureLine('10482', 'C', '15.10.2026', { supplier: 'BETA SYSTEM TM FBS' }),
        fixtureLine('10482', 'D', '01.08.2020', { supplier: 'alpha trade import' }),
      ]);
      const report = await service.syncCostReference();
      expect(report).toMatchObject({ rowsRead: 4, created: 4, rejected: [] });
      expect(report.skippedBySupplierFilter).toEqual([]);
      expect((await refs('10482')).sort()).toEqual(['A', 'B', 'C', 'D']);
    });

    it('partial supplier names are skipped without validation noise', async () => {
      setLines([
        fixtureLine('10482', 'A', '12.10.2026', { supplier: 'alpha trade import 2' }),
        // Garbage everywhere, but not a selected supplier: skipped, not rejected.
        { ...fixtureLine('10482', 'B', 'garbage'), supplier: 'someone else', costUsd: 'x' },
        fixtureLine('10482', 'C', '12.10.2026'),
      ]);
      const report = await service.syncCostReference();
      expect(report).toMatchObject({ created: 1, rejected: [] });
      expect(report.skippedBySupplierFilter.map((s) => [s.supplier, s.count])).toEqual([
        ['alpha trade import 2', 1],
        ['someone else', 1],
      ]);
    });

    it('a selected supplier with an unparsable date is REJECTED, not skipped, not stored', async () => {
      setLines([
        fixtureLine('10482', 'A', '1 September', { supplier: 'Beta system tm fbs' }),
        fixtureLine('10482', 'B', '', { supplier: 'alpha trade import' }),
      ]);
      const report = await service.syncCostReference();
      expect(report.skippedBySupplierFilter).toEqual([]);
      expect(report.rejected.map((r) => r.issues[0]?.path)).toEqual(['Дата', 'Дата']);
      await expect(t.prisma.priceReference.count()).resolves.toBe(0);
    });

    it('supplier typos are visible: each look-alike shows up as its own report entry, nothing is stored', async () => {
      const typos = [
        'alpha trade import.', // trailing dot
        'alpha trade\u200b import', // zero-width space
        '\u0435\u0441\u043e xiaomi import', // Cyrillic е с о
        '\uff45\uff43\uff4f xiaomi import', // fullwidth e c o
        'eco-xiaomi-import',
      ];
      setLines(
        typos.map((supplier, i) => fixtureLine('10482', `T-${i}`, '12.10.2026', { supplier })),
      );
      const report = await service.syncCostReference();
      expect(report.skippedBySupplierFilter).toHaveLength(5);
      expect(new Set(report.skippedBySupplierFilter.map((s) => s.supplier)).size).toBe(5);
      for (const typo of typos) {
        expect(report.skippedBySupplierFilter.map((s) => s.supplier)).toContain(typo);
      }
      expect(report.skippedBySupplierFilter.every((s) => s.count === 1)).toBe(true);
      expect(
        report.skippedBySupplierFilter.every((s) => s.reason === 'SUPPLIER_NOT_SELECTED'),
      ).toBe(true);
      const zeroWidth = report.skippedBySupplierFilter.find((s) => s.supplier.includes('\u200b'));
      expect(zeroWidth?.hasInvisibleCharacters).toBe(true);
      expect(report.skippedBySupplierFilter.filter((s) => s.hasInvisibleCharacters)).toHaveLength(
        1,
      );
      expect(report.created).toBe(0);
      await expect(t.prisma.priceReference.count()).resolves.toBe(0);
    });

    it('skipped suppliers are counted per distinct normalized value (case merged, whitespace collapsed)', async () => {
      setLines([
        fixtureLine('10482', 'A', '12.10.2026', { supplier: 'Foo  Trading' }),
        fixtureLine('10482', 'B', '12.10.2026', { supplier: 'foo trading' }),
        fixtureLine('10482', 'C', '12.10.2026', { supplier: ' Foo Trading ' }),
        fixtureLine('10482', 'D', '12.10.2026', { supplier: 'Bar' }),
        fixtureLine('10482', 'E', '12.10.2026', {
          supplier: 'Beta system tm fbs',
          deliveredAt: '31/08/2026 23:59:59',
        }),
      ]);
      const report = await service.syncCostReference();
      expect(report.skippedBySupplierFilter).toEqual([
        {
          supplier: 'Foo Trading',
          reason: 'SUPPLIER_NOT_SELECTED',
          count: 3,
          hasInvisibleCharacters: false,
        },
        {
          supplier: 'Bar',
          reason: 'SUPPLIER_NOT_SELECTED',
          count: 1,
          hasInvisibleCharacters: false,
        },
      ]);
    });

    describe('a row with UZS cost but no USD cost and no rate', () => {
      const blankCost = { costUsd: rawCell(''), usdRateUsed: rawCell('') };
      const rateRow = (): FixtureLine =>
        fixtureLine('20001', 'RATE', '25/09/2026 12:00:00', {
          supplier: 'Some Other Supplier',
          usdRateUsed: '12000',
        });

      it('stores USD = UZS / the nearest rate in the sheet, any supplier row, and reports it', async () => {
        source.replaceTable(
          fixtureTable([
            // Never stored: this row only lends its rate.
            rateRow(),
            {
              ...fixtureLine('10482', '7265', '25/09/2026 13:09:12', {
                supplier: 'Beta system tm fbs',
                costUzs: '1185000',
              }),
              ...blankCost,
            },
          ]),
        );
        const report = await service.syncCostReference();
        expect(report).toMatchObject({ created: 1, rejected: [], mismatches: [] });
        expect(report.derivedUsdCosts).toEqual([{ productCode: '10482', deliveryRef: '7265' }]);
        const row = await t.prisma.priceReference.findFirstOrThrow({
          where: { deliveryRef: '7265' },
        });
        expect(row.costUsd?.toFixed(4)).toBe('98.7500');
        expect(row.usdRateUsed?.toFixed(4)).toBe('12000.0000');
        expect(row.costUzs?.toFixed(2)).toBe('1185000.00');
        expect(await stockOf('10482')).toBe('250.500');
        await expect(
          t.prisma.priceReference.count({ where: { deliveryRef: 'RATE' } }),
        ).resolves.toBe(0);
      });

      it('a second read of the same sheet changes nothing; real values written later replace the derived ones', async () => {
        const line = fixtureLine('10482', '7265', '25/09/2026 13:09:12', { costUzs: '1185000' });
        source.replaceTable(fixtureTable([rateRow(), { ...line, ...blankCost }]));
        await service.syncCostReference();

        await expect(service.syncCostReference()).resolves.toMatchObject({
          created: 0,
          updated: 0,
          unchanged: 1,
        });

        source.replaceTable(
          fixtureTable([rateRow(), { ...line, costUsd: '100', usdRateUsed: '11850' }]),
        );
        const report = await service.syncCostReference();
        expect(report).toMatchObject({ updated: 1, derivedUsdCosts: [] });
        const row = await t.prisma.priceReference.findFirstOrThrow({
          where: { deliveryRef: '7265' },
        });
        expect(row.costUsd?.toFixed(4)).toBe('100.0000');
        expect(row.usdRateUsed?.toFixed(4)).toBe('11850.0000');
      });

      it('no rate anywhere in the sheet: still REJECTED; no UZS cost either: stored as cost pending', async () => {
        source.replaceTable(
          fixtureTable([
            { ...fixtureLine('10482', 'A', '25.09.2026', { costUzs: '1185000' }), ...blankCost },
          ]),
        );
        const noRate = await service.syncCostReference();
        expect(noRate.rejected.map((r) => r.issues.map((i) => i.path))).toEqual([
          ['Цена закупа $', 'Курс на день поставки'],
        ]);

        source.replaceTable(
          fixtureTable([
            fixtureLine('20001', 'RATE', '25.09.2026', { supplier: 'Some Other Supplier' }),
            { ...fixtureLine('10482', 'A', '25.09.2026'), costUzs: rawCell(''), ...blankCost },
          ]),
        );
        // All three cost cells empty is not a broken row but a cost-pending line (2026-11-06):
        // nothing to derive, stored with null costs, its stock counts.
        const noUzs = await service.syncCostReference();
        expect(noUzs.rejected).toEqual([]);
        expect(noUzs.derivedUsdCosts).toEqual([]);
        const pending = await t.prisma.priceReference.findFirstOrThrow({
          where: { deliveryRef: 'A' },
        });
        expect(pending).toMatchObject({ costUsd: null, usdRateUsed: null, costUzs: null });
        await expect(stockOf('10482')).resolves.toBe('250.500');
      });
    });

    it('lines of unselected suppliers are never stored, not even as audit or report content', async () => {
      const report = await service.syncCostReference();
      expect(await t.prisma.priceReference.count({ where: { deliveryRef: 'REQ-500' } })).toBe(0);
      // The report MAY name unselected suppliers (staff-only; that is how typos become visible) but
      // they are never stored anywhere.
      const stored = JSON.stringify([
        await t.prisma.priceReference.findMany(),
        await t.prisma.auditLog.findMany(),
      ]);
      expect(stored).not.toContain('Some Other Supplier');
      expect(report.skippedBySupplierFilter.map((s) => s.supplier)).toContain(
        'Some Other Supplier',
      );
    });
  });

  describe('stock aggregate (stock_cache)', () => {
    it('sums the available quantity over ALL delivery lines of a product', async () => {
      await service.syncCostReference();
      expect(await stockOf('10482')).toBe('312.000'); // 0 + 12 + 300
      expect(await stockOf('10931')).toBe('501.000'); // 250.5 + 250.5
      const audit = await t.prisma.auditLog.findMany({ where: { entityType: 'STOCK_CACHE' } });
      expect(audit).toHaveLength(3); // 10482, 10931 and the product created from the sheet
      expect(audit.every((a) => a.actorUserId === null)).toBe(true);
      expect(audit.find((a) => a.entityId === ids['10482'])?.diff).toEqual({
        quantity: { from: null, to: '312.000' },
      });
    });

    it('follows availability changes with before AND after in the history', async () => {
      await service.syncCostReference();
      setLines(
        FIXTURE_LINES.map((l) =>
          l.deliveryRef === 'REQ-014' ? { ...l, availableQuantity: '0.000' } : l,
        ),
      );
      const report = await service.syncCostReference();
      expect(report.stock).toEqual({ created: 0, updated: 1, unchanged: 2 });
      expect(await stockOf('10482')).toBe('300.000');
      expect(await stockOf('10931')).toBe('501.000');
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_STOCK_UPDATED' },
      });
      expect(row).toMatchObject({ actorUserId: null, entityId: ids['10482'] });
      expect(row.diff).toEqual({ quantity: { from: '312.000', to: '300.000' } });
    });

    it('products whose lines are not in this read keep their aggregate (only touched products are recomputed)', async () => {
      await service.syncCostReference();
      const untouched = await t.prisma.product.create({
        data: { productCode: '20001', unit: 'box' },
      });
      await t.prisma.stockCache.create({
        data: {
          productId: untouched.id,
          quantity: '77.000',
          syncedAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      // 20001's lines belong to an unselected supplier (skipped); a re-sync must leave it alone.
      await service.syncCostReference();
      const row = await t.prisma.stockCache.findUniqueOrThrow({
        where: { productId: untouched.id },
      });
      expect(row.quantity.toFixed(3)).toBe('77.000');
      expect(row.syncedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('counts stored lines the current read no longer lists (nothing is deleted, so stock stays)', async () => {
      await service.syncCostReference();
      setLines(FIXTURE_LINES.filter((l) => l.deliveryRef !== 'REQ-027'));
      const report = await service.syncCostReference();
      expect(report.staleRefs).toEqual([{ productCode: '10482', deliveryRef: 'REQ-027' }]);
      expect(await stockOf('10482')).toBe('312.000');
    });

    it('carries no cost, supplier or any delivery column', async () => {
      await service.syncCostReference();
      const columns = await t.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_cache' ORDER BY 1`;
      expect(columns.map((c) => c.column_name)).toEqual(['product_id', 'quantity', 'synced_at']);
    });

    it('rejects a negative aggregate at the database level', async () => {
      await expect(
        t.prisma.stockCache.create({
          data: { productId: ids['10482']!, quantity: '-1.000', syncedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('is not exposed to customers (no customer response mentions stock)', async () => {
      await service.syncCostReference();
      const draft = (
        await t.request('POST', '/staff/price-list/drafts', { actor: MANAGER, body: {} })
      ).body as { id: string };
      await t.request('PUT', `/staff/price-list/drafts/${draft.id}/items`, {
        actor: MANAGER,
        body: { items: [{ productId: ids['10482'], basePrice: '190000.00' }] },
      });
      await t.request('POST', `/staff/price-list/drafts/${draft.id}/publish`, { actor: MANAGER });
      const customer = await t.request('GET', '/price-list/current', {
        actor: {
          userId: 'u',
          staffRoles: [],
          membership: { organizationId: 'o', role: 'SHOP_OWNER' },
        },
      });
      expect(JSON.stringify(customer.body).toLowerCase()).not.toContain('stock');
      expect(JSON.stringify(customer.body)).not.toContain('312.000');
    });
  });

  describe('UZS cost consistency (reported, never rejected)', () => {
    it('reports the deliberately inconsistent fixture line, with a percentage and no cost values', async () => {
      const report = await service.syncCostReference();
      expect(report.mismatches).toEqual([
        {
          productCode: '10931',
          deliveryRef: 'REQ-021',
          differencePercent: expect.stringMatching(/^\d+\.\d{2}$/),
        },
      ]);
      const stored = await t.prisma.priceReference.findFirstOrThrow({
        where: { deliveryRef: 'REQ-021' },
      });
      expect(stored.costUzs?.toFixed(2)).toBe('999999.00');
      const text = JSON.stringify(report.mismatches);
      for (const secret of ['999999', '12650', '12.3456']) expect(text).not.toContain(secret);
    });

    it('a line within tolerance is consistent; just outside is a mismatch', async () => {
      const exact = uzsFor('10.0000', FIXTURE_RATE);
      const within = new Prisma.Decimal(exact).mul('1.004').toFixed(2);
      const outside = new Prisma.Decimal(exact).mul('1.006').toFixed(2);
      setLines([
        fixtureLine('10482', 'A', '01.10.2026', { costUsd: '10.0000', costUzs: within }),
        fixtureLine('10482', 'B', '02.10.2026', { costUsd: '10.0000', costUzs: outside }),
        fixtureLine('10482', 'C', '03.10.2026', { costUsd: '10.0000', costUzs: exact }),
      ]);
      const report = await service.syncCostReference();
      expect(report.created).toBe(3);
      expect(report.mismatches).toEqual([
        { productCode: '10482', deliveryRef: 'B', differencePercent: '0.60' },
      ]);
    });
  });

  describe('stale deliveries (reported, never deleted or flagged)', () => {
    it('reports stored deliveries of the read product codes that are absent from the read', async () => {
      await service.syncCostReference();
      setLines(FIXTURE_LINES.filter((l) => l.deliveryRef !== 'REQ-014'));
      const before = await t.prisma.priceReference.findMany({ orderBy: { deliveryRef: 'asc' } });
      const report = await service.syncCostReference();
      expect(report.staleRefs).toEqual([{ productCode: '10482', deliveryRef: 'REQ-014' }]);
      expect(report).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
      await expect(
        t.prisma.priceReference.findMany({ orderBy: { deliveryRef: 'asc' } }),
      ).resolves.toEqual(before);
    });

    it('a rejected row is matched to stored deliveries with the same whitespace-collapsed key', async () => {
      setLines([fixtureLine('10482', 'A 1', '12.10.2026')]);
      await service.syncCostReference();
      // The same delivery, spelled with two spaces and with a broken cell: rejected, not stale.
      setLines([fixtureLine('10482', 'A  1', '12.10.2026', { costUsd: 'garbage' })]);
      const report = await service.syncCostReference();
      expect(report.rejected).toHaveLength(1);
      expect(report.staleRefs).toEqual([]);
    });

    it('a malformed row that names the delivery is not stale; other products are not reported', async () => {
      await service.syncCostReference();
      setLines(
        FIXTURE_LINES.filter((l) => l.productCode.trim().toLowerCase() === '10482').map((l) =>
          l.deliveryRef === 'REQ-014' ? { ...l, costUsd: 'garbage' } : l,
        ),
      );
      const report = await service.syncCostReference();
      expect(report.rejected).toHaveLength(1);
      expect(report.staleRefs).toEqual([]);
    });
  });

  describe('safe errors', () => {
    it('a database failure becomes a SyncError whose text contains no cost values', async () => {
      const real = t.get(PriceReferenceService);
      // Force a CHECK violation (rate must be positive) AFTER the source schema accepted the row.
      const forcing = {
        ...real,
        upsertDeliveries: (
          rows: readonly CostDeliveryInput[],
          after?: Parameters<PriceReferenceService['upsertDeliveries']>[1],
        ) =>
          real.upsertDeliveries(
            rows.map((r) => ({ ...r, usdRateUsed: new Prisma.Decimal('0') })),
            after,
          ),
        findStoredDeliveryRefs: real.findStoredDeliveryRefs.bind(real),
        availableTotals: real.availableTotals.bind(real),
      } as unknown as PriceReferenceService;
      const failing = new SheetsSyncService(
        source,
        t.get(CatalogService),
        forcing,
        t.clock,
        t.get(SupplyRemovalService),
        new SheetSyncRunRepository(t.prisma),
      );

      const error = await failing.syncCostReference().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(SyncError);
      const text = `${error?.message}\n${error?.stack}\n${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`;
      expect(error?.message).toMatch(/chunk 1 of 1/);
      expect('cause' in (error as object)).toBe(false);
      for (const secret of [
        '12.3456',
        '156190',
        '1000.000',
        '250.5',
        '12650',
        'Failing row',
        'alpha trade import',
        'Смартфоны',
      ]) {
        expect(text, `must not contain ${secret}`).not.toContain(secret);
      }
    });
  });

  describe('big syncs (chunked commits)', () => {
    /** 1,200 products and `count` lines spread over them. */
    async function bigService(count: number): Promise<SheetsSyncService> {
      await t.prisma.product.createMany({
        data: Array.from({ length: 1200 }, (_, i) => ({
          productCode: `BULK-${String(i).padStart(4, '0')}`,
          unit: 'box',
        })),
      });
      const big = new FakeDeliveryCostSource(
        fixtureTable(
          Array.from({ length: count }, (_, i) =>
            fixtureLine(
              `bulk-${String(i % 1200).padStart(4, '0')}`,
              `REQ-${String(i).padStart(5, '0')}`,
              '12.10.2026',
            ),
          ),
        ),
      );
      return new SheetsSyncService(
        big,
        t.get(CatalogService),
        t.get(PriceReferenceService),
        t.clock,
        t.get(SupplyRemovalService),
        new SheetSyncRunRepository(t.prisma),
      );
    }

    it('syncs 5,000 lines over 1,200 products with their stock aggregates, idempotently', async () => {
      const bigSync = await bigService(5000);
      const started = Date.now();
      const report = await bigSync.syncCostReference();
      expect(report).toMatchObject({
        rowsRead: 5000,
        created: 5000,
        updated: 0,
        unchanged: 0,
        rejected: [],
        staleRefs: [],
        mismatches: [],
      });
      expect(report.createdProducts).toEqual([]);
      await expect(t.prisma.priceReference.count()).resolves.toBe(5000);
      await expect(t.prisma.stockCache.count()).resolves.toBe(1200);
      expect(Date.now() - started).toBeLessThan(90_000);
      // Product 0 has lines 0, 1200, 2400, 3600, 4800 -> 5 x 250.5.
      const first = await t.prisma.product.findUniqueOrThrow({
        where: { productCode: 'BULK-0000' },
      });
      expect(
        (
          await t.prisma.stockCache.findUniqueOrThrow({ where: { productId: first.id } })
        ).quantity.toFixed(3),
      ).toBe('1252.500');

      const again = await bigSync.syncCostReference();
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 5000 });
      expect(again.stock.updated + again.stock.created).toBe(0);
    }, 180_000);

    it('a failing chunk leaves no partial chunk, stock included; earlier chunks stay; a re-run finishes', async () => {
      const bigSync = await bigService(1200); // chunks of 500, 500, 200
      const audit = t.get(AuditService);
      const original = audit.recordSystemMany.bind(audit);
      let calls = 0;
      // Per chunk: call 1 = delivery audit, call 2 = stock audit. Fail the STOCK audit of chunk 2.
      vi.spyOn(audit, 'recordSystemMany').mockImplementation((tx, entries) => {
        calls += 1;
        return calls === 4 ? Promise.reject(new Error('audit down')) : original(tx, entries);
      });

      const error = await bigSync.syncCostReference().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(SyncError);
      expect(error?.message).toMatch(/chunk 2 of 3 \(1 earlier chunk\(s\) were committed/);
      await expect(t.prisma.priceReference.count()).resolves.toBe(500);
      await expect(t.prisma.stockCache.count()).resolves.toBe(500);
      await expect(
        t.prisma.auditLog.count({ where: { action: 'SHEET_SYNC_CREATED' } }),
      ).resolves.toBe(500);
      await expect(
        t.prisma.auditLog.count({ where: { action: 'SHEET_SYNC_STOCK_CREATED' } }),
      ).resolves.toBe(500);

      vi.restoreAllMocks();
      const rerun = await bigSync.syncCostReference();
      expect(rerun).toMatchObject({ created: 700, unchanged: 500 });
      await expect(t.prisma.priceReference.count()).resolves.toBe(1200);
      await expect(t.prisma.stockCache.count()).resolves.toBe(1200);
    }, 180_000);

    it('two syncs at once serialize per chunk and end consistent', async () => {
      await bigService(1200); // creates the 1,200 products
      const make = (): SheetsSyncService => {
        // Same data, separate service instances.
        return new SheetsSyncService(
          new FakeDeliveryCostSource(
            fixtureTable(
              Array.from({ length: 1200 }, (_, i) =>
                fixtureLine(
                  `bulk-${String(i).padStart(4, '0')}`,
                  `REQ-${String(i).padStart(5, '0')}`,
                  '12.10.2026',
                ),
              ),
            ),
          ),
          t.get(CatalogService),
          t.get(PriceReferenceService),
          t.clock,
          t.get(SupplyRemovalService),
          new SheetSyncRunRepository(t.prisma),
        );
      };
      const [a, b] = await Promise.all([make().syncCostReference(), make().syncCostReference()]);
      const total = (
        r: Pick<UpsertDeliveriesResult, 'created' | 'updated' | 'unchanged'>,
      ): number => r.created + r.updated + r.unchanged;
      expect(a.created + b.created).toBe(1200);
      expect(a.updated + b.updated).toBe(0);
      expect(total(a)).toBe(1200);
      expect(total(b)).toBe(1200);
      await expect(t.prisma.priceReference.count()).resolves.toBe(1200);
      await expect(t.prisma.stockCache.count()).resolves.toBe(1200);
      await expect(
        t.prisma.auditLog.count({ where: { action: 'SHEET_SYNC_CREATED' } }),
      ).resolves.toBe(1200);
    }, 180_000);
  });

  describe('failure and report hygiene', () => {
    it('a failed audit insert rolls the whole chunk back (lines and stock) and surfaces a SyncError', async () => {
      vi.spyOn(t.get(AuditService), 'recordSystemMany').mockRejectedValue(new Error('audit down'));
      await expect(service.syncCostReference()).rejects.toThrow(SyncError);
      await expect(t.prisma.priceReference.count()).resolves.toBe(0);
      await expect(t.prisma.stockCache.count()).resolves.toBe(0);
    });

    it('the report never contains cost values or supplier names', async () => {
      const text = JSON.stringify(await service.syncCostReference());
      for (const secret of [
        '12.3456',
        '13.1000',
        '156190',
        '165721',
        '999999',
        '12650',
        'alpha trade import', // a selected supplier's name is not report content
        'Безнал',
        'Смартфоны',
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
