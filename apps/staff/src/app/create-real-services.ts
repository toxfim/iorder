import { createActivityStore } from '@/features/activity/composables/activity-store';
import { unavailableActivityHistoryApi } from '@/features/activity-history/api/activity-history-api';
import type { CurrentUserStore } from '@/features/auth/composables/current-user-store';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { createHttpCatalogApi } from '@/features/catalog/api/catalog-api';
import { createHttpCustomerSiteApi } from '@/features/staff-customer-site/api/customer-site-api';
import { createCustomerSiteStore } from '@/features/staff-customer-site/composables/customer-site-store';
import { forgetInitData, readInitData } from '@core/telegram/launch';
import { createHttpDirectoryApi } from '@/features/directory/api/http-directory-api';
import { createDirectoryStore } from '@/features/directory/composables/directory-store';
import { createHttpPricingApi } from '@/features/pricing/api/pricing-api';
import { createHttpPriceListShareApi } from '@/features/pricing/api/price-list-share-api';
import { createHttpBrandsApi } from '@/features/staff-brands/api/brands-api';
import { createHttpSuccessionsApi } from '@/features/pricing/api/successions-api';
import { createPriceVersionStore } from '@/features/pricing/composables/price-version-store';
import { createHttpProductImagesApi } from '@/features/product-images/api/product-images-api';
import { createCommandPalette } from '@/features/search/composables/command-palette';
import { createHttpAuthApi } from '@/features/staff-auth/api/http-auth-api';
import {
  createSignInHttpClient,
  createStaffHttpClient,
} from '@/features/staff-auth/api/staff-http';
import {
  createStaffSessionStore,
  type StaffSessionStore,
} from '@/features/staff-auth/session-store';
import { createHttpCostApi } from '@/features/staff-cost/api/cost-api';
import { createHttpByOrderApi } from '@/features/staff-cost/api/by-order-api';
import { createHttpStockApi } from '@/features/staff-cost/api/stock-api';
import { createSheetAttentionStore } from '@/features/staff-cost/composables/sheet-attention-store';
import { createUnpricedCountStore } from '@/features/staff-cost/composables/unpriced-count-store';
import { createHttpDashboardSummaryApi } from '@/features/staff-orders/api/dashboard-summary-api';
import { createHttpDriversApi } from '@/features/staff-orders/api/drivers-api';
import { createHttpStaffOrdersApi } from '@/features/staff-orders/api/staff-orders-api';
import { createAwaitingApproval } from '@/features/staff-orders/composables/awaiting-approval';
import { createDashboardSummaryStore } from '@/features/staff-orders/composables/dashboard-summary-store';
import { forgetRememberedListQuery } from '@/features/staff-orders/composables/orders-list-memory';
import { createOrdersStore } from '@/features/staff-orders/composables/orders-store';
import { createOrderDebtStore } from '@/features/staff-orders/composables/order-debt-store';
import { createHttpOrganizationsApi } from '@/features/staff-organizations/api/organizations-api';
import { createHttpOrganizationBalanceApi } from '@/features/staff-organizations/api/organization-balance-api';
import { createHttpPeopleApi } from '@/features/people/api/people-api';
import { createHttpStaffAccountsApi } from '@/features/staff-users/api/staff-accounts-api';
import { createHttpStaffNotificationsApi } from '@/features/staff-notifications/api/staff-notifications-api';
import { createHttpOwnProfileApi } from '@/features/staff-profile/api/own-profile-api';
import { createHttpStaffUsersApi } from '@/features/staff-users/api/staff-users-api';
import { createWaitingOrganizationsStore } from '@/features/staff-organizations/composables/waiting-organizations-store';
import { reloadPage } from '@core/lib/app-outdated';
import { systemClock, type Clock } from '@core/lib/business-clock';
import { resetPerPersonStores } from './session-reset';
import type { Services } from './services';
import { unavailableActivityApi, unavailableDashboardApi } from './unavailable-apis';

export interface RealServicesOptions {
  /** `/api` or an https origin (validated in app/env.ts). */
  readonly baseUrl: string;
  /** The staff session ended on the server (a 401 on a signed-in call): move to the login. */
  readonly onSessionExpired?: () => void;
  readonly session?: StaffSessionStore;
  readonly readInitData?: () => string | null;
  readonly forgetInitData?: () => void;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: Clock;
}

/**
 * The services of the staff web app over the real api. Every staff and customer-facing client
 * that exists is wired here; the few screens whose routes do not exist yet get adapters that fail
 * with a typed error (see unavailable-apis.ts). Roles come only from `GET /auth/session`.
 */
