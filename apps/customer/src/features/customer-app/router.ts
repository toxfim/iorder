import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';

// The customer Mini App has its own small router: no staff routes exist here, and access is
// decided by the session (the server refuses everything else). Each page is a lazy chunk.
export const customerRoutes: readonly RouteRecordRaw[] = [
  {
    path: '/',
    name: 'customer-home',
    component: () => import('@/features/customer-home/components/HomePage.vue'),
    meta: { titleKey: 'customer.presentation.home' },
  },
  {
    path: '/my-products',
    name: 'customer-goods',
    component: () => import('@/features/customer-goods/components/MyProductsPage.vue'),
    meta: { titleKey: 'customer.goods.title', navGroup: 'customer-orders' },
  },
  {
    path: '/my-products/:productId',
    name: 'customer-goods-product',
    component: () => import('@/features/customer-goods/components/ProductUnitsPage.vue'),
    meta: { titleKey: 'customer.goods.title', navGroup: 'customer-orders' },
  },
  {
    path: '/my-products/:productId/units/:unitId',
    name: 'customer-goods-unit',
    component: () => import('@/features/customer-goods/components/UnitHistoryPage.vue'),
    meta: { titleKey: 'customer.goods.unitHistory', navGroup: 'customer-orders' },
  },
  {
    path: '/profile',
    name: 'customer-profile',
    component: () => import('./components/ProfilePage.vue'),
    meta: { titleKey: 'customer.presentation.profile' },
  },
  {
    path: '/prices',
    name: 'customer-catalog',
    component: () => import('@/features/customer-catalog/components/CatalogPage.vue'),
    meta: { titleKey: 'nav.customer.catalog' },
  },
  {
    path: '/cart',
    name: 'customer-cart',
    component: () => import('@/features/customer-cart/components/CartPage.vue'),
    meta: { titleKey: 'nav.customer.cart' },
  },
  {
    path: '/orders',
    name: 'customer-orders',
    component: () => import('@/features/customer-orders/components/OrdersPage.vue'),
    meta: { titleKey: 'nav.customer.orders' },
  },
  {
    path: '/orders/:id',
    name: 'customer-order',
    component: () => import('@/features/customer-orders/components/OrderPage.vue'),
    meta: { titleKey: 'nav.customer.orders' },
  },
  {
    path: '/orders/:id/placed',
    name: 'customer-placed',
    component: () => import('@/features/customer-orders/components/PlacedPage.vue'),
    meta: { titleKey: 'customer.placed.title' },
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'customer-catalog' } },
];

export function createCustomerRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: [...customerRoutes],
    // Filters change only the query: they keep the place on the page.
    scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path ? false : { top: 0 }),
  });
}
