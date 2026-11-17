import { Injectable } from '@nestjs/common';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PIECE_UNIT, productCodeKey } from '@iorder/shared';
import { escapeLike } from '../../common/database/like.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { Language, Prisma } from '../../generated/prisma/client.js';
import type { TrackingType } from '@iorder/shared/staff-orders';
import type {
  ProductCategoryView,
  SheetCategoryView,
  ProductTranslationView,
  ProductView,
  ProductWithStock,
} from './product.view.js';

const WITH_TRANSLATIONS = { translations: { orderBy: { lang: 'asc' } } } as const;

/** Search text as the staff lists use it: a product code part (lowercase key) or a name part. */
export interface ProductSearch {
  productCodeKey: string;
  text: string;
}

function searchWhere(search: ProductSearch): Prisma.ProductWhereInput {
  return {
    OR: [
      { productCodeKey: { contains: escapeLike(search.productCodeKey) } },
      {
        translations: {
          some: { name: { contains: escapeLike(search.text), mode: 'insensitive' } },
        },
      },
    ],
  };
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs `work` in one database transaction; the caller passes `tx` on to every write. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  async create(
    tx: Tx,
    data: {
      productCode: string;
      translations: ProductTranslationView[];
      now: Date;
      /** A staff-added product without a sheet code: the code came from the sequence. */
      codeGenerated?: boolean;
      brandId?: string | null;
      /** The category label staff chose (the column the sheet fills for sheet products). */
      category?: string | null;
    },
  ): Promise<ProductView> {
    const row = await tx.product.create({
      data: {
        productCode: data.productCode,
        unit: PIECE_UNIT,
        codeGenerated: data.codeGenerated ?? false,
        brandId: data.brandId ?? null,
        category: data.category ?? null,
        createdAt: data.now,
        updatedAt: data.now,
        translations: { create: data.translations },
      },
      include: WITH_TRANSLATIONS,
    });
    return row;
  }

  /** The next number of the generated product codes (IO-000123); the sequence never repeats. */
  async nextGeneratedCodeNumber(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT nextval('product_generated_code_seq') AS n`;
    const next = rows[0]?.n;
    if (next === undefined) throw new Error('product_generated_code_seq returned no value');
    return Number(next);
  }

  /** Lowercase trimmed common names of the ACTIVE products, for "a product of that name exists". */
  async findActiveNameKeys(db?: DbClient): Promise<Set<string>> {
    const rows = await (db ?? this.prisma).productTranslation.findMany({
      where: { product: { isActive: true } },
      select: { name: true },
    });
    return new Set(rows.map((row) => row.name.trim().toLowerCase()));
  }

  /** Active generated-code products (a merged one is inactive, so it is never among them). */
  findActiveGenerated(db?: DbClient): Promise<ProductView[]> {
    return (db ?? this.prisma).product.findMany({
      where: { isActive: true, codeGenerated: true },
      include: WITH_TRANSLATIONS,
    });
  }

  /**
   * Generated-code products that stand alone (active, not merged), plus the generated-code ones
   * among `alsoIds` whatever their state (the "by order" page still lists a removed or merged
   * product while an open order waits for it). One statement.
   */
  findGeneratedStandingOr(alsoIds: readonly string[]): Promise<ProductView[]> {
    return this.prisma.product.findMany({
      where: {
        codeGenerated: true,
        OR: [{ isActive: true, mergedIntoProductId: null }, { id: { in: [...alsoIds] } }],
      },
      include: WITH_TRANSLATIONS,
    });
  }

  /**
   * Ids of the active, non-merged products whose name (any language row) resembles `typedName`:
   * the letters-and-digits forms of both contain one another. A PREFILTER for the pure ranking in
   * `product-name-match.ts`: both sides are normalised by the same SQL expression, which strips at
   * least what the helper strips, so the result is a superset of what the helper accepts and the
   * helper decides. Products whose compact name equals the typed one come first, so the limit
   * never cuts an exact match. Bounded by `limit`; one statement.
   */
  async findSimilarNameCandidateIds(typedName: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH typed AS (
        SELECT lower(regexp_replace(${typedName}::text, '[^[:alnum:]]+', '', 'g')) AS key
      ),
      named AS (
        SELECT t.product_id, lower(regexp_replace(t.name, '[^[:alnum:]]+', '', 'g')) AS key
        FROM product_translations t
      )
      SELECT p.id
      FROM products p
      WHERE p.is_active
        AND p.merged_into_id IS NULL
        AND EXISTS (
          SELECT 1 FROM named n, typed
          WHERE n.product_id = p.id AND n.key <> '' AND typed.key <> ''
            AND (position(n.key IN typed.key) > 0 OR position(typed.key IN n.key) > 0))
      ORDER BY
        (EXISTS (SELECT 1 FROM named n, typed WHERE n.product_id = p.id AND n.key = typed.key)) DESC,
        p.product_code
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  /**
   * Active sheet products (not generated, not merged) whose name (any language row) has the same
   * letters-and-digits form as one of `names`. The same prefilter idea as above: the pairing itself
   * is done by `pairSheetMatches`. One statement whatever the number of names.
   */
  async findSheetProductsByCompactNames(names: readonly string[]): Promise<ProductView[]> {
    if (names.length === 0) return [];
    const list = [...names];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH wanted AS (
        SELECT DISTINCT lower(regexp_replace(n, '[^[:alnum:]]+', '', 'g')) AS key
        FROM unnest(${list}::text[]) AS n
      )
      SELECT DISTINCT p.id
      FROM products p
      JOIN product_translations t ON t.product_id = p.id
      JOIN wanted w ON w.key = lower(regexp_replace(t.name, '[^[:alnum:]]+', '', 'g'))
      WHERE p.is_active AND p.code_generated = false AND p.merged_into_id IS NULL AND w.key <> ''`;
    if (rows.length === 0) return [];
    return this.findByIds(rows.map((row) => row.id));
  }

  /** The merge's final step on the source row: inactive, pointing at the target. */
  async markMerged(tx: Tx, sourceId: string, targetId: string, now: Date): Promise<void> {
    await tx.product.update({
      where: { id: sourceId },
      data: { isActive: false, mergedIntoProductId: targetId, updatedAt: now },
    });
  }

  async setBrand(tx: Tx, productId: string, brandId: string, now: Date): Promise<void> {
    await tx.product.update({ where: { id: productId }, data: { brandId, updatedAt: now } });
  }

  /**
   * Creates products that came from the sheet, in the caller's transaction. `skipDuplicates`
   * (ON CONFLICT DO NOTHING) makes a concurrent creation of the same code harmless: only the
   * rows really inserted come back. The RU name is the sheet's «Наименование товара».
   */
  async createFromSheet(
    tx: Tx,
    rows: readonly { productCode: string; name: string }[],
    now: Date,
  ): Promise<string[]> {
    if (rows.length === 0) return [];
    const created = await tx.product.createManyAndReturn({
      data: rows.map((r) => ({
        productCode: r.productCode,
        unit: PIECE_UNIT,
        createdAt: now,
        updatedAt: now,
      })),
      skipDuplicates: true,
      select: { id: true, productCode: true },
    });
    const nameByCode = new Map(rows.map((r) => [r.productCode, r.name]));
    await tx.productTranslation.createMany({
      data: created.map((c) => ({
        productId: c.id,
        lang: 'RU' as const,
        name: nameByCode.get(c.productCode) ?? c.productCode,
      })),
    });
    return created.map((c) => c.productCode);
  }

  /**
   * Row lock so the "before" values written to the audit log are the ones really replaced.
   * FOR NO KEY UPDATE is enough (the key never changes) and, unlike FOR UPDATE, does not block
   * price list items being inserted for this product (their foreign key takes FOR KEY SHARE,
   * which does not conflict with it).
   */
  async lockById(tx: Tx, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM products WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    return rows.length > 0;
  }

  /** The same lock on several rows, taken in id order so two merges never wait for each other. */
  async lockByIds(tx: Tx, ids: readonly string[]): Promise<void> {
    const list = [...ids];
    await tx.$queryRaw`
      SELECT id FROM products WHERE id = ANY(${list}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
  }

  async findById(id: string, tx?: DbClient): Promise<ProductView | null> {
    return (tx ?? this.prisma).product.findUnique({ where: { id }, include: WITH_TRANSLATIONS });
  }

  /** Case-insensitive: looks up by the generated lowercase key, not by the stored spelling. */
  async findByProductCode(productCode: string): Promise<ProductView | null> {
    return this.prisma.product.findUnique({
      where: { productCodeKey: productCodeKey(productCode) },
      include: WITH_TRANSLATIONS,
    });
  }

  /**
   * FOR SHARE blocks a concurrent deactivation (it takes FOR NO KEY UPDATE) until the caller's
   * transaction ends, and waits for one already in flight. Items' foreign keys only take
   * FOR KEY SHARE, so creating a price for a product stays unblocked.
   */
  async lockForShare(tx: Tx, ids: readonly string[]): Promise<void> {
    const list = [...ids];
    await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${list}::uuid[]) FOR SHARE`;
  }

  /** `productCodeKeys` are lowercase comparison keys (see productCodeKey in @iorder/shared). */
  async findByProductCodes(
    productCodeKeys: readonly string[],
    tx?: DbClient,
  ): Promise<ProductView[]> {
    return (tx ?? this.prisma).product.findMany({
      where: { productCodeKey: { in: [...productCodeKeys] } },
      include: WITH_TRANSLATIONS,
    });
  }

  // ---- stock aggregate (stock_cache) ------------------------------------------------------

  findStock(
    ids: readonly string[],
    db?: DbClient,
  ): Promise<{ productId: string; quantity: Prisma.Decimal }[]> {
    return (db ?? this.prisma).stockCache.findMany({
      where: { productId: { in: [...ids] } },
      select: { productId: true, quantity: true },
    });
  }

  async createStock(
    tx: Tx,
    rows: readonly { productId: string; quantity: Prisma.Decimal; syncedAt: Date }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.stockCache.createMany({ data: [...rows] });
  }

  async updateStock(
    tx: Tx,
    productId: string,
    quantity: Prisma.Decimal,
    syncedAt: Date,
  ): Promise<void> {
    await tx.stockCache.update({ where: { productId }, data: { quantity, syncedAt } });
  }

  async findByIds(ids: readonly string[], tx?: DbClient): Promise<ProductView[]> {
    return (tx ?? this.prisma).product.findMany({
      where: { id: { in: [...ids] } },
      include: WITH_TRANSLATIONS,
    });
  }

  async list(filter: { search?: ProductSearch; category?: string }): Promise<ProductView[]> {
    return this.prisma.product.findMany({
      where: {
        ...(filter.search ? searchWhere(filter.search) : {}),
        ...(filter.category === undefined ? {} : { category: filter.category }),
      },
      orderBy: { productCode: 'asc' },
      include: WITH_TRANSLATIONS,
    });
  }

  /**
   * Products with their stock aggregate. `withStockOrDeliveries`: keep only products that have a
   * stock row or at least one live delivery line (a relation filter: no id list is sent). A fixed
   * number of statements whatever the number of products.
   */
  async listWithStock(filter: {
    search?: ProductSearch;
    withStockOrDeliveries?: boolean;
  }): Promise<ProductWithStock[]> {
    const and: Prisma.ProductWhereInput[] = [];
    if (filter.search) and.push(searchWhere(filter.search));
    if (filter.withStockOrDeliveries) {
      and.push({
        OR: [{ stock: { isNot: null } }, { priceReferences: { some: { removedAt: null } } }],
      });
    }
    const rows = await this.prisma.product.findMany({
      where: { AND: and },
      orderBy: { productCode: 'asc' },
      include: { ...WITH_TRANSLATIONS, stock: { select: { quantity: true } } },
    });
    return rows.map(({ stock, ...product }) => ({
      product,
      stockQuantity: stock?.quantity ?? null,
    }));
  }

  /** Active products whose id is not in `excludedIds` (a count; no rows are loaded). */
  countActiveExcluding(excludedIds: readonly string[]): Promise<number> {
    return this.prisma.product.count({
      where: { isActive: true, id: { notIn: [...excludedIds] } },
    });
  }

  findCategories(
    tx: Tx,
    ids: readonly string[],
  ): Promise<{ id: string; category: string | null }[]> {
    return tx.product.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, category: true },
    });
  }

  /** One statement for all rows. */
  async updateCategories(
    tx: Tx,
    entries: readonly { productId: string; category: string | null }[],
    now: Date,
  ): Promise<void> {
    if (entries.length === 0) return;
    const ids = entries.map((e) => e.productId);
    const categories = entries.map((e) => e.category);
    await tx.$executeRaw`
      UPDATE products AS p SET category = v.category, updated_at = ${now}
      FROM unnest(${ids}::uuid[], ${categories}::text[]) AS v(id, category)
      WHERE p.id = v.id`;
  }

  async updateFields(
    tx: Tx,
    id: string,
    data: { isActive?: boolean; updatedAt: Date },
  ): Promise<void> {
    await tx.product.update({ where: { id }, data });
  }

  async upsertTranslation(
    tx: Tx,
    productId: string,
    translation: ProductTranslationView,
  ): Promise<void> {
    const lang: Language = translation.lang;
    await tx.productTranslation.upsert({
      where: { productId_lang: { productId, lang } },
      create: { productId, lang, name: translation.name, description: translation.description },
      update: { name: translation.name, description: translation.description },
    });
  }

  // ------------------------------------------------------------ categories and code rule

  async listCategories(tx?: Tx): Promise<ProductCategoryView[]> {
    const rows = await (tx ?? this.prisma).productCategory.findMany({
      orderBy: [{ isActive: 'desc' }, { nameKey: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    return rows.map(toCategoryView);
  }

  async findCategoryById(id: string, tx?: Tx): Promise<ProductCategoryView | null> {
    const row = await (tx ?? this.prisma).productCategory.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    return row === null ? null : toCategoryView(row);
  }

  async lockCategory(tx: Tx, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM product_categories WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length > 0;
  }

  async findCategoryByName(tx: Tx, name: string): Promise<{ id: string } | null> {
    return tx.productCategory.findUnique({
      where: { nameKey: name.trim().toLowerCase() },
      select: { id: true },
    });
  }

  async createCategory(
    tx: Tx,
    data: {
      name: string;
      trackingTypeDefault: TrackingType;
      markingRequiredDefault: boolean;
      now: Date;
    },
  ): Promise<string> {
    const row = await tx.productCategory.create({
      data: {
        name: data.name,
        trackingTypeDefault: data.trackingTypeDefault,
        markingRequiredDefault: data.markingRequiredDefault,
        createdAt: data.now,
        updatedAt: data.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async updateCategory(
    tx: Tx,
    id: string,
    data: {
      name?: string;
      trackingTypeDefault?: TrackingType;
      markingRequiredDefault?: boolean;
      isActive?: boolean;
      updatedAt: Date;
    },
  ): Promise<void> {
    await tx.productCategory.update({ where: { id }, data });
  }

  /**
   * Sheet categories («Категория» of the products) without a staff category of the same name,
   * grouped ignoring case and outer spaces. The shown spelling is the most common one (ties: the
   * smallest), so the name a new category gets matches what staff see in the sheet.
   */
  async listSheetCategoriesWithoutTemplate(): Promise<SheetCategoryView[]> {
    const rows = await this.prisma.$queryRaw<{ name: string; product_count: number }[]>`
      SELECT (array_agg(btrim(category) ORDER BY spelling_count DESC, btrim(category)))[1] AS name,
             sum(spelling_count)::int AS product_count
      FROM (
        SELECT category, count(*) AS spelling_count
        FROM products
        WHERE category IS NOT NULL AND btrim(category) <> ''
        GROUP BY category
      ) AS spellings
      WHERE lower(btrim(category)) NOT IN (SELECT name_key FROM product_categories)
      GROUP BY lower(btrim(category))
      ORDER BY lower(btrim(category))`;
    return rows.map((r) => ({ name: r.name, productCount: r.product_count }));
  }

  /**
   * Products not linked to any category whose sheet category has this name (ignoring case and
   * outer spaces) and whose rule was never set: the ones a new category may adopt.
   */
  async findAdoptableProducts(tx: Tx, nameKey: string): Promise<{ id: string }[]> {
    return tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM products
      WHERE category_id IS NULL
        AND code_rule_configured = false
        AND lower(btrim(category)) = ${nameKey}
      ORDER BY id
      FOR UPDATE`;
  }

  /** Active categories by name key, for linking products whose sheet category matches. */
  async findActiveCategoriesByKeys(
    tx: Tx,
    keys: readonly string[],
  ): Promise<
    {
      id: string;
      nameKey: string;
      trackingTypeDefault: TrackingType;
      markingRequiredDefault: boolean;
    }[]
  > {
    if (keys.length === 0) return [];
    return tx.productCategory.findMany({
      where: { nameKey: { in: [...keys] }, isActive: true },
      select: { id: true, nameKey: true, trackingTypeDefault: true, markingRequiredDefault: true },
    });
  }

  /** Unlinked products with an untouched rule among `ids` (sheet sync adoption). */
  async findUnlinkedUntouched(tx: Tx, ids: readonly string[]): Promise<{ id: string }[]> {
    if (ids.length === 0) return [];
    return tx.product.findMany({
      where: {
        id: { in: [...ids] },
        categoryId: null,
        codeRuleConfigured: false,
      },
      select: { id: true },
    });
  }

  async updateTracking(
    tx: Tx,
    id: string,
    data: {
      categoryId?: string | null;
      trackingType?: TrackingType;
      markingRequired?: boolean;
      codeRuleConfigured?: boolean;
      updatedAt: Date;
    },
  ): Promise<void> {
    await tx.product.update({ where: { id }, data });
  }
}

function toCategoryView(row: {
  id: string;
  name: string;
  trackingTypeDefault: TrackingType;
  markingRequiredDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { products: number };
}): ProductCategoryView {
  return {
    id: row.id,
    name: row.name,
    trackingTypeDefault: row.trackingTypeDefault,
    markingRequiredDefault: row.markingRequiredDefault,
    isActive: row.isActive,
    productCount: row._count.products,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
