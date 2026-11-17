import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPrisma, resetCatalogPricingAudit } from './support/test-db.js';

// Defence in depth for hard rules 3-5: these go around the service layer on purpose.
describe('database invariants for catalog, pricing and audit (real PostgreSQL)', () => {
  const prisma = createTestPrisma();
  let productId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });
  beforeEach(async () => {
    await resetCatalogPricingAudit(prisma);
    productId = (await prisma.product.create({ data: { productCode: 'CODE-1', unit: 'piece' } }))
      .id;
  });

  const publishedAt = new Date('2026-10-20T08:00:00Z');

  async function makeVersion(status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'): Promise<string> {
    // Created as DRAFT with an item, then moved through the real lifecycle.
    const version = await prisma.priceListVersion.create({ data: {} });
    await prisma.priceListItem.create({
      data: { versionId: version.id, productId, basePrice: '1690000.10' },
    });
    if (status !== 'DRAFT') {
      await prisma.priceListVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt, publishedBy: 'u1' },
      });
    }
    if (status === 'ARCHIVED') {
      await prisma.priceListVersion.update({
        where: { id: version.id },
        data: { status: 'ARCHIVED' },
      });
    }
    return version.id;
  }

  it('rejects a second PUBLISHED version', async () => {
    await makeVersion('PUBLISHED');
    const second = await prisma.priceListVersion.create({ data: {} });
    await expect(
      prisma.priceListVersion.update({
        where: { id: second.id },
        data: { status: 'PUBLISHED', publishedAt, publishedBy: 'u1' },
      }),
    ).rejects.toThrow();
    await expect(prisma.priceListVersion.count({ where: { status: 'PUBLISHED' } })).resolves.toBe(
      1,
    );
  });

  it('rejects a second open DRAFT (restrictive choice, see migration)', async () => {
    await makeVersion('DRAFT');
    await expect(prisma.priceListVersion.create({ data: {} })).rejects.toThrow();
  });

  it('rejects raw UPDATE and DELETE on items of a PUBLISHED version', async () => {
    const versionId = await makeVersion('PUBLISHED');
    await expect(
      prisma.$executeRaw`UPDATE price_list_items SET base_price = 1 WHERE version_id = ${versionId}::uuid`,
    ).rejects.toThrow(/not a draft/);
    await expect(
      prisma.$executeRaw`DELETE FROM price_list_items WHERE version_id = ${versionId}::uuid`,
    ).rejects.toThrow(/not a draft/);
    await expect(
      prisma.$executeRaw`INSERT INTO price_list_items (id, version_id, product_id, base_price)
        VALUES (${randomUUID()}::uuid, ${versionId}::uuid, ${productId}::uuid, 5)`,
    ).rejects.toThrow(/not a draft/);
    // The RRP is frozen with the rest of the row: it changes only by publishing a new version.
    await expect(
      prisma.$executeRaw`UPDATE price_list_items SET rrp = 5 WHERE version_id = ${versionId}::uuid`,
    ).rejects.toThrow(/not a draft/);
    const item = await prisma.priceListItem.findFirstOrThrow({ where: { versionId } });
    expect(item.basePrice.toFixed(2)).toBe('1690000.10');
    expect(item.rrp).toBeNull();
  });

  it('rejects changes to items of an ARCHIVED version', async () => {
    const versionId = await makeVersion('ARCHIVED');
    await expect(
      prisma.$executeRaw`DELETE FROM price_list_items WHERE version_id = ${versionId}::uuid`,
    ).rejects.toThrow(/not a draft/);
  });

  it('rejects moving an item of a draft into a published version', async () => {
    const published = await makeVersion('PUBLISHED');
    const draft = await prisma.priceListVersion.create({ data: {} });
    const item = await prisma.priceListItem.create({
      data: { versionId: draft.id, productId, basePrice: '10.00' },
    });
    await expect(
      prisma.$executeRaw`UPDATE price_list_items SET version_id = ${published}::uuid WHERE id = ${item.id}::uuid`,
    ).rejects.toThrow(/not a draft/);
  });

  it('allows editing and deleting items of a DRAFT, and deleting the draft with its items', async () => {
    const versionId = await makeVersion('DRAFT');
    await prisma.$executeRaw`UPDATE price_list_items SET base_price = 2 WHERE version_id = ${versionId}::uuid`;
    await prisma.priceListVersion.delete({ where: { id: versionId } });
    await expect(prisma.priceListItem.count()).resolves.toBe(0);
  });

  it('freezes version metadata once published and rejects deleting or reviving versions', async () => {
    const archived = await makeVersion('ARCHIVED');
    const published = await makeVersion('PUBLISHED');
    // Raw SQL: the ORM maps trigger errors to a generic message, raw SQL keeps ours.
    await expect(
      prisma.$executeRaw`UPDATE price_list_versions SET note = 'edited' WHERE id = ${published}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM price_list_versions WHERE id = ${published}::uuid`,
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      prisma.$executeRaw`UPDATE price_list_versions SET note = 'x' WHERE id = ${archived}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`UPDATE price_list_versions SET status = 'DRAFT', published_at = NULL, published_by = NULL WHERE id = ${archived}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`UPDATE price_list_versions SET status = 'DRAFT', published_at = NULL, published_by = NULL WHERE id = ${published}::uuid`,
    ).rejects.toThrow(/immutable/);
  });

  it('rejects zero/negative prices and a DRAFT with publication data', async () => {
    const draft = await prisma.priceListVersion.create({ data: {} });
    await expect(
      prisma.priceListItem.create({ data: { versionId: draft.id, productId, basePrice: '0' } }),
    ).rejects.toThrow();
    // The RRP is optional, but never zero or negative (price_list_items_rrp_positive).
    for (const rrp of ['0', '-1.00']) {
      await expect(
        prisma.priceListItem.create({
          data: { versionId: draft.id, productId, basePrice: '10.00', rrp },
        }),
      ).rejects.toThrow();
    }
    await expect(
      prisma.priceListVersion.update({
        where: { id: draft.id },
        data: { status: 'PUBLISHED' },
      }),
    ).rejects.toThrow();
  });

  it('rejects TRUNCATE (also CASCADE) on every protected table, even for the owner', async () => {
    const versionId = await makeVersion('PUBLISHED');
    for (const table of [
      'price_list_items',
      'price_list_versions',
      'products',
      'product_translations',
      'audit_log',
    ]) {
      await expect(prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`), table).rejects.toThrow(
        /not allowed|append-only/,
      );
    }
    await expect(
      prisma.priceListVersion.findUniqueOrThrow({ where: { id: versionId } }),
    ).resolves.toMatchObject({ status: 'PUBLISHED' });
    await expect(prisma.priceListItem.count({ where: { versionId } })).resolves.toBe(1);
  });

  describe('product code rule in the database', () => {
    const insert = (productCode: string) =>
      prisma.$executeRaw`INSERT INTO products (id, product_code, unit, updated_at)
        VALUES (${randomUUID()}::uuid, ${productCode}, 'box', now())`;

    it('accepts product codes as entered, mixed case included (valid control inserts)', async () => {
      await expect(insert('HONOR-X7C-6GB128GB-MidnightBlack')).resolves.toBe(1);
      await expect(insert('a.b_c-d/e')).resolves.toBe(1);
      await expect(insert('A'.repeat(64))).resolves.toBe(1);
      const row = await prisma.product.findFirstOrThrow({
        where: { productCode: { startsWith: 'HONOR' } },
      });
      expect(row.productCode).toBe('HONOR-X7C-6GB128GB-MidnightBlack'); // original spelling kept
      expect(row.productCodeKey).toBe('honor-x7c-6gb128gb-midnightblack'); // generated, lowercase
    });

    it.each([
      ['an inner space', 'AB 1'],
      ['a padded value', ' PADDED'],
      ['a trailing space', 'TRAIL '],
      ['empty', ''],
      ['spaces only', ' '],
      ['Cyrillic', 'КБ-15'],
      ['an emoji', 'AB-1😀'],
      ['sharp s', 'Straße-1'],
      ['a tab', 'AB\t1'],
      ['a non-breaking space', 'AB\u00a01'],
      ['a newline at the end', 'AB-1\n'],
      ['a leading dash', '-AB1'],
      ['a leading dot', '.AB1'],
      ['65 characters', 'A'.repeat(65)],
      ['a comma', 'AB,1'],
    ])('refuses %s with the named CHECK', async (_name, productCode) => {
      await expect(insert(productCode)).rejects.toThrow(/products_product_code_format/);
    });

    it('refuses a case-only duplicate with the unique key on the generated column', async () => {
      await expect(insert('Honor-X7C')).resolves.toBe(1);
      await expect(insert('HONOR-X7C')).rejects.toThrow(/products_product_code_key_key/);
      await expect(insert('honor-x7c')).rejects.toThrow(/products_product_code_key_key/);
      await expect(prisma.product.count()).resolves.toBe(2); // beforeEach product + Honor-X7C
    });

    it('the generated key cannot be written by the application', async () => {
      await expect(
        prisma.$executeRaw`UPDATE products SET product_code_key = 'x' WHERE product_code = 'CODE-1'`,
      ).rejects.toThrow(); // PostgreSQL refuses writes to a generated column
    });

    it('case-only duplicates make the migration fail loudly when the unique index is built (rolled back here)', async () => {
      class Rollback extends Error {}
      const failure = await prisma
        .$transaction(async (tx) => {
          // Reproduce the pre-migration state inside a transaction that is always rolled back:
          // no unique key on the generated column yet, two rows that differ only in case.
          await tx.$executeRaw`DROP INDEX products_product_code_key_key`;
          await tx.$executeRaw`INSERT INTO products (id, product_code, unit, updated_at)
            VALUES (${randomUUID()}::uuid, 'kb-15', 'box', now()), (${randomUUID()}::uuid, 'KB-15', 'box', now())`;
          try {
            // The statement of migration 20261022090000_sku_as_entered_case_insensitive:
            await tx.$executeRaw`CREATE UNIQUE INDEX products_product_code_key_key ON products (product_code_key)`;
          } catch (error) {
            return error as Error;
          }
          throw new Rollback('migration unexpectedly succeeded');
        })
        .catch((error: unknown) => error as Error);
      expect(failure).not.toBeInstanceOf(Rollback);
      expect(String(failure.message)).toMatch(/products_product_code_key_key|unique|duplicate/i);
      // Rolled back: the index is back (a case-only duplicate is refused again) and the rows are gone.
      await expect(prisma.product.count({ where: { productCodeKey: 'kb-15' } })).resolves.toBe(0);
      await expect(insert('Dup-1')).resolves.toBe(1);
      await expect(insert('DUP-1')).rejects.toThrow(/products_product_code_key_key/);
    });
  });

  it('price_reference refuses negative quantities and costs, a zero rate, blank refs and TRUNCATE', async () => {
    const insert = (overrides: Record<string, string>) => {
      const v = {
        delivered: '1',
        available: '1',
        usd: '1',
        rate: '12000',
        uzs: '12000',
        ref: 'R-1',
        supplier: 'alpha trade import',
        method: 'Безнал',
        category: 'Смартфоны',
        ...overrides,
      };
      return prisma.$executeRawUnsafe(
        `INSERT INTO price_reference (id, product_id, delivery_ref, supplier, purchase_method, category,
           delivered_quantity, available_quantity, cost_usd, usd_rate_used, cost_uzs, delivered_at, synced_at)
         VALUES ('${randomUUID()}', '${productId}', '${v.ref}', '${v.supplier}', '${v.method}', '${v.category}', ${v.delivered}, ${v.available}, ${v.usd}, ${v.rate}, ${v.uzs}, now(), now())`,
      );
    };
    await expect(insert({})).resolves.toBe(1);
    await expect(insert({ ref: 'R-2', delivered: '-1' })).rejects.toThrow();
    await expect(insert({ ref: 'R-3', available: '-0.001' })).rejects.toThrow();
    await expect(insert({ ref: 'R-4', usd: '-1' })).rejects.toThrow();
    await expect(insert({ ref: 'R-5', rate: '0' })).rejects.toThrow();
    await expect(insert({ ref: '  ' })).rejects.toThrow();
    await expect(insert({ ref: 'S-1', supplier: '  ' })).rejects.toThrow(/supplier_not_blank/);
    await expect(insert({ ref: 'S-2', method: '' })).rejects.toThrow(/purchase_method_not_blank/);
    await expect(insert({ ref: 'S-3', category: ' ' })).rejects.toThrow(/category_not_blank/);
    await expect(insert({})).rejects.toThrow(); // unique(product, delivery_ref)
    // CASCADE: order_allocations references this table, and without it the FK check answers first
    // and the trigger under test never runs.
    await expect(prisma.$executeRawUnsafe('TRUNCATE price_reference CASCADE')).rejects.toThrow(
      /not allowed/,
    );
  });

  it('only accepts USD (entered since 2026-10-29) and older UZS prices', async () => {
    const draft = await prisma.priceListVersion.create({ data: {} });
    await expect(
      prisma.priceListItem.create({
        data: { versionId: draft.id, productId, basePrice: '1.00', currency: 'EUR' },
      }),
    ).rejects.toThrow();
    const item = await prisma.priceListItem.create({
      data: { versionId: draft.id, productId, basePrice: '1.00' },
    });
    expect(item.currency).toBe('USD');
  });

  it('says clearly when an item points at a version that does not exist', async () => {
    const missing = randomUUID();
    await expect(
      prisma.$executeRaw`INSERT INTO price_list_items (id, version_id, product_id, base_price)
        VALUES (${randomUUID()}::uuid, ${missing}::uuid, ${productId}::uuid, 5)`,
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses a NULL actor unless the action is a SHEET_SYNC_* system action', async () => {
    const insert = (actor: string | null, action: string) =>
      prisma.$executeRaw`INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, diff, created_at)
        VALUES (${randomUUID()}::uuid, ${actor}, 'T', 'e', ${action}, '{}'::jsonb, now())`;
    await expect(insert(null, 'PRODUCT_UPDATED')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert(null, 'SHEET_SYNC')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert(null, 'XSHEET_SYNC_A')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert(null, 'SHEET_SYNC_CREATED')).resolves.toBe(1);
    await expect(insert(null, 'RATE_REFRESH_UPDATED')).resolves.toBe(1);
    await expect(insert(null, 'RATE_REFRESH')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert(null, 'RATE_REFRESHED')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert(null, 'XRATE_REFRESH_A')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert('u1', 'PRODUCT_UPDATED')).resolves.toBe(1);
  });

  it('keeps audit_log append-only at the database level', async () => {
    const id = randomUUID();
    await prisma.$executeRaw`INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, diff, created_at)
      VALUES (${id}::uuid, 'u1', 'PRODUCT', 'p1', 'TEST', '{}'::jsonb, now())`;
    await expect(
      prisma.$executeRaw`UPDATE audit_log SET action = 'TAMPERED' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${id}::uuid`).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRaw`TRUNCATE audit_log`).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.count()).resolves.toBe(1);
  });
});
