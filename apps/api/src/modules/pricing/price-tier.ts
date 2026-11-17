import type { PriceTier } from '@iorder/shared';
import type { ItemPrices, PricedProduct } from './pricing.types.js';

// PURE: which prices of a price list item a customer of a tier is charged [C, owner 2026-11-11].

type TierInput = Pick<
  ItemPrices,
  | 'basePrice'
  | 'deferredPrice'
  | 'wholesalePrice'
  | 'wholesaleDeferredPrice'
  | 'alifPrice'
  | 'alifDeferredPrice'
>;

/**
 * Whether the tier is offered the item at all. ALIF_FACTORING only with an Alif sale price
 * [C, owner 2026-11-12: "a product without an Alif price is not shown and cannot be ordered", no
 * fallback]. The other tiers always are (wholesale falls back to standard, see `tierPrices`).
 */
export function offeredInTier(item: Pick<ItemPrices, 'alifPrice'>, tier: PriceTier): boolean {
  return tier !== 'ALIF_FACTORING' || item.alifPrice !== null;
}

/**
 * The tier's sale and deferred price. STANDARD: the item's own. WHOLESALE_PARTNER: the wholesale
 * prices when the item has a wholesale sale price; the wholesale deferred price may be null (then
 * that tier cannot choose DEFERRED for it). Without a wholesale sale price the tier falls back to
 * BOTH standard prices [P, to be confirmed by the owner]. ALIF_FACTORING: the Alif prices (the
 * deferred one may be null, like wholesale); an item without an Alif sale price must have been
 * left out by `offeredInTier` before, so reaching here is a programming error, never a fallback.
 */
export function tierPrices(
  item: TierInput,
  tier: PriceTier,
): Pick<ItemPrices, 'basePrice' | 'deferredPrice'> {
  if (tier === 'ALIF_FACTORING') {
    if (item.alifPrice === null) {
      throw new Error('An item without an Alif price is not offered to the Alif factoring tier');
    }
    return { basePrice: item.alifPrice, deferredPrice: item.alifDeferredPrice };
  }
  if (tier === 'WHOLESALE_PARTNER' && item.wholesalePrice !== null) {
    return { basePrice: item.wholesalePrice, deferredPrice: item.wholesaleDeferredPrice };
  }
  return { basePrice: item.basePrice, deferredPrice: item.deferredPrice };
}

/**
 * The item as ONE tier sees it: base/deferred are that tier's, and every other tier's fields are
 * null, so no price of another tier is left anywhere in what a customer-facing mapper receives.
 */
export function inTier<T extends ItemPrices>(item: T, tier: PriceTier): T {
  return {
    ...item,
    ...tierPrices(item, tier),
    wholesalePrice: null,
    wholesaleDeferredPrice: null,
    alifPrice: null,
    alifDeferredPrice: null,
  };
}

/** `inTier` for a priced product: its stored prices and both conversions (UZS, USD). */
export function productInTier(item: PricedProduct, tier: PriceTier): PricedProduct {
  return {
    ...inTier(item, tier),
    uzs: item.uzs === null ? null : inTier(item.uzs, tier),
    usd: item.usd === null ? null : inTier(item.usd, tier),
  };
}
