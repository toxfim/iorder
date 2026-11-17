import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { CatalogModule, CatalogService } from '../src/modules/catalog/index.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import {
  ACCOUNTANT,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SHOP_OWNER,
  type TestApp,
} from './support/test-app.js';

const newProduct = { productCode: 'APPLE-1', name: 'Olma' };

describe('catalog endpoints and audit (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule]);
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

  it('401 without an actor, 403 for roles without UPDATE_PRICE_LIST', async () => {
    expect((await t.request('GET', '/staff/products')).status).toBe(401);
    for (const actor of [SHOP_OWNER, DRIVER, ACCOUNTANT]) {
      expect((await t.request('GET', '/staff/products', { actor })).status).toBe(403);
      expect((await t.request('POST', '/staff/products', { actor, body: newProduct })).status).toBe(
        403,
      );
    }
  });

  it('422 for invalid input', async () => {
    const response = await t.request('POST', '/staff/products', {
      actor: MANAGER,
      body: { ...newProduct, name: '' },
    });
    expect(response.status).toBe(422);
    // The unit and the per-language names are gone from the contract (owner, 2026-10-28).
    for (const body of [
      { ...newProduct, unit: 'box' },
      { productCode: 'X-1', translations: [{ lang: 'UZ', name: 'x' }] },
    ]) {
      expect((await t.request('POST', '/staff/products', { actor: MANAGER, body })).status).toBe(
        422,
      );
    }
    expect((await t.request('GET', '/staff/products/not-a-uuid', { actor: MANAGER })).status).toBe(
      422,
    );
  });

  it('manager and admin can create, update and list; product code conflicts return 409', async () => {
    const created = await t.request('POST', '/staff/products', {
      actor: MANAGER,
      body: newProduct,
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const duplicate = await t.request('POST', '/staff/products', {
      actor: ADMIN,
      body: newProduct,
    });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { error: { reason: string } }).error.reason).toBe(
      'DUPLICATE_PRODUCT_CODE',
    );

    const updated = await t.request('PATCH', `/staff/products/${id}`, {
      actor: ADMIN,
      body: { isActive: false, name: 'Yashil olma' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ isActive: false, name: 'Yashil olma', unit: 'PIECE' });

    const list = await t.request('GET', '/staff/products', { actor: MANAGER });
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);
    expect((await t.request('GET', `/staff/products/${id}`, { actor: MANAGER })).status).toBe(200);
    expect(
      (
        await t.request('GET', '/staff/products/019a0000-0000-7000-8000-000000000000', {
          actor: MANAGER,
        })
      ).status,
    ).toBe(404);
  });

  it('records who/when and full before/after in the audit log', async () => {
    const created = await t.request('POST', '/staff/products', {
      actor: MANAGER,
      body: newProduct,
    });
    const id = (created.body as { id: string }).id;
    t.clock.set(new Date('2026-10-21T10:30:00Z'));
    await t.request('PATCH', `/staff/products/${id}`, {
      actor: ADMIN,
      body: { name: 'Qizil olma' },
    });

    const rows = await t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['PRODUCT_CREATED', 'PRODUCT_UPDATED']);
    expect(rows[0]).toMatchObject({ actorUserId: MANAGER.userId, entityId: id });
    expect(rows[1]?.actorUserId).toBe(ADMIN.userId);
    expect(rows[1]?.createdAt.toISOString()).toBe('2026-10-21T10:30:00.000Z');
    expect(rows[1]?.diff).toEqual({
      'translations.UZ.name': { from: 'Olma', to: 'Qizil olma' },
    });
  });

  it('a pure activation toggle gets its own action; a no-op writes nothing', async () => {
    const created = await t.request('POST', '/staff/products', {
      actor: MANAGER,
      body: newProduct,
    });
    const id = (created.body as { id: string }).id;
    await t.request('PATCH', `/staff/products/${id}`, {
      actor: MANAGER,
      body: { isActive: false },
    });
    await t.request('PATCH', `/staff/products/${id}`, {
      actor: MANAGER,
      body: { isActive: false },
    });
    const actions = (await t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (r) => r.action,
    );
    expect(actions).toEqual(['PRODUCT_CREATED', 'PRODUCT_ACTIVATION_CHANGED']);
  });

  describe('product code rule: stored as entered, compared ignoring case', () => {
    const create = (productCode: string) =>
      t.request('POST', '/staff/products', {
        actor: MANAGER,
        body: { ...newProduct, productCode },
      });
    const REAL = 'HONOR-X7C-6GB128GB-MidnightBlack';

    it('stores the product code as entered (trimmed) and returns that spelling', async () => {
      const response = await create(`  ${REAL} `);
      expect(response.status).toBe(201);
      expect((response.body as { productCode: string }).productCode).toBe(REAL);
      await expect(t.prisma.product.findFirstOrThrow()).resolves.toMatchObject({
        productCode: REAL,
        productCodeKey: REAL.toLowerCase(),
      });
      const detail = await t.request(
        'GET',
        `/staff/products/${(response.body as { id: string }).id}`,
        {
          actor: MANAGER,
        },
      );
      expect((detail.body as { productCode: string }).productCode).toBe(REAL);
    });

    it('Honor-X7C and HONOR-X7C are one product: the second create is a 409', async () => {
      expect((await create('Honor-X7C')).status).toBe(201);
      for (const again of ['HONOR-X7C', 'honor-x7c', ' hOnOr-X7c ']) {
        const r = await create(again);
        expect(r.status, again).toBe(409);
        expect((r.body as { error: { code: string } }).error.code).toBe('CONFLICT');
        expect((r.body as { error: { reason: string } }).error.reason).toBe(
          'DUPLICATE_PRODUCT_CODE',
        );
      }
      await expect(t.prisma.product.count()).resolves.toBe(1);
      // The first spelling survives.
      await expect(t.prisma.product.findFirstOrThrow()).resolves.toMatchObject({
        productCode: 'Honor-X7C',
      });
    });

    it('two concurrent creates that differ only in letter case: exactly one wins', async () => {
      const results = await Promise.all([create('Race-Case'), create('RACE-CASE')]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect((loser.body as { error: { reason: string } }).error.reason).toBe(
        'DUPLICATE_PRODUCT_CODE',
      );
      await expect(t.prisma.product.count()).resolves.toBe(1);
    });

    it('the service trims and compares ignoring case even if the boundary was bypassed', async () => {
      const catalog = t.get(CatalogService);
      const created = await catalog.createProduct(MANAGER, { productCode: ' Ab-1 ', name: 'X' });
      expect(created.productCode).toBe('Ab-1');
      await expect(
        catalog.createProduct(MANAGER, { productCode: 'aB-1', name: 'X' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', reason: 'DUPLICATE_PRODUCT_CODE' });
      await expect(
        catalog.findProductsByProductCodes([' ab-1', 'AB-1', 'aB-1']),
      ).resolves.toHaveLength(1);
    });

    it.each([
      ['an inner space', 'AB 1'],
      ['Cyrillic', 'КБ-15'],
      ['an emoji', 'AB-1😀'],
      ['sharp s', 'Straße-1'],
      ['a tab', 'AB\t1'],
      ['a tab at the edge', '\tAB-1'],
      ['a non-breaking space', 'AB\u00a01'],
      ['a non-breaking space at the edge', '\u00a0AB-1'],
      ['a leading dash', '-AB1'],
      ['a leading dot', '.AB1'],
      ['65 characters', 'A'.repeat(65)],
      ['a comma', 'AB,1'],
      ['an empty value', '   '],
    ])('rejects %s with 422', async (_name, productCode) => {
      expect((await create(productCode)).status).toBe(422);
      await expect(t.prisma.product.count()).resolves.toBe(0);
    });

    it('accepts the allowed characters and the 64-character limit', async () => {
      for (const productCode of ['A', '9', 'a.b_c-d/e', REAL, 'A'.repeat(64)]) {
        expect((await create(productCode)).status, productCode).toBe(201);
      }
    });

    it('search ignores letter case for product codes, in the staff list', async () => {
      await create(REAL);
      const found = async (q: string): Promise<string[]> =>
        (
          (
            await t.request('GET', `/staff/products?search=${encodeURIComponent(q)}`, {
              actor: MANAGER,
            })
          ).body as { items: { productCode: string }[] }
        ).items.map((p) => p.productCode);
      expect(await found('honor-x7c-6gb128gb-midnightblack')).toEqual([REAL]);
      expect(await found('MIDNIGHT')).toEqual([REAL]);
      expect(await found('  x7c ')).toEqual([REAL]);
    });

    it('LIKE wildcards in the search text are literal: % and _ do not match everything', async () => {
      await create('KB-15');
      await create('AB_1');
      await t.request('POST', '/staff/products', {
        actor: MANAGER,
        body: { productCode: 'ZX-9', name: '100% Olma' },
      });
      const codes = async (q: string): Promise<string[]> =>
        (
          (
            await t.request('GET', `/staff/products?search=${encodeURIComponent(q)}`, {
              actor: MANAGER,
            })
          ).body as { items: { productCode: string }[] }
        ).items.map((p) => p.productCode);
      expect(await codes('%')).toEqual(['ZX-9']); // only the name that really contains a percent sign
      expect(await codes('_')).toEqual(['AB_1']); // only the product code that really contains an underscore
      expect(await codes('K_-15')).toEqual([]); // "_" is not "any one character"
      expect(await codes('K%5')).toEqual([]); // "%" is not "any characters"
      expect(await codes('AB_')).toEqual(['AB_1']);
    });

    it('search is case-insensitive and trims whitespace; it matches product code and names', async () => {
      await create('KB-15');
      await t.request('POST', '/staff/products', {
        actor: MANAGER,
        body: { productCode: 'ZX-1', name: 'Qizil Olma' },
      });
      const codes = async (q: string): Promise<string[]> =>
        (
          (
            await t.request('GET', `/staff/products?search=${encodeURIComponent(q)}`, {
              actor: MANAGER,
            })
          ).body as { items: { productCode: string }[] }
        ).items.map((p) => p.productCode);
      expect(await codes('kb-15')).toEqual(['KB-15']);
      expect(await codes('  Kb-1 ')).toEqual(['KB-15']);
      expect(await codes('qizil')).toEqual(['ZX-1']);
      expect(await codes('nothing')).toEqual([]);
      expect((await t.request('GET', '/staff/products?search=', { actor: MANAGER })).status).toBe(
        422,
      );
    });
  });

  it('takes created_at/updated_at from the Clock, and a no-op PATCH touches nothing', async () => {
    const created = await t.request('POST', '/staff/products', {
      actor: MANAGER,
      body: newProduct,
    });
    const id = (created.body as { id: string }).id;
    expect((created.body as { updatedAt: string }).updatedAt).toBe('2026-10-20T08:00:00.000Z');

    t.clock.set(new Date('2026-10-20T09:00:00Z'));
    const noop = await t.request('PATCH', `/staff/products/${id}`, {
      actor: MANAGER,
      body: { isActive: true, name: 'Olma' },
    });
    expect(noop.status).toBe(200);
    expect((noop.body as { updatedAt: string }).updatedAt).toBe('2026-10-20T08:00:00.000Z');
    await expect(t.prisma.auditLog.count()).resolves.toBe(1);

    await t.request('PATCH', `/staff/products/${id}`, { actor: MANAGER, body: { name: 'Nok' } });
    const row = await t.prisma.product.findUniqueOrThrow({ where: { id } });
    expect(row.updatedAt.toISOString()).toBe('2026-10-20T09:00:00.000Z');
    expect(row.createdAt.toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('two concurrent creates with the same product code: exactly one 201, the other 409', async () => {
    for (let round = 0; round < 5; round += 1) {
      const body = { ...newProduct, productCode: `RACE-${round}` };
      const results = await Promise.all([
        t.request('POST', '/staff/products', { actor: MANAGER, body }),
        t.request('POST', '/staff/products', { actor: ADMIN, body }),
      ]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([201, 409]);
      expect(
        (results.find((r) => r.status === 409)!.body as { error: { reason: string } }).error.reason,
      ).toBe('DUPLICATE_PRODUCT_CODE');
      await expect(
        t.prisma.product.count({ where: { productCode: body.productCode } }),
      ).resolves.toBe(1);
      // The loser's transaction rolled back completely, audit row included.
      await expect(t.prisma.auditLog.count({ where: { action: 'PRODUCT_CREATED' } })).resolves.toBe(
        round + 1,
      );
    }
  });

  it('rolls the change back when the audit row cannot be written', async () => {
    vi.spyOn(t.get(AuditService), 'record').mockRejectedValue(new Error('audit down'));
    const response = await t.request('POST', '/staff/products', {
      actor: MANAGER,
      body: newProduct,
    });
    expect(response.status).toBe(500);
    await expect(t.prisma.product.count()).resolves.toBe(0);
    await expect(t.prisma.auditLog.count()).resolves.toBe(0);
  });
});
