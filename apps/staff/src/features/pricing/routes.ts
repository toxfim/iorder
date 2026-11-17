import type { RouteRecordRaw } from 'vue-router';
import type { StaffPage } from '@/features/staff-shell/nav-config';
import { staffRouteName } from '@/features/staff-shell/nav-config';
import { PRICE_ADMIN_VIEW_ROLES } from '@/features/staff-shell/price-access';

/**
 * The "Narxlar" section: one parent (heading and tabs) with the current list, the versions and
 * the product management as children. The sidebar entry keeps the name `staff-prices`, the name
 * of the first child, so it stays highlighted on every tab.
 */
export function createPricesRoute(page: StaffPage): RouteRecordRaw {
  return {
    path: page.path,
    component: () => import('./components/PriceSection.vue'),
    meta: { staffRoles: page.roles },
    children: [
      {
        path: '',
        name: staffRouteName(page),
        component: () => import('./components/PricesPage.vue'),
        meta: { titleKey: page.labelKey },
      },
      // The accountant may read the current list (with cost) only: the versions and the product
      // management are for the people who change prices and the purchasing manager, who reads them.
      {
        path: 'versions',
        name: 'staff-price-versions',
        component: () => import('./components/VersionsPage.vue'),
        meta: { staffRoles: PRICE_ADMIN_VIEW_ROLES, titleKey: 'prices.versions.title' },
      },
      {
        path: 'versions/:id',
        name: 'staff-price-version',
        component: () => import('./components/VersionDetailPage.vue'),
        meta: { staffRoles: PRICE_ADMIN_VIEW_ROLES, titleKey: 'prices.versions.title' },
      },
      {
        path: 'products',
        name: 'staff-products',
        component: () => import('@/features/catalog/components/ProductsPage.vue'),
        meta: { staffRoles: PRICE_ADMIN_VIEW_ROLES, titleKey: 'prices.tabs.products' },
      },
      // "Newer model" pairs for the customer home [C, 2026-11-09]: read by the price management
      // roles, decided by manager and admin (the server refuses the rest).
      {
        path: 'newer-models',
        name: 'staff-newer-models',
        component: () => import('./components/NewerModelsPage.vue'),
        meta: { staffRoles: PRICE_ADMIN_VIEW_ROLES, titleKey: 'newerModels.title' },
      },
      // Templates of the per-unit code rule (IMEI / SN / marking): the same people as products.
      {
        path: 'categories',
        name: 'staff-product-categories',
        component: () => import('@/features/catalog/components/ProductCategoriesPage.vue'),
        meta: { staffRoles: PRICE_ADMIN_VIEW_ROLES, titleKey: 'products.categories.title' },
      },
    ],
  };
}
