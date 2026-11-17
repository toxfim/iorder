import { shallowRef } from 'vue';
import type { StockApi } from '../api/stock-api';

/**
 * Category of every product that has deliveries, keyed by product id. The price list DTO carries
 * no category (it is staff-only sheet data), so the list tabs read it from the stock overview.
 * The same answer counts the active products of the stock without a price: the number on
 * "Ostatokdan qo'shish", which opens exactly that filtered stock list.
 * A failure leaves the map empty: the tabs then show "All" only and the table still works.
 */
export function useProductCategories(api: StockApi, enabled: () => boolean) {
  const byProduct = shallowRef<ReadonlyMap<string, string | null>>(new Map());
  const unpricedInStock = shallowRef(0);
  // False until the first answer (or failure): the category tabs wait for it.
  const loaded = shallowRef(!enabled());

  async function reload(): Promise<void> {
    if (!enabled()) return;
    try {
      const { items } = await api.listStock();
      byProduct.value = new Map(items.map((item) => [item.productId, item.category]));
      unpricedInStock.value = items.filter((item) => !item.isPriced && item.isActive).length;
    } catch {
      byProduct.value = new Map();
      unpricedInStock.value = 0;
    } finally {
      loaded.value = true;
    }
  }

  void reload();
  return { byProduct, unpricedInStock, loaded, reload };
}
