import type { CustomerOrderGroup, CustomerOrderSummary } from '@iorder/shared';
import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { ViewState } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { CustomerOrdersApi } from '../api/customer-orders-api';
import { statusesOfState, type CustomerOrderState } from '../domain/order-display';
import { createOrderPages, type OrderPages } from './order-pages';

/**
 * The organization's orders, newest first, one page at a time, filtered by a group or by one of
 * the three customer states. A newer first-page load wins over late answers of older ones.
 */
export function useOrdersList(api: CustomerOrdersApi) {
  const filter = ref<CustomerOrderState | null>(null);
  const group = ref<CustomerOrderGroup | null>(null);
  const search = ref('');
  const orders = shallowRef<readonly CustomerOrderSummary[]>([]);
  const hasMore = ref(false);
  const state = ref<ViewState>('loading');
  const error = shallowRef<unknown>(null);
  const loadingMore = ref(false);
  const moreError = shallowRef<unknown>(null);
  let pages: OrderPages | null = null;
  let run = 0;
  let disposed = false;

  const openPages = (): OrderPages =>
    createOrderPages(
      api,
      {
        ...(group.value === null ? {} : { group: group.value }),
        ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      },
      filter.value === null ? null : statusesOfState(filter.value),
    );

  async function reload(): Promise<void> {
    const mine = ++run;
    const fresh = openPages();
    state.value = 'loading';
    error.value = null;
    moreError.value = null;
    loadingMore.value = false;
    try {
      const first = await fresh.next();
      if (mine !== run || disposed) return;
      pages = fresh;
      orders.value = first;
      hasMore.value = fresh.hasMore();
      state.value = first.length === 0 ? 'empty' : 'ready';
    } catch (caught) {
      if (mine !== run || disposed) return;
      pages = null;
      hasMore.value = false;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  /** Resolves true when the next page added orders (infinite scroll then checks again). */
  async function loadMore(): Promise<boolean> {
    const current = pages;
    if (current === null || !current.hasMore() || loadingMore.value) return false;
    const mine = run;
    loadingMore.value = true;
    moreError.value = null;
    try {
      const next = await current.next();
      if (mine !== run || disposed) return false;
      const known = new Set(orders.value.map((o) => o.id));
      const added = next.filter((o) => !known.has(o.id));
      orders.value = [...orders.value, ...added];
      hasMore.value = current.hasMore();
      return added.length > 0;
    } catch (caught) {
      if (mine !== run || disposed) return false;
      moreError.value = caught;
      return false;
    } finally {
      if (mine === run) loadingMore.value = false;
    }
  }

  watch([filter, group, search], () => void reload());
  onScopeDispose(() => {
    disposed = true;
  });
  void reload();

  return {
    /** One of the three customer states, or null for every order. */
    filter,
    group,
    search,
    orders,
    hasMore,
    state,
    error,
    loadingMore,
    moreError,
    reload,
    loadMore,
  };
}
