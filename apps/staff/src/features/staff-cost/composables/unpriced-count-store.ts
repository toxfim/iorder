import { shallowRef, type Ref } from 'vue';
import type { StockApi } from '../api/stock-api';

export interface UnpricedCountStore {
  /** Active products with no price in the published list; null until known (or unreadable). */
  readonly count: Readonly<Ref<number | null>>;
  refresh: () => Promise<void>;
  /** Forgets the number (a different person signs in) and discards any read still in flight. */
  reset: () => void;
  /** Pages that already read the list tell the store, so no second request is needed. */
  set: (count: number) => void;
}

/**
 * The number on the Narxlar nav item and in the dashboard's price card. Inactive products are
 * not counted: they cannot be sold, so there is nothing to price. A failed read keeps the last
 * value; this is a hint, never something that blocks the screen.
 */
export function createUnpricedCountStore(api: StockApi): UnpricedCountStore {
  const count = shallowRef<number | null>(null);
  let run = 0;

  async function refresh(): Promise<void> {
    const mine = ++run;
    try {
      const { items } = await api.listUnpriced();
      if (mine === run) count.value = items.filter((item) => item.isActive).length;
    } catch {
      // Keep the last known value.
    }
  }

  function reset(): void {
    run += 1;
    count.value = null;
  }

  function set(next: number): void {
    run += 1; // a slower read that started earlier must not overwrite this fresher number
    count.value = next;
  }

  return { count, refresh, set, reset };
}
