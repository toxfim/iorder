import type {
  StaffOrderCountsResponse,
  StaffOrderListQuery,
  StaffOrderListResponse,
  StaffOrderSummary,
} from '@iorder/shared/staff-orders';
import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { NO_ORDER_FILTERS, orderListRequest, type OrderFilters } from '../domain/order-filters';
import { ORDERS_PAGE_SIZE, usePagedOrders } from './use-paged-orders';

// 60 orders, newest first, the way the server pages them (cursor = last id of the page).
const ALL = Array.from(
  { length: 60 },
  (_, i) =>
    ({ id: `order-${String(60 - i).padStart(2, '0')}`, status: 'SUBMITTED' }) as StaffOrderSummary,
);

function fakeApi() {
  const listOrders = vi.fn(async (query: StaffOrderListQuery = {}) => {
    const start = query.cursor ? ALL.findIndex((o) => o.id === query.cursor) + 1 : 0;
    const limit = query.limit ?? 25;
    const orders = query.search ? ALL.slice(0, 1) : ALL.slice(start, start + limit);
    const last = orders[orders.length - 1];
    const more = !query.search && start + limit < ALL.length;
    return { orders, nextCursor: more && last ? last.id : null } as StaffOrderListResponse;
  });
  const countOrders = vi.fn((): Promise<StaffOrderCountsResponse> =>
    Promise.resolve({ byStatus: { SUBMITTED: { count: ALL.length } } }),
  );
  return { listOrders, countOrders };
}

function mount(api = fakeApi(), filters = ref<OrderFilters>(NO_ORDER_FILTERS)) {
  const changes = ref(0);
  const scope = effectScope();
  const paged = scope.run(() =>
    usePagedOrders(api, () => orderListRequest(filters.value), { changes }),
  );
  if (!paged) throw new Error('no scope');
  return { api, paged, filters, changes, scope };
}

describe('usePagedOrders', () => {
  it('reads the first page with the counts, then one page per loadMore until the end', async () => {
    const { api, paged } = mount();
    await flushPromises();
    expect(paged.state.value).toBe('ready');
    expect(paged.orders.value).toHaveLength(ORDERS_PAGE_SIZE);
    expect(paged.counts.value).toEqual({ SUBMITTED: { count: 60 } });
    expect(api.listOrders).toHaveBeenLastCalledWith({ limit: ORDERS_PAGE_SIZE });

    expect(await paged.loadMore()).toBe(true);
    expect(await paged.loadMore()).toBe(true);
    expect(paged.orders.value.map((o) => o.id)).toEqual(ALL.map((o) => o.id));
    expect(paged.nextCursor.value).toBeNull();
    // At the end nothing more is asked for.
    expect(await paged.loadMore()).toBe(false);
    expect(api.listOrders).toHaveBeenCalledTimes(3);
  });

  it('keeps the page on screen while new filters load, and the newest answer wins', async () => {
    const api = fakeApi();
    const { paged, filters } = mount(api);
    await flushPromises();
    let release: () => void = () => undefined;
    api.listOrders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ orders: ALL.slice(10, 11), nextCursor: null });
        }),
    );
    filters.value = { ...NO_ORDER_FILTERS, text: 'slow' };
    await nextTick();
    expect(paged.state.value).toBe('ready');
    expect(paged.refreshing.value).toBe(true);
    filters.value = { ...NO_ORDER_FILTERS, text: 'fast' };
    await flushPromises();
    expect(paged.orders.value.map((o) => o.id)).toEqual([ALL[0]?.id]);
    // The older, slower answer arrives last and is dropped.
    release();
    await flushPromises();
    expect(paged.orders.value.map((o) => o.id)).toEqual([ALL[0]?.id]);
    expect(paged.refreshing.value).toBe(false);
  });

  it('reads again when an order changed, and asks for nothing a filter rules out', async () => {
    const { api, paged, filters, changes } = mount();
    await flushPromises();
    changes.value += 1;
    await flushPromises();
    expect(api.listOrders).toHaveBeenCalledTimes(2);
    expect(api.countOrders).toHaveBeenCalledTimes(2);

    // A debt is never SUBMITTED: no list request, the counts still come.
    filters.value = { ...NO_ORDER_FILTERS, period: 'debt', stage: 'SUBMITTED' };
    await flushPromises();
    expect(api.listOrders).toHaveBeenCalledTimes(2);
    expect(api.countOrders).toHaveBeenLastCalledWith({ paymentStatus: 'UNPAID' });
    expect(paged.state.value).toBe('empty');
  });

  it('a failed next page keeps the rows and says so; the next try goes on', async () => {
    const api = fakeApi();
    const { paged } = mount(api);
    await flushPromises();
    api.listOrders.mockRejectedValueOnce(new Error('offline'));
    expect(await paged.loadMore()).toBe(false);
    expect(paged.moreError.value).toBeInstanceOf(Error);
    expect(paged.orders.value).toHaveLength(ORDERS_PAGE_SIZE);
    expect(await paged.loadMore()).toBe(true);
    expect(paged.moreError.value).toBeNull();
    expect(paged.orders.value).toHaveLength(2 * ORDERS_PAGE_SIZE);
  });
});
