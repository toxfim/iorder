import { shallowRef } from 'vue';
import type { StockOverviewResponse } from '@iorder/shared/staff-cost';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { ViewState } from '@core/composables/use-async-view';
import type { StockApi } from '../api/stock-api';

/**
 * The whole stock list. Every filter of the page (ready views, search, category, brand,
 * supplier) runs on the client over this answer, so choosing one never makes a request.
 */
export function useStockOverview(api: StockApi) {
  const state = shallowRef<ViewState>('loading');
  const error = shallowRef<unknown>(null);
  const response = shallowRef<StockOverviewResponse | null>(null);
  /** A silent reload is running: the old rows stay on screen until the answer arrives. */
  const refreshing = shallowRef(false);
  /** When the answer arrived: "Yangi postavka" counts days back from it. */
  const loadedAt = shallowRef(Date.now());
  let run = 0;

  async function reload(options: { silent?: boolean } = {}): Promise<void> {
    const mine = ++run;
    if (!options.silent || response.value === null) state.value = 'loading';
    else refreshing.value = true;
    error.value = null;
    try {
      const next = await api.listStock();
      if (mine !== run) return;
      response.value = next;
      loadedAt.value = Date.now();
      state.value = next.items.length === 0 ? 'empty' : 'ready';
    } catch (caught) {
      if (mine !== run) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    } finally {
      if (mine === run) refreshing.value = false;
    }
  }

  void reload();
  return { state, error, response, refreshing, loadedAt, reload };
}
