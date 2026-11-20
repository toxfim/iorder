import {
  createDraftWithRateResponseSchema,
  publishChangesWithRateResponseSchema,
  publishWithRateResponseSchema,
  staffPriceListWithRateResponseSchema,
  staffVersionListWithRateResponseSchema,
  staffVersionWithRateResponseSchema,
  staffProductDetailListResponseSchema,
  staffProductDetailResponseSchema,
} from '@iorder/shared/staff-cost';
import {
  ERROR_CODES,
  customerPriceListResponseSchema,
  errorBodySchema,
  priceHistoryResponseSchema,
} from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInTransaction } from '../src/common/database/transaction.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/index.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PricingModule, PricingService } from '../src/modules/pricing/index.js';
import { UsdRateService } from '../src/modules/pricing/usd-rate/usd-rate.service.js';
import {
  findForbiddenKeys,
  stripStaffPriceTier,
  stripStaffRateSnapshot,
} from './support/forbidden-fields.js';
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

/** A round USD rate keeps the expected UZS amounts readable: 10.00 USD = 1 000 UZS. */
const RATE = '100';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

/** Asserts 409 CONFLICT with a machine-readable reason. */
function expectConflict(r: { status: number; body: Body }, reason: string, label: string): void {
  expect(r.status, label).toBe(409);
  expect(r.body.error.code, label).toBe('CONFLICT');
  expect(r.body.error.reason, label).toBe(reason);
}

