import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';
import type { CurrentUserStore } from '@/features/auth/composables/current-user-store';
import { CUSTOMER_SITE_ROLES } from '@/features/staff-customer-site/access';
import { createCustomersRoute } from '@/features/directory/routes';
import { createPricesRoute } from '@/features/pricing/routes';
import { createOrganizationsRoute } from '@/features/staff-shell/organizations-routes';
import { STAFF_PAGES, staffRouteName } from '@/features/staff-shell/nav-config';
import { createOrdersRoute, createRoleQueueRoute } from '@/features/staff-shell/orders-routes';
import { ensureStaffCostMessages } from '@/i18n/staff-cost-messages';
import { ensureStaffCommonMessages } from '@/i18n/staff-common-messages';
import { ensureStaffOrdersMessages } from '@/i18n/staff-orders-messages';
import { ensureStaffOrganizationsMessages } from '@/i18n/staff-organizations-messages';
import { ensureStaffSystemPagesMessages } from '@/i18n/staff-system-pages-messages';
import { ensureStaffUsersMessages } from '@/i18n/staff-users-messages';
import type { AppI18n } from '@core/i18n';
import { installGuards, TELEGRAM_REFUSED } from './guards';

const staffRoutes: RouteRecordRaw = {
  path: '/staff',
  component: () => import('@/features/staff-shell/components/StaffShell.vue'),
  meta: { area: 'staff' },
  children: [
    // No component: the guard always redirects /staff to the first page the role may open.
    { path: '', name: 'staff-home', component: { render: () => null } },
    ...STAFF_PAGES.map((page): RouteRecordRaw => {
      switch (page.key) {
        case 'prices':
          return createPricesRoute(page);
        case 'stock':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/staff-cost/components/StockPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'byOrder':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/staff-cost/components/ByOrderPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'brands':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/staff-brands/components/BrandsPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'dashboard':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/dashboard/components/DashboardPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'orders':
          return createOrdersRoute(page);
        case 'customers':
          return createCustomersRoute(page);
        case 'organizations':
          return createOrganizationsRoute(page);
        case 'employees':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/staff-users/components/StaffAccountsPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'history':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () =>
              import('@/features/activity-history/components/ActivityHistoryPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'botSettings':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/bot-settings/components/BotSettingsPage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'profile':
          return {
            path: page.path,
            name: staffRouteName(page),
            component: () => import('@/features/profile/components/ProfilePage.vue'),
            meta: { staffRoles: page.roles, titleKey: page.labelKey },
          };
        case 'accounting':
        case 'warehouse':
        case 'deliveries':
          return createRoleQueueRoute(page) ?? { path: page.path, redirect: '/staff' };
        default:
          // Unreachable while every STAFF_PAGES key has a case above; never a stand-in page.
          return { path: page.path, redirect: '/staff' };
      }
    }),
  ],
};

export const routes: readonly RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/features/auth/components/LoginPage.vue'),
    meta: { area: 'public', titleKey: 'auth.login.title' },
  },
  {
    path: '/session-error',
    name: 'session-error',
    component: () => import('@/features/auth/components/SessionErrorPage.vue'),
    meta: { area: 'public', titleKey: 'state.error.title' },
  },
  {
    // Inside Telegram: the launch could not sign the person in as staff. Says what to do.
    path: '/telegram-sign-in',
    name: TELEGRAM_REFUSED,
    component: () => import('@/features/auth/components/TelegramRefusedPage.vue'),
    meta: { area: 'public', titleKey: 'auth.telegram.pageTitle' },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('@/features/auth/components/ForbiddenPage.vue'),
    meta: { area: 'public', titleKey: 'state.denied.title' },
  },
  // Hands a signed-in staff member over to the customer site ([C] 2026-11-09). A staff page (so
  // the guard asks for the sign-in first and comes back here), but outside the shell: the person
  // is only passing through. The customer site sends its returning staff visitors to this path.
  {
    path: '/handoff',
    name: 'customer-site-handoff',
    component: () => import('@/features/staff-customer-site/components/HandoffPage.vue'),
    meta: {
      area: 'staff',
      staffRoles: CUSTOMER_SITE_ROLES,
      titleKey: 'customerSite.entry',
    },
  },
  // No component: the guard sends every signed-in person to their first staff page.
  { path: '/', name: 'home', component: { render: () => null }, meta: { area: 'staff' } },
  staffRoutes,
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export interface AppRouterOptions {
  /** True while the tab holds Telegram's init data (see `resolveAccess`). */
  readonly viaTelegram?: () => boolean;
}

export function createAppRouter(
  currentUser: CurrentUserStore,
  history: RouterHistory = createWebHistory(),
  i18n?: AppI18n,
  options: AppRouterOptions = {},
): Router {
  const router = createRouter({ history, routes: [...routes] });
  installGuards(router, currentUser, options.viaTelegram);
  if (i18n) {
    // Staff cost and back-office order labels are not in the eager catalogs (hard rule 7); the
    // staff area loads them before its pages render.
    router.beforeResolve(async (to) => {
      if (to.matched.some((record) => record.meta.area === 'staff')) {
        await Promise.all([
          ensureStaffCostMessages(i18n),
          ensureStaffOrdersMessages(i18n),
          ensureStaffCommonMessages(i18n),
          ensureStaffOrganizationsMessages(i18n),
          ensureStaffUsersMessages(i18n),
          ensureStaffSystemPagesMessages(i18n),
        ]);
      }
    });
  }
  return router;
}
