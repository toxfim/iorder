import { Injectable } from '@nestjs/common';
import { STAFF_LIST_PAGE_SIZE_DEFAULT } from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { BrandService, CatalogService, type ProductWithStock } from '../catalog/index.js';
import { PriceReferenceRepository } from './price-reference.repository.js';
import type { CostDeliverySummaryView } from './price-reference.types.js';
import { PricingService } from './pricing.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { SupplyAllocationService } from './supply-allocation/supply-allocation.service.js';
import { pageByProductCode } from './staff-list-cursor.js';

export interface StaffStockEntry extends ProductWithStock {
  latest: CostDeliverySummaryView | null;
  /** The live primary photo, null without one. */
  primaryImageId: string | null;
}

export interface PageInfo {
  nextCursor: string | null;
  total: number;
}

export interface CategoryTotals {
  categories: { category: string; count: number }[];
  uncategorizedCount: number;
}

export interface UnpricedResult extends CategoryTotals, PageInfo {
  items: (StaffStockEntry & { hasDraftPrice: boolean })[];
}

export interface StockResult extends CategoryTotals, PageInfo {
  items: (StaffStockEntry & {
    isPriced: boolean;
    deliveryCount: number;
    /** Distinct suppliers of the live delivery lines, sorted. */
    suppliers: string[];
    /** The resolved brand name (staff choice, else the brand finder); null without one. */
    brand: string | null;
    heldQuantity: Prisma.Decimal;
    availableQuantity: Prisma.Decimal | null;
  })[];
}

// UTF-16 code unit order, the same on every machine: localeCompare depends on the ICU data and
// the default locale of the process, so the order of the category tabs would differ per server.
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Distinct categories with counts, sorted by name in code unit order (deterministic, not
 * language aware); products without a category are counted apart.
 */
export function countCategories(entries: readonly ProductWithStock[]): CategoryTotals {
  const counts = new Map<string, number>();
  let uncategorizedCount = 0;
  for (const { product } of entries) {
    if (product.category === null) uncategorizedCount += 1;
    else counts.set(product.category, (counts.get(product.category) ?? 0) + 1);
  }
  const categories = [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => compareCodeUnits(a.category, b.category));
  return { categories, uncategorizedCount };
}

/**
 * STAFF-ONLY read models over the catalog, the price lists and the delivery lines (stock, latest
 * delivery with its supplier and costs). A fixed number of queries whatever the catalog size: the
 * priced sets (1), the products with translations and stock (a fixed few), the delivery counts
 * (1, stock list), the suppliers (1, stock list), the newest delivery and the primary photo of the products shown (1 each). Nothing here is reachable
 * from a customer route (hard rule 7).
 */
