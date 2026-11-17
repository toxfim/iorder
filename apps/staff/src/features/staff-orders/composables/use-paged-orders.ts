import type { StaffOrderCountsResponse, StaffOrderSummary } from '@iorder/shared/staff-orders';
import { onScopeDispose, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue';
import type { ViewState } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { StaffOrdersApi } from '../api/staff-orders-api';
import type { OrderListRequest } from '../domain/order-filters';

/** A page is small: staff open the list on phones and tablets too. */
export const ORDERS_PAGE_SIZE = 25;

export interface PagedOrders {
  readonly state: Ref<ViewState>;
  readonly error: ShallowRef<unknown>;
  /** The pages read so far, newest first. */
  readonly orders: ShallowRef<readonly StaffOrderSummary[]>;
  /** Per status over the request's filters (the stage tabs, the count and the sum). */
  readonly counts: ShallowRef<StaffOrderCountsResponse['byStatus']>;
  readonly nextCursor: Ref<string | null>;
  readonly loadingMore: Ref<boolean>;
  readonly moreError: ShallowRef<unknown>;
  /** A silent reload is in flight: the rows on screen are about to be replaced. */
  readonly refreshing: Ref<boolean>;
  /** Reads the first page and the counts again; `silent` keeps the list on screen meanwhile. */
  reload: (options?: { silent?: boolean }) => Promise<void>;
  /** Resolves true when the next page added orders (infinite scroll then checks again). */
  loadMore: () => Promise<boolean>;
}

/**
 * Staff orders filtered and paged by the server (cursor, newest first), with the counts over the
 * same filters. A new request (the filters in the URL changed) and a change of `changes` reload.
 * Once something is on screen a reload is silent: the page (and the search box being typed in)
 * stays while `refreshing` is on. A newer load wins over late answers of older ones. A reload
 * reads the first page only, so rows loaded further down go until scrolled to again.
 */
export function usePagedOrders(
  api: Pick<StaffOrdersApi, 'listOrders' | 'countOrders'>,
  request: () => OrderListRequest,
  options: { changes?: Readonly<Ref<number>> } = {},
): PagedOrders {
  const orders = shallowRef<readonly StaffOrderSummary[]>([]);
  const counts = shallowRef<StaffOrderCountsResponse['byStatus']>({});
  const nextCursor = ref<string | null>(null);
  const state = ref<ViewState>('loading');
  const error = shallowRef<unknown>(null);
  const loadingMore = ref(false);
  const moreError = shallowRef<unknown>(null);
  const refreshing = ref(false);
  let run = 0;
  let disposed = false;

  async function reload({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const mine = ++run;
    const { list, counts: countsQuery } = request();
    if (silent) refreshing.value = true;
    else state.value = 'loading';
    moreError.value = null;
    loadingMore.value = false;
    try {
      const [page, counted] = await Promise.all([
        list === null
          ? { orders: [], nextCursor: null }
          : api.listOrders({ ...list, limit: ORDERS_PAGE_SIZE }),
        api.countOrders(countsQuery),
      ]);
      if (mine !== run || disposed) return;
      orders.value = page.orders;
      nextCursor.value = page.nextCursor;
      counts.value = counted.byStatus;
      error.value = null;
      state.value = page.orders.length === 0 ? 'empty' : 'ready';
    } catch (caught) {
      if (mine !== run || disposed) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    } finally {
      if (mine === run) refreshing.value = false;
    }
  }

  const shown = (): boolean => state.value === 'ready' || state.value === 'empty';

  async function loadMore(): Promise<boolean> {
    const cursor = nextCursor.value;
    const { list } = request();
    if (cursor === null || list === null || loadingMore.value) return false;
    const mine = run;
    loadingMore.value = true;
    moreError.value = null;
    try {
      const page = await api.listOrders({ ...list, limit: ORDERS_PAGE_SIZE, cursor });
      if (mine !== run || disposed) return false;
      const known = new Set(orders.value.map((o) => o.id));
      const added = page.orders.filter((o) => !known.has(o.id));
      orders.value = [...orders.value, ...added];
      nextCursor.value = page.nextCursor;
      return added.length > 0;
    } catch (caught) {
      if (mine !== run || disposed) return false;
      moreError.value = caught;
      return false;
    } finally {
      if (mine === run) loadingMore.value = false;
    }
  }

  // Compared as JSON: a recomputed request with the same filters is not a new request.
  watch(
    () => JSON.stringify(request()),
    () => void reload({ silent: shown() }),
  );
  // An order changed (approved, rejected...): its row and the counts may have moved.
  if (options.changes) watch(options.changes, () => void reload({ silent: shown() }));
  onScopeDispose(() => {
    disposed = true;
  });
  void reload();

  return {
    state,
    error,
    orders,
    counts,
    nextCursor,
    loadingMore,
    moreError,
    refreshing,
    reload,
    loadMore,
  };
}
