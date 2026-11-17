import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { Clock } from '../../common/clock/clock.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService, diffFields, type AuditValue, type AuditChanges } from '../audit/index.js';
import { BrandRepository } from './brand.repository.js';
import { CatalogRepository } from './catalog.repository.js';
import { ProductImagesService } from './product-images.service.js';
import { compactProductName, pairSheetMatches, rankSimilarProducts } from './product-name-match.js';
import { ProductTrackingService } from './product-tracking.service.js';
import {
  PRODUCT_NAME_LANG,
  commonProductName,
  formatGeneratedProductCode,
  hasGeneratedProductCodePrefix,
  normalizeProductCode,
  productCodeKey,
  type CreateProductRequest,
  type UpdateProductRequest,
} from '@iorder/shared';
import type { BrandView, ProductView, ProductWithStock } from './product.view.js';

const ENTITY_TYPE = 'PRODUCT';

/** What a staff-added product without a sheet code starts with [C, 2026-11-09]. */
export interface ManualProductInput {
  name: string;
  brandId: string | null;
  /** The category label customers browse by [P, design 2026-11-09]; null = none. */
  category: string | null;
}

/** The sheet product a generated-code product stands for, by name ("Sheetda bor"). */
export interface SheetMatch {
  productId: string;
  productCode: string;
  name: string;
}

/** The two locked, validated sides of a merge. */
export interface MergePair {
  source: ProductView;
  target: ProductView;
}

/** What the catalog moved from the source to the target (for the merge's audit rows). */
export interface MergeMoves {
  movedBrand: boolean;
  movedName: boolean;
  movedImageCount: number;
}

export interface ProductsFromSheetResult {
  /** Existing and newly created products for the asked codes (one per case-insensitive code). */
  products: ProductView[];
  /** Codes (as stored) of the products this call created. */
  createdCodes: string[];
}

export interface StockReplaceResult {
  created: number;
  updated: number;
  unchanged: number;
}
/** Product codes per IN (...) list in findProductsByProductCodes. */
const CODE_LOOKUP_CHUNK = 1000;
/** Rows the name check's prefilter may return; the pure ranking keeps the five closest of them. */
const SIMILAR_CANDIDATE_LIMIT = 50;

