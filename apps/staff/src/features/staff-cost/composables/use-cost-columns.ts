import { computed, shallowRef } from 'vue';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import type { ViewState } from '@core/composables/use-async-view';
import type { CostApi } from '../api/cost-api';
import { toCostRows, type CostRowView } from '../domain/cost-view';

/**
 * Stock and latest cost of every product of the current price list, loaded in ONE call. Inert
 * (no request) when `enabled` is false, so a role that may not view cost never asks.
 */
export function useCostColumns(api: CostApi, enabled: () => boolean) {
  const state = shallowRef<ViewState>(enabled() ? 'loading' : 'ready');
  const error = shallowRef<unknown>(null);
  const rows = shallowRef<ReadonlyMap<string, CostRowView>>(new Map());
  let run = 0;

  async function reload(): Promise<void> {
    if (!enabled()) return;
    const mine = ++run;
    state.value = 'loading';
    error.value = null;
    try {
      const costs = await api.getPriceListCosts();
      if (mine !== run) return;
      rows.value = toCostRows(costs.items);
      state.value = 'ready';
    } catch (caught) {
      if (mine !== run) return;
      // Nothing is published yet, so there are no rows to put a cost on: not a failure.
      if (caught instanceof ApiNotFoundError) {
        rows.value = new Map();
        state.value = 'ready';
        return;
      }
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  void reload();

  return {
    state,
    error,
    rows,
    visible: computed(() => enabled()),
    reload,
  };
}

export type CostColumns = ReturnType<typeof useCostColumns>;
