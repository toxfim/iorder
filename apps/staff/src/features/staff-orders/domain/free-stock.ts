import type { AllocationPreview } from '@iorder/shared/staff-orders';
import { fromMilli, toMilli } from '@core/lib/quantity';

/**
 * What the stock can still give to each line of an order: the free quantity (available minus the
 * holds of OTHER orders) summed over the product's delivery lines, keyed by order item id. A
 * product whose stock is not tracked (staff-added, no sheet code) has no entry: there is nothing to
 * compare a quantity with. Indicative, like every stock figure (hard rule 10).
 */
export function freeStockByItem(preview: AllocationPreview): ReadonlyMap<string, string> {
  const free = new Map<string, string>();
  for (const item of preview.items) {
    if (!item.stockTracked) continue;
    const total = item.lines.reduce((sum, line) => sum + toMilli(line.freeQuantity), 0n);
    free.set(item.orderItemId, fromMilli(total));
  }
  return free;
}

/** How much of `quantity` the free stock does not cover; null when it covers all of it. */
export function shortOf(quantity: string, free: string): string | null {
  const missing = toMilli(quantity) - toMilli(free);
  return missing > 0n ? fromMilli(missing) : null;
}
