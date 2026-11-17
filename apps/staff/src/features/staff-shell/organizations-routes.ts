import { h } from 'vue';
import { RouterView, type RouteRecordRaw } from 'vue-router';
import { staffRouteName, type StaffPage } from './nav-config';

const passThrough = { render: () => h(RouterView) };

/** Organizations: the list and one organization (the section keeps its sidebar entry lit). */
export function createOrganizationsRoute(page: StaffPage): RouteRecordRaw {
  return {
    path: page.path,
    component: passThrough,
    meta: { staffRoles: page.roles },
    children: [
      {
        path: '',
        name: staffRouteName(page),
        component: () => import('@/features/staff-organizations/components/OrganizationsPage.vue'),
        meta: { titleKey: page.labelKey },
      },
      {
        path: ':organizationId',
        name: 'staff-organization',
        component: () =>
          import('@/features/staff-organizations/components/OrganizationDetailPage.vue'),
        meta: { titleKey: page.labelKey },
      },
    ],
  };
}
