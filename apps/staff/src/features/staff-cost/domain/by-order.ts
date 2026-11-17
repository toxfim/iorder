import type { ByOrderProduct } from '@iorder/shared/staff-cost';
import { addQuantities } from './decimal';

// The "Buyurtma orqali" page (staff vocabulary [C, owner 2026-11-09]): products that are not kept
// in the warehouse and are brought when an order arrives. Pure helpers of the list.

/** The search box: the name or the code contains the text, ignoring case and outer spaces. */
export function matchesByOrderSearch(item: ByOrderProduct, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return (
    item.name.toLowerCase().includes(needle) || item.productCode.toLowerCase().includes(needle)
  );
}

export interface ByOrderSummary {
  /** Products at least one open order waits for. */
  readonly products: number;
  /** Pieces to bring, over every product (three fraction digits). */
  readonly pieces: string;
  /** Distinct open orders behind them (one order may wait for several products). */
  readonly orders: number;
}

/** What has to be brought now, over the whole list (never over a search result). */
export function byOrderSummary(items: readonly ByOrderProduct[]): ByOrderSummary {
  const needed = items.filter((item) => item.openOrderCount > 0);
  return {
    products: needed.length,
    pieces: addQuantities(needed.map((item) => item.openQuantity)),
    orders: new Set(needed.flatMap((item) => item.orders.map((order) => order.orderId))).size,
  };
}
