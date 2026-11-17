import {
  stockOverviewResponseSchema,
  unpricedProductsResponseSchema,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PricingModule } from '../src/modules/pricing/index.js';
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

const code = (n: number): string => `P-${String(n).padStart(4, '0')}`;

// PricingModule first: the same order as AppModule (see StaffStockController).
describe('cursor paging of the staff unpriced and stock lists (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([PricingModule, CatalogModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetCatalogPricingAudit(t.prisma);
  });

  const get = async (path: string, actor = MANAGER): Promise<{ status: number; body: Body }> => {
    const r = await t.request('GET', path, { actor });
    return { status: r.status, body: (r.body ?? {}) as Body };
  };

  /** Products P-0001..P-n, every one with a stock row (so the stock list shows it too). */
  const seed = async (from: number, to: number): Promise<void> => {
    for (let n = from; n <= to; n += 1) {
      const product = await t.prisma.product.create({
        data: {
          productCode: code(n),
          unit: 'pcs',
          category: n % 2 === 0 ? 'Even' : 'Odd',
          translations: {
            create: [{ lang: 'RU', name: n % 3 === 0 ? `Special ${n}` : `Name ${n}` }],
          },
        },
      });
      await t.prisma.stockCache.create({
        data: { productId: product.id, quantity: '5.000', syncedAt: new Date() },
      });
    }
  };

  const pages = ['/staff/products/unpriced', '/staff/stock'] as const;

  describe.each(pages)('GET %s', (path) => {
    const schema =
      path === '/staff/stock' ? stockOverviewResponseSchema : unpricedProductsResponseSchema;

    it('pages through all rows without gaps or duplicates and the schema stays strict', async () => {
      await seed(1, 23);
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const query: string = `limit=5${cursor ? `&cursor=${cursor}` : ''}`;
        const r = await get(`${path}?${query}`);
        expect(r.status).toBe(200);
        const page = schema.parse(r.body);
        expect(page.total).toBe(23);
        expect(page.items.length).toBeLessThanOrEqual(5);
        seen.push(...page.items.map((i) => i.productCode));
        cursor = page.nextCursor;
        guard += 1;
      } while (cursor && guard < 20);
      expect(guard).toBe(5);
      expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => code(i + 1)));
    });

    it('stays consistent when rows are inserted between pages', async () => {
      await seed(10, 29);
      const first = schema.parse((await get(`${path}?limit=5`)).body);
      expect(first.items.map((i) => i.productCode)).toEqual([10, 11, 12, 13, 14].map(code));
      // Inserted before and after the cursor position.
      await seed(1, 5);
      await seed(30, 31);
      const rest: string[] = [];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = schema.parse((await get(`${path}?limit=7&cursor=${cursor}`)).body);
        rest.push(...page.items.map((i) => i.productCode));
        cursor = page.nextCursor;
      }
      expect(rest).toEqual([
        ...Array.from({ length: 15 }, (_, i) => code(i + 15)),
        code(30),
        code(31),
      ]);
    });

    it('answers an invalid cursor with 422 and out-of-range limits with 422', async () => {
      await seed(1, 3);
      for (const bad of [
        'cursor=!!!',
        'cursor=QQ==',
        'limit=0',
        'limit=201',
        'limit=abc',
        'limit=1.5',
      ]) {
        const r = await get(`${path}?${bad}`);
        expect(r.status, bad).toBe(422);
      }
      expect((await get(`${path}?limit=1`)).status).toBe(200);
      expect((await get(`${path}?limit=200`)).status).toBe(200);
    });

    it('counts total over the search filter, not over the page', async () => {
      await seed(1, 30);
      const r = schema.parse((await get(`${path}?search=Special&limit=4`)).body);
      expect(r.total).toBe(10);
      expect(r.items).toHaveLength(4);
      expect(r.nextCursor).not.toBeNull();
      const tail = schema.parse(
        (await get(`${path}?search=Special&limit=4&cursor=${r.nextCursor}`)).body,
      );
      expect(tail.total).toBe(10);
    });

    it('without paging params returns the first full page with total and no cursor', async () => {
      await seed(1, 12);
      const r = schema.parse((await get(path)).body);
      expect(r.items).toHaveLength(12);
      expect(r.total).toBe(12);
      expect(r.nextCursor).toBeNull();
    });

    it('keeps the permissions: cost-visible staff only', async () => {
      await seed(1, 2);
      for (const actor of [MANAGER, ACCOUNTANT, ADMIN]) {
        expect((await get(`${path}?limit=1`, actor)).status).toBe(200);
      }
      for (const actor of [WAREHOUSE, DRIVER, SELLER, SHOP_OWNER]) {
        expect([401, 403], String(actor.userId)).toContain(
          (await get(`${path}?limit=1`, actor)).status,
        );
      }
    });

    it('answers the 147-row dev-like catalogue in a single fast request', async () => {
      await seed(1, 147);
      await get(path); // warm-up (connection, plan cache)
      const started = performance.now();
      const r = schema.parse((await get(path)).body);
      const elapsed = performance.now() - started;
      expect(r.items).toHaveLength(147);
      expect(r.total).toBe(147);
      expect(elapsed).toBeLessThan(100);
    }, 60_000);
  });
});
