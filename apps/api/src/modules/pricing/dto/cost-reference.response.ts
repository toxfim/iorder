import type {
  CostDelivery,
  CostDeliverySummary,
  PriceListCostsResponse,
  ProductCostReferenceResponse,
  UsdRateResponse,
} from '@iorder/shared/staff-cost';
import type { ProductView } from '../../catalog/index.js';
import type {
  CostDeliverySummaryView,
  CostDeliveryView,
  UsdRateView,
} from '../price-reference.types.js';

// STAFF-ONLY mappers. Explicit allow-list, nothing spread from the row. The shapes live in
// @iorder/shared (cost.ts); customer mappers must never import this file.

export function toCostDelivery(row: CostDeliveryView): CostDelivery {
  return {
    deliveryRef: row.deliveryRef,
    supplier: row.supplier,
    purchaseMethod: row.purchaseMethod,
    category: row.category,
    deliveredQuantity: row.deliveredQuantity.toFixed(3),
    availableQuantity: row.availableQuantity.toFixed(3),
    // Null together while the line's cost is pending (the sheet's cost cells are still empty).
    costUsd: row.costUsd?.toFixed(4) ?? null,
    usdRateUsed: row.usdRateUsed?.toFixed(4) ?? null,
    costUzs: row.costUzs?.toFixed(2) ?? null,
    deliveredAt: row.deliveredAt.toISOString(),
    syncedAt: row.syncedAt.toISOString(),
  };
}

/** `deliveries` must already be sorted newest first; `latest` is the first one. */
export function toProductCostReferenceResponse(
  product: ProductView,
  deliveries: readonly CostDeliveryView[],
): ProductCostReferenceResponse {
  const mapped = deliveries.map(toCostDelivery);
  return {
    productId: product.id,
    productCode: product.productCode,
    latest: mapped[0] ?? null,
    deliveries: mapped,
  };
}

export function toUsdRateResponse(
  view: UsdRateView,
  names: ReadonlyMap<string, string>,
): UsdRateResponse {
  const name = view.setBy === null ? undefined : names.get(view.setBy);
  return {
    rate: view.rate ? view.rate.toFixed(4) : null,
    updatedAt: view.updatedAt?.toISOString() ?? null,
    // An unknown actor is shown as nobody, never as the stored id.
    updatedBy: name ?? null,
    updatedByUserId: name === undefined ? null : view.setBy,
    source: view.source,
    rateDate: view.rateDate,
    followsCentralBank: view.followsCentralBank,
    manualRate: view.manualRate ? view.manualRate.toFixed(4) : null,
    manualExpiresAt: view.manualExpiresAt?.toISOString() ?? null,
    lastRefreshFailedAt: view.lastRefreshFailedAt?.toISOString() ?? null,
    lastChannelFailedAt: view.lastChannelFailedAt?.toISOString() ?? null,
  };
}

export function toCostDeliverySummary(row: CostDeliverySummaryView): CostDeliverySummary {
  return {
    deliveredAt: row.deliveredAt.toISOString(),
    deliveryRef: row.deliveryRef,
    supplier: row.supplier,
    costUsd: row.costUsd?.toFixed(4) ?? null,
    usdRateUsed: row.usdRateUsed?.toFixed(4) ?? null,
    costUzs: row.costUzs?.toFixed(2) ?? null,
  };
}

export function toPriceListCostsResponse(costs: {
  versionNumber: number;
  items: {
    productId: string;
    recent: readonly CostDeliverySummaryView[];
    stockQuantity: { toFixed(digits: number): string } | null;
    suppliers: readonly string[];
  }[];
}): PriceListCostsResponse {
  return {
    versionNumber: costs.versionNumber,
    items: costs.items.map((item) => {
      const recent = item.recent.map(toCostDeliverySummary);
      return {
        productId: item.productId,
        latest: recent[0] ?? null,
        recent,
        stockQuantity: item.stockQuantity ? item.stockQuantity.toFixed(3) : null,
        suppliers: [...item.suppliers],
      };
    }),
  };
}
