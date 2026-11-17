import { onScopeDispose, ref, watch } from 'vue';
import { useAsyncView } from '@core/composables/use-async-view';
import type { GoodsQuery } from '../api/customer-goods-api';
export interface GoodsPage<T> {
  items: T[];
  nextCursor: string | null;
}
export function useGoodsList<T>(
  load: (query: GoodsQuery) => Promise<GoodsPage<T>>,
  initialSearch = '',
) {
  const search = ref(initialSearch),
    moreBusy = ref(false),
    moreError = ref(false);
  let generation = 0,
    disposed = false;
  const view = useAsyncView(() => load({ search: search.value }), {
    isEmpty: (data) => data.items.length === 0,
  });
  watch(search, () => {
    generation += 1;
    moreError.value = false;
    void view.reload();
  });
  onScopeDispose(() => {
    disposed = true;
    generation += 1;
  });
  /** Resolves true when the next page added items (infinite scroll then checks again). */
  async function more(): Promise<boolean> {
    const cursor = view.data.value?.nextCursor;
    if (!cursor || moreBusy.value) return false;
    const mine = generation;
    moreBusy.value = true;
    moreError.value = false;
    try {
      const next = await load({ search: search.value, cursor });
      if (mine !== generation || disposed || !view.data.value) return false;
      view.data.value = {
        items: [...view.data.value.items, ...next.items],
        nextCursor: next.nextCursor,
      };
      return next.items.length > 0;
    } catch {
      if (mine === generation && !disposed) moreError.value = true;
      return false;
    } finally {
      moreBusy.value = false;
    }
  }
  return { search, view, more, moreBusy, moreError };
}
