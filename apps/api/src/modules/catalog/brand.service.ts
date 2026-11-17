import { Injectable } from '@nestjs/common';
import type { Locale } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { AuditService } from '../audit/index.js';
import { findBrand } from './brand-finder.js';
import { BrandRepository } from './brand.repository.js';
import type { BrandView, ProductView } from './product.view.js';

// The sheet's «Наименование товара» is stored as the RU name, so it is read first; a name staff
// typed in another language may mention the brand as well.
const NAME_ORDER: readonly Locale[] = ['RU', 'UZ', 'EN'];

// Owner decision 2026-11-04: Redmi and Mijia are sold as Xiaomi. Their rows stay in `brands` because
// the application never deletes a brand; the finder still needs them to recognize those names.
const PARENT_BRAND = 'xiaomi';
const SUB_BRANDS: ReadonlySet<string> = new Set(['redmi', 'mijia']);

const brandKey = (brand: BrandView): string => brand.name.trim().toLowerCase();

function toParentBrand(brand: BrandView, brands: readonly BrandView[]): BrandView {
  if (!SUB_BRANDS.has(brandKey(brand))) return brand;
  return brands.find((candidate) => brandKey(candidate) === PARENT_BRAND) ?? brand;
}

/** The brands staff may choose from: a sub-brand is never offered. */
export function visibleBrands(brands: readonly BrandView[]): BrandView[] {
  return brands.filter((brand) => !SUB_BRANDS.has(brandKey(brand)));
}

/**
 * The brand of a product: the one staff chose, else the one the finder sees in a name, else none.
 * A sub-brand resolves to its parent. Pure; `chosenBrandId` comes from products.brand_id.
 */
export function resolveBrand(
  product: ProductView,
  chosenBrandId: string | null,
  brands: readonly BrandView[],
): BrandView | null {
  if (chosenBrandId !== null) {
    const chosen = brands.find((brand) => brand.id === chosenBrandId);
    if (chosen) return toParentBrand(chosen, brands);
  }
  for (const lang of NAME_ORDER) {
    const name = product.translations.find((t) => t.lang === lang)?.name;
    const found = name === undefined ? null : findBrand(name, brands);
    if (found) return toParentBrand(found, brands);
  }
  return null;
}

/**
 * Brands ([C] 2026-10-28): the price list Excel file has one sheet per brand. Manager and admin
 * list and add brands and choose the brand of a product the finder cannot place. Both changes
 * are audited with before/after in the same transaction (hard rule 12).
 */
@Injectable()
export class BrandService {
  constructor(
    private readonly repository: BrandRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async listBrands(actor: Actor): Promise<BrandView[]> {
    this.assertMayView(actor);
    return visibleBrands(await this.repository.listBrands());
  }

  async createBrand(actor: Actor, name: string): Promise<BrandView> {
    this.assertMayManage(actor);
    const trimmed = name.trim();
    const duplicate = (): ConflictError =>
      new ConflictError(`Brand ${trimmed} already exists`, 'DUPLICATE_BRAND_NAME');
    if (await this.repository.existsByName(trimmed)) throw duplicate();
    try {
      return await this.repository.transaction(async (tx) => {
        const created = await this.repository.createBrand(tx, {
          name: trimmed,
          createdByUserId: actor.userId,
          now: this.clock.now(),
        });
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: 'BRAND',
          entityId: created.id,
          action: 'BRAND_CREATED',
          changes: { name: { from: null, to: created.name } },
        });
        return created;
      });
    } catch (error) {
      // Two creates with the same name raced past the check above.
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
  }

  /** The manual brand of a product; it wins over the finder from now on. Idempotent. */
  async setProductBrand(
    actor: Actor,
    productId: string,
    brandId: string,
  ): Promise<{ productId: string; brand: BrandView }> {
    this.assertMayManage(actor);
    return this.repository.transaction(async (tx) => {
      const before = await this.repository.lockProduct(tx, productId);
      if (before === undefined) throw new NotFoundError('Product not found');
      const brand = await this.repository.findBrandById(brandId, tx);
      if (!brand) throw new NotFoundError('Brand not found');
      if (before === brandId) return { productId, brand };
      const previous = before === null ? null : await this.repository.findBrandById(before, tx);
      await this.repository.setProductBrand(tx, productId, brandId, this.clock.now());
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: 'PRODUCT',
        entityId: productId,
        action: 'PRODUCT_BRAND_CHANGED',
        changes: {
          brandId: { from: before, to: brandId },
          brandName: { from: previous?.name ?? null, to: brand.name },
        },
      });
      return { productId, brand };
    });
  }

  /** Active products whose brand is neither chosen by staff nor found in a name. */
  async listUnbranded(actor: Actor): Promise<ProductView[]> {
    this.assertMayView(actor);
    const [brands, candidates] = await Promise.all([
      this.repository.listBrands(),
      this.repository.listActiveWithoutChosenBrand(),
    ]);
    return candidates.filter((product) => resolveBrand(product, null, brands) === null);
  }

  /**
   * For other modules (the staff form's name check; the caller authorizes): the brand the finder
   * reads in one typed name, a sub-brand resolved to its parent; null when it sees none.
   */
  async findBrandInName(name: string): Promise<BrandView | null> {
    const brands = await this.repository.listBrands();
    const found = findBrand(name, brands);
    return found === null ? null : toParentBrand(found, brands);
  }

  /**
   * For other modules (the price list file; the caller authorizes): the brand of each product,
   * null when it has none. Two queries whatever the number of products.
   */
  async resolveBrands(products: readonly ProductView[]): Promise<Map<string, BrandView | null>> {
    const [brands, chosen] = await Promise.all([
      this.repository.listBrands(),
      this.repository.findBrandIds(products.map((p) => p.id)),
    ]);
    return new Map(
      products.map((product) => [
        product.id,
        resolveBrand(product, chosen.get(product.id) ?? null, brands),
      ]),
    );
  }

  // Brands only shape the price list, so they share its permission (manager and admin).
  private assertMayManage(actor: Actor): void {
    if (!can(actor, 'UPDATE_PRICE_LIST')) throw new ForbiddenError('Access denied');
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_PRICE_ADMIN')) throw new ForbiddenError('Access denied');
  }
}