/** Flat field -> value map used for before/after audit diffs. */
function snapshot(product: ProductView): Record<string, AuditValue> {
  const fields: Record<string, AuditValue> = {
    productCode: product.productCode,
    category: product.category,
    categoryId: product.categoryId,
    trackingType: product.trackingType,
    markingRequired: product.markingRequired,
    codeRuleConfigured: product.codeRuleConfigured,
    isActive: product.isActive,
    codeGenerated: product.codeGenerated,
    mergedIntoProductId: product.mergedIntoProductId,
    brandId: product.brandId,
  };
  for (const t of product.translations) {
    fields[`translations.${t.lang}.name`] = t.name;
    fields[`translations.${t.lang}.description`] = t.description;
  }
  return fields;
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly tracking: ProductTrackingService,
    private readonly images: ProductImagesService,
    private readonly brands: BrandRepository,
  ) {}

  /**
   * productId -> live primary photo id of the given products (one query), for the staff list rows
   * of other modules. Photos are not cost data; customer DTOs do not carry them yet.
   */
  primaryImageIds(productIds: readonly string[]): Promise<Map<string, string>> {
    return this.images.primaryImageIds(productIds);
  }

  async createProduct(actor: Actor, input: CreateProductRequest): Promise<ProductView> {
    this.assertMayManage(actor);
    // Defensive: the request schema already trims and validates, other callers might not.
    // The product code is stored as entered; uniqueness ignores letter case (database column product_code_key).
    const productCode = normalizeProductCode(input.productCode);
    // IO- is the shape of the system-made codes [C, 2026-11-09]: a person may not type one.
    if (hasGeneratedProductCodePrefix(productCode)) {
      throw new ConflictError(
        'Product codes starting with IO- are reserved for generated codes',
        'RESERVED_PRODUCT_CODE_PREFIX',
      );
    }
    if (await this.repository.findByProductCode(productCode)) {
      throw new ConflictError(
        `Product code ${productCode} already exists`,
        'DUPLICATE_PRODUCT_CODE',
      );
    }
    try {
      return await this.repository.transaction(async (tx) => {
        const created = await this.repository.create(tx, {
          productCode,
          translations: [{ lang: PRODUCT_NAME_LANG, name: input.name, description: null }],
          now: this.clock.now(),
        });
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: ENTITY_TYPE,
          entityId: created.id,
          action: 'PRODUCT_CREATED',
          changes: diffFields({}, snapshot(created)),
        });
        return created;
      });
    } catch (error) {
      // Two creates with the same product code raced past the check above.
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          `Product code ${productCode} already exists`,
          'DUPLICATE_PRODUCT_CODE',
        );
      }
      throw error;
    }
  }

  async updateProduct(actor: Actor, id: string, input: UpdateProductRequest): Promise<ProductView> {
    this.assertMayManage(actor);
    return this.repository.transaction((tx) => this.updateProductIn(tx, actor, id, input));
  }

  /**
   * The update inside the caller's transaction (the price list import renames generated-code
   * products in the publish transaction). The caller has authorized the actor.
   */
  async updateProductIn(
    tx: Tx,
    actor: Actor,
    id: string,
    input: UpdateProductRequest,
  ): Promise<ProductView> {
    if (!(await this.repository.lockById(tx, id))) throw new NotFoundError('Product not found');
    const before = await this.repository.findById(id, tx);
    if (!before) throw new NotFoundError('Product not found');
    // A merged product stands for nothing any more; the target carries on (the database CHECK
    // products_merged_into_check refuses it too).
    if (input.isActive === true && before.mergedIntoProductId !== null) {
      throw new ConflictError('A merged product cannot be reactivated', 'PRODUCT_ALREADY_MERGED', {
        mergedIntoProductId: before.mergedIntoProductId,
      });
    }

    // Write only what really differs: a no-op PATCH must not touch the row (updated_at)
    // or the audit log.
    const fields =
      input.isActive !== undefined && input.isActive !== before.isActive
        ? { isActive: input.isActive }
        : {};
    // The one name goes into the PRODUCT_NAME_LANG row, which commonProductName reads first;
    // the other language rows are kept as they are (history, search).
    const newName =
      input.name !== undefined &&
      input.name !== commonProductName(before.translations, before.productCode)
        ? input.name
        : undefined;
    if (Object.keys(fields).length === 0 && newName === undefined) return before;

    await this.repository.updateFields(tx, id, { ...fields, updatedAt: this.clock.now() });
    if (newName !== undefined) {
      const current = before.translations.find((t) => t.lang === PRODUCT_NAME_LANG);
      await this.repository.upsertTranslation(tx, id, {
        lang: PRODUCT_NAME_LANG,
        name: newName,
        description: current?.description ?? null,
      });
    }
    const after = await this.repository.findById(id, tx);
    if (!after) throw new NotFoundError('Product not found');

    const changes = diffFields(snapshot(before), snapshot(after));
    if (Object.keys(changes).length > 0) {
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY_TYPE,
        entityId: id,
        action: productAction(changes),
        changes,
      });
    }
    return after;
  }

  // -------------------------------------------------------------------------------------
  // Staff-added products without a sheet «Товар_ID» [C, 2026-11-09]
  // -------------------------------------------------------------------------------------

  /**
   * Creates a product with the next generated code (IO-000123) inside the caller's transaction
   * (the price list publish that gives it its price). The name goes into the PRODUCT_NAME_LANG row;
   * the brand, when given, must exist (404 UNKNOWN_BRAND). Audited PRODUCT_CREATED like any product;
   * the snapshot shows codeGenerated and the brand. The caller has authorized the actor.
   */
  async createManualProduct(tx: Tx, actor: Actor, input: ManualProductInput): Promise<ProductView> {
    if (input.brandId !== null) await this.requireBrand(input.brandId, tx);
    const productCode = formatGeneratedProductCode(
      await this.repository.nextGeneratedCodeNumber(tx),
    );
    const created = await this.repository.create(tx, {
      productCode,
      codeGenerated: true,
      brandId: input.brandId,
      category: input.category,
      translations: [{ lang: PRODUCT_NAME_LANG, name: input.name, description: null }],
      now: this.clock.now(),
    });
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: ENTITY_TYPE,
      entityId: created.id,
      action: 'PRODUCT_CREATED',
      changes: diffFields({}, snapshot(created)),
    });
    return created;
  }

  /** A brand by id (404 UNKNOWN_BRAND when none), for callers that store a brand reference. */
  async requireBrand(brandId: string, db?: DbClient): Promise<BrandView> {
    const brand = await this.brands.findBrandById(brandId, db);
    if (!brand) throw new NotFoundError('Brand not found', { reason: 'UNKNOWN_BRAND' });
    return brand;
  }

  /** Brands by their case-insensitive name key (lower(btrim(name))), for the import's brand cells. */
  findBrandsByNameKeys(db?: DbClient): Promise<Map<string, BrandView>> {
    return this.brands.listBrandsByNameKey(db);
  }

  /** Lowercase trimmed names of the active products: "a product of that name exists" checks. */
  findActiveProductNameKeys(db?: DbClient): Promise<Set<string>> {
    return this.repository.findActiveNameKeys(db);
  }

  /** The active generated-code products (the import template is pre-filled with them). */
  findActiveGeneratedProducts(db?: DbClient): Promise<ProductView[]> {
    return this.repository.findActiveGenerated(db);
  }

  /**
   * For the "by order" page (the caller authorizes): every generated-code product that stands
   * alone, plus the generated-code ones among `alsoIds` even when removed or merged.
   */
  findByOrderProducts(alsoIds: readonly string[]): Promise<ProductView[]> {
    return this.repository.findGeneratedStandingOr(alsoIds);
  }

  /**
   * Active, non-merged products whose common name is alike to `typedName` (the staff form's check
   * [P, design 2026-11-09]): exact first, then the same letters and digits, then containment; at
   * most SIMILAR_PRODUCTS_LIMIT. One bounded query, ranked by the pure helper. Read-only; the
   * caller has authorized the actor.
   */
  async findSimilarProducts(typedName: string): Promise<ProductView[]> {
    if (compactProductName(typedName) === '') return [];
    const ids = await this.repository.findSimilarNameCandidateIds(
      typedName,
      SIMILAR_CANDIDATE_LIMIT,
    );
    if (ids.length === 0) return [];
    const candidates = (await this.repository.findByIds(ids)).map((product) => ({
      product,
      productCode: product.productCode,
      name: commonProductName(product.translations, product.productCode),
    }));
    return rankSimilarProducts(typedName, candidates).map((entry) => entry.product);
  }

  /**
   * For each generated-code product among `products`, the active sheet product with the same
   * common name ignoring case, spacing and punctuation ("Sheetda bor" [P, design 2026-11-09]).
   * One query for all of them; a product without a match is absent. The caller authorizes.
   */
  async findSheetMatches(products: readonly ProductView[]): Promise<Map<string, SheetMatch>> {
    const generated = products
      .filter((product) => product.codeGenerated)
      .map((product) => ({
        id: product.id,
        name: commonProductName(product.translations, product.productCode),
      }));
    if (generated.length === 0) return new Map();
    const sheetProducts = (
      await this.repository.findSheetProductsByCompactNames(generated.map((g) => g.name))
    ).map((product) => ({
      productId: product.id,
      productCode: product.productCode,
      name: commonProductName(product.translations, product.productCode),
    }));
    return pairSheetMatches(generated, sheetProducts);
  }

  /**
   * Locks both sides of a merge (FOR NO KEY UPDATE, in id order) and proves the rules: the source
   * is a generated-code product that was not merged before, the target an active sheet product,
   * and they differ. 404 for an unknown id. The caller has authorized the actor.
   */
  async lockMergePair(tx: Tx, sourceId: string, targetId: string): Promise<MergePair> {
    assertDistinctMergePair(sourceId, targetId);
    await this.repository.lockByIds(tx, [sourceId, targetId]);
    return this.findMergePair(sourceId, targetId, tx);
  }

  /**
   * The same checks as `lockMergePair` without the locks: what the merge dialog shows before the
   * person confirms (the preview raises the reasons the merge would). Read-only.
   */
  async findMergePair(sourceId: string, targetId: string, db?: DbClient): Promise<MergePair> {
    assertDistinctMergePair(sourceId, targetId);
    const rows = await this.repository.findByIds([sourceId, targetId], db);
    const source = rows.find((p) => p.id === sourceId);
    const target = rows.find((p) => p.id === targetId);
    if (!source) throw new NotFoundError('Product not found', { productId: sourceId });
    if (!target) throw new NotFoundError('Product not found', { productId: targetId });
    if (!source.codeGenerated) {
      throw new ConflictError(
        'Only a product without a sheet code can be merged',
        'NOT_GENERATED_CODE',
      );
    }
    if (source.mergedIntoProductId !== null) {
      throw new ConflictError('This product was merged already', 'PRODUCT_ALREADY_MERGED', {
        mergedIntoProductId: source.mergedIntoProductId,
      });
    }
    if (target.codeGenerated) {
      throw new ConflictError('The target must be a sheet product', 'TARGET_IS_GENERATED');
    }
    if (!target.isActive) {
      throw new ConflictError('The target product is inactive', 'INACTIVE_PRODUCT', {
        productIds: [targetId],
      });
    }
    return { source, target };
  }

  /**
   * The catalog side of a merge, in the caller's transaction, after `lockMergePair`: the source's
   * brand moves when the target has none, its staff-entered name is copied when the target has no
   * row in that language, its photos move (the target's primary wins), then the source becomes
   * inactive and points at the target. Returns what moved; the caller writes the merge audit rows.
   */
  async applyMerge(tx: Tx, actor: Actor, pair: MergePair): Promise<MergeMoves> {
    const now = this.clock.now();
    const { source, target } = pair;
    let movedBrand = false;
    if (source.brandId !== null && target.brandId === null) {
      await this.repository.setBrand(tx, target.id, source.brandId, now);
      movedBrand = true;
    }
    const sourceName = source.translations.find((t) => t.lang === PRODUCT_NAME_LANG);
    const targetHasName = target.translations.some((t) => t.lang === PRODUCT_NAME_LANG);
    let movedName = false;
    if (sourceName !== undefined && !targetHasName) {
      await this.repository.upsertTranslation(tx, target.id, sourceName);
      movedName = true;
    }
    // The merge pointer first: the photo guard lets product_id move only onto that product.
    await this.repository.markMerged(tx, source.id, target.id, now);
    const movedImageCount = await this.images.moveImagesIn(tx, actor, source.id, target.id, now);
    return { movedBrand, movedName, movedImageCount };
  }

  async getProduct(actor: Actor, id: string): Promise<ProductView> {
    this.assertMayView(actor);
    return this.requireProduct(id);
  }

  async listProducts(
    actor: Actor,
    filter: { search?: string; category?: string } = {},
  ): Promise<ProductView[]> {
    this.assertMayView(actor);
    return this.repository.list({
      search: toSearch(filter.search),
      ...(filter.category === undefined ? {} : { category: filter.category }),
    });
  }

  /**
   * For other modules (staff stock and unpriced lists; the caller authorizes): products with their
   * stock aggregate, by product code. `withStockOrDeliveries` keeps only products that have a
   * stock aggregate or a live delivery line. Staff-only data.
   */
  listProductsWithStock(filter: {
    search?: string;
    withStockOrDeliveries?: boolean;
  }): Promise<ProductWithStock[]> {
    return this.repository.listWithStock({
      search: toSearch(filter.search),
      ...(filter.withStockOrDeliveries === undefined
        ? {}
        : { withStockOrDeliveries: filter.withStockOrDeliveries }),
    });
  }

  /**
   * For other modules (the staff dashboard; the caller authorizes): how many ACTIVE products are
   * not among `excludedIds` (for example the ids that have a published price). Counts in SQL.
   */
  countActiveProductsExcluding(excludedIds: readonly string[]): Promise<number> {
    return this.repository.countActiveExcluding(excludedIds);
  }

  /**
   * The sheet sync meets product codes (and the sheet's product names) in ONE chunk transaction:
   * returns the product for each code, creating the missing ones. A created product is active,
   * has the sheet name as its RU translation, the piece unit and NO price (so no customer can see it: it
   * is in no published price list). A system action: audit rows with a null actor,
   * SHEET_SYNC_PRODUCT_CREATED. Idempotent: existing products (any letter case) are returned as
   * they are, and a concurrent creation of the same code is absorbed (ON CONFLICT DO NOTHING).
   */
  async ensureProductsFromSheet(
    tx: Tx,
    entries: readonly { productCode: string; name: string }[],
  ): Promise<ProductsFromSheetResult> {
    const wanted = new Map<string, { productCode: string; name: string }>();
    for (const entry of entries) {
      const key = productCodeKey(entry.productCode);
      if (!wanted.has(key)) {
        wanted.set(key, { productCode: normalizeProductCode(entry.productCode), name: entry.name });
      }
    }
    const keys = [...wanted.keys()];
    let products = await this.findByKeys(keys, tx);
    const have = new Set(products.map((p) => productCodeKey(p.productCode)));
    const missing = [...wanted].filter(([key]) => !have.has(key)).map(([, value]) => value);
    if (missing.length === 0) return { products, createdCodes: [] };

    const createdCodes = await this.repository.createFromSheet(tx, missing, this.clock.now());
    products = await this.findByKeys(keys, tx);
    const created = new Set(createdCodes);
    await this.audit.recordSystemMany(
      tx,
      products
        .filter((p) => created.has(p.productCode))
        .map((p) => ({
          systemSource: 'SHEET_SYNC' as const,
          entityType: ENTITY_TYPE,
          entityId: p.id,
          action: 'SHEET_SYNC_PRODUCT_CREATED' as const,
          changes: diffFields({}, snapshot(p)),
        })),
    );
    return { products, createdCodes };
  }

  /**
   * Sets the category of products (the category of each product's latest live delivery line, or
   * null when it has none), inside the caller's transaction. Only real changes are written and
   * audited, with before and after: SHEET_SYNC_PRODUCT_CATEGORY_CHANGED by the sheet sync, or
   * PRODUCT_CATEGORY_CHANGED under the actor's name when a person's decision (a confirmed line
   * removal) caused it. Returns how many changed.
   */
  /** The sheet sync's step for the company's marked goods list. Returns the categories created. */
  adoptMarkedSheetCategories(): Promise<number> {
    return this.tracking.adoptMarkedSheetCategories();
  }

  async setCategories(
    tx: Tx,
    entries: readonly { productId: string; category: string | null }[],
    cause: { actorUserId?: string } = {},
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const current = new Map(
      (
        await this.repository.findCategories(
          tx,
          entries.map((e) => e.productId),
        )
      ).map((row) => [row.id, row.category]),
    );
    const changed = entries.filter(
      (e) => current.has(e.productId) && (current.get(e.productId) ?? null) !== e.category,
    );
    await this.repository.updateCategories(tx, changed, this.clock.now());
    await this.tracking.adoptBySheetCategory(tx, changed, cause.actorUserId);
    const changesOf = (e: { productId: string; category: string | null }): AuditChanges => ({
      category: { from: current.get(e.productId) ?? null, to: e.category },
    });
    if (cause.actorUserId !== undefined) {
      for (const e of changed) {
        await this.audit.record(tx, {
          actorUserId: cause.actorUserId,
          entityType: ENTITY_TYPE,
          entityId: e.productId,
          action: 'PRODUCT_CATEGORY_CHANGED',
          changes: changesOf(e),
        });
      }
    } else {
      await this.audit.recordSystemMany(
        tx,
        changed.map((e) => ({
          systemSource: 'SHEET_SYNC' as const,
          entityType: ENTITY_TYPE,
          entityId: e.productId,
          action: 'SHEET_SYNC_PRODUCT_CATEGORY_CHANGED' as const,
          changes: changesOf(e),
        })),
      );
    }
    return changed.length;
  }

  private async findByKeys(keys: readonly string[], tx?: Tx): Promise<ProductView[]> {
    const found: ProductView[] = [];
    for (let i = 0; i < keys.length; i += CODE_LOOKUP_CHUNK) {
      found.push(
        ...(await this.repository.findByProductCodes(keys.slice(i, i + CODE_LOOKUP_CHUNK), tx)),
      );
    }
    return found;
  }

  /**
   * REPLACES the stock aggregate of the given products, inside the caller's transaction (a
   * branded Tx, so it is atomic with whatever the caller just wrote). Audit rows carry the quantity
   * before and after. By default it is a SYSTEM action (null actor, SHEET_SYNC_* names: the sheet
   * sync). When a person's decision causes the change (a confirmed removal), pass `actorUserId`:
   * the rows then name that person. Unchanged aggregates are not written (idempotent) and keep
   * their synced_at. The aggregate carries no cost and no supplier. Indicative only, never a
   * reservation (hard rule 10).
   */
  async replaceStock(
    tx: Tx,
    entries: readonly { productId: string; quantity: Prisma.Decimal }[],
    cause: { actorUserId?: string } = {},
  ): Promise<StockReplaceResult> {
    const result: StockReplaceResult = { created: 0, updated: 0, unchanged: 0 };
    if (entries.length === 0) return result;
    const latest = new Map(entries.map((e) => [e.productId, e.quantity]));
    const existing = new Map(
      (await this.repository.findStock([...latest.keys()], tx)).map((s) => [
        s.productId,
        s.quantity,
      ]),
    );
    const syncedAt = this.clock.now();
    const toCreate: { productId: string; quantity: Prisma.Decimal; syncedAt: Date }[] = [];
    const audits: { action: 'CREATED' | 'UPDATED'; productId: string; changes: AuditChanges }[] =
      [];
    for (const [productId, quantity] of latest) {
      const before = existing.get(productId);
      if (before === undefined) {
        toCreate.push({ productId, quantity, syncedAt });
        audits.push({
          action: 'CREATED',
          productId,
          changes: { quantity: { from: null, to: quantity.toFixed(3) } },
        });
        result.created += 1;
      } else if (before.equals(quantity)) {
        result.unchanged += 1;
      } else {
        await this.repository.updateStock(tx, productId, quantity, syncedAt);
        audits.push({
          action: 'UPDATED',
          productId,
          changes: { quantity: { from: before.toFixed(3), to: quantity.toFixed(3) } },
        });
        result.updated += 1;
      }
    }
    await this.repository.createStock(tx, toCreate);
    if (cause.actorUserId !== undefined) {
      for (const a of audits) {
        await this.audit.record(tx, {
          actorUserId: cause.actorUserId,
          entityType: 'STOCK_CACHE',
          entityId: a.productId,
          action: `STOCK_CACHE_${a.action === 'CREATED' ? 'CREATED' : 'RECOMPUTED'}`,
          changes: a.changes,
        });
      }
    } else {
      await this.audit.recordSystemMany(
        tx,
        audits.map((a) => ({
          systemSource: 'SHEET_SYNC' as const,
          entityType: 'STOCK_CACHE',
          entityId: a.productId,
          action: `SHEET_SYNC_STOCK_${a.action}` as const,
          changes: a.changes,
        })),
      );
    }
    return result;
  }

  /** Stock aggregate per product (staff-only data). Missing products have no entry. */
  async getStockQuantities(ids: readonly string[]): Promise<Map<string, Prisma.Decimal>> {
    const found: { productId: string; quantity: Prisma.Decimal }[] = [];
    for (let i = 0; i < ids.length; i += CODE_LOOKUP_CHUNK) {
      found.push(...(await this.repository.findStock(ids.slice(i, i + CODE_LOOKUP_CHUNK))));
    }
    return new Map(found.map((s) => [s.productId, s.quantity]));
  }

  /**
   * For other modules (sheets-sync, the price list import): products by product code; input is
   * normalized here. `db` lets a caller read inside its own transaction (the import's confirm).
   */
  async findProductsByProductCodes(
    codes: readonly string[],
    db?: DbClient,
  ): Promise<ProductView[]> {
    if (codes.length === 0) return [];
    // Chunked: a first sync can name thousands of product codes, and one giant IN (...) list is slow.
    // Distinct by case-insensitive key: 'kb-15' and 'KB-15' are one product.
    const unique = [...new Set(codes.map(productCodeKey))];
    const found: ProductView[] = [];
    for (let i = 0; i < unique.length; i += CODE_LOOKUP_CHUNK) {
      found.push(
        ...(await this.repository.findByProductCodes(unique.slice(i, i + CODE_LOOKUP_CHUNK), db)),
      );
    }
    return found;
  }

  /** For other modules (pricing). No actor check: callers authorize their own use case. */
  async requireProduct(id: string): Promise<ProductView> {
    const product = await this.repository.findById(id);
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  async findProductsByIds(ids: readonly string[], tx?: Tx): Promise<ProductView[]> {
    if (ids.length === 0) return [];
    return this.repository.findByIds(ids, tx);
  }

  /**
   * Loads products and keeps a share lock on them until the caller's transaction ends, so the
   * state the caller checks (isActive) cannot change before it commits. Missing ids are simply
   * absent from the result.
   */
  async findProductsLockedForShare(tx: Tx, ids: readonly string[]): Promise<ProductView[]> {
    if (ids.length === 0) return [];
    await this.repository.lockForShare(tx, ids);
    // A separate statement after the lock: under READ COMMITTED it sees the committed state
    // of any deactivation we just waited for.
    return this.repository.findByIds(ids, tx);
  }

  // Catalog editing shares the price-list permission: the matrix has no separate catalog
  // action and the docs do not define one.
  private assertMayManage(actor: Actor): void {
    if (!can(actor, 'UPDATE_PRICE_LIST')) throw new ForbiddenError('Access denied');
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_PRICE_ADMIN')) throw new ForbiddenError('Access denied');
  }
}

/**
 * The product code part of a search compares lowercase keys, so it ignores letter case; names are
 * matched with a case-insensitive query.
 */
function toSearch(
  search: string | undefined,
): { productCodeKey: string; text: string } | undefined {
  return search ? { productCodeKey: productCodeKey(search), text: search.trim() } : undefined;
}

function assertDistinctMergePair(sourceId: string, targetId: string): void {
  if (sourceId === targetId) {
    throw new ConflictError('A product cannot be merged into itself', 'TARGET_IS_GENERATED');
  }
}

/** Gives pure activation toggles their own action name so history reads clearly. */
function productAction(changes: Record<string, unknown>): string {
  const keys = Object.keys(changes);
  if (keys.length === 1 && keys[0] === 'isActive') return 'PRODUCT_ACTIVATION_CHANGED';
  return 'PRODUCT_UPDATED';
}
