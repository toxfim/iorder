import type { Services } from './services';

/** The stores that hold one person's data. Everything listed here is emptied on a session change. */
export type PerPersonStores = Pick<
  Services,
  | 'ordersStore'
  | 'orderDebtStore'
  | 'dashboardSummaryStore'
  | 'directoryStore'
  | 'activityStore'
  | 'priceVersionStore'
  | 'unpricedCountStore'
  | 'sheetAttentionStore'
  | 'waitingOrganizationsStore'
  | 'customerSiteStore'
>;

/**
 * Called when a different person signs in, or the session ends. The stores are singletons, so
 * without this the next person would briefly see (or keep) the previous person's orders, counts
 * and lists, even though the server only answers each request for its own caller.
 */
export function resetPerPersonStores(stores: PerPersonStores): void {
  stores.ordersStore.reset();
  stores.orderDebtStore.reset();
  stores.dashboardSummaryStore.reset();
  stores.directoryStore.reset();
  stores.activityStore.reset();
  stores.priceVersionStore.reset();
  stores.unpricedCountStore.reset();
  stores.sheetAttentionStore.reset();
  stores.waitingOrganizationsStore.reset();
  stores.customerSiteStore.reset();
}
