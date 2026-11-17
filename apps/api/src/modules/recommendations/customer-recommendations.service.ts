import { Injectable } from '@nestjs/common';
import { commonProductName } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { effectiveMembership } from '../../common/auth/permission-matrix.js';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CatalogService, type ProductView } from '../catalog/index.js';
import { PricingService, type PriceListView, type PricedProduct } from '../pricing/index.js';
import { RecommendationsRepository, type PurchaseStats } from './recommendations.repository.js';

/** How many "time to reorder" rows and "matches what you bought" cards the home shows [P]. */
export const REORDER_LIMIT = 6;
export const MATCHING_LIMIT = 12;

export interface ReorderView {
  product: PricedProduct;
  /** Whole pieces, at least one: the quantity of the last received order of the product. */
  usualQuantity: Prisma.Decimal;
  lastReceivedAt: Date;
  timesOrdered: number;
}

export interface MatchingView {
  product: PricedProduct;
  /** The product the organization bought in the same category (the "why" line). */
  boughtProductName: string;
}

export interface NewerModelView {
  product: PricedProduct;
  replacesProductName: string;
  replacesTimesOrdered: number;
}

export interface HomeRecommendationsView {
  /** The published list the cards come from (prices in UZS); null when there is none. */
  list: PriceListView | null;
  reorder: ReorderView[];
  matching: MatchingView[];
  newerModel: NewerModelView | null;
}

const EMPTY: HomeRecommendationsView = { list: null, reorder: [], matching: [], newerModel: null };

const categoryKey = (category: string | null): string | null => {
  const key = category?.trim().toLowerCase() ?? '';
  return key === '' ? null : key;
};

/**
 * The customer home recommendations [C, owner 2026-11-09], computed from the caller's OWN
 * organization's RECEIVED orders and the current published price list:
 * - reorder: products bought before that are in the list, longest since the last purchase first;
 * - matching: products of the categories bought from, not bought yet;
 * - newer model: the newer product of a CONFIRMED pair whose older product was bought; never an
 *   unconfirmed pair, and never a model the organization already buys.
 * A customer with no received order, or a staff viewer (no organization), gets empty blocks.
 * The organization always comes from the authenticated membership (hard rule 6); every card is
 * mapped through the customer price list allow-list (hard rule 7).
 */
@Injectable()
export class CustomerRecommendationsService {
  constructor(
    private readonly repository: RecommendationsRepository,
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
  ) {}

  async forHome(actor: Actor): Promise<HomeRecommendationsView> {
    if (!can(actor, 'VIEW_OWN_RECOMMENDATIONS')) throw new ForbiddenError('Access denied');
    const organizationId = effectiveMembership(actor)?.organizationId;
    if (organizationId === undefined) return EMPTY;

    const list = await this.publishedListOrNull(actor);
    if (list === null) return EMPTY;
    const stats = await this.repository.purchaseStats(organizationId);
    if (stats.length === 0) return EMPTY;

    const listed = new Map(list.items.map((item) => [item.product.id, item]));
    const bought = new Map(stats.map((stat) => [stat.productId, stat]));
    const [boughtProducts, confirmed] = await Promise.all([
      this.catalog.findProductsByIds(stats.map((stat) => stat.productId)),
      this.repository.confirmedSuccessionsOf(stats.map((stat) => stat.productId)),
    ]);
    const nameOf = productNames(boughtProducts);

    const newerModel = pickNewerModel(confirmed, bought, listed, nameOf);
    return {
      list,
      reorder: pickReorder(stats, listed),
      matching: pickMatching(stats, listed, bought, nameOf, newerModel?.product.product.id ?? null),
      newerModel,
    };
  }

  /** "No price list yet" is an empty home, not a failure. */
  private async publishedListOrNull(actor: Actor): Promise<PriceListView | null> {
    try {
      return await this.pricing.getCurrentForCustomer(actor);
    } catch (caught) {
      if (caught instanceof NotFoundError) return null;
      throw caught;
    }
  }
}