export function createRealServices(options: RealServicesOptions): Services {
  const session = options.session ?? createStaffSessionStore();
  // The token is shared by every tab of the browser. When another tab signs in or out, this tab
  // shows a person the stored token no longer belongs to; starting again is the one way every
  // store and screen agrees with it (signed out: the login page; signed in: that person).
  session.onExternalChange(reloadPage);
  const initData = options.readInitData ?? readInitData;
  const clock = options.clock ?? systemClock;
  const fetchImpl = options.fetchImpl;

  // `currentUser` is needed by the 401 handler, which is needed by the http client, which is
  // needed by the auth api, which is needed by `currentUser`: close the loop with a late binding.
  let currentUser: CurrentUserStore | null = null;
  const http = createStaffHttpClient({
    baseUrl: options.baseUrl,
    session,
    readInitData: initData,
    ...(fetchImpl ? { fetchImpl } : {}),
    onUnauthenticated: (credential) => {
      // The person's own sign-out is already ending the session (and the page they go to next).
      if (currentUser?.isSigningOut()) return;
      // Only the credential the server refused ends. A refused init data (an unknown person in
      // the Mini App, or a forged fragment opened in a browser) leaves the website token alone:
      // that token may be another person's session in another tab (security review, 2026-11-10).
      if (credential === 'session') session.clear();
      // Parallel 401s end the session once; a 401 while nobody is signed in is nothing to do.
      if (!currentUser?.expire()) return;
      // A website session that ended inside Telegram: the init data of the tab may still sign
      // the person in, so ask before the page moves. A refused init data has no second chance.
      if (credential === 'session' && initData() !== null) {
        void currentUser.reload().finally(() => options.onSessionExpired?.());
      } else options.onSessionExpired?.();
    },
  });
  const authApi = createHttpAuthApi({
    http,
    signInHttp: createSignInHttpClient(options.baseUrl, fetchImpl),
    session,
    readInitData: initData,
    forgetInitData: options.forgetInitData ?? forgetInitData,
  });
  currentUser = createCurrentUserStore(authApi, {
    onSignedOut: forgetRememberedListQuery,
    onSessionChanged: () => resetPerPersonStores(stores),
  });

  const ordersApi = createHttpStaffOrdersApi(http);
  const stockApi = createHttpStockApi(http);
  const organizationsApi = createHttpOrganizationsApi(http);
  const staffUsersApi = createHttpStaffUsersApi(http);
  const activityStore = createActivityStore(unavailableActivityApi);
  const dashboardSummaryStore = createDashboardSummaryStore(createHttpDashboardSummaryApi(http));
  const onChanged = (): void => {
    void activityStore.refresh();
    void dashboardSummaryStore.refreshIfShown();
  };
  const ordersStore = createOrdersStore(ordersApi, { onChanged });
  const orderDebtStore = createOrderDebtStore(ordersApi, { changes: ordersStore.revision });
  const pricingApi = createHttpPricingApi(http);
  const customerSiteApi = createHttpCustomerSiteApi(http);

  const stores = {
    ordersStore,
    orderDebtStore,
    dashboardSummaryStore,
    activityStore,
    directoryStore: createDirectoryStore(createHttpDirectoryApi(http, staffUsersApi), {
      onChanged,
    }),
    priceVersionStore: createPriceVersionStore(pricingApi),
    unpricedCountStore: createUnpricedCountStore(stockApi),
    sheetAttentionStore: createSheetAttentionStore(stockApi),
    waitingOrganizationsStore: createWaitingOrganizationsStore(organizationsApi),
    customerSiteStore: createCustomerSiteStore(customerSiteApi),
  };

  return {
    authApi,
    customerSiteApi,
    pricingApi,
    priceListShareApi: createHttpPriceListShareApi(http),
    brandsApi: createHttpBrandsApi(http),
    successionsApi: createHttpSuccessionsApi(http),
    catalogApi: createHttpCatalogApi(http),
    productImagesApi: createHttpProductImagesApi(http),
    costApi: createHttpCostApi(http),
    stockApi,
    byOrderApi: createHttpByOrderApi(http),
    dashboardApi: unavailableDashboardApi,
    currentUser,
    clock,
    ordersApi,
    driversApi: createHttpDriversApi(http),
    awaitingApproval: createAwaitingApproval(ordersStore, dashboardSummaryStore, clock),
    commandPalette: createCommandPalette(),
    organizationsApi,
    organizationBalanceApi: createHttpOrganizationBalanceApi(http),
    staffUsersApi,
    peopleApi: createHttpPeopleApi(http),
    staffAccountsApi: createHttpStaffAccountsApi(http),
    staffNotificationsApi: createHttpStaffNotificationsApi(http),
    ownProfileApi: createHttpOwnProfileApi(http),
    // The audit trail is written on the server but has no read route: the page says so.
    activityHistoryApi: unavailableActivityHistoryApi,
    ...stores,
  };
}