@Injectable()
export class StaffStockService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly pricing: PricingService,
    private readonly deliveries: PriceReferenceRepository,
    private readonly holds: SupplyAllocationService,
    private readonly brands: BrandService,
  ) {}

  /** Products with NO price in the current published list (also when none is published). */
  async listUnpriced(
    actor: Actor,
    query: { category?: string; search?: string; limit?: number; cursor?: string },
  ): Promise<UnpricedResult> {
    this.assertMayView(actor);
    const [sets, matching] = await Promise.all([
      this.pricing.getPricedProductSets(),
      this.catalog.listProductsWithStock({ search: query.search }),
    ]);
    // A merged generated-code product stands for nothing any more: it is never offered for pricing.
    const unpriced = matching.filter(
      (entry) =>
        !sets.published.has(entry.product.id) && entry.product.mergedIntoProductId === null,
    );
    const shown = this.byCategory(unpriced, query.category);
    const page = this.page(shown, query);
    const [latest, images] = await this.pageExtras(page.items);
    return {
      ...countCategories(unpriced),
      nextCursor: page.nextCursor,
      total: page.total,
      items: page.items.map((entry) => ({
        ...entry,
        latest: latest.get(entry.product.id) ?? null,
        primaryImageId: images.get(entry.product.id) ?? null,
        hasDraftPrice: sets.draft.has(entry.product.id),
      })),
    };
  }

  /** How many ACTIVE products have no price in the published list (a dashboard figure). */
  async countUnpricedActive(actor: Actor): Promise<number> {
    this.assertMayView(actor);
    const sets = await this.pricing.getPricedProductSets();
    return this.catalog.countActiveProductsExcluding([...sets.published]);
  }

  /** Every product that has a stock aggregate or at least one live delivery line. */
  async listStock(
    actor: Actor,
    query: {
      category?: string;
      search?: string;
      inStock?: boolean;
      limit?: number;
      cursor?: string;
    },
  ): Promise<StockResult> {
    this.assertMayView(actor);
    const counts = new Map(
      (await this.deliveries.countDeliveriesByProduct()).map((c) => [c.productId, c.count]),
    );
    const [sets, matching, held, available, suppliers] = await Promise.all([
      this.pricing.getPricedProductSets(),
      this.catalog.listProductsWithStock({
        search: query.search,
        withStockOrDeliveries: true,
      }),
      this.holds.heldByProduct(),
      this.holds.availableByProduct(),
      this.deliveries.findSuppliersByProduct(),
    ]);
    const availableOfEntry = (entry: ProductWithStock): Prisma.Decimal | null =>
      entry.stockQuantity ? (available.get(entry.product.id) ?? new Prisma.Decimal(0)) : null;
    // "In stock" means what can still be promised: stock that is all held is not in stock.
    const stockFiltered =
      query.inStock === undefined
        ? matching
        : matching.filter((entry) => (availableOfEntry(entry)?.gt(0) ?? false) === query.inStock);
    const shown = this.byCategory(stockFiltered, query.category);
    const page = this.page(shown, query);
    // The same brand rule as the price list file, for the page's products only (two queries).
    const [[latest, images], brandOf] = await Promise.all([
      this.pageExtras(page.items),
      this.brands.resolveBrands(page.items.map((entry) => entry.product)),
    ]);
    return {
      ...countCategories(stockFiltered),
      nextCursor: page.nextCursor,
      total: page.total,
      items: page.items.map((entry) => ({
        ...entry,
        latest: latest.get(entry.product.id) ?? null,
        primaryImageId: images.get(entry.product.id) ?? null,
        isPriced: sets.published.has(entry.product.id),
        deliveryCount: counts.get(entry.product.id) ?? 0,
        suppliers: suppliers.get(entry.product.id) ?? [],
        brand: brandOf.get(entry.product.id)?.name ?? null,
        heldQuantity: held.get(entry.product.id) ?? new Prisma.Decimal(0),
        availableQuantity: availableOfEntry(entry),
      })),
    };
  }

  /** Product code order; the latest-delivery query below then covers only the page. */
  private page(
    entries: readonly ProductWithStock[],
    query: { limit?: number; cursor?: string },
  ): ReturnType<typeof pageByProductCode<ProductWithStock>> {
    return pageByProductCode(
      entries,
      (entry) => entry.product.productCode,
      query.limit ?? STAFF_LIST_PAGE_SIZE_DEFAULT,
      query.cursor,
    );
  }

  private byCategory(
    entries: ProductWithStock[],
    category: string | undefined,
  ): ProductWithStock[] {
    return category === undefined
      ? entries
      : entries.filter((entry) => entry.product.category === category);
  }

  /** The newest delivery and the primary photo of the page's products: one query each. */
  private pageExtras(
    entries: readonly ProductWithStock[],
  ): Promise<[Map<string, CostDeliverySummaryView>, Map<string, string>]> {
    return Promise.all([
      this.latestByProduct(entries),
      this.catalog.primaryImageIds(entries.map((entry) => entry.product.id)),
    ]);
  }

  private async latestByProduct(
    entries: readonly ProductWithStock[],
  ): Promise<Map<string, CostDeliverySummaryView>> {
    const rows = await this.deliveries.findRecentByProducts(
      entries.map((entry) => entry.product.id),
      1,
    );
    return new Map(rows.map((row) => [row.productId, row]));
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
  }
}
