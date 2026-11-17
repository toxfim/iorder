import { Injectable } from '@nestjs/common';
import type {
  CreateProductCategoryRequest,
  UpdateProductCategoryRequest,
  UpdateProductTrackingRequest,
} from '@iorder/shared/staff-cost';
import type { TrackingType } from '@iorder/shared/staff-orders';
import { suggestCategoryCodeRule } from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { AuditService, diffFields } from '../audit/index.js';
import { CatalogRepository } from './catalog.repository.js';
import type { ProductCategoryView, ProductView, SheetCategoryView } from './product.view.js';

const PRODUCT_ENTITY = 'PRODUCT';
const CATEGORY_ENTITY = 'PRODUCT_CATEGORY';

interface CodeRule {
  categoryId: string | null;
  trackingType: TrackingType;
  markingRequired: boolean;
}

/**
 * Product categories and the per-unit code rule, the reference-distributor model ([C] 2026-10-25): a
 * category is a TEMPLATE whose defaults are copied onto a product when the product is linked;
 * the product's own `trackingType` / `markingRequired` is the rule the warehouse follows while
 * picking. Changing a category never changes products already linked (not retroactive).
 */
@Injectable()
export class ProductTrackingService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async listCategories(actor: Actor): Promise<ProductCategoryView[]> {
    this.assertMayView(actor);
    return this.repository.listCategories();
  }

  /** Sheet categories that still need a code rule (no staff category of the same name). */
  async listSheetCategories(actor: Actor): Promise<SheetCategoryView[]> {
    this.assertMayView(actor);
    return this.repository.listSheetCategoriesWithoutTemplate();
  }

  /**
   * Creates a category and adopts the products that are not linked yet, whose rule was never set
   * and whose sheet category («Категория») has the same name: they get the defaults, one audit
   * row each. Products with a rule of their own are left alone.
   */
  async createCategory(
    actor: Actor,
    input: CreateProductCategoryRequest,
  ): Promise<ProductCategoryView> {
    const [created] = await this.createCategories(actor, [input]);
    return created!;
  }

  /** Several categories in ONE transaction, each like `createCategory`: all or nothing. */
  async createCategories(
    actor: Actor,
    inputs: readonly CreateProductCategoryRequest[],
  ): Promise<ProductCategoryView[]> {
    this.assertMayManage(actor);
    try {
      return await this.repository.transaction(async (tx) => {
        const now = this.clock.now();
        const created: ProductCategoryView[] = [];
        for (const input of inputs) {
          created.push(await this.createInTx(tx, actor, input, now));
        }
        return created;
      });
    } catch (error) {
      // A concurrent create of the same name; the batch does not say which one, so name none.
      if (isUniqueViolation(error)) {
        throw inputs.length === 1 ? duplicateCategory(inputs[0]!.name) : duplicateCategory();
      }
      throw error;
    }
  }

  private async createInTx(
    tx: Tx,
    actor: Actor,
    input: CreateProductCategoryRequest,
    now: Date,
  ): Promise<ProductCategoryView> {
    if (await this.repository.findCategoryByName(tx, input.name)) {
      throw duplicateCategory(input.name);
    }
    const id = await this.repository.createCategory(tx, { ...input, now });
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: CATEGORY_ENTITY,
      entityId: id,
      action: 'PRODUCT_CATEGORY_CREATED',
      changes: diffFields({}, categoryFields(input, true)),
    });
    const adoptable = await this.repository.findAdoptableProducts(tx, nameKeyOf(input.name));
    for (const product of adoptable) {
      await this.applyRule(
        tx,
        product.id,
        {
          categoryId: id,
          trackingType: input.trackingTypeDefault,
          markingRequired: input.markingRequiredDefault,
        },
        now,
        actor.userId,
      );
    }
    return this.requireCategory(id, tx);
  }

  /** Not retroactive: linked products keep their own rule. Archived categories stay listed. */
  async updateCategory(
    actor: Actor,
    id: string,
    input: UpdateProductCategoryRequest,
  ): Promise<ProductCategoryView> {
    this.assertMayManage(actor);
    try {
      return await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lockCategory(tx, id))) {
          throw new NotFoundError('Category not found');
        }
        const before = await this.requireCategory(id, tx);
        if (input.name !== undefined) {
          const holder = await this.repository.findCategoryByName(tx, input.name);
          if (holder !== null && holder.id !== id) throw duplicateCategory(input.name);
        }
        const beforeFields = categoryFields(before, before.isActive);
        const afterFields = {
          name: input.name ?? before.name,
          trackingTypeDefault: input.trackingTypeDefault ?? before.trackingTypeDefault,
          markingRequiredDefault: input.markingRequiredDefault ?? before.markingRequiredDefault,
          isActive: input.isActive ?? before.isActive,
        };
        const changes = diffFields(beforeFields, afterFields);
        if (Object.keys(changes).length === 0) return before;
        await this.repository.updateCategory(tx, id, {
          ...afterFields,
          updatedAt: this.clock.now(),
        });
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: CATEGORY_ENTITY,
          entityId: id,
          action: 'PRODUCT_CATEGORY_UPDATED',
          changes,
        });
        return this.requireCategory(id, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error) && input.name !== undefined) {
        throw duplicateCategory(input.name);
      }
      throw error;
    }
  }

  /**
   * Sets a product's own code rule. Linking a (different) category copies its defaults for the
   * fields the request leaves out; explicit fields win. An archived category cannot be linked.
   * Release always checks the CURRENT rule, so a change reaches orders still being picked.
   */
  async updateProductTracking(
    actor: Actor,
    productId: string,
    input: UpdateProductTrackingRequest,
  ): Promise<ProductView> {
    this.assertMayManage(actor);
    return this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockById(tx, productId))) {
        throw new NotFoundError('Product not found');
      }
      const product = await this.requireProduct(tx, productId);
      let defaults: Partial<Pick<CodeRule, 'trackingType' | 'markingRequired'>> = {};
      if (typeof input.categoryId === 'string') {
        const category = await this.repository.findCategoryById(input.categoryId, tx);
        if (category === null) throw new NotFoundError('Category not found');
        if (!category.isActive) {
          throw new ConflictError('The category is archived', 'CATEGORY_ARCHIVED');
        }
        if (category.id !== product.categoryId) {
          defaults = {
            trackingType: category.trackingTypeDefault,
            markingRequired: category.markingRequiredDefault,
          };
        }
      }
      await this.applyRule(
        tx,
        productId,
        {
          categoryId: input.categoryId === undefined ? product.categoryId : input.categoryId,
          trackingType: input.trackingType ?? defaults.trackingType ?? product.trackingType,
          markingRequired:
            input.markingRequired ?? defaults.markingRequired ?? product.markingRequired,
        },
        this.clock.now(),
        actor.userId,
      );
      return this.requireProduct(tx, productId);
    });
  }

  /**
   * For the sheet sync (inside its transaction): a product that got a sheet category for which an
   * active staff category exists, and that is not linked and has no rule of its own, is linked and
   * gets the defaults. A rule someone set is never overwritten (reference-distributor sync behaviour).
   * `actorUserId` names the person whose decision caused the category change, if any.
   */
  async adoptBySheetCategory(
    tx: Tx,
    entries: readonly { productId: string; category: string | null }[],
    actorUserId?: string,
  ): Promise<void> {
    const named = entries.flatMap((e) =>
      e.category !== null && e.category.trim() !== ''
        ? [{ productId: e.productId, key: nameKeyOf(e.category) }]
        : [],
    );
    if (named.length === 0) return;
    const categories = new Map(
      (
        await this.repository.findActiveCategoriesByKeys(tx, [...new Set(named.map((e) => e.key))])
      ).map((c) => [c.nameKey, c]),
    );
    if (categories.size === 0) return;
    const untouched = new Set(
      (
        await this.repository.findUnlinkedUntouched(
          tx,
          named.map((e) => e.productId),
        )
      ).map((p) => p.id),
    );
    const now = this.clock.now();
    for (const entry of named) {
      const category = categories.get(entry.key);
      if (category === undefined || !untouched.has(entry.productId)) continue;
      await this.applyRule(
        tx,
        entry.productId,
        {
          categoryId: category.id,
          trackingType: category.trackingTypeDefault,
          markingRequired: category.markingRequiredDefault,
        },
        now,
        actorUserId,
      );
    }
  }

  /**
   * For the sheet sync: every sheet category on the company's marked goods list ([C] owner
   * 2026-10-31, marking scan mandatory) that has no staff category yet gets one, and its products
   * whose rule was never set are linked. A staff category of that name, active or archived, is a
   * decision someone made and stops this. The scan rule stays NONE: only marking was decided.
   * Returns the number of categories created.
   */
  async adoptMarkedSheetCategories(): Promise<number> {
    const marked = (await this.repository.listSheetCategoriesWithoutTemplate()).filter(
      (category) => suggestCategoryCodeRule(category.name).markingRequired,
    );
    if (marked.length === 0) return 0;
    return this.repository.transaction(async (tx) => {
      const now = this.clock.now();
      let created = 0;
      for (const { name } of marked) {
        // Re-read inside the transaction: a manager may have created it since the list above.
        if (await this.repository.findCategoryByName(tx, name)) continue;
        const input = { name, trackingTypeDefault: 'NONE', markingRequiredDefault: true } as const;
        const id = await this.repository.createCategory(tx, { ...input, now });
        await this.audit.recordSystemMany(tx, [
          {
            systemSource: 'SHEET_SYNC',
            entityType: CATEGORY_ENTITY,
            entityId: id,
            action: 'SHEET_SYNC_PRODUCT_CATEGORY_CREATED',
            changes: diffFields({}, categoryFields(input, true)),
          },
        ]);
        for (const product of await this.repository.findAdoptableProducts(tx, nameKeyOf(name))) {
          await this.applyRule(
            tx,
            product.id,
            { categoryId: id, trackingType: 'NONE', markingRequired: true },
            now,
            undefined,
          );
        }
        created += 1;
      }
      return created;
    });
  }

  /**
   * Writes the rule when it differs, with one audit row (the person, or the sheet sync). Applying a
   * rule always marks it configured, so saving the suggested rule unchanged still records the
   * decision and later suggestions or sheet adoption leave it alone.
   */
  private async applyRule(
    tx: Tx,
    productId: string,
    rule: CodeRule,
    now: Date,
    actorUserId: string | undefined,
  ): Promise<void> {
    const before = await this.requireProduct(tx, productId);
    const after = { ...rule, codeRuleConfigured: true };
    const changes = diffFields(
      {
        categoryId: before.categoryId,
        trackingType: before.trackingType,
        markingRequired: before.markingRequired,
        codeRuleConfigured: before.codeRuleConfigured,
      },
      after,
    );
    if (Object.keys(changes).length === 0) return;
    await this.repository.updateTracking(tx, productId, { ...after, updatedAt: now });
    if (actorUserId !== undefined) {
      await this.audit.record(tx, {
        actorUserId,
        entityType: PRODUCT_ENTITY,
        entityId: productId,
        action: 'PRODUCT_TRACKING_CHANGED',
        changes,
      });
      return;
    }
    await this.audit.recordSystemMany(tx, [
      {
        systemSource: 'SHEET_SYNC',
        entityType: PRODUCT_ENTITY,
        entityId: productId,
        action: 'SHEET_SYNC_PRODUCT_TRACKING_LINKED',
        changes,
      },
    ]);
  }

  private async requireCategory(id: string, tx: Tx): Promise<ProductCategoryView> {
    const category = await this.repository.findCategoryById(id, tx);
    if (!category) throw new NotFoundError('Category not found');
    return category;
  }

  private async requireProduct(tx: Tx, id: string): Promise<ProductView> {
    const product = await this.repository.findById(id, tx);
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  // Same permission as catalog editing (manager and admin): the rule is product data.
  private assertMayManage(actor: Actor): void {
    if (!can(actor, 'UPDATE_PRICE_LIST')) throw new ForbiddenError('Access denied');
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_PRICE_ADMIN')) throw new ForbiddenError('Access denied');
  }
}

function nameKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

function duplicateCategory(name?: string): ConflictError {
  const message =
    name === undefined ? 'A category already exists' : `Category ${name} already exists`;
  return new ConflictError(message, 'DUPLICATE_CATEGORY_NAME');
}

function categoryFields(
  category: {
    name: string;
    trackingTypeDefault: TrackingType;
    markingRequiredDefault: boolean;
  },
  isActive: boolean,
): {
  name: string;
  trackingTypeDefault: TrackingType;
  markingRequiredDefault: boolean;
  isActive: boolean;
} {
  return {
    name: category.name,
    trackingTypeDefault: category.trackingTypeDefault,
    markingRequiredDefault: category.markingRequiredDefault,
    isActive,
  };
}
