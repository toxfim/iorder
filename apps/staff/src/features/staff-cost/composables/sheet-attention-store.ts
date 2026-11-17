import { computed, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { StockApi } from '../api/stock-api';

export interface SheetAttentionStore {
  /** Open removal requests (decisions the sheet cleanup waits for); null until known. */
  readonly removals: Readonly<Ref<number | null>>;
  /** Products the last sync created that still have no price; null until known. */
  readonly newUnpriced: Readonly<Ref<number | null>>;
  /** The number on the Qoldiq nav item: both of the above. 0 while nothing is known. */
  readonly count: ComputedRef<number>;
  refresh: () => Promise<void>;
  /** Forgets the numbers (a different person signs in) and discards any read still in flight. */
  reset: () => void;
  /** The Qoldiq page already read the list, so the badge needs no second request. */
  setRemovals: (count: number) => void;
}

/**
 * What the sheet sync leaves for a manager to do. It used to be visible only on the Qoldiq page,
 * so a pending confirmation could wait unseen (F-04). Both reads are hints: a failed one keeps the
 * last value and never blocks a screen.
 */
export function createSheetAttentionStore(api: StockApi): SheetAttentionStore {
  const removals = shallowRef<number | null>(null);
  const newUnpriced = shallowRef<number | null>(null);
  let run = 0;

  async function readRemovals(mine: number): Promise<void> {
    try {
      const { total } = await api.listSupplyRemovals();
      if (mine === run) removals.value = total;
    } catch {
      // Keep the last known value.
    }
  }

  async function readNewUnpriced(mine: number): Promise<void> {
    try {
      // listUnpriced answers one whole list (no cursor in its contract). If it ever pages, this count
      // becomes a lower bound and needs a server-side count instead.
      const [last, unpriced] = await Promise.all([api.getLastSyncRun(), api.listUnpriced()]);
      if (mine !== run) return;
      const created = new Set(last?.createdProducts ?? []);
      newUnpriced.value = unpriced.items.filter(
        (item) => item.isActive && created.has(item.productCode),
      ).length;
    } catch {
      // Keep the last known value.
    }
  }

  async function refresh(): Promise<void> {
    const mine = ++run;
    await Promise.all([readRemovals(mine), readNewUnpriced(mine)]);
  }

  function reset(): void {
    run += 1;
    removals.value = null;
    newUnpriced.value = null;
  }

  function setRemovals(next: number): void {
    removals.value = next;
  }

  const count = computed(() => (removals.value ?? 0) + (newUnpriced.value ?? 0));
  return { removals, newUnpriced, count, refresh, setRemovals, reset };
}
