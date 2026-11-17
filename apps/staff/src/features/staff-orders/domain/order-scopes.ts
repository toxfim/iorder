import type { OrdersScope } from '../composables/orders-store';

// What each role page asks the server for (status filters; the list endpoint takes one status at a
// time). Queues are read whole, "recent" lists only as the newest page.

/** A1: the queue waiting for the accountant, and the orders the manager passed without them. */
export const ACCOUNTANT_SCOPE: OrdersScope = {
  queue: ['MANAGER_APPROVED'],
  recent: ['ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED'],
};

/**
 * W1: the orders to prepare, those to release, those whose goods have to come back, and the latest
 * closed ones (the server sends the warehouse only those that had been approved).
 */
export const WAREHOUSE_SCOPE: OrdersScope = {
  queue: ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED'],
  recent: ['CANCELLED', 'REJECTED'],
  goodsReturnPending: true,
};

/** D1: the deliveries to make, and the latest finished ones. */
export const DRIVER_SCOPE: OrdersScope = {
  queue: ['RELEASED'],
  recent: ['DELIVERED', 'RECEIVED'],
};

/** M1: the manager's queue, read on every page (the sidebar badge, the home page list). */
export const MANAGER_SCOPE: OrdersScope = { queue: ['SUBMITTED'], recent: [] };