describe('pricing (real PostgreSQL)', () => {
  let t: TestApp;
  let apple: string;
  let pear: string;

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
    // Prices are entered in USD [owner 2026-10-29]; customers see them x this rate in UZS.
    await t.prisma.appSetting.deleteMany({ where: { key: 'usd_rate' } });
    await t.get(UsdRateService).setUsdRate(MANAGER, new Prisma.Decimal(RATE));
    const make = async (productCode: string, uz: string, ru: string): Promise<string> =>
      (
        await t.prisma.product.create({
          data: {
            productCode,
            unit: 'box',
            translations: {
              create: [
                { lang: 'UZ', name: uz },
                { lang: 'RU', name: ru },
              ],
            },
          },
        })
      ).id;
    apple = await make('APPLE', 'Olma', 'Яблоко');
    pear = await make('PEAR', 'Nok', 'Груша');
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

  /** Creates a draft with the given prices (productId -> price) and publishes it. */
  async function publishVersion(prices: Record<string, string>, actor = MANAGER): Promise<string> {
    const draft = await call('POST', '/staff/price-list/drafts', actor, { copyFromCurrent: false });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    const put = await call('PUT', `/staff/price-list/drafts/${id}/items`, actor, {
      items: Object.entries(prices).map(([productId, basePrice]) => ({ productId, basePrice })),
    });
    expect(put.status).toBe(200);
    expect((await call('POST', `/staff/price-list/drafts/${id}/publish`, actor)).status).toBe(200);
    return id;
  }

  describe('permissions and validation', () => {
    it('401 without an actor on every route', async () => {
      for (const [method, path] of [
        ['GET', '/price-list/current'],
        ['GET', '/staff/price-list/current'],
        ['GET', '/staff/price-list/versions'],
        ['POST', '/staff/price-list/drafts'],
        ['POST', '/staff/price-list/drafts/019a0000-0000-7000-8000-000000000000/publish'],
        ['POST', '/staff/price-list/publish'],
        ['GET', '/staff/products/019a0000-0000-7000-8000-000000000000/price-history'],
      ] as const) {
        expect((await t.request(method, path)).status, `${method} ${path}`).toBe(401);
      }
    });

    it('customers cannot edit prices; warehouse and driver cannot browse', async () => {
      for (const actor of [SHOP_OWNER, SELLER, ACCOUNTANT, WAREHOUSE, DRIVER]) {
        expect((await call('POST', '/staff/price-list/drafts', actor, {})).status).toBe(403);
        expect(
          (await call('POST', '/staff/price-list/publish', actor, { baseVersionNumber: null }))
            .status,
        ).toBe(403);
        expect((await call('GET', '/staff/price-list/versions', actor)).status).toBe(403);
      }
      for (const actor of [WAREHOUSE, DRIVER]) {
        expect((await call('GET', '/price-list/current', actor)).status).toBe(403);
        expect((await call('GET', '/staff/price-list/current', actor)).status).toBe(403);
      }
    });

    it('customers and accountants may browse; customers get 403 on the staff view', async () => {
      await publishVersion({ [apple]: '10.00' });
      for (const actor of [SHOP_OWNER, SELLER, ACCOUNTANT, MANAGER, ADMIN]) {
        expect((await call('GET', '/price-list/current', actor)).status).toBe(200);
      }
      expect((await call('GET', '/staff/price-list/current', ACCOUNTANT)).status).toBe(200);
      expect((await call('GET', '/staff/price-list/current', SHOP_OWNER)).status).toBe(403);
      expect((await call('GET', '/staff/price-list/current', SELLER)).status).toBe(403);
    });

    it('422 for bad prices (float, zero, negative, 3 decimals, overflow) and bad shapes', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      const url = `/staff/price-list/drafts/${draft}/items`;
      for (const basePrice of [
        1690000.1,
        '0',
        '0.00',
        '-5',
        '10.001',
        '1e3',
        '',
        '10000000000000000',
      ]) {
        const r = await call('PUT', url, MANAGER, { items: [{ productId: apple, basePrice }] });
        expect(r.status, JSON.stringify(basePrice)).toBe(422);
      }
      expect((await call('PUT', url, MANAGER, { items: [] })).status).toBe(422);
      expect(
        (
          await call('PUT', url, MANAGER, {
            items: [
              { productId: apple, basePrice: '1.00' },
              { productId: apple, basePrice: '2.00' },
            ],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await call('PUT', url, MANAGER, {
            items: [{ productId: apple, basePrice: '1.00', cost: '1' }],
          })
        ).status,
      ).toBe(422);
      expect((await call('PUT', '/staff/price-list/drafts/nope/items', MANAGER, {})).status).toBe(
        422,
      );
      expect((await call('GET', '/price-list/current?lang=DE', MANAGER)).status).toBe(422);
    });

    it('404 for unknown products and versions; 404 when nothing is published', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      const unknown = '019a0000-0000-7000-8000-000000000000';
      expect(
        (
          await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
            items: [{ productId: unknown, basePrice: '1.00' }],
          })
        ).status,
      ).toBe(404);
      expect((await call('GET', `/staff/price-list/versions/${unknown}`)).status).toBe(404);
      expect((await call('GET', '/price-list/current', SHOP_OWNER)).status).toBe(404);
    });
  });

  describe('lifecycle rules', () => {
    it('publish archives the previous version; only one PUBLISHED remains', async () => {
      const first = await publishVersion({ [apple]: '10.00' });
      t.clock.set(new Date('2026-10-21T09:00:00Z'));
      const second = await publishVersion({ [apple]: '11.00' });
      const rows = await t.prisma.priceListVersion.findMany({ orderBy: { number: 'asc' } });
      expect(rows.map((r) => [r.id, r.status])).toEqual([
        [first, 'ARCHIVED'],
        [second, 'PUBLISHED'],
      ]);
      expect(rows[1]?.publishedAt?.toISOString()).toBe('2026-10-21T09:00:00.000Z');
      expect(rows[1]?.publishedBy).toBe(MANAGER.userId);
    });

    it('published versions are immutable through the API (reason DRAFT_NOT_OPEN)', async () => {
      const id = await publishVersion({ [apple]: '10.00' });
      const url = `/staff/price-list/drafts/${id}`;
      expectConflict(
        await call('PUT', `${url}/items`, MANAGER, {
          items: [{ productId: apple, basePrice: '1.00' }],
        }),
        'DRAFT_NOT_OPEN',
        'upsert',
      );
      expectConflict(await call('DELETE', `${url}/items/${apple}`), 'DRAFT_NOT_OPEN', 'remove');
      expectConflict(await call('PATCH', url, MANAGER, { note: 'x' }), 'DRAFT_NOT_OPEN', 'patch');
      expectConflict(await call('DELETE', url), 'DRAFT_NOT_OPEN', 'discard');
      expectConflict(await call('POST', `${url}/publish`), 'DRAFT_NOT_OPEN', 'publish');
      expect((await call('GET', '/price-list/current', SHOP_OWNER)).body.items[0].price).toBe(
        '1000.00',
      );
    });

    it('two concurrent draft creations: exactly one 201, the other 409 (partial unique index)', async () => {
      for (let round = 0; round < 5; round += 1) {
        const results = await Promise.all([
          call('POST', '/staff/price-list/drafts', MANAGER, {}),
          call('POST', '/staff/price-list/drafts', ADMIN, {}),
        ]);
        expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.error.reason).toBe('DRAFT_ALREADY_OPEN');
        await expect(t.prisma.priceListVersion.count({ where: { status: 'DRAFT' } })).resolves.toBe(
          1,
        );
        const winner = results.find((r) => r.status === 201)!.body.id as string;
        expect((await call('DELETE', `/staff/price-list/drafts/${winner}`)).status).toBe(204);
      }
    });

    it('an ARCHIVED version answers VERSION_NOT_DRAFT', async () => {
      const first = await publishVersion({ [apple]: '10.00' });
      await publishVersion({ [apple]: '11.00' }); // archives the first one
      const url = `/staff/price-list/drafts/${first}`;
      expectConflict(await call('POST', `${url}/publish`), 'VERSION_NOT_DRAFT', 'publish archived');
      expectConflict(
        await call('PATCH', url, MANAGER, { note: 'x' }),
        'VERSION_NOT_DRAFT',
        'patch archived',
      );
      expectConflict(
        await call('PUT', `${url}/items`, MANAGER, {
          items: [{ productId: apple, basePrice: '1.00' }],
        }),
        'VERSION_NOT_DRAFT',
        'upsert archived',
      );
    });

    it('allows only one open draft (restrictive choice) and cannot publish an empty draft', async () => {
      const first = await call('POST', '/staff/price-list/drafts', MANAGER, {});
      expectConflict(
        await call('POST', '/staff/price-list/drafts', MANAGER, {}),
        'DRAFT_ALREADY_OPEN',
        'second draft',
      );
      expectConflict(
        await call('POST', `/staff/price-list/drafts/${first.body.id}/publish`),
        'EMPTY_DRAFT',
        'empty publish',
      );
      expect((await call('DELETE', `/staff/price-list/drafts/${first.body.id}`)).status).toBe(204);
      expect((await call('POST', '/staff/price-list/drafts', MANAGER, {})).status).toBe(201);
    });

    it('copy creates a draft with the published prices; editing it does not touch the published list', async () => {
      await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      const draft = await call('POST', '/staff/price-list/drafts', MANAGER, {
        copyFromCurrent: true,
      });
      expect(draft.status).toBe(201);
      const edited = await call('PUT', `/staff/price-list/drafts/${draft.body.id}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '12.50' }],
      });
      expect(edited.body.items.map((i: Body) => [i.productCode, i.basePrice])).toEqual([
        ['APPLE', '12.50'],
        ['PEAR', '20.00'],
      ]);
      const current = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(current.body.items.map((i: Body) => i.price)).toEqual(['1000.00', '2000.00']);
    });

    it('GET /staff/price-list/drafts/current returns the open draft, or 404 when there is none', async () => {
      const url = '/staff/price-list/drafts/current';
      expect((await call('GET', url)).status).toBe(404);
      expect((await call('GET', url)).body.error.code).toBe('NOT_FOUND');

      const created = await call('POST', '/staff/price-list/drafts', MANAGER, { note: 'Oct' });
      const current = await call('GET', url, ADMIN);
      expect(current.status).toBe(200);
      expect(staffVersionWithRateResponseSchema.parse(current.body)).toMatchObject({
        id: created.body.id,
        status: 'DRAFT',
        note: 'Oct',
      });

      // After publishing there is no open draft any more; after discarding neither.
      await call('PUT', `/staff/price-list/drafts/${created.body.id}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '10.00' }],
      });
      await call('POST', `/staff/price-list/drafts/${created.body.id}/publish`);
      expect((await call('GET', url)).status).toBe(404);
      const second = await call('POST', '/staff/price-list/drafts', MANAGER, {});
      expect((await call('GET', url)).status).toBe(200);
      await call('DELETE', `/staff/price-list/drafts/${second.body.id}`);
      expect((await call('GET', url)).status).toBe(404);
    });

    it('GET /staff/price-list/drafts/current: 401 without an actor, 403 for non-managers', async () => {
      const url = '/staff/price-list/drafts/current';
      expect((await t.request('GET', url)).status).toBe(401);
      for (const actor of [SHOP_OWNER, SELLER, ACCOUNTANT, WAREHOUSE, DRIVER]) {
        expect((await call('GET', url, actor)).status, actor.userId).toBe(403);
      }
    });

    it('copyFromCurrent skips inactive products and reports how many (skippedInactiveCount)', async () => {
      const quince = (
        await t.prisma.product.create({ data: { productCode: 'QUINCE', unit: 'box' } })
      ).id;
      await publishVersion({ [apple]: '10.00', [pear]: '20.00', [quince]: '30.00' });
      await call('PATCH', `/staff/products/${pear}`, MANAGER, { isActive: false });
      await call('PATCH', `/staff/products/${quince}`, MANAGER, { isActive: false });

      const draft = await call('POST', '/staff/price-list/drafts', MANAGER, {
        copyFromCurrent: true,
      });
      expect(draft.status).toBe(201);
      expect(createDraftWithRateResponseSchema.parse(draft.body).skippedInactiveCount).toBe(2);
      const detail = await call('GET', `/staff/price-list/versions/${draft.body.id}`);
      expect(detail.body.items.map((i: Body) => i.productCode)).toEqual(['APPLE']);

      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_DRAFT_COPIED', entityId: draft.body.id },
      });
      expect(audit.diff).toMatchObject({
        itemCount: { from: null, to: 1 },
        skippedInactiveCount: { from: null, to: 2 },
      });

      // The copy can be published as is: nothing inactive is left in it.
      expect((await call('POST', `/staff/price-list/drafts/${draft.body.id}/publish`)).status).toBe(
        200,
      );
    });

    it('skippedInactiveCount is 0 for a plain draft and for a copy without inactive products', async () => {
      const plain = await call('POST', '/staff/price-list/drafts', MANAGER, {});
      expect(createDraftWithRateResponseSchema.parse(plain.body).skippedInactiveCount).toBe(0);
      await call('DELETE', `/staff/price-list/drafts/${plain.body.id}`);
      await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      const copy = await call('POST', '/staff/price-list/drafts', MANAGER, {
        copyFromCurrent: true,
      });
      expect(createDraftWithRateResponseSchema.parse(copy.body).skippedInactiveCount).toBe(0);
      const detail = await call('GET', `/staff/price-list/versions/${copy.body.id}`);
      expect(detail.body.items).toHaveLength(2);
    });

    it('copyFromCurrent without a published version is a conflict (NO_PUBLISHED_VERSION)', async () => {
      expectConflict(
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true }),
        'NO_PUBLISHED_VERSION',
        'copy',
      );
    });

    it('inactive products cannot be priced and disappear from the customer list', async () => {
      await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      await call('PATCH', `/staff/products/${pear}`, MANAGER, { isActive: false });
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(customer.body.items.map((i: Body) => i.productCode)).toEqual(['APPLE']);
      const staff = await call('GET', '/staff/price-list/current', MANAGER);
      expect(staff.body.items.map((i: Body) => i.productCode)).toEqual(['APPLE', 'PEAR']);
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id;
      const priced = await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: pear, basePrice: '1.00' }],
      });
      expectConflict(priced, 'INACTIVE_PRODUCT', 'price inactive');
      expect(priced.body.error.details).toEqual({ productIds: [pear] });
    });

    it('staff and customer DTOs show the product code with its original spelling', async () => {
      const honor = await t.prisma.product.create({
        data: {
          productCode: 'HONOR-X7C-6GB128GB-MidnightBlack',
          unit: 'box',
          translations: { create: [{ lang: 'UZ', name: 'Honor X7c' }] },
        },
      });
      await publishVersion({ [honor.id]: '1690000.10' });
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(customer.body.items[0].productCode).toBe('HONOR-X7C-6GB128GB-MidnightBlack');
      const staff = await call('GET', '/staff/price-list/current');
      expect(staff.body.items[0].productCode).toBe('HONOR-X7C-6GB128GB-MidnightBlack');
      const history = await call('GET', `/staff/products/${honor.id}/price-history`);
      expect(history.body.productCode).toBe('HONOR-X7C-6GB128GB-MidnightBlack');
    });

    it('customer list shows one common name whatever the requested language', async () => {
      await publishVersion({ [apple]: '10.00' });
      const ru = await call('GET', '/price-list/current?lang=RU', SHOP_OWNER);
      const en = await call('GET', '/price-list/current?lang=EN', SHOP_OWNER);
      const dflt = await call('GET', '/price-list/current', SHOP_OWNER);
      expect([ru.body.items[0].name, en.body.items[0].name, dflt.body.items[0].name]).toEqual([
        'Olma',
        'Olma',
        'Olma',
      ]);
    });
  });

  describe('publish changes without a draft (the staff app flow)', () => {
    const publishChanges = (
      body: unknown,
      actor = MANAGER,
    ): Promise<{ status: number; body: Body }> =>
      call('POST', '/staff/price-list/publish', actor, body);
    const codesOf = (list: Body): string[] => list.items.map((i: Body) => i.productCode);
    // Version numbers come from a sequence that is not reset between tests: read, never assume.
    const currentNumber = async (): Promise<number> =>
      (await call('GET', '/staff/price-list/current')).body.version.number as number;
    const pricesOf = (list: Body): Record<string, string> =>
      Object.fromEntries(list.items.map((i: Body) => [i.productCode, i.basePrice ?? i.price]));

    it('the first call (base null) publishes v1 directly, in one transaction, with a parsed response', async () => {
      const r = await publishChanges({
        baseVersionNumber: null,
        upserts: [{ productId: apple, basePrice: '10.00' }],
      });
      expect(r.status).toBe(200);
      const parsed = publishChangesWithRateResponseSchema.parse(r.body);
      expect(parsed).toMatchObject({
        status: 'PUBLISHED',
        // This fixture actor is no real person: no name, and the stored id is never shown instead.
        publishedBy: null,
        publishedByUserId: null,
        skippedInactiveCount: 0,
      });
      expect(parsed.publishedAt).toBe('2026-10-20T08:00:00.000Z');
      expect(findForbiddenKeys(stripStaffRateSnapshot(r.body))).toEqual([]);
      const rows = await t.prisma.priceListVersion.findMany();
      expect(rows.map((v) => v.status)).toEqual(['PUBLISHED']);
      expect(rows[0]?.number).toBe(parsed.number);
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(pricesOf(customer.body)).toEqual({ APPLE: '1000.00' });
    });

    it('applies upserts and removals on the published list and archives the old version', async () => {
      const quince = (
        await t.prisma.product.create({ data: { productCode: 'QUINCE', unit: 'box' } })
      ).id;
      const first = await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      const base = await currentNumber();
      t.clock.set(new Date('2026-10-21T09:00:00Z'));
      const r = await publishChanges({
        baseVersionNumber: base,
        upserts: [
          { productId: apple, basePrice: '11.50' },
          { productId: quince, basePrice: '30.00' },
        ],
        removedProductIds: [pear],
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'PUBLISHED', skippedInactiveCount: 0 });
      expect(r.body.number).toBeGreaterThan(base);
      const versions = await t.prisma.priceListVersion.findMany({ orderBy: { number: 'asc' } });
      expect(versions.map((v) => [v.number, v.status])).toEqual([
        [base, 'ARCHIVED'],
        [r.body.number, 'PUBLISHED'],
      ]);
      expect(versions[0]?.id).toBe(first);
      const staff = await call('GET', '/staff/price-list/current');
      expect(staff.body.version.number).toBe(r.body.number);
      expect(pricesOf(staff.body)).toEqual({ APPLE: '11.50', QUINCE: '30.00' });
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(codesOf(customer.body)).toEqual(['APPLE', 'QUINCE']);
      // The archived version kept its items (published versions are immutable).
      const old = await call('GET', `/staff/price-list/versions/${first}`);
      expect(pricesOf(old.body)).toEqual({ APPLE: '10.00', PEAR: '20.00' });
    });

    it('stores the optional deferred price, keeps it on untouched items and audits each change', async () => {
      const first = await publishChanges({
        baseVersionNumber: null,
        upserts: [
          { productId: apple, basePrice: '10.00', deferredPrice: '9.50' },
          { productId: pear, basePrice: '20.00' },
        ],
      });
      expect(first.status).toBe(200);
      const deferredOf = (list: Body): Record<string, string | null> =>
        Object.fromEntries(list.items.map((i: Body) => [i.productCode, i.deferredPrice]));
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(customerPriceListResponseSchema.parse(customer.body)).toBeTruthy();
      expect(deferredOf(customer.body)).toEqual({ APPLE: '950.00', PEAR: null });

      // Only the pear changes: the apple keeps its deferred price in the new version.
      const second = await publishChanges({
        baseVersionNumber: first.body.number,
        upserts: [{ productId: pear, basePrice: '20.00', deferredPrice: '19.00' }],
      });
      expect(second.status).toBe(200);
      const staff = await call('GET', '/staff/price-list/current');
      expect(deferredOf(staff.body)).toEqual({ APPLE: '9.50', PEAR: '19.00' });
      const published = await t.prisma.auditLog.findFirst({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: second.body.id },
      });
      const changes = published?.diff as Record<string, unknown>;
      expect(changes[`item.${pear}.deferredPrice`]).toEqual({ from: null, to: '19.00' });
      expect(changes[`item.${pear}.basePrice`]).toBeUndefined();
      expect(changes[`item.${apple}.deferredPrice`]).toBeUndefined();

      // Clearing the deferred price (null) is a change too.
      const third = await publishChanges({
        baseVersionNumber: second.body.number,
        upserts: [{ productId: apple, basePrice: '10.00', deferredPrice: null }],
      });
      expect(third.status).toBe(200);
      const after = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(deferredOf(after.body)).toEqual({ APPLE: null, PEAR: '1900.00' });
      const history = await call('GET', `/staff/products/${apple}/price-history`);
      expect(
        history.body.entries.map((e: Body) => [e.oldDeferredPrice, e.newDeferredPrice]),
      ).toEqual([
        [null, '9.50'],
        ['9.50', null],
      ]);
    });

    it('keeps prices in USD, shows staff both currencies and customers only UZS at the current rate', async () => {
      const first = await publishChanges({
        baseVersionNumber: null,
        upserts: [{ productId: apple, basePrice: '85.00', deferredPrice: '87.25' }],
      });
      expect(first.status).toBe(200);
      const row = await t.prisma.priceListItem.findFirstOrThrow({
        where: { versionId: first.body.id },
      });
      expect([row.currency, row.basePrice.toFixed(2)]).toEqual(['USD', '85.00']);

      const staff = staffPriceListWithRateResponseSchema.parse(
        (await call('GET', '/staff/price-list/current')).body,
      );
      expect(staff.items[0]).toMatchObject({
        basePrice: '85.00',
        deferredPrice: '87.25',
        currency: 'USD',
        uzs: { basePrice: '8500.00', deferredPrice: '8725.00' },
      });

      // A new rate moves the UZS amounts at once (whole so'm, half up); the USD list is unchanged.
      await t.get(UsdRateService).setUsdRate(MANAGER, new Prisma.Decimal('11960'));
      const customer = customerPriceListResponseSchema.parse(
        (await call('GET', '/price-list/current', SHOP_OWNER)).body,
      );
      expect(customer.items[0]).toMatchObject({
        price: '1016600.00',
        deferredPrice: '1043510.00',
        currency: 'UZS',
      });

      // Without a rate a USD price has no UZS amount: staff see why, customers do not see it.
      await t.prisma.appSetting.deleteMany({ where: { key: 'usd_rate' } });
      expect((await call('GET', '/staff/price-list/current')).body.items[0].uzs).toBeNull();
      expect((await call('GET', '/price-list/current', SHOP_OWNER)).body.items).toEqual([]);
    });

    it('keeps an older UZS item in UZS when another product is priced in USD', async () => {
      const first = await publishChanges({
        baseVersionNumber: null,
        upserts: [{ productId: apple, basePrice: '246000.00' }],
      });
      // Stand-in for a list published before 2026-10-29 (the column used to allow only UZS).
      await t.prisma.$executeRaw`ALTER TABLE price_list_items DISABLE TRIGGER USER`;
      await t.prisma.$executeRaw`UPDATE price_list_items SET currency = 'UZS'`;
      await t.prisma.$executeRaw`ALTER TABLE price_list_items ENABLE TRIGGER USER`;
      const second = await publishChanges({
        baseVersionNumber: first.body.number,
        upserts: [{ productId: pear, basePrice: '20.00' }],
      });
      expect(second.status).toBe(200);
      const items = await t.prisma.priceListItem.findMany({
        where: { versionId: second.body.id },
        include: { product: true },
        orderBy: { basePrice: 'asc' },
      });
      expect(items.map((i) => [i.product.productCode, i.currency])).toEqual([
        ['PEAR', 'USD'],
        ['APPLE', 'UZS'],
      ]);
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(pricesOf(customer.body)).toEqual({ APPLE: '246000.00', PEAR: '2000.00' });

      // Re-pricing the older item moves it to USD, and the audit row says so.
      const third = await publishChanges({
        baseVersionNumber: second.body.number,
        upserts: [{ productId: apple, basePrice: '20.57' }],
      });
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: third.body.id },
      });
      expect((audit.diff as Record<string, unknown>)[`item.${apple}.currency`]).toEqual({
        from: 'UZS',
        to: 'USD',
      });
    });

    it('stores the optional RRP, shows it to customers in UZS, keeps it on untouched items and audits each change', async () => {
      const first = await publishChanges({
        baseVersionNumber: null,
        upserts: [
          { productId: apple, basePrice: '10.00', rrp: '14.99' },
          { productId: pear, basePrice: '20.00' },
        ],
      });
      expect(first.status).toBe(200);
      const rrpOf = (list: Body): Record<string, string | null> =>
        Object.fromEntries(list.items.map((i: Body) => [i.productCode, i.rrp]));
      // Stored as an exact decimal in the item's currency, next to the other prices.
      const row = await t.prisma.priceListItem.findFirstOrThrow({
        where: { versionId: first.body.id, productId: apple },
      });
      expect([row.currency, row.basePrice.toFixed(2), row.rrp?.toFixed(2)]).toEqual([
        'USD',
        '10.00',
        '14.99',
      ]);
      const staff = staffPriceListWithRateResponseSchema.parse(
        (await call('GET', '/staff/price-list/current')).body,
      );
      expect(rrpOf(staff)).toEqual({ APPLE: '14.99', PEAR: null });
      // Customers get it in UZS at the current rate, exactly like the sale price (x 100 here).
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(customerPriceListResponseSchema.parse(customer.body)).toBeTruthy();
      expect(rrpOf(customer.body)).toEqual({ APPLE: '1499.00', PEAR: null });
      expect(pricesOf(customer.body)).toEqual({ APPLE: '1000.00', PEAR: '2000.00' });
      expect(findForbiddenKeys(customer.body)).toEqual([]);

      // Only the pear changes: the apple keeps its RRP in the new version.
      const second = await publishChanges({
        baseVersionNumber: first.body.number,
        upserts: [{ productId: pear, basePrice: '20.00', rrp: '29.90' }],
      });
      expect(second.status).toBe(200);
      expect(rrpOf((await call('GET', '/staff/price-list/current')).body)).toEqual({
        APPLE: '14.99',
        PEAR: '29.90',
      });
      const published = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: second.body.id },
      });
      const changes = published.diff as Record<string, unknown>;
      expect(changes[`item.${pear}.rrp`]).toEqual({ from: null, to: '29.90' });
      expect(changes[`item.${pear}.basePrice`]).toBeUndefined();
      expect(changes[`item.${apple}.rrp`]).toBeUndefined();

      // An upsert replaces the whole item: leaving the RRP out removes it, and that is audited.
      const third = await publishChanges({
        baseVersionNumber: second.body.number,
        upserts: [{ productId: apple, basePrice: '10.00' }],
      });
      expect(third.status).toBe(200);
      const cleared = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: third.body.id },
      });
      expect((cleared.diff as Record<string, unknown>)[`item.${apple}.rrp`]).toEqual({
        from: '14.99',
        to: null,
      });
      // A new rate moves the RRP like the sale price (whole so'm, half up): 29.90 x 11960.5.
      await t.get(UsdRateService).setUsdRate(MANAGER, new Prisma.Decimal('11960.5'));
      const after = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(rrpOf(after.body)).toEqual({ APPLE: null, PEAR: '357619.00' });

      // The history shows the RRP changes of the product, although its sale price never moved.
      const history = await call('GET', `/staff/products/${apple}/price-history`);
      expect(priceHistoryResponseSchema.parse(history.body)).toBeTruthy();
      expect(
        history.body.entries.map((e: Body) => [e.oldPrice, e.newPrice, e.oldRrp, e.newRrp]),
      ).toEqual([
        [null, '10.00', null, '14.99'],
        ['10.00', '10.00', '14.99', null],
      ]);
      // The archived version kept its RRP (published versions are immutable).
      const old = await call('GET', `/staff/price-list/versions/${first.body.id}`);
      expect(rrpOf(old.body)).toEqual({ APPLE: '14.99', PEAR: null });
    });

    it('rejects an RRP that is not a positive money string', async () => {
      for (const rrp of ['0', '-1.00', 9.5, '1.234', '']) {
        const r = await publishChanges({
          baseVersionNumber: null,
          upserts: [{ productId: apple, basePrice: '10.00', rrp }],
        });
        expect(r.status, String(rrp)).toBe(422);
      }
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(0);
    });

    it('rejects a deferred price that is not a positive money string', async () => {
      for (const deferredPrice of ['0', '-1.00', 9.5, '1.234']) {
        const r = await publishChanges({
          baseVersionNumber: null,
          upserts: [{ productId: apple, basePrice: '10.00', deferredPrice }],
        });
        expect(r.status, String(deferredPrice)).toBe(422);
      }
    });

    it('refuses a stale base version (PRICE_LIST_CHANGED) and changes nothing', async () => {
      await publishVersion({ [apple]: '10.00' });
      await publishVersion({ [apple]: '12.00' });
      const current = await currentNumber();
      const auditBefore = await t.prisma.auditLog.count();
      for (const baseVersionNumber of [current - 1, current + 1, null]) {
        const r = await publishChanges({
          baseVersionNumber,
          upserts: [{ productId: apple, basePrice: '99.00' }],
        });
        expectConflict(r, 'PRICE_LIST_CHANGED', `base ${String(baseVersionNumber)}`);
        expect(r.body.error.details).toEqual({ currentVersionNumber: current });
      }
      await expect(t.prisma.auditLog.count()).resolves.toBe(auditBefore);
      expect(await currentNumber()).toBe(current);
      // Before the first publish the base must be null.
      await resetCatalogPricingAudit(t.prisma);
      const fresh = (await t.prisma.product.create({ data: { productCode: 'FIG', unit: 'box' } }))
        .id;
      const r = await publishChanges({
        baseVersionNumber: current,
        upserts: [{ productId: fresh, basePrice: '1.00' }],
      });
      expectConflict(r, 'PRICE_LIST_CHANGED', 'a number before the first publish');
      expect(r.body.error.details).toEqual({ currentVersionNumber: null });
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(0);
    });

    it('drops inactive products of the previous list and reports them; an inactive upsert is refused', async () => {
      const quince = (
        await t.prisma.product.create({ data: { productCode: 'QUINCE', unit: 'box' } })
      ).id;
      await publishVersion({ [apple]: '10.00', [pear]: '20.00', [quince]: '30.00' });
      await call('PATCH', `/staff/products/${pear}`, MANAGER, { isActive: false });
      await call('PATCH', `/staff/products/${quince}`, MANAGER, { isActive: false });

      const refused = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: pear, basePrice: '21.00' }],
      });
      expectConflict(refused, 'INACTIVE_PRODUCT', 'inactive upsert');
      expect(refused.body.error.details).toEqual({ productIds: [pear] });
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(1);

      const r = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: apple, basePrice: '10.50' }],
      });
      expect(r.status).toBe(200);
      expect(r.body.skippedInactiveCount).toBe(2);
      const staff = await call('GET', '/staff/price-list/current');
      expect(pricesOf(staff.body)).toEqual({ APPLE: '10.50' });
    });

    it('404 for an unknown product; a product whose stored unit is NULL is priced (pieces only)', async () => {
      await publishVersion({ [apple]: '10.00' });
      const unknown = '019a0000-0000-7000-8000-000000000000';
      const missing = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: unknown, basePrice: '1.00' }],
      });
      expect(missing.status).toBe(404);
      expect(missing.body.error.details).toEqual({ productIds: [unknown] });
      const noUnit = (await t.prisma.product.create({ data: { productCode: 'NOUNIT' } })).id;
      await t.prisma.$executeRaw`UPDATE products SET unit = NULL WHERE id = ${noUnit}::uuid`;
      const unitless = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: noUnit, basePrice: '1.00' }],
      });
      expect(unitless.status).toBe(200);
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(2);
    });

    it('refuses to leave the list empty (EMPTY_PRICE_LIST); removing an unlisted product is ignored', async () => {
      await publishVersion({ [apple]: '10.00' });
      expectConflict(
        await publishChanges({
          baseVersionNumber: await currentNumber(),
          removedProductIds: [apple],
        }),
        'EMPTY_PRICE_LIST',
        'empty',
      );
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(1);
      // `pear` is not in the list: no 404, the publish goes through.
      const r = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: apple, basePrice: '10.10' }],
        removedProductIds: [pear],
      });
      expect(r.status).toBe(200);
    });

    it('discards a leftover draft of the old flow (with its audit row) and publishes', async () => {
      await publishVersion({ [apple]: '10.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: pear, basePrice: '5.00' }],
      });
      const r = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: apple, basePrice: '11.00' }],
      });
      expect(r.status).toBe(200);
      const versions = await t.prisma.priceListVersion.findMany({ orderBy: { number: 'asc' } });
      expect(versions.map((v) => v.status)).toEqual(['ARCHIVED', 'PUBLISHED']);
      expect(versions.some((v) => v.id === draft)).toBe(false);
      const discarded = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_DRAFT_DISCARDED', entityId: draft },
      });
      expect(discarded.diff).toMatchObject({
        status: { from: 'DRAFT', to: null },
        [`item.${pear}.basePrice`]: { from: '5.00', to: null },
      });
      // The draft's prices never reached the published list.
      expect(pricesOf((await call('GET', '/staff/price-list/current')).body)).toEqual({
        APPLE: '11.00',
      });
    });

    it('writes PRICE_LIST_PUBLISHED with the item diffs (from -> to) and PRICE_LIST_ARCHIVED', async () => {
      const quince = (
        await t.prisma.product.create({ data: { productCode: 'QUINCE', unit: 'box' } })
      ).id;
      const first = await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      const base = await currentNumber();
      t.clock.set(new Date('2026-10-21T09:00:00Z'));
      const r = await publishChanges({
        baseVersionNumber: base,
        upserts: [
          { productId: apple, basePrice: '11.00' },
          { productId: quince, basePrice: '30.00' },
        ],
        removedProductIds: [pear],
      });
      const id = r.body.id as string;
      const published = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: id },
      });
      expect(published.actorUserId).toBe(MANAGER.userId);
      expect(published.createdAt.toISOString()).toBe('2026-10-21T09:00:00.000Z');
      expect(published.diff).toMatchObject({
        status: { from: 'DRAFT', to: 'PUBLISHED' },
        replacedVersionId: { from: null, to: first },
        itemCount: { from: null, to: 2 },
        baseVersionNumber: { from: null, to: base },
        skippedInactiveCount: { from: null, to: 0 },
        [`item.${apple}.basePrice`]: { from: '10.00', to: '11.00' },
        [`item.${quince}.basePrice`]: { from: null, to: '30.00' },
        [`item.${pear}.basePrice`]: { from: '20.00', to: null },
      });
      const archived = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_ARCHIVED', entityId: first },
      });
      expect(archived.diff).toMatchObject({ replacedByVersionId: { from: null, to: id } });
      // No draft-flow rows for this publish.
      await expect(
        t.prisma.auditLog.count({
          where: {
            entityId: id,
            action: { in: ['PRICE_LIST_DRAFT_CREATED', 'PRICE_LIST_ITEMS_CHANGED'] },
          },
        }),
      ).resolves.toBe(0);
    });

    it('a failed audit insert rolls the whole publish back', async () => {
      const first = await publishVersion({ [apple]: '10.00' });
      const auditRowsBefore = await t.prisma.auditLog.count();
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValue(new Error('audit down'));
      const r = await publishChanges({
        baseVersionNumber: await currentNumber(),
        upserts: [{ productId: apple, basePrice: '11.00' }],
      });
      expect(r.status).toBe(500);
      const rows = await t.prisma.priceListVersion.findMany();
      expect(rows.map((v) => [v.id, v.status])).toEqual([[first, 'PUBLISHED']]);
      await expect(t.prisma.auditLog.count()).resolves.toBe(auditRowsBefore);
    });

    it('422 for an empty request, an overlap, duplicates, bad prices and extra keys', async () => {
      await publishVersion({ [apple]: '10.00' });
      const base = await currentNumber();
      for (const body of [
        { baseVersionNumber: base },
        { baseVersionNumber: base, upserts: [], removedProductIds: [] },
        {
          baseVersionNumber: base,
          upserts: [{ productId: apple, basePrice: '1.00' }],
          removedProductIds: [apple],
        },
        {
          baseVersionNumber: base,
          upserts: [
            { productId: apple, basePrice: '1.00' },
            { productId: apple, basePrice: '2.00' },
          ],
        },
        { baseVersionNumber: base, removedProductIds: [apple, apple] },
        { baseVersionNumber: base, upserts: [{ productId: apple, basePrice: 1.5 }] },
        { baseVersionNumber: base, upserts: [{ productId: apple, basePrice: '0' }] },
        { baseVersionNumber: 0, upserts: [{ productId: apple, basePrice: '1.00' }] },
        { upserts: [{ productId: apple, basePrice: '1.00' }] },
        { baseVersionNumber: base, upserts: [{ productId: apple, basePrice: '1.00', cost: '1' }] },
        { baseVersionNumber: base, note: 'x', upserts: [{ productId: apple, basePrice: '1.00' }] },
      ]) {
        const r = await publishChanges(body);
        expect(r.status, JSON.stringify(body)).toBe(422);
        errorBodySchema.parse(r.body);
      }
      await expect(t.prisma.priceListVersion.count()).resolves.toBe(1);
    });

    it('two concurrent publishes of the same base: one wins, the other gets a conflict', async () => {
      await publishVersion({ [apple]: '10.00' });
      const base = await currentNumber();
      const results = await Promise.all([
        publishChanges({
          baseVersionNumber: base,
          upserts: [{ productId: apple, basePrice: '11.00' }],
        }),
        publishChanges({
          baseVersionNumber: base,
          upserts: [{ productId: apple, basePrice: '12.00' }],
        }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409);
      expect(['PRICE_LIST_CHANGED', 'ANOTHER_VERSION_PUBLISHED']).toContain(
        loser?.body.error.reason,
      );
      const rows = await t.prisma.priceListVersion.findMany({ orderBy: { number: 'asc' } });
      expect(rows.map((v) => v.status)).toEqual(['ARCHIVED', 'PUBLISHED']);
    });
  });

  describe('concurrency', () => {
    it('parallel publishes of the same draft leave exactly one PUBLISHED version', async () => {
      await publishVersion({ [apple]: '10.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '11.00' }],
      });

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => t.get(PricingService).publish(MANAGER, draft)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: 'CONFLICT',
          reason: 'DRAFT_NOT_OPEN',
        });
      }
      const rows = await t.prisma.priceListVersion.findMany();
      expect(rows.filter((r) => r.status === 'PUBLISHED').map((r) => r.id)).toEqual([draft]);
      expect(rows.filter((r) => r.status === 'ARCHIVED')).toHaveLength(1);
      // The winner wrote exactly one PUBLISHED audit row.
      await expect(
        t.prisma.auditLog.count({ where: { action: 'PRICE_LIST_PUBLISHED', entityId: draft } }),
      ).resolves.toBe(1);
    });

    it('a draft edit racing a publish never lands in the published version', async () => {
      await publishVersion({ [apple]: '10.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      const service = t.get(PricingService);
      const outcomes = await Promise.allSettled([
        service.publish(MANAGER, draft),
        service.upsertDraftItems(MANAGER, draft, {
          items: [
            {
              productId: pear,
              basePrice: new Prisma.Decimal('99.00'),
              deferredPrice: null,
              rrp: null,
            },
          ],
        }),
      ]);
      expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
      const published = await t.prisma.priceListVersion.findUniqueOrThrow({
        where: { id: draft },
        include: { items: true },
      });
      expect(published.status).toBe('PUBLISHED');
      // Whatever order won, the published item set equals what the audit log says was published.
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PRICE_LIST_PUBLISHED', entityId: draft },
      });
      expect((row.diff as Body).itemCount.to).toBe(published.items.length);
    });
  });

  describe('inactive products are re-checked inside the transaction', () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    /** Deactivates a product in a transaction that stays open until `release()`. */
    async function holdDeactivation(productId: string): Promise<() => Promise<void>> {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const ready = new Promise<void>((resolve) => (started = resolve));
      const holder = t.prisma.$transaction(async (tx) => {
        await tx.product.update({ where: { id: productId }, data: { isActive: false } });
        started();
        await gate;
      });
      await ready;
      return async () => {
        release();
        await holder;
      };
    }

    it('publish rejects a draft that contains a product deactivated after it was added', async () => {
      const first = await publishVersion({ [apple]: '10.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: pear, basePrice: '20.00' }],
      });
      await call('PATCH', `/staff/products/${pear}`, MANAGER, { isActive: false });

      const r = await call('POST', `/staff/price-list/drafts/${draft}/publish`);
      expectConflict(r, 'INACTIVE_PRODUCT_IN_DRAFT', 'publish with inactive');
      expect(r.body.error.message).toMatch(/inactive/i);
      expect(r.body.error.details.productIds).toEqual([pear]);
      const rows = await t.prisma.priceListVersion.findMany();
      expect(Object.fromEntries(rows.map((v) => [v.id, v.status]))).toEqual({
        [first]: 'PUBLISHED',
        [draft]: 'DRAFT',
      });
    });

    it('an upsert waits for a deactivation in flight and then refuses the product', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      const release = await holdDeactivation(apple);
      let settled = false;
      const pending = t
        .get(PricingService)
        .upsertDraftItems(MANAGER, draft, {
          items: [
            {
              productId: apple,
              basePrice: new Prisma.Decimal('5.00'),
              deferredPrice: null,
              rrp: null,
            },
          ],
        })
        .finally(() => (settled = true));
      const outcome = expect(pending).rejects.toMatchObject({
        code: 'CONFLICT',
        reason: 'INACTIVE_PRODUCT',
      });
      await sleep(300);
      expect(settled, 'must be blocked by the share lock while the deactivation is open').toBe(
        false,
      );
      await release();
      await outcome;
      await expect(t.prisma.priceListItem.count()).resolves.toBe(0);
    });

    it('a publish waits for a deactivation in flight and then refuses the draft', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '5.00' }],
      });
      const release = await holdDeactivation(apple);
      let settled = false;
      const pending = t
        .get(PricingService)
        .publish(MANAGER, draft)
        .finally(() => (settled = true));
      const outcome = expect(pending).rejects.toMatchObject({
        code: 'CONFLICT',
        reason: 'INACTIVE_PRODUCT_IN_DRAFT',
      });
      await sleep(300);
      expect(settled).toBe(false);
      await release();
      await outcome;
      await expect(
        t.prisma.priceListVersion.count({ where: { status: 'PUBLISHED' } }),
      ).resolves.toBe(0);
    });
  });

  describe('bulk edits', () => {
    it(
      'handles a 500-item upsert (create, then update) within the transaction budget',
      { timeout: 30_000 },
      async () => {
        await t.prisma.product.createMany({
          data: Array.from({ length: 500 }, (_, i) => ({
            productCode: `BULK-${String(i).padStart(4, '0')}`,
            unit: 'piece',
          })),
        });
        const ids = (
          await t.prisma.product.findMany({
            where: { productCode: { startsWith: 'BULK-' } },
            orderBy: { productCode: 'asc' },
          })
        ).map((p) => p.id);
        expect(ids).toHaveLength(500);
        const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body
          .id as string;
        const url = `/staff/price-list/drafts/${draft}/items`;

        const created = await call('PUT', url, MANAGER, {
          items: ids.map((productId, i) => ({ productId, basePrice: `${1000 + i}.50` })),
        });
        expect(created.status).toBe(200);
        expect(created.body.items).toHaveLength(500);

        const updated = await call('PUT', url, MANAGER, {
          items: ids.map((productId, i) => ({ productId, basePrice: `${2000 + i}.25` })),
        });
        expect(updated.status).toBe(200);
        expect(updated.body.items[0].basePrice).toBe('2000.25');
        expect(updated.body.items[499].basePrice).toBe('2499.25');

        // One audit row for the whole call, with before AND after for every product.
        const rows = await t.prisma.auditLog.findMany({
          where: { action: 'PRICE_LIST_ITEMS_CHANGED' },
          orderBy: { createdAt: 'asc' },
        });
        expect(rows).toHaveLength(2);
        const second = rows[1]?.diff as Body;
        expect(Object.keys(second)).toHaveLength(500);
        expect(second[`item.${ids[0]}.basePrice`]).toEqual({ from: '1000.50', to: '2000.25' });
      },
    );
  });

  describe('money', () => {
    it('round-trips exact decimals with no float drift', async () => {
      const big = '9999999999999999.99';
      const id = await publishVersion({ [apple]: '1690000.10', [pear]: big });
      const stored = await t.prisma.$queryRaw<{ base_price: string }[]>`
        SELECT base_price::text FROM price_list_items WHERE version_id = ${id}::uuid ORDER BY base_price`;
      expect(stored.map((r) => r.base_price)).toEqual(['1690000.10', big]);
      // The customer amount is USD x rate in exact decimal arithmetic, rounded to whole so'm.
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      expect(customer.body.items.map((i: Body) => i.price)).toEqual([
        '169000010.00',
        '999999999999999999.00',
      ]);
      const staff = await call('GET', `/staff/price-list/versions/${id}`);
      expect(staff.body.items.map((i: Body) => i.basePrice)).toEqual(['1690000.10', big]);
      expect(customer.body.items.every((i: Body) => typeof i.price === 'string')).toBe(true);
    });
  });

  describe('price history', () => {
    it('shows old/new price, who, when and source across 3 versions', async () => {
      t.clock.set(new Date('2026-10-20T08:00:00Z'));
      await publishVersion({ [apple]: '100.00', [pear]: '5.00' }, MANAGER);
      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      // v2: apple changes, pear unchanged.
      const d2 = (await call('POST', '/staff/price-list/drafts', ADMIN, { copyFromCurrent: true }))
        .body.id;
      await call('PUT', `/staff/price-list/drafts/${d2}/items`, ADMIN, {
        items: [{ productId: apple, basePrice: '120.50' }],
      });
      await call('POST', `/staff/price-list/drafts/${d2}/publish`, ADMIN);
      t.clock.set(new Date('2026-10-22T08:00:00Z'));
      // v3: apple removed, pear unchanged.
      const d3 = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id;
      await call('DELETE', `/staff/price-list/drafts/${d3}/items/${apple}`);
      await call('POST', `/staff/price-list/drafts/${d3}/publish`);

      const history = await call('GET', `/staff/products/${apple}/price-history`);
      expect(history.status).toBe(200);
      expect(history.body.productCode).toBe('APPLE');
      expect(
        history.body.entries.map((e: Body) => [
          e.versionNumber,
          e.oldPrice,
          e.newPrice,
          e.publishedBy,
          e.publishedAt,
          e.source,
        ]),
      ).toEqual([
        [expect.any(Number), null, '100.00', null, '2026-10-20T08:00:00.000Z', 'MANUAL'],
        [expect.any(Number), '100.00', '120.50', null, '2026-10-21T08:00:00.000Z', 'MANUAL'],
        [expect.any(Number), '120.50', null, null, '2026-10-22T08:00:00.000Z', 'MANUAL'],
      ]);
      const pearHistory = await call('GET', `/staff/products/${pear}/price-history`);
      expect(pearHistory.body.entries).toHaveLength(1);
      expect((await call('GET', `/staff/products/${apple}/price-history`, SHOP_OWNER)).status).toBe(
        403,
      );
    });

    it("gives each current item its last price change: any tier counts, a re-entry too, the rest doesn't", async () => {
      const lastChanges = async (): Promise<Record<string, unknown>> => {
        const current = await call('GET', '/staff/price-list/current');
        expect(current.status).toBe(200);
        return Object.fromEntries(
          current.body.items.map((i: Body) => [i.productCode, i.lastChange]),
        );
      };
      const publish = async (body: Body): Promise<number> => {
        const head = (await call('GET', '/staff/price-list/current')).body.version?.number ?? null;
        const r = await call('POST', '/staff/price-list/publish', MANAGER, {
          baseVersionNumber: head,
          upserts: [],
          removedProductIds: [],
          ...body,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return r.body.number as number;
      };

      t.clock.set(new Date('2026-10-20T08:00:00Z'));
      const v1 = await publish({
        baseVersionNumber: null,
        upserts: [
          { productId: apple, basePrice: '100.00' },
          { productId: pear, basePrice: '5.00' },
        ],
      });
      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      const v2 = await publish({ upserts: [{ productId: apple, basePrice: '120.50' }] });
      // Only the wholesale price of the pear changes: that is a price change too.
      t.clock.set(new Date('2026-10-22T08:00:00Z'));
      const v3 = await publish({
        upserts: [{ productId: pear, basePrice: '5.00', wholesalePrice: '4.50' }],
      });
      expect(await lastChanges()).toEqual({
        APPLE: { versionNumber: v2, changedAt: '2026-10-21T08:00:00.000Z', changedBy: null },
        PEAR: { versionNumber: v3, changedAt: '2026-10-22T08:00:00.000Z', changedBy: null },
      });

      // Removed, then priced again at the very same price: the return is the change.
      t.clock.set(new Date('2026-10-23T08:00:00Z'));
      await publish({ removedProductIds: [apple] });
      t.clock.set(new Date('2026-10-24T08:00:00Z'));
      const v5 = await publish({ upserts: [{ productId: apple, basePrice: '120.50' }] });
      const after = await lastChanges();
      expect(after.APPLE).toEqual({
        versionNumber: v5,
        changedAt: '2026-10-24T08:00:00.000Z',
        changedBy: null,
      });
      expect(after.PEAR).toMatchObject({ versionNumber: v3 });
      expect(v1).toBeLessThan(v2);
    });

    it('gives each current item its brand by the price list file rule, null without one', async () => {
      const phone = (
        await t.prisma.product.create({
          data: {
            productCode: 'PHONE',
            unit: 'box',
            translations: { create: [{ lang: 'RU', name: 'Смартфон Xiaomi Redmi 15' }] },
          },
        })
      ).id;
      await publishVersion({ [apple]: '10.00', [phone]: '150.00' });
      const current = await call('GET', '/staff/price-list/current');
      const brands = Object.fromEntries(
        current.body.items.map((i: Body) => [i.productCode, i.brand]),
      );
      expect(brands).toEqual({ APPLE: null, PHONE: 'Xiaomi' });
      // Staff-only: the customer list carries neither field.
      const customer = await call('GET', '/price-list/current', SHOP_OWNER);
      for (const item of customer.body.items as Body[]) {
        expect(item).not.toHaveProperty('brand');
        expect(item).not.toHaveProperty('lastChange');
      }
    });
  });

  describe('audit: full history in the same transaction', () => {
    it('stores before AND after for an item price change, with actor and Clock time', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      const url = `/staff/price-list/drafts/${draft}/items`;
      await call('PUT', url, MANAGER, { items: [{ productId: apple, basePrice: '100.00' }] });
      t.clock.set(new Date('2026-10-20T12:34:56Z'));
      await call('PUT', url, ADMIN, { items: [{ productId: apple, basePrice: '110.25' }] });
      // Same price again: no change, no audit row.
      await call('PUT', url, ADMIN, { items: [{ productId: apple, basePrice: '110.25' }] });

      const rows = await t.prisma.auditLog.findMany({
        where: { entityId: draft, action: 'PRICE_LIST_ITEMS_CHANGED' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.diff)).toEqual([
        { [`item.${apple}.basePrice`]: { from: null, to: '100.00' } },
        { [`item.${apple}.basePrice`]: { from: '100.00', to: '110.25' } },
      ]);
      expect(rows[1]).toMatchObject({
        actorUserId: ADMIN.userId,
        entityType: 'PRICE_LIST_VERSION',
      });
      expect(rows[1]?.createdAt.toISOString()).toBe('2026-10-20T12:34:56.000Z');
    });

    it('records create, copy, remove, discard and publish (with the archived version)', async () => {
      const first = await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      await call('DELETE', `/staff/price-list/drafts/${draft}/items/${pear}`);
      await call('POST', `/staff/price-list/drafts/${draft}/publish`);
      const second = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      await call('DELETE', `/staff/price-list/drafts/${second}`);

      const byAction = async (action: string, entityId: string) =>
        (await t.prisma.auditLog.findFirstOrThrow({ where: { action, entityId } })).diff as Body;
      expect(await byAction('PRICE_LIST_DRAFT_COPIED', draft)).toMatchObject({
        copiedFromVersionId: { from: null, to: first },
        itemCount: { from: null, to: 2 },
      });
      expect(await byAction('PRICE_LIST_ITEM_REMOVED', draft)).toEqual({
        [`item.${pear}.basePrice`]: { from: '20.00', to: null },
      });
      expect(await byAction('PRICE_LIST_PUBLISHED', draft)).toMatchObject({
        status: { from: 'DRAFT', to: 'PUBLISHED' },
        replacedVersionId: { from: null, to: first },
      });
      expect(await byAction('PRICE_LIST_ARCHIVED', first)).toMatchObject({
        status: { from: 'PUBLISHED', to: 'ARCHIVED' },
        replacedByVersionId: { from: null, to: draft },
      });
      expect(await byAction('PRICE_LIST_DRAFT_DISCARDED', second)).toMatchObject({
        status: { from: 'DRAFT', to: null },
        [`item.${apple}.basePrice`]: { from: '10.00', to: null },
      });
    });

    it('a failed audit insert rolls back the item change', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      const auditRowsBefore = await t.prisma.auditLog.count();
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValue(new Error('audit down'));
      const r = await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
        items: [{ productId: apple, basePrice: '5.00' }],
      });
      expect(r.status).toBe(500);
      await expect(t.prisma.priceListItem.count()).resolves.toBe(0);
      await expect(t.prisma.auditLog.count()).resolves.toBe(auditRowsBefore);
    });

    it('a failed audit insert on publish leaves the old version PUBLISHED and the draft a DRAFT', async () => {
      const first = await publishVersion({ [apple]: '10.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id as string;
      const auditRowsBefore = await t.prisma.auditLog.count();
      const original = t.get(AuditService).record.bind(t.get(AuditService));
      let calls = 0;
      // The first audit row (archive of the old version) succeeds, the second fails: both must roll back.
      vi.spyOn(t.get(AuditService), 'record').mockImplementation((tx, entry) => {
        calls += 1;
        return calls === 1 ? original(tx, entry) : Promise.reject(new Error('audit down'));
      });
      expect((await call('POST', `/staff/price-list/drafts/${draft}/publish`)).status).toBe(500);
      const rows = await t.prisma.priceListVersion.findMany();
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
        [first]: 'PUBLISHED',
        [draft]: 'DRAFT',
      });
      await expect(t.prisma.auditLog.count()).resolves.toBe(auditRowsBefore);
    });

    it('audit rows share the caller transaction: rolling back the transaction removes them', async () => {
      const audit = t.get(AuditService);
      await expect(
        runInTransaction(t.prisma, async (tx) => {
          await audit.record(tx, {
            actorUserId: 'u1',
            entityType: 'TEST',
            entityId: 'e1',
            action: 'TEST',
            changes: { a: { from: 1, to: 2 } },
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      await expect(t.prisma.auditLog.count({ where: { entityType: 'TEST' } })).resolves.toBe(0);
    });
  });

  describe('cost-field leak check (hard rule 7)', () => {
    it('no response of this phase contains a forbidden key at any depth', async () => {
      const id = await publishVersion({ [apple]: '10.00', [pear]: '20.00' });
      const draft = (
        await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
      ).body.id;
      const responses: [string, Body][] = [
        ['customer list', (await call('GET', '/price-list/current?lang=RU', SHOP_OWNER)).body],
        ['customer list (seller)', (await call('GET', '/price-list/current', SELLER)).body],
        ['staff current', (await call('GET', '/staff/price-list/current')).body],
        ['staff versions', (await call('GET', '/staff/price-list/versions')).body],
        ['staff version', (await call('GET', `/staff/price-list/versions/${id}`)).body],
        ['draft', (await call('GET', `/staff/price-list/versions/${draft}`)).body],
        ['history', (await call('GET', `/staff/products/${apple}/price-history`)).body],
        [
          'publish changes',
          (
            await call('POST', '/staff/price-list/publish', MANAGER, {
              baseVersionNumber: (await call('GET', '/staff/price-list/current')).body.version
                .number,
              upserts: [{ productId: apple, basePrice: '12.00' }],
            })
          ).body,
        ],
        ['products', (await call('GET', '/staff/products')).body],
        ['product', (await call('GET', `/staff/products/${apple}`)).body],
      ];
      for (const [name, body] of responses) {
        expect(Object.keys(body).length, name).toBeGreaterThan(0);
        // Staff version DTOs legitimately carry the rate snapshot and the staff list the selling
        // price tier [C, 2026-11-11]; nothing else cost-like. Customer bodies are never stripped.
        const staff = !name.startsWith('customer');
        const scanned = staff ? stripStaffPriceTier(stripStaffRateSnapshot(body)) : body;
        expect(findForbiddenKeys(scanned), name).toEqual([]);
      }
    });

    it('live responses parse with the strict shared schemas (api and web share one contract)', async () => {
      const id = await publishVersion({ [apple]: '10.00', [pear]: '1690000.10' });
      const created = await call('POST', '/staff/price-list/drafts', MANAGER, {
        copyFromCurrent: true,
      });
      const draft = created.body.id;
      const parse = (schema: { parse: (v: unknown) => unknown }, body: unknown): unknown =>
        schema.parse(body);
      parse(createDraftWithRateResponseSchema, created.body);
      parse(
        staffVersionWithRateResponseSchema,
        (await call('GET', '/staff/price-list/drafts/current')).body,
      );

      parse(
        customerPriceListResponseSchema,
        (await call('GET', '/price-list/current?lang=RU', SHOP_OWNER)).body,
      );
      parse(
        staffPriceListWithRateResponseSchema,
        (await call('GET', '/staff/price-list/current')).body,
      );
      parse(
        staffPriceListWithRateResponseSchema,
        (await call('GET', `/staff/price-list/versions/${id}`)).body,
      );
      parse(
        staffVersionListWithRateResponseSchema,
        (await call('GET', '/staff/price-list/versions')).body,
      );
      parse(
        staffVersionWithRateResponseSchema,
        (await call('GET', `/staff/price-list/versions/${id}`)).body.version,
      );
      parse(
        staffVersionWithRateResponseSchema,
        (await call('PATCH', `/staff/price-list/drafts/${draft}`, MANAGER, { note: 'n' })).body,
      );
      parse(
        staffPriceListWithRateResponseSchema,
        (
          await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
            items: [{ productId: apple, basePrice: '11.00' }],
          })
        ).body,
      );
      parse(
        publishWithRateResponseSchema,
        (await call('POST', `/staff/price-list/drafts/${draft}/publish`)).body,
      );
      parse(
        publishChangesWithRateResponseSchema,
        (
          await call('POST', '/staff/price-list/publish', MANAGER, {
            baseVersionNumber: (await call('GET', '/staff/price-list/current')).body.version.number,
            upserts: [{ productId: pear, basePrice: '1690000.20' }],
          })
        ).body,
      );
      parse(
        priceHistoryResponseSchema,
        (await call('GET', `/staff/products/${apple}/price-history`)).body,
      );
      parse(staffProductDetailListResponseSchema, (await call('GET', '/staff/products')).body);
      parse(staffProductDetailResponseSchema, (await call('GET', `/staff/products/${apple}`)).body);

      // Error bodies, including validation details.
      for (const response of [
        await call('GET', '/staff/products/019a0000-0000-7000-8000-000000000000'),
        await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
          items: [{ productId: apple, basePrice: 1.5 }],
        }),
        await call('POST', '/staff/price-list/drafts', SHOP_OWNER, {}),
        await call('POST', `/staff/price-list/drafts/${draft}/publish`),
      ]) {
        const body = errorBodySchema.parse(response.body);
        expect(ERROR_CODES as readonly string[]).toContain(body.error.code);
      }
    });

    it('the detector itself catches forbidden keys at depth, in any case', () => {
      expect(findForbiddenKeys({ a: [{ b: { PurchasePrice: 1 } }] })).toEqual([
        '$.a[0].b.PurchasePrice',
      ]);
      expect(
        findForbiddenKeys({
          Supplier: 1,
          exchangeRate: 2,
          Margin: 3,
          tannarx: 4,
          kurs: 5,
          markup: 6,
          unitCost: 7,
        }),
      ).toHaveLength(7);
      expect(findForbiddenKeys({ price: '1', productCode: 'x' })).toEqual([]);
    });
  });
});
