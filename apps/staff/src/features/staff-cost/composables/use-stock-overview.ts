import { shallowRef, watch, type Ref } from 'vue';
import type { StockOverviewResponse } from '@iorder/shared/staff-cost';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { ViewState } from '@core/composables/use-async-view';
import type { StockApi } from '../api/stock-api';

/**
 * The stock list. "In stock only" is a server filter (`inStock=true`); search and category are
 * applied on the client over the answer, so typing never makes a request.
 */
export function useStockOverview(api: StockApi, inStockOnly: Ref<boolean>) {
  const state = shallowRef<ViewState>('loading');
  const error = shallowRef<unknown>(null);
  const response = shallowRef<StockOverviewResponse | null>(null);
  /** A silent reload is running: the old rows stay on screen until the answer arrives. */
  const refreshing = shallowRef(false);
  let run = 0;

  async function reload(options: { silent?: boolean } = {}): Promise<void> {
    const mine = ++run;
    if (!options.silent || response.value === null) state.value = 'loading';
    else refreshing.value = true;
    error.value = null;
    try {
      const next = await api.listStock(inStockOnly.value ? { inStock: true } : {});
      if (mine !== run) return;
      response.value = next;
      state.value = next.items.length === 0 && !inStockOnly.value ? 'empty' : 'ready';
    } catch (caught) {
      if (mine !== run) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    } finally {
      if (mine === run) refreshing.value = false;
    }
  }

  // Toggling the filter keeps the table mounted: swapping it for the skeleton made the whole list
  // blink on every click.
  watch(inStockOnly, () => void reload({ silent: true }));
  void reload();
  return { state, error, response, refreshing, reload };
}
