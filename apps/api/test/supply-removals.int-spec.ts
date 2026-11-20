import { randomUUID } from 'node:crypto';
import {
  supplyRemovalDecisionResponseSchema,
  supplyRemovalListResponseSchema,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/index.js';
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
  fixtureTable,
} from '../src/modules/sheets-sync/fake-delivery-cost-source.js';
import { SheetSyncRunRepository } from '../src/modules/sheets-sync/sheet-sync-run.repository.js';
import { SheetsSyncService } from '../src/modules/sheets-sync/sheets-sync.service.js';
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

describe('manager confirmation when a sheet line disappears (real PostgreSQL)', () => {
  let t: TestApp;
  let source: FakeDeliveryCostSource;
  let sync: SheetsSyncService;
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
    sync = new SheetsSyncService(
      source,
      t.get(CatalogService),
      t.get(PriceReferenceService),
      t.clock,
      t.get(SupplyRemovalService),
      new SheetSyncRunRepository(t.prisma),
      new FixtureRowSelection(),
    );
    await sync.syncCostReference();
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
  const setLines = (lines: typeof FIXTURE_LINES): void => source.replaceTable(fixtureTable(lines));
  const without = (...refs: string[]): typeof FIXTURE_LINES =>
    FIXTURE_LINES.filter((l) => !refs.includes(l.deliveryRef));
  const line = (ref: string) =>
    t.prisma.priceReference.findFirstOrThrow({ where: { deliveryRef: ref } });
  const requests = () => t.prisma.supplyRemovalRequest.findMany({ orderBy: { detectedAt: 'asc' } });
  const stock = async (code: string): Promise<string | null> =>
    (await t.prisma.stockCache.findUnique({ where: { productId: ids[code]! } }))?.quantity.toFixed(
      3,
    ) ?? null;
  /** The pending request for a delivery ref, via the API. */
  async function pendingId(ref: string): Promise<string> {
    const list = await call('GET', '/staff/supply-removals');
    return list.body.items.find((i: Body) => i.deliveryRef === ref).id as string;
  }

  describe('detection by the sync (changes nothing but the request)', () => {
    it('opens a PENDING request for a vanished line, audited as a system action; nothing else changes', async () => {
      setLines(without('REQ-014'));
      const before = await t.prisma.priceReference.findMany({ orderBy: { deliveryRef: 'asc' } });
      const stockBefore = await stock('10482');
      t.clock.set(new Date('2026-10-21T09:00:00Z'));

      const report = await sync.syncCostReference();
      expect(report.staleRefs).toEqual([{ productCode: '10482', deliveryRef: 'REQ-014' }]);
      expect(report.removals).toEqual({ requested: 1, dismissed: 0 });

      const [request] = await requests();
      expect(request).toMatchObject({
        productId: ids['10482'],
        deliveryRef: 'REQ-014',
        status: 'PENDING',
        decidedBy: null,
        decidedAt: null,
      });
      expect(request?.detectedAt.toISOString()).toBe('2026-10-21T09:00:00.000Z');
      // Not deleted, not flagged, still counting for stock.
      await expect(
        t.prisma.priceReference.findMany({ orderBy: { deliveryRef: 'asc' } }),
      ).resolves.toEqual(before);
      expect(await stock('10482')).toBe(stockBefore);
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_REMOVAL_REQUESTED' },
      });
      expect(audit).toMatchObject({ actorUserId: null, entityId: request?.id });
      expect(audit.diff).toMatchObject({ status: { from: null, to: 'PENDING' } });
    });

    it('is idempotent: re-running with the line still missing opens no second request', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const audits = await t.prisma.auditLog.count();
      const again = await sync.syncCostReference();
      expect(again.removals).toEqual({ requested: 0, dismissed: 0 });
      expect(await requests()).toHaveLength(1);
      await expect(t.prisma.auditLog.count()).resolves.toBe(audits);
    });

    it('auto-DISMISSES a pending request when the line reappears (audited, no person)', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      setLines(FIXTURE_LINES);
      t.clock.set(new Date('2026-10-22T09:00:00Z'));
      const report = await sync.syncCostReference();
      expect(report.removals).toEqual({ requested: 0, dismissed: 1 });
      const [request] = await requests();
      expect(request).toMatchObject({ status: 'DISMISSED', decidedBy: null });
      expect(request?.decidedAt?.toISOString()).toBe('2026-10-22T09:00:00.000Z');
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_REMOVAL_DISMISSED' },
      });
      expect(audit).toMatchObject({ actorUserId: null });
      expect(audit.diff).toEqual({ status: { from: 'PENDING', to: 'DISMISSED' } });
    });

    it('a line that vanishes again after a dismissal gets a NEW request', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      setLines(FIXTURE_LINES);
      await sync.syncCostReference();
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      expect((await requests()).map((r) => r.status)).toEqual(['DISMISSED', 'PENDING']);
    });

    it('products that were not read produce no request; neither does a rejected row naming the line', async () => {
      // 10931 is absent from the read entirely: its lines are not "missing", the product was not read.
      setLines(FIXTURE_LINES.filter((l) => l.productCode.trim().toLowerCase() === '10482'));
      expect((await sync.syncCostReference()).removals.requested).toBe(0);
      // A malformed row that still names REQ-014 is "mentioned", not missing.
      setLines(
        FIXTURE_LINES.filter((l) => l.productCode.trim().toLowerCase() === '10482').map((l) =>
          l.deliveryRef === 'REQ-014' ? { ...l, costUsd: 'garbage' } : l,
        ),
      );
      const report = await sync.syncCostReference();
      expect(report.rejected).toHaveLength(1);
      expect(report.removals.requested).toBe(0);
      expect(await requests()).toHaveLength(0);
    });

    it('a rolled-back transaction leaves no request (audit failure)', async () => {
      setLines(without('REQ-014'));
      vi.spyOn(t.get(AuditService), 'recordSystemMany').mockRejectedValue(new Error('audit down'));
      await expect(sync.syncCostReference()).rejects.toThrow();
      expect(await requests()).toHaveLength(0);
    });
  });

  describe('GET /staff/supply-removals', () => {
    it('401 without an actor; 403 for warehouse, driver and customers; 200 for manager, accountant, admin', async () => {
      expect((await t.request('GET', '/staff/supply-removals')).status).toBe(401);
      for (const actor of [WAREHOUSE, DRIVER, SHOP_OWNER, SELLER]) {
        expect((await call('GET', '/staff/supply-removals', actor)).status, actor.userId).toBe(403);
      }
      for (const actor of [MANAGER, ACCOUNTANT, ADMIN]) {
        expect((await call('GET', '/staff/supply-removals', actor)).status, actor.userId).toBe(200);
      }
    });

    it('is empty with total 0, then lists pending requests with the line staff need to decide', async () => {
      expect((await call('GET', '/staff/supply-removals')).body).toEqual({ total: 0, items: [] });
      setLines(without('REQ-014', 'REQ-020'));
      await sync.syncCostReference();
      const r = await call('GET', '/staff/supply-removals', ACCOUNTANT);
      const body = supplyRemovalListResponseSchema.parse(r.body);
      expect(body.total).toBe(2);
      const kb = body.items.find((i) => i.deliveryRef === 'REQ-014');
      expect(kb).toMatchObject({
        productId: ids['10482'],
        productCode: '10482',
        line: {
          deliveredAt: '2026-09-10T04:15:00.000Z', // 10/09/2026 09:15:00 in Tashkent
          supplier: 'alpha trade import',
          deliveredQuantity: '1000.000',
          availableQuantity: '12.000',
          costUsd: '12.8000',
          usdRateUsed: '12650.0000',
        },
      });
    });

    it('decided requests leave the list; total counts only pending', async () => {
      setLines(without('REQ-014', 'REQ-020'));
      await sync.syncCostReference();
      await call('POST', `/staff/supply-removals/${await pendingId('REQ-014')}/dismiss`);
      const body = (await call('GET', '/staff/supply-removals')).body;
      expect(body.total).toBe(1);
      expect(body.items.map((i: Body) => i.deliveryRef)).toEqual(['REQ-020']);
    });
  });

  describe('confirm: soft removal of the line, stock recomputed in the same transaction', () => {
    it('removes the line from stock, history and the costs overview; it stays in the table and the audit log', async () => {
      // Publish a list so the costs endpoint has something to show.
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: ids['10482'], basePrice: '190000.00' }],
      });
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);

      expect(await stock('10482')).toBe('312.000'); // 0 + 12 + 300
      setLines(without('REQ-027')); // the LATEST 10482 delivery vanishes
      await sync.syncCostReference();
      const id = await pendingId('REQ-027');

      t.clock.set(new Date('2026-10-23T10:00:00Z'));
      const r = await call('POST', `/staff/supply-removals/${id}/confirm`, ADMIN);
      expect(r.status).toBe(200);
      expect(supplyRemovalDecisionResponseSchema.parse(r.body)).toEqual({
        id,
        status: 'CONFIRMED',
        decidedAt: '2026-10-23T10:00:00.000Z',
        decidedBy: null,
      });

      // The row stays, marked.
      const removed = await line('REQ-027');
      expect(removed.removedAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
      expect(removed.removedBy).toBe(ADMIN.userId);
      // Stock without it (12 + 0), same transaction.
      expect(await stock('10482')).toBe('12.000');
      // History and the costs overview do not show it any more; "latest" moves to the next line.
      const history = await call('GET', `/staff/products/${ids['10482']}/cost-reference`);
      expect(history.body.deliveries.map((d: Body) => d.deliveryRef)).toEqual([
        'REQ-014',
        'REQ-001',
      ]);
      expect(history.body.latest.deliveryRef).toBe('REQ-014');
      const costs = await call('GET', '/staff/price-list/current/costs');
      const item = costs.body.items.find((i: Body) => i.productId === ids['10482']);
      expect(item.latest.deliveryRef).toBe('REQ-014');
      expect(item.recent.map((d: Body) => d.deliveryRef)).toEqual(['REQ-014', 'REQ-001']);
      expect(item.stockQuantity).toBe('12.000');

      // Full history: who confirmed, the line removal, and the stock change with its actor.
      const audit = await t.prisma.auditLog.findMany({
        where: { actorUserId: ADMIN.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => [a.action, a.entityType]).sort()).toEqual(
        [
          ['SUPPLY_LINE_REMOVED', 'PRICE_REFERENCE'],
          ['STOCK_CACHE_RECOMPUTED', 'STOCK_CACHE'],
          ['SUPPLY_REMOVAL_CONFIRMED', 'SUPPLY_REMOVAL_REQUEST'],
        ].sort(),
      );
      expect(audit.find((a) => a.action === 'STOCK_CACHE_RECOMPUTED')?.diff).toEqual({
        quantity: { from: '312.000', to: '12.000' },
      });
      expect(audit.find((a) => a.action === 'SUPPLY_LINE_REMOVED')?.diff).toEqual({
        removedAt: { from: null, to: '2026-10-23T10:00:00.000Z' },
        removedBy: { from: null, to: ADMIN.userId },
      });
    });

    it("removing a product's last remaining line rewrites its aggregate to 0 (not left stale)", async () => {
      // Open requests for BOTH 10931 lines directly (the sync only opens them for products it read).
      await t.get(SupplyRemovalService).syncDetected({
        missing: [
          { productId: ids['10931']!, deliveryRef: 'REQ-020' },
          { productId: ids['10931']!, deliveryRef: 'REQ-021' },
        ],
        present: [],
      });
      expect(await stock('10931')).toBe('501.000');
      await call('POST', `/staff/supply-removals/${await pendingId('REQ-020')}/confirm`);
      expect(await stock('10931')).toBe('250.500');
      await call('POST', `/staff/supply-removals/${await pendingId('REQ-021')}/confirm`);
      expect(await stock('10931')).toBe('0.000');
    });

    describe('category after a confirmed removal', () => {
      const category = async (code: string): Promise<string | null> =>
        (await t.prisma.product.findUniqueOrThrow({ where: { id: ids[code]! } })).category;
      const categoryAudit = () =>
        t.prisma.auditLog.findMany({
          where: { entityId: ids['10482']!, action: 'PRODUCT_CATEGORY_CHANGED' },
          orderBy: { createdAt: 'asc' },
        });

      // The newest 10482 delivery (REQ-027) has its own category; the older ones keep the default.
      const withNewestCategory = (): typeof FIXTURE_LINES =>
        FIXTURE_LINES.map((l) =>
          l.deliveryRef === 'REQ-027' ? { ...l, category: 'Planshetlar' } : l,
        );

      it('moves back to the new latest line when the newest line is removed (audited under the actor)', async () => {
        setLines(withNewestCategory());
        await sync.syncCostReference();
        expect(await category('10482')).toBe('Planshetlar');

        setLines(withNewestCategory().filter((l) => l.deliveryRef !== 'REQ-027'));
        await sync.syncCostReference();
        await call('POST', `/staff/supply-removals/${await pendingId('REQ-027')}/confirm`, ADMIN);

        expect(await category('10482')).toBe('Смартфоны');
        const [row] = await categoryAudit();
        expect(row?.actorUserId).toBe(ADMIN.userId);
        expect(row?.diff).toEqual({ category: { from: 'Planshetlar', to: 'Смартфоны' } });
      });

      it('is cleared to NULL when no live line is left (audited under the actor)', async () => {
        // Open requests for ALL 10482 lines directly (the sync only opens them for products it read).
        const refs = ['REQ-027', 'REQ-014', 'REQ-001'];
        await t.get(SupplyRemovalService).syncDetected({
          missing: refs.map((deliveryRef) => ({ productId: ids['10482']!, deliveryRef })),
          present: [],
        });
        for (const ref of refs) {
          await call('POST', `/staff/supply-removals/${await pendingId(ref)}/confirm`, ADMIN);
        }

        expect(await category('10482')).toBeNull();
        const rows = await categoryAudit();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.diff).toEqual({ category: { from: 'Смартфоны', to: null } });
        expect(rows[0]?.actorUserId).toBe(ADMIN.userId);
        // The category is also gone from the staff product DTO.
        const dto = await call('GET', `/staff/products/${ids['10482']}`);
        expect(dto.body.category).toBeNull();
      });

      it('an unchanged category writes and audits nothing', async () => {
        setLines(without('REQ-027'));
        await sync.syncCostReference();
        await call('POST', `/staff/supply-removals/${await pendingId('REQ-027')}/confirm`, ADMIN);
        expect(await category('10482')).toBe('Смартфоны');
        expect(await categoryAudit()).toHaveLength(0);
      });

      it('rolls back with the removal when the category audit cannot be written', async () => {
        setLines(withNewestCategory().filter((l) => l.deliveryRef !== 'REQ-027'));
        await sync.syncCostReference();
        const id = await pendingId('REQ-027');
        const record = t.get(AuditService).record.bind(t.get(AuditService));
        vi.spyOn(t.get(AuditService), 'record').mockImplementation(async (tx, entry) => {
          if (entry.action === 'PRODUCT_CATEGORY_CHANGED') throw new Error('audit down');
          await record(tx, entry);
        });
        // The newest line carries a different category only after a sync; set it directly.
        await t.prisma.product.update({
          where: { id: ids['10482']! },
          data: { category: 'Planshetlar' },
        });

        expect((await call('POST', `/staff/supply-removals/${id}/confirm`, ADMIN)).status).toBe(
          500,
        );
        expect((await line('REQ-027')).removedAt).toBeNull();
        expect(await category('10482')).toBe('Planshetlar');
      });
    });

    it('a confirmed line is not revived when it reappears in the sheet; it is only reported', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      await call('POST', `/staff/supply-removals/${await pendingId('REQ-014')}/confirm`);
      const stockAfter = await stock('10482');
      setLines(FIXTURE_LINES);
      const report = await sync.syncCostReference();
      expect(report.reappearedAfterRemoval).toEqual([
        { productCode: '10482', deliveryRef: 'REQ-014' },
      ]);
      expect((await line('REQ-014')).removedAt).not.toBeNull();
      expect(await stock('10482')).toBe(stockAfter);
      expect(report.removals.requested).toBe(0);
    });

    it('a confirmed line that stays absent is not stale again and opens no new request', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      await call('POST', `/staff/supply-removals/${await pendingId('REQ-014')}/confirm`);
      const report = await sync.syncCostReference();
      expect(report.staleRefs).toEqual([]);
      expect(report.removals).toEqual({ requested: 0, dismissed: 0 });
      expect(await requests()).toHaveLength(1);
    });

    it('rolls everything back when the audit cannot be written (request stays PENDING, line stays)', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValue(new Error('audit down'));
      expect((await call('POST', `/staff/supply-removals/${id}/confirm`)).status).toBe(500);
      expect((await requests())[0]?.status).toBe('PENDING');
      expect((await line('REQ-014')).removedAt).toBeNull();
      expect(await stock('10482')).toBe('312.000');
    });
  });

  describe('dismiss', () => {
    it('keeps the line exactly as it is and records the decision', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      const before = await line('REQ-014');
      t.clock.set(new Date('2026-10-23T10:00:00Z'));
      const r = await call('POST', `/staff/supply-removals/${id}/dismiss`, MANAGER);
      expect(supplyRemovalDecisionResponseSchema.parse(r.body)).toMatchObject({
        status: 'DISMISSED',
        decidedBy: null,
      });
      expect(await line('REQ-014')).toEqual(before);
      expect(await stock('10482')).toBe('312.000');
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SUPPLY_REMOVAL_DISMISSED' },
      });
      expect(audit).toMatchObject({ actorUserId: MANAGER.userId, entityId: id });
    });
  });

  describe('permissions and conflicts', () => {
    it('the accountant can view but never decide; warehouse, driver and customers cannot either', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      for (const action of ['confirm', 'dismiss']) {
        expect((await t.request('POST', `/staff/supply-removals/${id}/${action}`)).status).toBe(
          401,
        );
        for (const actor of [ACCOUNTANT, WAREHOUSE, DRIVER, SHOP_OWNER, SELLER]) {
          expect(
            (await call('POST', `/staff/supply-removals/${id}/${action}`, actor)).status,
            `${actor.userId} ${action}`,
          ).toBe(403);
        }
      }
      expect((await requests())[0]?.status).toBe('PENDING');
    });

    it('409 REMOVAL_REQUEST_NOT_PENDING for every decision on a request that is no longer pending', async () => {
      // 10482 keeps REQ-027 and 10931 keeps REQ-021, so both products count as read.
      setLines(without('REQ-014', 'REQ-001', 'REQ-020'));
      await sync.syncCostReference();
      const confirmed = await pendingId('REQ-014');
      const dismissed = await pendingId('REQ-001');
      const reappeared = await pendingId('REQ-020');
      await call('POST', `/staff/supply-removals/${confirmed}/confirm`);
      await call('POST', `/staff/supply-removals/${dismissed}/dismiss`);
      // REQ-020 comes back in the sheet: auto-dismissed.
      setLines(without('REQ-014', 'REQ-001'));
      await sync.syncCostReference();

      for (const id of [confirmed, dismissed, reappeared]) {
        for (const action of ['confirm', 'dismiss']) {
          const r = await call('POST', `/staff/supply-removals/${id}/${action}`);
          expect(r.status, `${id} ${action}`).toBe(409);
          expect(r.body.error).toMatchObject({
            code: 'CONFLICT',
            reason: 'REMOVAL_REQUEST_NOT_PENDING',
          });
        }
      }
      // Nothing changed by the rejected attempts.
      expect((await line('REQ-014')).removedBy).toBe(MANAGER.userId);
      expect((await line('REQ-001')).removedAt).toBeNull();
      expect((await line('REQ-020')).removedAt).toBeNull();
    });

    it('two simultaneous confirmations: exactly one wins, the other is a 409', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      const results = await Promise.all([
        call('POST', `/staff/supply-removals/${id}/confirm`, MANAGER),
        call('POST', `/staff/supply-removals/${id}/confirm`, ADMIN),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await stock('10482')).toBe('300.000');
      await expect(
        t.prisma.auditLog.count({ where: { action: 'SUPPLY_REMOVAL_CONFIRMED' } }),
      ).resolves.toBe(1);
    });

    it('404 for an unknown request, 422 for a malformed id', async () => {
      const unknown = randomUUID();
      expect((await call('POST', `/staff/supply-removals/${unknown}/confirm`)).status).toBe(404);
      expect((await call('POST', `/staff/supply-removals/${unknown}/dismiss`)).status).toBe(404);
      expect((await call('POST', '/staff/supply-removals/not-a-uuid/confirm')).status).toBe(422);
    });
  });

  describe('database guarantees', () => {
    it('at most one PENDING request per line; decided ones do not block a new one', async () => {
      const insert = (status: string, decided: boolean) =>
        t.prisma.$executeRawUnsafe(
          `INSERT INTO supply_removal_requests (id, product_id, delivery_ref, status, detected_at, decided_at, decided_by)
           VALUES ('${randomUUID()}', '${ids['10482']}', 'X-1', '${status}', now(),
                   ${decided ? 'now()' : 'NULL'}, ${status === 'CONFIRMED' ? "'u1'" : 'NULL'})`,
        );
      await expect(insert('PENDING', false)).resolves.toBe(1);
      await expect(insert('PENDING', false)).rejects.toThrow(/one_pending|unique/);
      await expect(insert('DISMISSED', true)).resolves.toBe(1);
      await expect(insert('CONFIRMED', true)).resolves.toBe(1);
    });

    it('keeps decisions consistent: no half-decided rows, a confirmation needs a person', async () => {
      const raw = (status: string, decidedAt: string, decidedBy: string) =>
        t.prisma.$executeRawUnsafe(
          `INSERT INTO supply_removal_requests (id, product_id, delivery_ref, status, detected_at, decided_at, decided_by)
           VALUES ('${randomUUID()}', '${ids['10482']}', 'Y-${randomUUID()}', '${status}', now(), ${decidedAt}, ${decidedBy})`,
        );
      await expect(raw('PENDING', 'now()', 'NULL')).rejects.toThrow(/decision_consistent/);
      await expect(raw('PENDING', 'NULL', "'u1'")).rejects.toThrow(/decision_consistent/);
      await expect(raw('CONFIRMED', 'now()', 'NULL')).rejects.toThrow(/decision_consistent/);
      await expect(raw('CONFIRMED', 'NULL', "'u1'")).rejects.toThrow(/decision_consistent/);
      await expect(raw('DISMISSED', 'NULL', 'NULL')).rejects.toThrow(/decision_consistent/);
      await expect(raw('DISMISSED', 'now()', 'NULL')).resolves.toBe(1); // automatic dismissal
    });

    it('a decided request cannot be flipped back or edited by raw SQL; only PENDING can be decided', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      // Allowed: the decision itself.
      await expect(
        t.prisma.$executeRawUnsafe(
          `UPDATE supply_removal_requests SET status = 'DISMISSED', decided_at = now() WHERE id = '${id}'`,
        ),
      ).resolves.toBe(1);
      for (const sql of [
        `UPDATE supply_removal_requests SET status = 'PENDING', decided_at = NULL WHERE id = '${id}'`,
        `UPDATE supply_removal_requests SET status = 'CONFIRMED', decided_by = 'u1' WHERE id = '${id}'`,
        `UPDATE supply_removal_requests SET decided_at = now() WHERE id = '${id}'`,
        `DELETE FROM supply_removal_requests WHERE id = '${id}'`,
      ]) {
        await expect(t.prisma.$executeRawUnsafe(sql)).rejects.toThrow(
          /already decided|cannot be deleted/,
        );
      }
      // A pending row may not change its identity or stay pending through an update.
      setLines(without('REQ-001'));
      await sync.syncCostReference();
      const other = await pendingId('REQ-001');
      await expect(
        t.prisma.$executeRawUnsafe(
          `UPDATE supply_removal_requests SET delivery_ref = 'X' WHERE id = '${other}'`,
        ),
      ).rejects.toThrow(/may only be decided/);
      await expect(requests()).resolves.toHaveLength(2);
    });

    it('a removal marks both removed_at and removed_by, or neither; TRUNCATE is refused', async () => {
      await expect(
        t.prisma
          .$executeRaw`UPDATE price_reference SET removed_at = now() WHERE delivery_ref = 'REQ-014'`,
      ).rejects.toThrow(/removal_complete/);
      await expect(
        t.prisma
          .$executeRaw`UPDATE price_reference SET removed_by = 'u1' WHERE delivery_ref = 'REQ-014'`,
      ).rejects.toThrow(/removal_complete/);
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE supply_removal_requests')).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  describe('races (deterministic: a transaction is held open on purpose)', () => {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    function gate(): {
      wait: Promise<void>;
      open: () => void;
      entered: Promise<void>;
      enter: () => void;
    } {
      let open!: () => void;
      let enter!: () => void;
      const wait = new Promise<void>((r) => (open = r));
      const entered = new Promise<void>((r) => (enter = r));
      return { wait, open, entered, enter };
    }
    /** True when the promise is still pending after the given time. */
    async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
      let settled = false;
      void p.then(
        () => (settled = true),
        () => (settled = true),
      );
      await sleep(ms);
      return !settled;
    }

    it('a sync auto-dismissal cannot overwrite a confirmation that is still in flight', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      const audit = t.get(AuditService);
      const original = audit.record.bind(audit);
      const g = gate();
      vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
        if (entry.action === 'SUPPLY_REMOVAL_CONFIRMED') {
          g.enter();
          await g.wait; // the confirm transaction stays open here, holding its locks
        }
        return original(tx, entry);
      });

      const confirm = call('POST', `/staff/supply-removals/${id}/confirm`);
      await g.entered;
      const detected = t.get(SupplyRemovalService).syncDetected({
        missing: [],
        present: [{ productId: ids['10482']!, deliveryRef: 'REQ-014' }],
      });
      expect(await stillPending(detected)).toBe(true); // waits for the confirmation
      g.open();
      const [confirmed, outcome] = await Promise.all([confirm, detected]);

      expect(confirmed.status).toBe(200);
      expect(outcome).toEqual({ requested: 0, dismissed: 0 });
      const [request] = await requests();
      expect(request).toMatchObject({ status: 'CONFIRMED', decidedBy: MANAGER.userId });
      await expect(
        t.prisma.auditLog.count({ where: { action: 'SHEET_SYNC_REMOVAL_DISMISSED' } }),
      ).resolves.toBe(0);
      await expect(
        t.prisma.auditLog.count({ where: { action: 'SUPPLY_REMOVAL_CONFIRMED', entityId: id } }),
      ).resolves.toBe(1);
    });

    it('a sync dismissal that finds the request already decided changes and audits nothing', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      await call('POST', `/staff/supply-removals/${id}/dismiss`);
      const audits = await t.prisma.auditLog.count();
      const outcome = await t.get(SupplyRemovalService).syncDetected({
        missing: [],
        present: [{ productId: ids['10482']!, deliveryRef: 'REQ-014' }],
      });
      expect(outcome).toEqual({ requested: 0, dismissed: 0 });
      await expect(t.prisma.auditLog.count()).resolves.toBe(audits);
    });

    it('a confirmation waits for an open sync chunk, so stock ends equal to the live lines', async () => {
      setLines(without('REQ-014'));
      await sync.syncCostReference();
      const id = await pendingId('REQ-014');
      const prs = t.get(PriceReferenceService);
      const catalog = t.get(CatalogService);
      const g = gate();
      const chunk = prs.upsertDeliveries(
        [
          {
            productId: ids['10482']!,
            deliveryRef: 'NEW-1',
            supplier: 'S',
            purchaseMethod: 'm',
            category: 'c',
            deliveredQuantity: new Prisma.Decimal('50'),
            availableQuantity: new Prisma.Decimal('50'),
            costUsd: new Prisma.Decimal('10'),
            usdRateUsed: new Prisma.Decimal('12000'),
            costUzs: new Prisma.Decimal('120000'),
            deliveredAt: new Date('2026-10-20T00:00:00Z'),
          },
        ],
        async (tx, productIds) => {
          await catalog.replaceStock(tx, await prs.availableTotals(tx, productIds));
          g.enter();
          await g.wait; // the sync chunk transaction stays open, holding the sync lock
        },
      );
      await g.entered;
      const confirm = call('POST', `/staff/supply-removals/${id}/confirm`);
      expect(await stillPending(confirm)).toBe(true);
      g.open();
      await chunk;
      expect((await confirm).status).toBe(200);

      const live = await t.prisma.priceReference.findMany({
        where: { productId: ids['10482']!, removedAt: null },
      });
      const sum = live.reduce((acc, l) => acc.plus(l.availableQuantity), new Prisma.Decimal(0));
      expect(sum.toFixed(3)).toBe('350.000'); // 0 + 300 + 50; REQ-014 (12) removed
      expect(await stock('10482')).toBe(sum.toFixed(3));
    });
  });

  it('customers see nothing of removals: no route, no field', async () => {
    setLines(without('REQ-014'));
    await sync.syncCostReference();
    const customerList = await call('GET', '/price-list/current', SHOP_OWNER);
    expect(JSON.stringify(customerList.body).toLowerCase()).not.toMatch(
      /removal|pending|deliveryref/,
    );
  });
});
