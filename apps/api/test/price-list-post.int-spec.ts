import ExcelJS from 'exceljs';
import { priceListPostResponseSchema } from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRICE_LIST_POST_TYPE } from '../src/common/outbox/price-list-post.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/index.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import {
  PriceListPostService,
  PriceReferenceService,
  PricingModule,
} from '../src/modules/pricing/index.js';
import { makeOrganization } from './support/identity-fixtures.js';
import { resetCatalogPricingAudit, resetIdentity, resetOrders } from './support/test-db.js';
import {
  ACCOUNTANT,
  ACTOR_HEADER,
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

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('price list Excel file: download and posting to the groups (real PostgreSQL)', () => {
  let t: TestApp;
  let redmi: string;
  let unbranded: string;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    // 04:00 UTC = 09:00 in Tashkent, 28.10.2026.
    t.clock.set(new Date('2026-10-28T04:00:00Z'));
    await resetOrders(t.prisma);
    await resetIdentity(t.prisma);
    await resetCatalogPricingAudit(t.prisma);
    const make = async (code: string, ruName: string): Promise<string> =>
      (
        await t.prisma.product.create({
          data: {
            productCode: code,
            unit: 'dona',
            category: 'Наушники',
            translations: { create: [{ lang: 'RU', name: ruName }] },
          },
        })
      ).id;
    redmi = await make('R-1', 'Наушники REDMI Buds 8 Black');
    unbranded = await make('F-1', 'FreeBuds 6i Black');
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

  /** Publishes and returns the version number (a sequence: not reset between tests). */
  async function publish(prices: Record<string, string>): Promise<number> {
    const draft = await call('POST', '/staff/price-list/drafts', MANAGER, {
      copyFromCurrent: false,
    });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    await call('PUT', `/staff/price-list/drafts/${id}/items`, MANAGER, {
      items: Object.entries(prices).map(([productId, basePrice]) => ({ productId, basePrice })),
    });
    const published = await call('POST', `/staff/price-list/drafts/${id}/publish`);
    expect(published.status).toBe(200);
    return published.body.number as number;
  }

  const setRate = async (rate: string): Promise<void> => {
    expect((await call('PUT', '/staff/usd-rate', MANAGER, { rate })).status).toBe(200);
  };

  const priceRows = () =>
    t.prisma.notificationOutbox.findMany({
      where: { type: PRICE_LIST_POST_TYPE },
      orderBy: { recipientOrganizationId: 'asc' },
    });

  /** Two eligible organizations and three that must never get the post. */
  async function organizations(): Promise<{ eligible: string[] }> {
    const a = await makeOrganization(t.prisma);
    const b = await makeOrganization(t.prisma);
    const off = await makeOrganization(t.prisma);
    const inactive = await makeOrganization(t.prisma, { status: 'INACTIVE' });
    await makeOrganization(t.prisma);
    await t.prisma.organization.updateMany({
      where: { id: { in: [a.id, b.id, inactive.id] } },
      data: { pricePostingEnabled: true },
    });
    expect(off.id).toBeDefined();
    return { eligible: [a.id, b.id].sort() };
  }

  /** Raw fetch: the body is a file, not JSON. */
  async function download(
    actor = MANAGER,
  ): Promise<{ status: number; data: Uint8Array; headers: Headers }> {
    const { port } = t.app.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/staff/price-list/current/excel`, {
      headers: { [ACTOR_HEADER]: JSON.stringify(actor) },
    });
    return {
      status: response.status,
      data: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
    };
  }

  describe('POST /staff/price-list/post-to-groups', () => {
    it('queues one outbox row per eligible group and an audit row, in one transaction', async () => {
      const { eligible } = await organizations();
      const versionNumber = await publish({ [redmi]: '250000.00', [unbranded]: '1000.00' });
      await setRate('11960');

      const r = await call('POST', '/staff/price-list/post-to-groups', ADMIN);
      expect(r.status).toBe(200);
      expect(priceListPostResponseSchema.parse(r.body)).toEqual({
        versionNumber,
        queuedGroupCount: 2,
        recipients: {
          total: 2,
          byTier: { STANDARD: 2, WHOLESALE_PARTNER: 0, ALIF_FACTORING: 0 },
          byDestination: { GROUP: 2, PRIVATE: 0 },
        },
        skipped: { unbound: 0, inactive: 1, postingOff: 2, noPrices: 0 },
      });

      const rows = await priceRows();
      expect(rows.map((row) => row.recipientOrganizationId)).toEqual(eligible);
      for (const row of rows) {
        expect(row).toMatchObject({
          recipientKind: 'ORGANIZATION_CHAT',
          recipientUserId: null,
          recipientRole: null,
          orderId: null,
          status: 'PENDING',
          payload: {
            versionNumber,
            dateLabel: '28.10.2026',
            usdRate: '11960',
            priceTier: 'STANDARD',
          },
        });
        // Allow-listed payload: nothing else.
        expect(Object.keys(row.payload as object).sort()).toEqual([
          'dateLabel',
          'priceTier',
          'usdRate',
          'versionNumber',
        ]);
      }

      const audit = await t.prisma.auditLog.findMany({
        where: { action: 'PRICE_LIST_POSTED_TO_GROUPS' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorUserId).toBe(ADMIN.userId);
      expect(audit[0]?.diff).toMatchObject({
        versionNumber: { from: null, to: versionNumber },
        queuedGroupCount: { from: null, to: 2 },
        organizationIds: { from: null, to: eligible },
      });
    });

    it('every press is a new send', async () => {
      await organizations();
      await publish({ [redmi]: '250000.00' });
      await call('POST', '/staff/price-list/post-to-groups');
      await call('POST', '/staff/price-list/post-to-groups');
      const rows = await priceRows();
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(4);
      expect(rows.every((row) => row.payload !== null)).toBe(true);
      expect((rows[0]?.payload as Body).usdRate).toBeNull();
    });

    it('writes nothing when the history row cannot be written (one transaction)', async () => {
      await organizations();
      await publish({ [redmi]: '250000.00' });
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit down'));
      expect((await call('POST', '/staff/price-list/post-to-groups')).status).toBe(500);
      expect(await priceRows()).toHaveLength(0);
    });

    it('404 when nothing is published; only manager and admin may post', async () => {
      await organizations();
      expect((await call('POST', '/staff/price-list/post-to-groups')).status).toBe(404);
      await publish({ [redmi]: '250000.00' });
      for (const actor of [ACCOUNTANT, WAREHOUSE, DRIVER, SHOP_OWNER, SELLER]) {
        expect((await call('POST', '/staff/price-list/post-to-groups', actor)).status).toBe(403);
      }
      expect(await priceRows()).toHaveLength(0);
    });
  });

  describe('the daily post (worker job, system actor)', () => {
    it('queues at most once per group per Tashkent day, with a system audit row', async () => {
      const { eligible } = await organizations();
      const versionNumber = await publish({ [redmi]: '250000.00' });
      const posts = t.get(PriceListPostService);

      expect(await posts.postDaily()).toEqual({
        outcome: 'QUEUED',
        versionNumber,
        queuedGroupCount: 2,
        recipients: {
          total: 2,
          byTier: { STANDARD: 2, WHOLESALE_PARTNER: 0, ALIF_FACTORING: 0 },
          byDestination: { GROUP: 2, PRIVATE: 0 },
        },
        skipped: { unbound: 0, inactive: 1, postingOff: 2, noPrices: 0 },
      });
      // Later the same Tashkent day: nothing new.
      t.clock.set(new Date('2026-10-28T18:00:00Z'));
      expect(await posts.postDaily()).toMatchObject({ queuedGroupCount: 0 });
      expect(await priceRows()).toHaveLength(2);
      // 19:30 UTC is already the 29th in Tashkent: a new day, a new post.
      t.clock.set(new Date('2026-10-28T19:30:00Z'));
      expect(await posts.postDaily()).toMatchObject({ queuedGroupCount: 2 });
      const rows = await priceRows();
      expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
        [
          ...eligible.map((id) => `price-post:daily:2026-10-28:${id}`),
          ...eligible.map((id) => `price-post:daily:2026-10-29:${id}`),
        ].sort(),
      );

      const audit = await t.prisma.auditLog.findMany({
        where: { action: 'PRICE_POST_DAILY_QUEUED' },
      });
      expect(audit).toHaveLength(2);
      expect(audit.every((a) => a.actorUserId === null)).toBe(true);
    });

    it('skips quietly when nothing is published', async () => {
      await organizations();
      expect(await t.get(PriceListPostService).postDaily()).toEqual({
        outcome: 'NOTHING_PUBLISHED',
      });
      expect(await priceRows()).toHaveLength(0);
      expect(await t.prisma.auditLog.count()).toBe(0);
    });
  });

  describe('GET /staff/price-list/current/excel', () => {
    it('sends the xlsx as an attachment to staff who may read the staff list', async () => {
      await publish({ [redmi]: '250000.00', [unbranded]: '1000.00' });
      for (const actor of [MANAGER, ADMIN, ACCOUNTANT]) {
        const r = await download(actor);
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toBe(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(r.headers.get('content-disposition')).toBe(
          'attachment; filename="iorder-price-2026-10-28.xlsx"',
        );
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Buffer.from(r.data) as unknown as ArrayBuffer);
        expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Xiaomi', 'Boshqa']);
      }
      for (const actor of [WAREHOUSE, DRIVER, SHOP_OWNER, SELLER]) {
        expect((await download(actor)).status).toBe(403);
      }
    });

    it('404 when nothing is published', async () => {
      expect((await download()).status).toBe(404);
    });

    it('holds no cost data except the USD rate the owner wants shown (hard rule 7)', async () => {
      await publish({ [redmi]: '250000.00', [unbranded]: '1000.00' });
      await setRate('11960');
      await t.get(PriceReferenceService).upsertDeliveries([
        {
          productId: redmi,
          deliveryRef: 'SECRET-REF-1',
          supplier: 'secret supplier llc',
          purchaseMethod: 'Безнал',
          category: 'Наушники',
          deliveredQuantity: D('77.000'),
          availableQuantity: D('12.000'),
          costUsd: D('17.4321'),
          usdRateUsed: D('12345.6789'),
          costUzs: D('215204.98'),
          deliveredAt: new Date('2026-10-20T00:00:00Z'),
        },
      ]);
      await t.prisma.stockCache.create({
        data: { productId: redmi, quantity: '12.000', syncedAt: new Date() },
      });

      const r = await download();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(r.data) as unknown as ArrayBuffer);
      const values: unknown[] = [];
      workbook.eachSheet((ws) =>
        ws.eachRow((row) => row.eachCell((cell) => values.push(cell.value))),
      );
      const text = JSON.stringify(values).toLowerCase();
      for (const secret of [
        'secret',
        'безнал',
        '17.4321',
        '12345',
        '215204',
        '77',
        'supplier',
        'usd',
      ]) {
        expect(text, secret).not.toContain(secret);
      }
      // What is allowed: the rate (owner exception), the stock (above 10 pieces as text), the prices.
      expect(values).toContain('Kurs: 11 960 UZS');
      expect(values).toContain('Есть в наличии');
      expect(values).toContain(250000);
    });
  });
});
