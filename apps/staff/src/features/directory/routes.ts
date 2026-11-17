import { h } from 'vue';
import { RouterView, type RouteRecordRaw } from 'vue-router';
import { staffRouteName, type StaffPage } from '@/features/staff-shell/nav-config';

// A section is a parent without its own page plus an empty-path child that carries the section's
// route name, so the sidebar entry stays highlighted on the detail pages (same pattern as Narxlar).
const passThrough = { render: () => h(RouterView) };

/** Customers: the list, an organization card and a member profile. */
export function createCustomersRoute(page: StaffPage): RouteRecordRaw {
  return {
    path: page.path,
    component: passThrough,
    meta: { staffRoles: page.roles },
    children: [
      {
        path: '',
        name: staffRouteName(page),
        component: () => import('./components/CustomersPage.vue'),
        meta: { titleKey: page.labelKey },
      },
      {
        path: ':organizationId',
        name: 'staff-customer',
        component: () => import('./components/OrganizationPage.vue'),
        meta: { titleKey: page.labelKey },
      },
      {
        path: ':organizationId/members/:memberId',
        name: 'staff-member',
        component: () => import('./components/MemberPage.vue'),
        meta: { titleKey: page.labelKey },
      },
    ],
  };
}
