import { randomUUID } from 'node:crypto';
import {
  brandListResponseSchema,
  brandResponseSchema,
  productBrandResponseSchema,
  unbrandedProductListResponseSchema,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
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

const UNKNOWN_ID = '019a0000-0000-7000-8000-000000000000';

describe('brands (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetCatalogPricingAudit(t.prisma);
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

  const makeProduct = async (code: string, ruName: string, isActive = true): Promise<string> =>
    (
      await t.prisma.product.create({
        data: {
          productCode: code,
          unit: 'dona',
          isActive,
          translations: { create: [{ lang: 'RU', name: ruName }] },
        },
      })
    ).id;

  /** Brands survive the catalog reset (seeded by the migration), so test names are unique. */
  const uniqueName = (prefix: string): string => `${prefix} ${randomUUID().slice(0, 8)}`;

  describe('permissions', () => {
    it('only manager and admin reach the brand routes', async () => {
      const product = await makeProduct('P-1', 'Something');
      const routes: [string, string, unknown?][] = [
        ['GET', '/staff/brands'],
        ['POST', '/staff/brands', { name: uniqueName('Perm') }],
        ['GET', '/staff/brands/unbranded-products'],
        ['PUT', `/staff/products/${product}/brand`, { brandId: UNKNOWN_ID }],
      ];
      for (const actor of [ACCOUNTANT, WAREHOUSE, DRIVER, SHOP_OWNER, SELLER]) {
        for (const [method, path, body] of routes) {
          expect((await call(method, path, actor, body)).status, `${method} ${path}`).toBe(403);
        }
      }
      for (const actor of [MANAGER, ADMIN]) {
        expect((await call('GET', '/staff/brands', actor)).status).toBe(200);
        expect((await call('GET', '/staff/brands/unbranded-products', actor)).status).toBe(200);
      }
      expect(await t.prisma.auditLog.count()).toBe(0);
    });
  });

  it('lists the seeded brands sorted by name', async () => {
    const r = await call('GET', '/staff/brands');
    const body = brandListResponseSchema.parse(r.body);
    const names = body.items.map((b) => b.name);
    for (const seeded of ['Xiaomi', 'Huawei', 'Motorola', 'Black Shark']) {
      expect(names).toContain(seeded);
    }
    // Sold as Xiaomi: the rows stay, but staff are not offered them.
    expect(names).not.toContain('Redmi');
    expect(names).not.toContain('Mijia');
    const keys = names.map((n) => n.toLowerCase());
    expect(keys).toEqual([...keys].sort());
  });

  it('creates a brand with an audit row; the same name in any case is a 409', async () => {
    const name = uniqueName('Acme');
    const created = await call('POST', '/staff/brands', ADMIN, { name: `  ${name} ` });
    expect(created.status).toBe(201);
    const brand = brandResponseSchema.parse(created.body);
    expect(brand.name).toBe(name);
    const row = await t.prisma.brand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(row.createdByUserId).toBe(ADMIN.userId);

    const audit = await t.prisma.auditLog.findMany({ where: { entityType: 'BRAND' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: ADMIN.userId,
      entityId: brand.id,
      action: 'BRAND_CREATED',
      diff: { name: { from: null, to: name } },
    });

    for (const duplicate of [name.toUpperCase(), 'xiaomi', 'BLACK SHARK']) {
      const again = await call('POST', '/staff/brands', MANAGER, { name: duplicate });
      expect(again.status, duplicate).toBe(409);
      expect(again.body.error.reason).toBe('DUPLICATE_BRAND_NAME');
    }
    expect(await t.prisma.auditLog.count({ where: { entityType: 'BRAND' } })).toBe(1);
  });

  it('rejects a blank or too long name (422)', async () => {
    expect((await call('POST', '/staff/brands', MANAGER, { name: '   ' })).status).toBe(422);
    expect((await call('POST', '/staff/brands', MANAGER, { name: 'x'.repeat(81) })).status).toBe(
      422,
    );
  });

  it('a brand creation that cannot be audited does not happen', async () => {
    vi.spyOn(t.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit down'));
    const name = uniqueName('Rolled back');
    expect((await call('POST', '/staff/brands', MANAGER, { name })).status).toBe(500);
    expect(await t.prisma.brand.count({ where: { name } })).toBe(0);
  });

  it('lists active products no brand applies to, priced first, then by name', async () => {
    await makeProduct('X-1', 'Xiaomi Robot Vacuum 6 EU');
    await makeProduct('R-1', 'Наушники REDMI Buds 8 Black');
    const freebuds = await makeProduct('F-1', 'FreeBuds 6i Black');
    const extender = await makeProduct('M-1', 'Mi Wi-Fi Range Extender Pro CE');
    const thermo = await makeProduct('T-1', 'Термометр Mi Temperature and Humidity Monitor 3');
    await makeProduct('OLD', 'Old unbranded thing', false);
    // Publish a price for the extender only: it is "priced".
    const draft = await call('POST', '/staff/price-list/drafts', MANAGER, {
      copyFromCurrent: false,
    });
    await call('PUT', `/staff/price-list/drafts/${draft.body.id as string}/items`, MANAGER, {
      items: [{ productId: extender, basePrice: '100000.00' }],
    });
    expect(
      (await call('POST', `/staff/price-list/drafts/${draft.body.id as string}/publish`)).status,
    ).toBe(200);

    const r = await call('GET', '/staff/brands/unbranded-products');
    const body = unbrandedProductListResponseSchema.parse(r.body);
    expect(body.items.map((i) => [i.productId, i.priced])).toEqual([
      [extender, true],
      [freebuds, false],
      [thermo, false],
    ]);
    expect(body.items[0]).toMatchObject({
      productCode: 'M-1',
      name: 'Mi Wi-Fi Range Extender Pro CE',
      category: null,
    });
  });

  it('sets the brand of a product (manual brand wins over the finder), audited with before and after', async () => {
    const product = await makeProduct('F-1', 'FreeBuds 6i Black');
    const brands = brandListResponseSchema.parse((await call('GET', '/staff/brands')).body).items;
    const huawei = brands.find((b) => b.name === 'Huawei');
    const xiaomi = brands.find((b) => b.name === 'Xiaomi');
    if (!huawei || !xiaomi) throw new Error('seeded brands missing');

    const set = await call('PUT', `/staff/products/${product}/brand`, MANAGER, {
      brandId: huawei.id,
    });
    expect(set.status).toBe(200);
    expect(productBrandResponseSchema.parse(set.body)).toEqual({
      productId: product,
      brand: huawei,
    });
    expect(
      unbrandedProductListResponseSchema
        .parse((await call('GET', '/staff/brands/unbranded-products')).body)
        .items.map((i) => i.productId),
    ).not.toContain(product);

    // The same brand again changes nothing and writes no history.
    expect(
      (await call('PUT', `/staff/products/${product}/brand`, MANAGER, { brandId: huawei.id }))
        .status,
    ).toBe(200);
    await call('PUT', `/staff/products/${product}/brand`, ADMIN, { brandId: xiaomi.id });

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PRODUCT', entityId: product, action: 'PRODUCT_BRAND_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => [a.actorUserId, a.diff])).toEqual([
      [
        MANAGER.userId,
        { brandId: { from: null, to: huawei.id }, brandName: { from: null, to: 'Huawei' } },
      ],
      [
        ADMIN.userId,
        {
          brandId: { from: huawei.id, to: xiaomi.id },
          brandName: { from: 'Huawei', to: 'Xiaomi' },
        },
      ],
    ]);
    const row = await t.prisma.product.findUniqueOrThrow({ where: { id: product } });
    expect(row.brandId).toBe(xiaomi.id);
  });

  it('404 for an unknown product or brand, 422 for a bad id', async () => {
    const product = await makeProduct('F-1', 'FreeBuds 6i Black');
    const brands = brandListResponseSchema.parse((await call('GET', '/staff/brands')).body).items;
    const any = brands[0];
    if (!any) throw new Error('no brand');
    expect(
      (await call('PUT', `/staff/products/${UNKNOWN_ID}/brand`, MANAGER, { brandId: any.id }))
        .status,
    ).toBe(404);
    expect(
      (await call('PUT', `/staff/products/${product}/brand`, MANAGER, { brandId: UNKNOWN_ID }))
        .status,
    ).toBe(404);
    expect(
      (await call('PUT', '/staff/products/nope/brand', MANAGER, { brandId: any.id })).status,
    ).toBe(422);
    expect(await t.prisma.auditLog.count()).toBe(0);
  });
});
