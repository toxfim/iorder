import {
  sheetSyncRunSchema,
  sheetSyncRunsResponseSchema,
  type SheetSyncRun,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogModule, CatalogService } from '../src/modules/catalog/index.js';
import {
  PriceReferenceService,
  PricingModule,
  SupplyRemovalService,
} from '../src/modules/pricing/index.js';
import {
  FakeDeliveryCostSource,
  FixtureRowSelection,
  FIXTURE_LINES,
  fixtureLine,
  fixtureTable,
  type FixtureLine,
} from '../src/modules/sheets-sync/fake-delivery-cost-source.js';
import { UnconfiguredDeliveryCostSource } from '../src/modules/sheets-sync/delivery-cost-source.js';
import {
  SHEET_SYNC_RUNS_KEPT,
  SheetSyncRunRepository,
} from '../src/modules/sheets-sync/sheet-sync-run.repository.js';
import { SheetFormatError } from '../src/modules/sheets-sync/sheet-columns.js';
import { SheetsSyncModule } from '../src/modules/sheets-sync/sheets-sync.module.js';
import { SheetsSyncService } from '../src/modules/sheets-sync/sheets-sync.service.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
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

describe('persisted sheet sync runs (real PostgreSQL)', () => {
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
  });

  const call = async (
    method: string,
    path: string,
    actor = MANAGER,
  ): Promise<{ status: number; body: Body }> => {
    const r = await t.request(method, path, { actor });
    return { status: r.status, body: (r.body ?? {}) as Body };
  };

  const serviceFor = (source: FakeDeliveryCostSource | UnconfiguredDeliveryCostSource) =>
    new SheetsSyncService(
      source,
      t.get(CatalogService),
      t.get(PriceReferenceService),
      t.clock,
      t.get(SupplyRemovalService),
      t.get(SheetSyncRunRepository),
      new FixtureRowSelection(),
    );
  const sync = (lines: readonly FixtureLine[]) =>
    serviceFor(new FakeDeliveryCostSource(fixtureTable(lines))).syncCostReference();

  const lastRun = async (): Promise<SheetSyncRun> => {
    const response = await call('GET', '/staff/sheet-sync/runs/last');
    expect(response.status).toBe(200);
    return sheetSyncRunSchema.parse(response.body);
  };

  describe('a skipped row whose supplier has a very long name', () => {
    it('is stored capped at 200 characters with an ellipsis marker', async () => {
      const long = `${'Long supplier '.repeat(40)}end`;
      await sync([
        fixtureLine('10482', 'R-OK', '10.10.2026'),
        fixtureLine('20001', 'R-LONG', '10.10.2026', { supplier: long }),
      ]);
      const stored = (await lastRun()).skippedSuppliers.map((s) => s.supplier);
      expect(stored).toHaveLength(1);
      expect([...(stored[0] ?? '')]).toHaveLength(200);
      expect(stored[0]?.endsWith('…')).toBe(true);
      expect(long.startsWith((stored[0] ?? '').slice(0, 199))).toBe(true);
    });
  });

  describe('a successful run', () => {
    it('stores counts, rejected rows, skipped suppliers, created products and mismatches', async () => {
      t.clock.set(new Date('2026-10-20T08:00:00Z'));
      await sync([
        ...FIXTURE_LINES,
        fixtureLine('BAD-1', 'R-BAD', '10.10.2026', { costUsd: 'garbage-cell' }),
        fixtureLine('bad code!', 'R-BAD2', '10.10.2026'),
      ]);
      const run = await lastRun();
      expect(run).toMatchObject({
        status: 'OK',
        trigger: 'MANUAL',
        errorCode: null,
        startedAt: '2026-10-20T08:00:00.000Z',
        finishedAt: '2026-10-20T08:00:00.000Z',
        pendingRemovalRequests: 0,
        counts: {
          rowsRead: 10,
          created: 6,
          rejected: 2,
          skippedRows: 2,
          mismatches: 1,
          createdProducts: 3,
        },
      });
      expect([...run.createdProducts].sort()).toEqual(['10482', '10931', '99999']);
      expect(run.skippedSuppliers.map((s) => [s.supplier, s.count]).sort()).toEqual(
        [
          ['Some Other Supplier', 1],
          ['Склад Север BM Восток F114 ECO sistem', 1],
        ].sort(),
      );
      expect(run.costMismatches).toEqual([
        { productCode: '10931', deliveryRef: 'REQ-021', differencePercent: expect.any(String) },
      ]);
      expect(run.rejectedRows).toEqual([
        {
          header: 'Цена закупа $',
          reason: expect.any(String),
          productCode: 'BAD-1',
          deliveryRef: 'R-BAD',
        },
        // The invalid product code itself is NOT kept (cell content), only the delivery id.
        { header: 'Товар_ID', reason: expect.any(String), deliveryRef: 'R-BAD2' },
      ]);
    });

    it('holds no cost value and no cell content (not even by key name)', async () => {
      await sync([
        ...FIXTURE_LINES,
        fixtureLine('BAD-1', 'R-BAD', '10.10.2026', { costUsd: 'garbage-cell' }),
      ]);
      const text = JSON.stringify(await lastRun());
      for (const secret of ['garbage-cell', '999999', '12650', '253000', '13.1', 'alpha trade']) {
        expect(text, secret).not.toContain(secret);
      }
      // Cost-like KEYS: only the two staff lists named for them may exist (supplier names of
      // skipped rows, the mismatch list); neither carries a cost value.
      const keys = findForbiddenKeys(JSON.parse(text)).filter(
        (key) => !/^\$\.(costMismatches|skippedSuppliers(\[\d+\]\.supplier)?)$/.test(key),
      );
      expect(keys).toEqual([]);
    });

    it('counts pending removal requests', async () => {
      await sync(FIXTURE_LINES);
      await sync(FIXTURE_LINES.filter((l) => l.deliveryRef !== 'REQ-014'));
      expect((await lastRun()).pendingRemovalRequests).toBe(1);
    });

    it('is written at the end of every run: newest first in the list', async () => {
      await sync(FIXTURE_LINES);
      t.clock.set(new Date('2026-10-20T09:00:00Z'));
      await sync(FIXTURE_LINES);
      t.clock.set(new Date('2026-10-20T10:00:00Z'));
      await sync(FIXTURE_LINES);
      const list = sheetSyncRunsResponseSchema.parse(
        (await call('GET', '/staff/sheet-sync/runs')).body,
      );
      expect(list.items.map((r) => r.startedAt)).toEqual([
        '2026-10-20T10:00:00.000Z',
        '2026-10-20T09:00:00.000Z',
        '2026-10-20T08:00:00.000Z',
      ]);
      const limited = sheetSyncRunsResponseSchema.parse(
        (await call('GET', '/staff/sheet-sync/runs?limit=2')).body,
      );
      expect(limited.items).toHaveLength(2);
      expect(limited.items[0]?.counts.createdProducts).toBe(0);
      expect(list.items[2]?.counts.createdProducts).toBe(3);
    });
  });

  describe('a failed run', () => {
    it('is recorded with an error code only: no message, no cost value', async () => {
      const totals = vi.spyOn(t.get(PriceReferenceService), 'availableTotals');
      totals.mockImplementation(() => {
        throw new Error('boom: cost row (12345.6789, secret-supplier)');
      });
      await expect(sync(FIXTURE_LINES)).rejects.toThrow();
      const run = await lastRun();
      expect(run).toMatchObject({
        status: 'FAILED',
        errorCode: 'SYNC_FAILED',
        counts: { rowsRead: 8, created: 0, createdProducts: 0 },
      });
      const text = JSON.stringify(run);
      for (const secret of ['boom', '12345', 'secret-supplier']) {
        expect(text, secret).not.toContain(secret);
      }
      // The failed chunk was rolled back: no product, no line.
      await expect(t.prisma.product.count()).resolves.toBe(0);
    });

    it('records a missing-column failure with its code', async () => {
      const source = new FakeDeliveryCostSource({ headers: ['Дата'], rows: [] });
      await expect(serviceFor(source).syncCostReference()).rejects.toBeInstanceOf(SheetFormatError);
      expect(await lastRun()).toMatchObject({
        status: 'FAILED',
        errorCode: 'SHEET_FORMAT_INVALID',
      });
    });

    it('records an unconfigured source too', async () => {
      await expect(
        serviceFor(new UnconfiguredDeliveryCostSource()).syncCostReference(),
      ).rejects.toThrow();
      const run = await lastRun();
      expect(run.status).toBe('FAILED');
      expect(run.errorCode).toMatch(/^[A-Za-z0-9_]+$/);
    });

    it('still throws the ORIGINAL error when the run cannot be recorded', async () => {
      vi.spyOn(t.get(SheetSyncRunRepository), 'insertAndPrune').mockRejectedValue(
        new Error('recording down'),
      );
      await expect(
        serviceFor(new UnconfiguredDeliveryCostSource()).syncCostReference(),
      ).rejects.toThrow(/No delivery cost source/);
    });
  });

  describe('retention', () => {
    it('keeps only the latest 200 runs and prunes in the same call', async () => {
      const old = Array.from({ length: SHEET_SYNC_RUNS_KEPT }, (_, i) => ({
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        status: 'OK' as const,
        trigger: 'MANUAL' as const,
        counts: {},
        rejectedRows: [],
        skippedSuppliers: [],
        createdProducts: [],
        pendingRemovalRequests: 0,
        costMismatches: [],
      }));
      await t.prisma.sheetSyncRun.createMany({ data: old });
      await expect(t.prisma.sheetSyncRun.count()).resolves.toBe(SHEET_SYNC_RUNS_KEPT);

      await sync(FIXTURE_LINES);

      await expect(t.prisma.sheetSyncRun.count()).resolves.toBe(SHEET_SYNC_RUNS_KEPT);
      const oldest = await t.prisma.sheetSyncRun.findFirstOrThrow({
        orderBy: { startedAt: 'asc' },
      });
      expect(oldest.startedAt.toISOString()).toBe('2026-01-01T00:01:00.000Z'); // minute 0 was pruned
      expect((await lastRun()).counts.rowsRead).toBe(8);
    });

    it('a failed run also prunes', async () => {
      await t.prisma.sheetSyncRun.createMany({
        data: Array.from({ length: SHEET_SYNC_RUNS_KEPT }, (_, i) => ({
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
          finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
          status: 'OK' as const,
          trigger: 'MANUAL' as const,
          counts: {},
          rejectedRows: [],
          skippedSuppliers: [],
          createdProducts: [],
          pendingRemovalRequests: 0,
          costMismatches: [],
        })),
      });
      await expect(
        serviceFor(new UnconfiguredDeliveryCostSource()).syncCostReference(),
      ).rejects.toThrow();
      await expect(t.prisma.sheetSyncRun.count()).resolves.toBe(SHEET_SYNC_RUNS_KEPT);
      expect((await lastRun()).status).toBe('FAILED');
    });
  });

  describe('database rules', () => {
    const base = {
      startedAt: new Date('2026-10-20T08:00:00Z'),
      finishedAt: new Date('2026-10-20T08:00:00Z'),
      trigger: 'MANUAL' as const,
      counts: {},
      rejectedRows: [],
      skippedSuppliers: [],
      createdProducts: [],
      pendingRemovalRequests: 0,
      costMismatches: [],
    };

    it('an error code exists exactly for a FAILED run', async () => {
      await expect(
        t.prisma.sheetSyncRun.create({ data: { ...base, status: 'FAILED' } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.sheetSyncRun.create({ data: { ...base, status: 'OK', errorCode: 'X' } }),
      ).rejects.toThrow();
    });

    it('rejects a run that finished before it started and JSON of the wrong shape', async () => {
      await expect(
        t.prisma.sheetSyncRun.create({
          data: {
            ...base,
            status: 'OK',
            finishedAt: new Date('2026-10-20T07:00:00Z'),
          },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.sheetSyncRun.create({ data: { ...base, status: 'OK', rejectedRows: {} } }),
      ).rejects.toThrow();
    });

    it('refuses TRUNCATE (guard trigger)', async () => {
      await expect(t.prisma.$executeRaw`TRUNCATE sheet_sync_runs`).rejects.toThrow();
    });
  });

  describe('endpoints', () => {
    const paths = ['/staff/sheet-sync/runs', '/staff/sheet-sync/runs/last'];

    it('last answers 404 before the first run, the list an empty array', async () => {
      expect((await call('GET', '/staff/sheet-sync/runs/last')).status).toBe(404);
      const list = sheetSyncRunsResponseSchema.parse((await call('GET', paths[0]!)).body);
      expect(list.items).toEqual([]);
    });

    it('401 without an actor; 403 for customers, warehouse and driver; 200 for manager, accountant, admin', async () => {
      await sync(FIXTURE_LINES);
      for (const path of paths) {
        expect((await t.request('GET', path)).status, path).toBe(401);
        for (const actor of [SHOP_OWNER, SELLER, WAREHOUSE, DRIVER]) {
          expect((await call('GET', path, actor)).status, `${actor.userId} ${path}`).toBe(403);
        }
        for (const actor of [MANAGER, ACCOUNTANT, ADMIN]) {
          expect((await call('GET', path, actor)).status, `${actor.userId} ${path}`).toBe(200);
        }
      }
    });

    it('validates the limit: 1 to 50, strict query', async () => {
      await sync(FIXTURE_LINES);
      expect((await call('GET', '/staff/sheet-sync/runs?limit=50')).status).toBe(200);
      for (const bad of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5', 'foo=1']) {
        expect((await call('GET', `/staff/sheet-sync/runs?${bad}`)).status, bad).toBe(422);
      }
    });

    it('"sync now" answers 409 SHEET_SYNC_QUEUE_UNAVAILABLE where the worker jobs are off (this test api)', async () => {
      const res = await call('POST', '/staff/sheet-sync/runs');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { reason: 'SHEET_SYNC_QUEUE_UNAVAILABLE' } });
    });
  });
});
