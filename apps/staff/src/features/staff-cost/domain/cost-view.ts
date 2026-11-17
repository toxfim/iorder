import type { CostDelivery, PriceListCostItem } from '@iorder/shared/staff-cost';
import { stockLevel, type StockLevel } from './decimal';

// View models for the price list: the screens read these neutral shapes, so only this folder
// (the "staff-cost" chunk, hard rule 7) knows the contract's cost field names.

/** One delivery as the tooltip and the supply history show it. */
export interface DeliveryView {
  readonly date: string;
  readonly ref: string;
  readonly supplier: string;
  /** Null together while the line's cost is pending (shown as "—"). */
  readonly usd: string | null;
  readonly rate: string | null;
  readonly uzs: string | null;
}

export interface CostRowView {
  /** Stock aggregate (3 fraction digits); null when the product has none. */
  readonly stock: string | null;
  readonly level: StockLevel;
  /** Latest delivery cost in USD and so'm; null when the product has no delivery. */
  readonly usd: string | null;
  readonly uzs: string | null;
  /** The USD rate of that same latest delivery: the so'm figure above was computed with it. */
  readonly rate: string | null;
  /** Up to five newest deliveries (the hover tooltip). */
  readonly recent: readonly DeliveryView[];
  /** Distinct suppliers of every live delivery line (the supplier filter). */
  readonly suppliers: readonly string[];
}

export function toCostRows(items: readonly PriceListCostItem[]): Map<string, CostRowView> {
  return new Map(
    items.map((item) => [
      item.productId,
      {
        stock: item.stockQuantity,
        level: stockLevel(item.stockQuantity),
        usd: item.latest?.costUsd ?? null,
        uzs: item.latest?.costUzs ?? null,
        rate: item.latest?.usdRateUsed ?? null,
        recent: item.recent.map((d) => ({
          date: d.deliveredAt,
          ref: d.deliveryRef,
          supplier: d.supplier,
          usd: d.costUsd,
          rate: d.usdRateUsed,
          uzs: d.costUzs,
        })),
        suppliers: item.suppliers,
      },
    ]),
  );
}

/** A delivery of the full history (side panel). */
export interface SupplyLineView extends DeliveryView {
  readonly delivered: string;
  readonly available: string;
  readonly method: string;
  readonly category: string;
}

export function toSupplyLines(deliveries: readonly CostDelivery[]): SupplyLineView[] {
  return deliveries.map((d) => ({
    date: d.deliveredAt,
    ref: d.deliveryRef,
    supplier: d.supplier,
    usd: d.costUsd,
    rate: d.usdRateUsed,
    uzs: d.costUzs,
    delivered: d.deliveredQuantity,
    available: d.availableQuantity,
    method: d.purchaseMethod,
    category: d.category,
  }));
}
