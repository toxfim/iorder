import type { LocalizedName } from './localized-name';
import { alifUsd, amountsIn, wholesaleUsd, type PriceRow } from './price-rows';

/** The product the price dialog prices, from the price list or from the stock. */
export interface PriceTarget {
  readonly productId: string;
  readonly productCode: string;
  readonly names: readonly LocalizedName[];
  readonly isActive: boolean;
  /** A staff-added product (generated code): it may be merged into a sheet product. */
  readonly codeGenerated: boolean;
  /** In the published list (also when its price is an older so'm one). */
  readonly listed: boolean;
  /** USD prices in the published list; null = none in USD (not listed, or an older so'm price). */
  readonly price: string | null;
  readonly deferredPrice: string | null;
  /** The recommended retail price (RRP) in USD; null = none (or an older so'm item). */
  readonly rrp: string | null;
  /** The «Оптовик/Партнер» prices in USD [C, owner 2026-11-11]; null = none. */
  readonly wholesalePrice: string | null;
  readonly wholesaleDeferredPrice: string | null;
  /** The «Alif factoring» prices in USD [C, owner 2026-11-12]; null = none. */
  readonly alifPrice: string | null;
  readonly alifDeferredPrice: string | null;
  /** The current sale price in so'm; null = not listed, or no rate to convert a USD price. */
  readonly priceUzs: string | null;
  /** Latest delivery cost in USD, as the sheet has it (staff-only); null when unknown. */
  readonly latestCostUsd: string | null;
}

export function priceTargetOf(
  // The stock rows carry no `codeGenerated`: a product the sheet has is never a generated one.
  product: Pick<PriceTarget, 'productId' | 'productCode' | 'names' | 'isActive'> &
    Partial<Pick<PriceTarget, 'codeGenerated'>>,
  row: PriceRow | null,
  latestCostUsd: string | null,
): PriceTarget {
  const usd = row ? amountsIn(row, 'USD') : null;
  const wholesale = row ? wholesaleUsd(row) : null;
  const alif = row ? alifUsd(row) : null;
  return {
    productId: product.productId,
    productCode: product.productCode,
    names: product.names,
    isActive: product.isActive,
    codeGenerated: row?.codeGenerated ?? product.codeGenerated ?? false,
    listed: row !== null,
    price: usd?.price ?? null,
    deferredPrice: usd?.deferredPrice ?? null,
    // Like the two prices above: only a USD item has an RRP the dialog can show and keep.
    rrp: row !== null && row.currency === 'USD' ? row.rrp : null,
    wholesalePrice: wholesale?.price ?? null,
    wholesaleDeferredPrice: wholesale?.deferredPrice ?? null,
    alifPrice: alif?.price ?? null,
    alifDeferredPrice: alif?.deferredPrice ?? null,
    priceUzs: row?.uzs?.price ?? null,
    latestCostUsd,
  };
}
