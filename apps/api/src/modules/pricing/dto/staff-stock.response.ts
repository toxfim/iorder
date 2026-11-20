import { PIECE_UNIT, productImageMediaUrl } from '@iorder/shared';
import type {
  LatestDelivery,
  StockOverviewResponse,
  UnpricedProductsResponse,
} from '@iorder/shared/staff-cost';
import type { ProductView } from '../../catalog/index.js';
import type { CostDeliverySummaryView } from '../price-reference.types.js';
import type { StockResult, UnpricedResult } from '../staff-stock.service.js';

// STAFF-ONLY mappers (supplier, costs, stock, category). Explicit allow-list, nothing spread.

function toLatestDelivery(row: CostDeliverySummaryView | null): LatestDelivery | null {
  if (!row) return null;
  return {
    deliveredAt: row.deliveredAt.toISOString(),
    supplier: row.supplier,
    // Null while the newest line's cost is pending (its sheet cost cells are still empty).
    costUsd: row.costUsd?.toFixed(4) ?? null,
    costUzs: row.costUzs?.toFixed(2) ?? null,
  };
}

function imageUrls(imageId: string | null): {
  imageUrl: string | null;
  imageLargeUrl: string | null;
} {
  return imageId === null
    ? { imageUrl: null, imageLargeUrl: null }
    : {
        imageUrl: productImageMediaUrl(imageId, 'thumb'),
        imageLargeUrl: productImageMediaUrl(imageId, 'large'),
      };
}

const names = (product: ProductView): { lang: 'UZ' | 'RU' | 'EN'; name: string }[] =>
  product.translations.map((t) => ({ lang: t.lang, name: t.name }));

export function toUnpricedProductsResponse(result: UnpricedResult): UnpricedProductsResponse {
  return {
    items: result.items.map(
      ({ product, stockQuantity, latest, hasDraftPrice, primaryImageId }) => ({
        productId: product.id,
        productCode: product.productCode,
        names: names(product),
        unit: PIECE_UNIT,
        isActive: product.isActive,
        category: product.category,
        stockQuantity: stockQuantity ? stockQuantity.toFixed(3) : null,
        latestDelivery: toLatestDelivery(latest),
        hasDraftPrice,
        ...imageUrls(primaryImageId),
      }),
    ),
    categories: result.categories,
    uncategorizedCount: result.uncategorizedCount,
    nextCursor: result.nextCursor,
    total: result.total,
  };
}

export function toStockOverviewResponse(result: StockResult): StockOverviewResponse {
  return {
    items: result.items.map(
      ({
        product,
        stockQuantity,
        latest,
        isPriced,
        deliveryCount,
        suppliers,
        brand,
        primaryImageId,
        heldQuantity,
        availableQuantity,
      }) => ({
        productId: product.id,
        productCode: product.productCode,
        names: names(product),
        unit: PIECE_UNIT,
        isActive: product.isActive,
        category: product.category,
        stockQuantity: stockQuantity ? stockQuantity.toFixed(3) : null,
        heldQuantity: heldQuantity.toFixed(3),
        availableQuantity: availableQuantity ? availableQuantity.toFixed(3) : null,
        isPriced,
        latestDelivery: toLatestDelivery(latest),
        deliveryCount,
        suppliers,
        brand,
        ...imageUrls(primaryImageId),
      }),
    ),
    categories: result.categories,
    uncategorizedCount: result.uncategorizedCount,
    nextCursor: result.nextCursor,
    total: result.total,
  };
}
