import type {
  CustomerHomeRecommendationsResponse,
  CustomerMatchingItem,
  CustomerNewerModelItem,
} from '@iorder/shared';

/**
 * How the home arranges the server's three blocks (design "2a", owner 2026-11-09). Pure, so the
 * arrangement is tested without a DOM.
 */

/** The hero: a confirmed newer model, or, without one, the first matching product with a neutral label. */
export type HomeHero =
  { kind: 'newer'; item: CustomerNewerModelItem } | { kind: 'pick'; item: CustomerMatchingItem };

export function heroOf(recs: CustomerHomeRecommendationsResponse): HomeHero | null {
  if (recs.newerModel !== null) return { kind: 'newer', item: recs.newerModel };
  const first = recs.matching[0];
  return first === undefined ? null : { kind: 'pick', item: first };
}

/** The matching cards under the hero: a product shown as the hero is not shown twice. */
export function matchingCardsOf(recs: CustomerHomeRecommendationsResponse): CustomerMatchingItem[] {
  const hero = heroOf(recs);
  return hero?.kind === 'pick' ? recs.matching.slice(1) : recs.matching;
}

/** Nothing to recommend: no purchase history (or a staff viewer), so the home shows the first visit. */
export function isFirstVisit(recs: CustomerHomeRecommendationsResponse): boolean {
  return recs.reorder.length === 0 && recs.matching.length === 0 && recs.newerModel === null;
}

/** A stock figure at or under this is called out on a card [P]. */
export const LOW_STOCK_AT = 5;

export type StockBadge = 'out' | 'low' | null;

export function stockBadgeOf(orderableStock: number | null): StockBadge {
  if (orderableStock === null) return null;
  if (orderableStock === 0) return 'out';
  return orderableStock <= LOW_STOCK_AT ? 'low' : null;
}

/** Whole days between a receipt and now, never negative (a device clock behind the server). */
export function daysSince(receivedAt: string, now: Date): number {
  const elapsed = now.getTime() - new Date(receivedAt).getTime();
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}

/**
 * The quantity a one-tap add puts in the cart: the wanted one, capped at the stock figure when
 * there is one. Zero means out of stock: nothing can be added.
 */
export function addableQuantity(wanted: number, orderableStock: number | null): number {
  if (orderableStock === null) return wanted;
  return Math.min(wanted, orderableStock);
}
