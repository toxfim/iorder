import { commonProductName } from '@iorder/shared';
import type { ManualProductCheckResponse, MergePreviewResponse } from '@iorder/shared/staff-cost';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { BrandView, ProductView } from '../../catalog/index.js';
import { formatMoney, type ItemPrices } from '../../pricing/index.js';

// Explicit allow-lists (hard rule 7): nothing is spread from a catalog view or a price row. These
// DTOs are staff-only (UPDATE_PRICE_LIST), still every field is named here on purpose.

/** What the name check found: the alike products and whether each is in the published list. */
export interface ManualProductCheckView {
  similar: readonly ProductView[];
  pricedProductIds: ReadonlySet<string>;
  brandFound: BrandView | null;
}

export function toManualProductCheckResponse(
  view: ManualProductCheckView,
): ManualProductCheckResponse {
  return {
    similar: view.similar.map((product) => ({
      productId: product.id,
      productCode: product.productCode,
      name: commonProductName(product.translations, product.productCode),
      codeGenerated: product.codeGenerated,
      priced: view.pricedProductIds.has(product.id),
    })),
    brandFound:
      view.brandFound === null ? null : { id: view.brandFound.id, name: view.brandFound.name },
  };
}

/** One side of a merge as the service read it; `prices` is null when the product is not in the list. */
export interface MergePreviewSide {
  product: ProductView;
  brandName: string | null;
  /** The two prices the dialog shows; the RRP moves with them but is not part of the preview. */
  prices: Pick<ItemPrices, 'basePrice' | 'deferredPrice'> | null;
}

export interface MergePreviewView {
  source: MergePreviewSide & { imageCount: number; cartLineCount: number };
  target: MergePreviewSide & {
    stockQuantity: Prisma.Decimal | null;
    /** Already null when the actor may not view cost (the pricing module decides). */
    costUsd: Prisma.Decimal | null;
  };
  nextVersionNumber: number | null;
}

/** Fraction digits of the staff stock and cost columns (the Decimal scales of their tables). */
const STOCK_DIGITS = 3;
const COST_USD_DIGITS = 4;

export function toMergePreviewResponse(view: MergePreviewView): MergePreviewResponse {
  return {
    source: {
      ...sideFields(view.source),
      imageCount: view.source.imageCount,
      cartLineCount: view.source.cartLineCount,
    },
    target: {
      ...sideFields(view.target),
      stockQuantity: view.target.stockQuantity?.toFixed(STOCK_DIGITS) ?? null,
      costUsd: view.target.costUsd?.toFixed(COST_USD_DIGITS) ?? null,
    },
    nextVersionNumber: view.nextVersionNumber,
  };
}

/** The fields both sides share (the contract's `previewPrices` plus the product's identity). */
type PreviewSideFields = Pick<
  MergePreviewResponse['source'],
  'productId' | 'productCode' | 'name' | 'brandName' | 'basePrice' | 'deferredPrice'
>;

function sideFields(side: MergePreviewSide): PreviewSideFields {
  return {
    productId: side.product.id,
    productCode: side.product.productCode,
    name: commonProductName(side.product.translations, side.product.productCode),
    brandName: side.brandName,
    basePrice: side.prices === null ? null : formatMoney(side.prices.basePrice),
    deferredPrice:
      side.prices?.deferredPrice === undefined || side.prices.deferredPrice === null
        ? null
        : formatMoney(side.prices.deferredPrice),
  };
}
