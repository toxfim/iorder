import { customerPriceListResponseSchema } from '@iorder/shared';
import {
  priceListCostsResponseSchema,
  productCostReferenceResponseSchema,
  usdRateResponseSchema,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ADVISORY_LOCK_CLASS, lockByName } from '../src/common/database/advisory-lock.js';
import { runInTransaction } from '../src/common/database/transaction.js';
import { CorruptSettingError } from '../src/common/errors/domain-errors.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/index.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PriceReferenceRepository } from '../src/modules/pricing/price-reference.repository.js';
import {
  PriceReferenceService,
  PricingModule,
  UsdRateService,
  type CostDeliveryInput,
} from '../src/modules/pricing/index.js';
import {
  containsStandalone,
  findForbiddenKeys,
  stripStaffPriceTier,
  findStaffOnlyFields,
  findStaffOnlyFieldsInCustomerPriceList,
  stripStaffRateSnapshot,
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
  STAFF_VIEWER,
  WAREHOUSE,
  type TestApp,
} from './support/test-app.js';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('cost reference and USD rate (real PostgreSQL)', () => {
  let t: TestApp;
  let apple: string;
  let sync: PriceReferenceService;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
    sync = t.get(PriceReferenceService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    await resetCatalogPricingAudit(t.prisma);
    apple = (
      await t.prisma.product.create({
        data: {
          productCode: 'APPLE',
          unit: 'box',
          translations: { create: [{ lang: 'UZ', name: 'Olma' }] },
        },
      })
    ).id;
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

  const delivery = (
    deliveryRef: string,
    deliveredAt: string,
    overrides: Partial<CostDeliveryInput> = {},
  ): CostDeliveryInput => ({
    productId: apple,
    deliveryRef,
    supplier: 'alpha trade import',
    purchaseMethod: 'Безнал',
    category: 'Смартфоны',
    deliveredQuantity: D('1000.125'),
    availableQuantity: D('250.500'),
    costUsd: D('12.3456'),
    usdRateUsed: D('12650.5000'),
    costUzs: D('156190.50'),
    deliveredAt: new Date(deliveredAt),
    ...overrides,
  });

  describe('permissions', () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/staff/products/019a0000-0000-7000-8000-000000000000/cost-reference'],
      ['GET', '/staff/usd-rate'],
      ['PUT', '/staff/usd-rate', { rate: '12650.50' }],
    ];

    it('401 without an actor', async () => {
      for (const [method, path, body] of routes) {
        expect((await t.request(method, path, { body })).status, path).toBe(401);
      }
    });

    it('accountant may view the reference and the rate, but not change the rate', async () => {
      expect((await call('GET', '/staff/usd-rate', ACCOUNTANT)).status).toBe(200);
      expect(
        (await call('GET', `/staff/products/${apple}/cost-reference`, ACCOUNTANT)).status,
      ).toBe(200);
      expect((await call('PUT', '/staff/usd-rate', ACCOUNTANT, { rate: '12650.50' })).status).toBe(
        403,
      );
      await expect(t.prisma.appSetting.count()).resolves.toBe(0);
    });

    it('the accountant can never change selling prices', async () => {
      expect((await call('POST', '/staff/price-list/drafts', ACCOUNTANT, {})).status).toBe(403);
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(0);
    });

    it('403 for customers, warehouse and driver on every cost route', async () => {
      for (const actor of [SHOP_OWNER, SELLER, WAREHOUSE, DRIVER]) {
        for (const [method, path, body] of routes) {
          expect((await call(method, path, actor, body)).status, `${actor.userId} ${path}`).toBe(
            403,
          );
        }
      }
    });

    it('manager and admin may read and change the rate and read the reference', async () => {
      for (const actor of [MANAGER, ADMIN]) {
        expect((await call('GET', '/staff/usd-rate', actor)).status).toBe(200);
        expect((await call('PUT', '/staff/usd-rate', actor, { rate: '12650.50' })).status).toBe(
          200,
        );
        expect((await call('GET', `/staff/products/${apple}/cost-reference`, actor)).status).toBe(
          200,
        );
      }
    });
  });

  describe('USD rate', () => {
    it('is unset until staff set it (no invented default)', async () => {
      const r = await call('GET', '/staff/usd-rate');
      expect(usdRateResponseSchema.parse(r.body)).toEqual({
        rate: null,
        updatedAt: null,
        updatedBy: null,
        updatedByUserId: null,
        source: null,
        rateDate: null,
        followsCentralBank: true, // the default is the Central Bank
        manualRate: null,
        manualExpiresAt: null,
        lastRefreshFailedAt: null,
        lastChannelFailedAt: null,
      });
    });

    it('422 for numbers, zero, negatives, too many digits and exponents', async () => {
      for (const rate of [12650.5, '0', '0.0000', '-1', '1.23456', '1e4', '', ' 5', '1,5']) {
        expect((await call('PUT', '/staff/usd-rate', MANAGER, { rate })).status, String(rate)).toBe(
          422,
        );
      }
      expect((await call('PUT', '/staff/usd-rate', MANAGER, { rate: '5', extra: 1 })).status).toBe(
        422,
      );
    });

    it('stores an exact decimal, shows who/when, and audits before AND after', async () => {
      t.clock.set(new Date('2026-10-20T09:00:00Z'));
      const first = await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      expect(first.body).toEqual({
        rate: '12650.5000',
        updatedAt: '2026-10-20T09:00:00.000Z',
        updatedBy: null,
        updatedByUserId: null,
        source: 'MANUAL',
        rateDate: null,
        followsCentralBank: false,
        manualRate: '12650.5000',
        manualExpiresAt: '2026-10-21T09:00:00.000Z',
        lastRefreshFailedAt: null,
        lastChannelFailedAt: null,
      });

      t.clock.set(new Date('2026-10-21T09:00:00Z'));
      const second = await call('PUT', '/staff/usd-rate', ADMIN, { rate: '12700.1234' });
      expect(second.body.rate).toBe('12700.1234');
      expect((await call('GET', '/staff/usd-rate')).body).toMatchObject({
        rate: '12700.1234',
        updatedBy: null,
      });

      const rows = await t.prisma.auditLog.findMany({
        where: { action: 'USD_RATE_CHANGED' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => [r.actorUserId, r.entityType, r.entityId, r.diff])).toEqual([
        [
          MANAGER.userId,
          'APP_SETTING',
          'usd_rate',
          {
            rate: { from: null, to: '12650.5000' },
            source: { from: null, to: 'MANUAL' },
            manualRate: { from: null, to: '12650.5000' },
            manualSetBy: { from: null, to: MANAGER.userId },
            manualExpiresAt: { from: null, to: '2026-10-21T09:00:00.000Z' },
          },
        ],
        [
          ADMIN.userId,
          'APP_SETTING',
          'usd_rate',
          {
            rate: { from: '12650.5000', to: '12700.1234' },
            manualRate: { from: '12650.5000', to: '12700.1234' },
            manualSetBy: { from: MANAGER.userId, to: ADMIN.userId },
            manualExpiresAt: { from: '2026-10-21T09:00:00.000Z', to: '2026-10-22T09:00:00.000Z' },
          },
        ],
      ]);
      expect(rows[1]?.createdAt.toISOString()).toBe('2026-10-21T09:00:00.000Z');
    });

    it('a failed audit insert rolls the rate change back', async () => {
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValue(new Error('audit down'));
      expect((await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.50' })).status).toBe(
        500,
      );
      await expect(t.prisma.appSetting.count()).resolves.toBe(0);
    });

    describe('a corrupt stored value', () => {
      const corrupt: [string, unknown][] = [
        ['rate is a number', { rate: 12650.5, updatedBy: 'u1' }],
        ['rate is exponent notation', { rate: '1e4', updatedBy: 'u1' }],
        ['rate has too many fraction digits', { rate: '1.23456', updatedBy: 'u1' }],
        ['rate is missing', { updatedBy: 'u1' }],
        ['updatedBy is missing', { rate: '12650.5000' }],
        ['an extra key is present', { rate: '12650.5000', updatedBy: 'u1', x: 1 }],
        ['the value is an array', []],
        ['the value is a string', 'oops'],
      ];

      it.each(corrupt)(
        '%s: clear typed error, no value in the message, no 500 TypeError',
        async (_name, value) => {
          await t.prisma.appSetting.create({
            data: { key: 'usd_rate', value: value as Prisma.InputJsonValue, updatedAt: new Date() },
          });
          const service = t.get(UsdRateService);
          const failure = await service.getUsdRate(MANAGER).then(
            () => null,
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(CorruptSettingError);
          expect((failure as Error).message).toBe('Stored setting "usd_rate" is invalid');

          const response = await call('GET', '/staff/usd-rate');
          expect(response.status).toBe(500);
          expect(response.body.error).toEqual({
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
          });
        },
      );

      it('can be repaired by setting the rate; the history says the previous value was invalid', async () => {
        await t.prisma.appSetting.create({
          data: { key: 'usd_rate', value: { rate: 'garbage' }, updatedAt: new Date() },
        });
        const repaired = await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
        expect(repaired.status).toBe(200);
        expect((await call('GET', '/staff/usd-rate')).body.rate).toBe('12650.5000');
        const row = await t.prisma.auditLog.findFirstOrThrow({
          where: { action: 'USD_RATE_CHANGED' },
        });
        expect(row.diff).toEqual({
          rate: { from: 'INVALID_STORED_VALUE', to: '12650.5000' },
          source: { from: null, to: 'MANUAL' },
          manualRate: { from: null, to: '12650.5000' },
          manualSetBy: { from: null, to: MANAGER.userId },
          manualExpiresAt: { from: null, to: '2026-10-21T08:00:00.000Z' },
        });
      });
    });

    it('advisory locks use the two-int form with the application class id', async () => {
      const locks = await runInTransaction(t.prisma, async (tx) => {
        await lockByName(tx, 'price_reference_sync');
        return tx.$queryRaw<{ classid: number; objsubid: number }[]>`
          SELECT classid::int AS classid, objsubid::int AS objsubid FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
      });
      expect(locks).toEqual([{ classid: APP_ADVISORY_LOCK_CLASS, objsubid: 2 }]); // 2 = (int, int) form
    });

    it('concurrent first-time writes end with one stored value and consistent audit rows', async () => {
      await Promise.all([
        call('PUT', '/staff/usd-rate', MANAGER, { rate: '100.0000' }),
        call('PUT', '/staff/usd-rate', ADMIN, { rate: '200.0000' }),
      ]);
      const rows = await t.prisma.auditLog.findMany({ where: { action: 'USD_RATE_CHANGED' } });
      expect(rows).toHaveLength(2);
      const stored = (await call('GET', '/staff/usd-rate')).body.rate as string;
      const froms = rows.map((r) => (r.diff as Body).rate.from);
      const tos = rows.map((r) => (r.diff as Body).rate.to);
      // One write saw "unset", the other saw the first one's value: a clean chain.
      expect(froms).toContain(null);
      expect(tos).toContain(stored);
      expect(froms.filter((f) => f !== null)).toEqual([tos.find((x) => x !== stored)]);
    });
  });

  describe('cost reference', () => {
    it('is empty for a product without deliveries', async () => {
      const r = await call('GET', `/staff/products/${apple}/cost-reference`);
      expect(r.body).toMatchObject({
        productId: apple,
        productCode: 'APPLE',
        latest: null,
        deliveries: [],
      });
    });

    it('404 for an unknown product, 422 for a bad id', async () => {
      expect(
        (await call('GET', '/staff/products/019a0000-0000-7000-8000-000000000000/cost-reference'))
          .status,
      ).toBe(404);
      expect((await call('GET', '/staff/products/nope/cost-reference')).status).toBe(422);
    });

    it('latest is the newest delivery; the list is newest first with the opened details', async () => {
      await sync.upsertDeliveries([
        delivery('R-100', '2026-09-01T00:00:00Z', { availableQuantity: D('0') }),
        delivery('R-300', '2026-10-15T00:00:00Z', { availableQuantity: D('40.250') }),
        delivery('R-200', '2026-10-01T00:00:00Z', { availableQuantity: D('5') }),
      ]);
      const r = await call('GET', `/staff/products/${apple}/cost-reference`);
      const body = productCostReferenceResponseSchema.parse(r.body);
      expect(body.deliveries.map((d) => d.deliveryRef)).toEqual(['R-300', 'R-200', 'R-100']);
      expect(body.latest).toEqual(body.deliveries[0]);
      expect(body.latest).toMatchObject({
        deliveryRef: 'R-300',
        deliveredQuantity: '1000.125',
        availableQuantity: '40.250',
      });
    });

    it('equal timestamps are ordered stably (delivery_ref descending), never flipping', async () => {
      const same = '2026-10-15T00:00:00Z';
      await sync.upsertDeliveries([
        delivery('A-1', same),
        delivery('C-3', same),
        delivery('B-2', same),
      ]);
      for (let i = 0; i < 3; i += 1) {
        const r = await call('GET', `/staff/products/${apple}/cost-reference`);
        expect(r.body.deliveries.map((d: Body) => d.deliveryRef)).toEqual(['C-3', 'B-2', 'A-1']);
        expect(r.body.latest.deliveryRef).toBe('C-3');
      }
    });

    it('round-trips exact decimals with no float drift', async () => {
      await sync.upsertDeliveries([
        delivery('EXACT', '2026-10-15T00:00:00Z', {
          deliveredQuantity: D('999999999999999.999'),
          costUsd: D('0.0001'),
          usdRateUsed: D('99999999999999.9999'),
          costUzs: D('9999999999999999.99'),
        }),
      ]);
      const stored = await t.prisma.$queryRaw<Record<string, string>[]>`
        SELECT delivered_quantity::text AS q, cost_usd::text AS usd, usd_rate_used::text AS rate, cost_uzs::text AS uzs
        FROM price_reference`;
      expect(stored[0]).toEqual({
        q: '999999999999999.999',
        usd: '0.0001',
        rate: '99999999999999.9999',
        uzs: '9999999999999999.99',
      });
      const r = await call('GET', `/staff/products/${apple}/cost-reference`);
      expect(r.body.latest).toMatchObject({
        deliveredQuantity: '999999999999999.999',
        costUsd: '0.0001',
        usdRateUsed: '99999999999999.9999',
        costUzs: '9999999999999999.99',
      });
    });
  });

  describe('per-product history carries supplier, purchase method and category', () => {
    it('lists them per delivery next to the available quantity', async () => {
      await sync.upsertDeliveries([
        delivery('R-1', '2026-10-01T00:00:00Z', {
          supplier: 'Beta system tm fbs',
          category: 'Планшеты',
        }),
        delivery('R-2', '2026-10-02T00:00:00Z', { availableQuantity: D('7') }),
      ]);
      const r = await call('GET', `/staff/products/${apple}/cost-reference`, ACCOUNTANT);
      const body = productCostReferenceResponseSchema.parse(r.body);
      expect(
        body.deliveries.map((d) => [
          d.deliveryRef,
          d.supplier,
          d.purchaseMethod,
          d.category,
          d.availableQuantity,
        ]),
      ).toEqual([
        ['R-2', 'alpha trade import', 'Безнал', 'Смартфоны', '7.000'],
        ['R-1', 'Beta system tm fbs', 'Безнал', 'Планшеты', '250.500'],
      ]);
    });
  });

  describe('GET /staff/price-list/current/costs (one call for the whole current list)', () => {
    const url = '/staff/price-list/current/costs';
    let pear: string;
    let quince: string;

    /** Publishes a list with the given products so the costs endpoint has a current list. */
    async function publishList(productIds: string[]): Promise<void> {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: productIds.map((productId) => ({ productId, basePrice: '190000.00' })),
      });
      expect((await call('POST', `/staff/price-list/drafts/${draft}/publish`)).status).toBe(200);
    }

    beforeEach(async () => {
      pear = (await t.prisma.product.create({ data: { productCode: 'PEAR', unit: 'box' } })).id;
      quince = (await t.prisma.product.create({ data: { productCode: 'QUINCE', unit: 'box' } })).id;
    });

    it('401 without an actor; 403 for customers, warehouse and driver; 200 for manager, accountant, admin', async () => {
      await publishList([apple]);
      expect((await t.request('GET', url)).status).toBe(401);
      for (const actor of [SHOP_OWNER, SELLER, WAREHOUSE, DRIVER]) {
        expect((await call('GET', url, actor)).status, actor.userId).toBe(403);
      }
      for (const actor of [MANAGER, ACCOUNTANT, ADMIN]) {
        expect((await call('GET', url, actor)).status, actor.userId).toBe(200);
      }
    });

    it('404 when nothing is published', async () => {
      expect((await call('GET', url)).status).toBe(404);
    });

    it('returns latest, the 5 most recent deliveries (newest first) and the stock aggregate per product', async () => {
      await publishList([apple, pear, quince]);
      await sync.upsertDeliveries(
        Array.from({ length: 7 }, (_, i) =>
          delivery(`R-${i}`, `2026-10-0${i + 1}T00:00:00Z`, {
            supplier: i % 2 === 0 ? 'alpha trade import' : 'Beta system tm fbs',
            costUsd: D(`${10 + i}.0000`),
          }),
        ),
      );
      // pear: one delivery; quince: none.
      await sync.upsertDeliveries([delivery('P-1', '2026-10-05T00:00:00Z', { productId: pear })]);
      await t.prisma.stockCache.create({
        data: { productId: apple, quantity: '312.500', syncedAt: new Date() },
      });

      const r = await call('GET', url);
      const body = priceListCostsResponseSchema.parse(r.body);
      const byId = new Map(body.items.map((i) => [i.productId, i]));
      expect(body.items).toHaveLength(3);

      const a = byId.get(apple)!;
      expect(a.recent.map((d) => d.deliveryRef)).toEqual(['R-6', 'R-5', 'R-4', 'R-3', 'R-2']);
      expect(a.latest).toEqual(a.recent[0]);
      expect(a.latest).toMatchObject({
        deliveryRef: 'R-6',
        supplier: 'alpha trade import',
        costUsd: '16.0000',
        usdRateUsed: '12650.5000',
        costUzs: '156190.50',
        deliveredAt: '2026-10-07T00:00:00.000Z',
      });
      expect(a.stockQuantity).toBe('312.500');
      // Every supplier of every live line, not only of the 5 recent ones, sorted.
      expect(a.suppliers).toEqual(['Beta system tm fbs', 'alpha trade import']);

      expect(byId.get(pear)!.recent.map((d) => d.deliveryRef)).toEqual(['P-1']);
      expect(byId.get(pear)!.stockQuantity).toBeNull();
      expect(byId.get(quince)).toEqual({
        productId: quince,
        latest: null,
        recent: [],
        stockQuantity: null,
        suppliers: [],
      });
    });

    it('uses the existing latest rule: newest delivered_at, ties by delivery ref descending', async () => {
      await publishList([apple]);
      const same = '2026-10-15T00:00:00Z';
      await sync.upsertDeliveries([
        delivery('A-1', same),
        delivery('C-3', same),
        delivery('B-2', same),
      ]);
      const body = priceListCostsResponseSchema.parse((await call('GET', url)).body);
      expect(body.items[0]?.recent.map((d) => d.deliveryRef)).toEqual(['C-3', 'B-2', 'A-1']);
      expect(body.items[0]?.latest?.deliveryRef).toBe('C-3');
      // The per-product history agrees.
      const history = await call('GET', `/staff/products/${apple}/cost-reference`);
      expect(history.body.latest.deliveryRef).toBe('C-3');
    });

    it('is not part of the existing price list DTOs, and customers still get no cost', async () => {
      await publishList([apple]);
      await sync.upsertDeliveries([delivery('R-1', '2026-10-01T00:00:00Z')]);
      for (const path of ['/staff/price-list/current', '/staff/price-list/versions']) {
        const text = JSON.stringify((await call('GET', path)).body);
        expect(text).not.toContain('recent');
        expect(text).not.toContain('stockQuantity');
        expect(text).not.toContain('alpha trade import');
      }
    });

    it('sends a fixed number of SQL statements whatever the list size (no N+1)', async () => {
      await publishList([apple]);
      const small = await recordSql(t.prisma, async () => {
        expect((await call('GET', url)).status).toBe(200);
      });

      await t.prisma.product.createMany({
        data: Array.from({ length: 40 }, (_, i) => ({ productCode: `MANY-${i}`, unit: 'box' })),
      });
      const many = await t.prisma.product.findMany({
        where: { productCode: { startsWith: 'MANY-' } },
      });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: many.map((p) => ({ productId: p.id, basePrice: '1.00' })),
      });
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);
      let items: unknown[] = [];
      const large = await recordSql(t.prisma, async () => {
        items = (await call('GET', url)).body.items as unknown[];
      });
      expect(items).toHaveLength(41);

      expect(small.length).toBeGreaterThan(0);
      expect(large.length).toBe(small.length);
    });

    it('the recent-deliveries read is one SQL statement (window function)', async () => {
      const repository = t.get(PriceReferenceRepository);
      const statements = await recordSql(t.prisma, () =>
        repository.findRecentByProducts([apple, pear, quince], 5),
      );
      expect(statements).toHaveLength(1);
    });
  });

  describe('sync writes (system action, full history)', () => {
    it('creates rows with a NULL actor, a SHEET_SYNC action and the full new state', async () => {
      const result = await sync.upsertDeliveries([delivery('R-1', '2026-10-15T00:00:00Z')]);
      expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { entityType: 'PRICE_REFERENCE' },
      });
      expect(row.actorUserId).toBeNull();
      expect(row.action).toBe('SHEET_SYNC_CREATED');
      expect(row.createdAt.toISOString()).toBe('2026-10-20T08:00:00.000Z');
      expect(row.diff).toMatchObject({
        productId: { from: null, to: apple },
        deliveryRef: { from: null, to: 'R-1' },
        availableQuantity: { from: null, to: '250.500' },
        costUsd: { from: null, to: '12.3456' },
      });
    });

    it('is idempotent: re-running the same data writes and audits nothing', async () => {
      const rows = [
        delivery('R-1', '2026-10-15T00:00:00Z'),
        delivery('R-2', '2026-10-16T00:00:00Z'),
      ];
      await sync.upsertDeliveries(rows);
      const auditBefore = await t.prisma.auditLog.count();
      const syncedBefore = (await t.prisma.priceReference.findMany()).map((r) =>
        r.syncedAt.toISOString(),
      );

      t.clock.set(new Date('2026-10-25T08:00:00Z'));
      const again = await sync.upsertDeliveries(rows);
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
      await expect(t.prisma.auditLog.count()).resolves.toBe(auditBefore);
      const syncedAfter = (await t.prisma.priceReference.findMany()).map((r) =>
        r.syncedAt.toISOString(),
      );
      expect(syncedAfter).toEqual(syncedBefore);
    });

    it('updates a changed row and records before AND after for the changed fields only', async () => {
      await sync.upsertDeliveries([delivery('R-1', '2026-10-15T00:00:00Z')]);
      t.clock.set(new Date('2026-10-25T08:00:00Z'));
      const result = await sync.upsertDeliveries([
        delivery('R-1', '2026-10-15T00:00:00Z', { availableQuantity: D('100'), costUsd: D('13') }),
      ]);
      expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHEET_SYNC_UPDATED' },
      });
      expect(row.actorUserId).toBeNull();
      expect(row.diff).toEqual({
        availableQuantity: { from: '250.500', to: '100.000' },
        costUsd: { from: '12.3456', to: '13.0000' },
      });
      const stored = await t.prisma.priceReference.findFirstOrThrow();
      expect(stored.syncedAt.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    });

    it('a failed audit insert rolls the whole sync back', async () => {
      vi.spyOn(t.get(AuditService), 'recordSystemMany').mockRejectedValue(new Error('audit down'));
      await expect(
        sync.upsertDeliveries([delivery('R-1', '2026-10-15T00:00:00Z')]),
      ).rejects.toThrow('audit down');
      await expect(t.prisma.priceReference.count()).resolves.toBe(0);
    });

    it('handles the same delivery twice in one batch without a unique violation', async () => {
      const result = await sync.upsertDeliveries([
        delivery('R-1', '2026-10-15T00:00:00Z'),
        delivery('R-1', '2026-10-15T00:00:00Z', { availableQuantity: D('1') }),
      ]);
      expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
      await expect(t.prisma.priceReference.count()).resolves.toBe(1);
      // The last occurrence wins.
      expect((await t.prisma.priceReference.findFirstOrThrow()).availableQuantity.toFixed(3)).toBe(
        '1.000',
      );
    });
  });

  describe('customers never see cost data', () => {
    it('customer price list and every customer response contain no cost reference data', async () => {
      await sync.upsertDeliveries([
        delivery('SECRET-REF-1', '2026-10-15T00:00:00Z'),
        delivery('SECRET-REF-2', '2026-10-16T00:00:00Z'),
      ]);
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      // The recommended retail price is the one price a customer sees besides what they pay
      // [C, 2026-11-09]; it comes back while every cost value below stays out.
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '190000.00', rrp: '200000.00' }],
      });
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);

      // A staff member in the customer app (the staff viewer, [C] 2026-11-09) reads the same
      // allow-listed DTO as a customer, and the cost routes are closed to that actor as well.
      for (const actor of [SHOP_OWNER, SELLER, STAFF_VIEWER]) {
        for (const lang of ['UZ', 'RU', 'EN']) {
          const r = await call('GET', `/price-list/current?lang=${lang}`, actor);
          expect(r.status).toBe(200);
          customerPriceListResponseSchema.parse(r.body); // strict: any extra key fails
          // 200000.00 USD x 12650.5, whole so'm: the RRP is returned, converted like the price.
          expect(r.body.items.map((item: Body) => item.rrp)).toEqual(['2530100000.00']);
          expect(findForbiddenKeys(r.body)).toEqual([]);
          expect(findStaffOnlyFieldsInCustomerPriceList(r.body), lang).toEqual([]);
          const text = JSON.stringify(r.body);
          for (const secret of [
            'SECRET-REF',
            '156190',
            '12.3456',
            '12650',
            '1000.125',
            '250.500',
            'alpha trade import',
            'Безнал',
            'Смартфоны',
          ]) {
            expect(containsStandalone(text, secret), `${lang} must not contain ${secret}`).toBe(
              false,
            );
          }
        }
        // And the cost routes themselves are closed to them.
        expect((await call('GET', `/staff/products/${apple}/cost-reference`, actor)).status).toBe(
          403,
        );
        expect((await call('GET', '/staff/usd-rate', actor)).status).toBe(403);
      }
    });

    it('a staff role on the customer price list route gets the customer DTO, not a staff one [C, 2026-11-09]', async () => {
      await sync.upsertDeliveries([delivery('SECRET-REF-1', '2026-10-15T00:00:00Z')]);
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '190000.00' }],
      });
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);

      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(customer.status).toBe(200);
      // Roles that read cost in the staff app: on this route they are the staff viewer.
      for (const actor of [MANAGER, ADMIN, ACCOUNTANT]) {
        const r = await call('GET', '/price-list/current', actor);
        expect(r.status).toBe(200);
        customerPriceListResponseSchema.parse(r.body); // strict: any extra key fails
        expect(findForbiddenKeys(r.body)).toEqual([]);
        expect(findStaffOnlyFieldsInCustomerPriceList(r.body)).toEqual([]);
        expect(JSON.stringify(r.body)).not.toMatch(/SECRET-REF|12650|156190/);
        expect(r.body).toEqual(customer.body);
      }
      // The warehouse and the driver see no price anywhere, here included.
      for (const actor of [WAREHOUSE, DRIVER]) {
        expect((await call('GET', '/price-list/current', actor)).status).toBe(403);
      }
    });

    it('EVERY customer-reachable response is free of staff-only field names (stock, supplier, ...), any case', async () => {
      await sync.upsertDeliveries([delivery('SECRET-REF-1', '2026-10-15T00:00:00Z')]);
      await t.prisma.stockCache.create({
        data: { productId: apple, quantity: '312.500', syncedAt: new Date() },
      });
      const customers = [SHOP_OWNER, SELLER, STAFF_VIEWER];
      const responses: [string, unknown][] = [];

      // Before anything is published: the 404 body.
      for (const actor of customers) {
        responses.push([
          `404 ${actor.userId}`,
          (await call('GET', '/price-list/current', actor)).body,
        ]);
      }
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '190000.00' }],
      });
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);

      for (const actor of customers) {
        for (const lang of ['UZ', 'RU', 'EN']) {
          responses.push([
            `list ${actor.userId} ${lang}`,
            (await call('GET', `/price-list/current?lang=${lang}`, actor)).body,
          ]);
        }
        responses.push([
          `bad lang ${actor.userId}`,
          (await call('GET', '/price-list/current?lang=DE', actor)).body,
        ]);
        for (const path of [
          `/staff/products/${apple}/cost-reference`,
          '/staff/price-list/current/costs',
          '/staff/price-list/current',
          '/staff/products',
          '/staff/usd-rate',
        ]) {
          responses.push([`403 ${path}`, (await call('GET', path, actor)).body]);
        }
      }

      expect(responses.length).toBeGreaterThan(10);
      for (const [label, body] of responses) {
        // The customer price list items are the one place a category label is allowed
        // (owner decision 2026-10-23); everything else, including the error bodies, is strict.
        const isPriceList = label.startsWith('list ');
        expect(
          isPriceList ? findStaffOnlyFieldsInCustomerPriceList(body) : findStaffOnlyFields(body),
          label,
        ).toEqual([]);
        expect(findForbiddenKeys(body), label).toEqual([]);
        const text = JSON.stringify(body).toLowerCase();
        for (const word of [
          'stock',
          'instock',
          'available',
          'stockcache',
          'supplier',
          'purchasemethod',
          ...(isPriceList ? [] : ['category']),
        ]) {
          expect(text, `${label} must not mention ${word}`).not.toContain(word);
        }
      }
    });

    it('cost data is also absent from the other staff responses (products, price lists, history)', async () => {
      await sync.upsertDeliveries([delivery('SECRET-REF-1', '2026-10-15T00:00:00Z')]);
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '190000.00' }],
      });
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);
      for (const path of [
        '/staff/products',
        `/staff/products/${apple}`,
        '/staff/price-list/current',
        '/staff/price-list/versions',
        `/staff/price-list/versions/${draft}`,
        `/staff/products/${apple}/price-history`,
      ]) {
        const r = await call('GET', path);
        // The staff list carries the selling price tier [C, 2026-11-11]: not cost, stripped here only.
        expect(
          findForbiddenKeys(stripStaffPriceTier(stripStaffRateSnapshot(r.body))),
          path,
        ).toEqual([]);
        // The staff PRODUCT endpoints (and only they) carry the product category, staff-only (the
        // sheet text and the staff-managed category id); every other staff-only name stays out.
        const isProductEndpoint = path === '/staff/products' || path === `/staff/products/${apple}`;
        const staffOnly = findStaffOnlyFields(r.body).filter(
          (field) => !(isProductEndpoint && /\.category(Id)?$/.test(field)),
        );
        expect(staffOnly, path).toEqual([]);
        expect(JSON.stringify(r.body), path).not.toContain('SECRET-REF');
      }
    });
  });
});
