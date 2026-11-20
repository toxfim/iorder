import { h } from 'vue';
import { RouterView, type RouteComponent, type RouteRecordRaw } from 'vue-router';
import { STAFF_ROLES } from '@iorder/shared';
import { staffRouteName, type StaffPage } from './nav-config';

// Route definitions only. They live in the shell (not in features/staff-orders) on purpose: the
// router is part of the entry chunk, and the entry must not import the back-office orders code
// statically. Every component is a dynamic import and lands in the lazy staff-orders chunk.

const passThrough = { render: () => h(RouterView) };

/**
 * Orders: the list (admin, manager) and the order page. The order page is also the place where
 * accountant, warehouse and driver do their own step, so every staff role may open it; the server
 * decides which orders each of them may see.
 */
export function createOrdersRoute(page: StaffPage): RouteRecordRaw {
  return {
    path: page.path,
    component: passThrough,
    meta: { staffRoles: page.roles },
    children: [
      {
        path: '',
        name: staffRouteName(page),
        component: () => import('@/features/staff-orders/components/OrdersPage.vue'),
        meta: { titleKey: page.labelKey },
      },
      // The manager's new order on a customer's behalf [C, owner 2026-11-20]; before `:orderId`.
      {
        path: 'new',
        name: 'staff-new-order',
        component: () => import('@/features/staff-orders/components/NewOrderPage.vue'),
        meta: { staffRoles: ['MANAGER'], titleKey: page.labelKey },
      },
      {
        path: ':orderId',
        name: 'staff-order',
        component: () => import('@/features/staff-orders/components/OrderDetailPage.vue'),
        meta: { staffRoles: STAFF_ROLES, titleKey: page.labelKey },
      },
    ],
  };
}

const ROLE_QUEUES: Readonly<Record<string, () => Promise<{ default: RouteComponent }>>> = {
  accounting: () => import('@/features/staff-orders/components/AccountingQueuePage.vue'),
  warehouse: () => import('@/features/staff-orders/components/WarehousePage.vue'),
  deliveries: () => import('@/features/staff-orders/components/DriverDeliveriesPage.vue'),
};

/** The accountant queue (A1), the warehouse list (W1) and the driver list (D1); null for other pages. */
export function createRoleQueueRoute(page: StaffPage): RouteRecordRaw | null {
  const component = ROLE_QUEUES[page.key];
  if (!component) return null;
  return {
    path: page.path,
    name: staffRouteName(page),
    component,
    meta: { staffRoles: page.roles, titleKey: page.labelKey },
  };
}