function productNames(products: readonly ProductView[]): (productId: string) => string | null {
  const names = new Map(
    products.map((p) => [p.id, commonProductName(p.translations, p.productCode)]),
  );
  return (productId) => names.get(productId) ?? null;
}

/** The last ordered quantity as whole pieces, at least one (an older fractional line rounds down). */
function usualQuantityOf(stat: PurchaseStats): Prisma.Decimal {
  return Prisma.Decimal.max(stat.lastQuantity.floor(), 1);
}

function pickReorder(
  stats: readonly PurchaseStats[],
  listed: ReadonlyMap<string, PricedProduct>,
): ReorderView[] {
  return stats
    .flatMap((stat) => {
      const product = listed.get(stat.productId);
      return product === undefined
        ? []
        : [
            {
              product,
              usualQuantity: usualQuantityOf(stat),
              lastReceivedAt: stat.lastReceivedAt,
              timesOrdered: stat.timesOrdered,
            },
          ];
    })
    .sort(
      (a, b) =>
        a.lastReceivedAt.getTime() - b.lastReceivedAt.getTime() ||
        a.product.product.id.localeCompare(b.product.product.id),
    )
    .slice(0, REORDER_LIMIT);
}

function pickMatching(
  stats: readonly PurchaseStats[],
  listed: ReadonlyMap<string, PricedProduct>,
  bought: ReadonlyMap<string, PurchaseStats>,
  nameOf: (productId: string) => string | null,
  excludedProductId: string | null,
): MatchingView[] {
  // Per category: the most recently bought product of it, so the "why" names something familiar.
  const byCategory = new Map<string, PurchaseStats>();
  for (const stat of stats) {
    const key = categoryKey(stat.category);
    if (key === null) continue;
    const current = byCategory.get(key);
    if (current === undefined || stat.lastReceivedAt > current.lastReceivedAt) {
      byCategory.set(key, stat);
    }
  }
  const matching: (MatchingView & { recency: number })[] = [];
  for (const item of listed.values()) {
    const id = item.product.id;
    if (bought.has(id) || id === excludedProductId) continue;
    const key = categoryKey(item.product.category);
    const because = key === null ? undefined : byCategory.get(key);
    if (because === undefined) continue;
    const boughtProductName = nameOf(because.productId);
    if (boughtProductName === null) continue;
    matching.push({ product: item, boughtProductName, recency: because.lastReceivedAt.getTime() });
  }
  return matching
    .sort(
      (a, b) =>
        b.recency - a.recency ||
        productName(a.product).localeCompare(productName(b.product), undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
    )
    .slice(0, MATCHING_LIMIT)
    .map(({ product, boughtProductName }) => ({ product, boughtProductName }));
}

const productName = (item: PricedProduct): string =>
  commonProductName(item.product.translations, item.product.productCode);

/**
 * The confirmed pair that applies best: the newer product must be in the list and not bought yet;
 * among several, the older product ordered most often wins, then the most recently bought.
 */
function pickNewerModel(
  confirmed: readonly { olderProductId: string; newerProductId: string }[],
  bought: ReadonlyMap<string, PurchaseStats>,
  listed: ReadonlyMap<string, PricedProduct>,
  nameOf: (productId: string) => string | null,
): NewerModelView | null {
  let best: { view: NewerModelView; older: PurchaseStats } | null = null;
  for (const pair of confirmed) {
    const older = bought.get(pair.olderProductId);
    const newer = listed.get(pair.newerProductId);
    if (older === undefined || newer === undefined || bought.has(pair.newerProductId)) continue;
    const replacesProductName = nameOf(older.productId);
    if (replacesProductName === null) continue;
    const better =
      best === null ||
      older.timesOrdered > best.older.timesOrdered ||
      (older.timesOrdered === best.older.timesOrdered &&
        older.lastReceivedAt > best.older.lastReceivedAt);
    if (better) {
      best = {
        older,
        view: { product: newer, replacesProductName, replacesTimesOrdered: older.timesOrdered },
      };
    }
  }
  return best?.view ?? null;
}
