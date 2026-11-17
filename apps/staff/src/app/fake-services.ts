import type { StaffOrganizationResponse, StaffOrganizationSummary } from '@iorder/shared';
import { createActivityStore } from '@/features/activity/composables/activity-store';
import { createFakeActivityHistoryApi } from '@/features/activity-history/api/fake-activity-history';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { createFakeCustomerSiteApi } from '@/features/staff-customer-site/api/fake-customer-site-api';
import { createCustomerSiteStore } from '@/features/staff-customer-site/composables/customer-site-store';
import { createFakeDashboardApi } from '@/features/dashboard/api/fake-dashboard-api';
import { createFakeBackoffice } from '@/features/directory/api/fake-backoffice';
import { createDirectoryStore } from '@/features/directory/composables/directory-store';
import { forgetRememberedListQuery } from '@/features/staff-orders/composables/orders-list-memory';
import { createFakeStaffOrders } from '@/features/staff-orders/api/fake-staff-orders-backend';
import { createFakeDashboardSummaryApi } from '@/features/staff-orders/api/fake-dashboard-summary-api';
import { createDashboardSummaryStore } from '@/features/staff-orders/composables/dashboard-summary-store';
import { createAwaitingApproval } from '@/features/staff-orders/composables/awaiting-approval';
import { createOrdersStore } from '@/features/staff-orders/composables/orders-store';
import { createOrderDebtStore } from '@/features/staff-orders/composables/order-debt-store';
import { createFakeByOrderApi } from '@/features/staff-cost/api/fake-by-order';
import { createFakeCostBackend } from '@/features/staff-cost/api/fake-cost-backend';
import { createFakePriceBackend } from '@/features/pricing/api/fake-price-backend';
import { createFakeSuccessionsBackend } from '@/features/pricing/api/fake-successions-backend';
import {
  createFakeProductImages,
  type FakeProductImages,
} from '@/features/product-images/api/fake-product-images';
import {
  createFakeBrandsBackend,
  type FakeBrandsBackend,
} from '@/features/staff-brands/api/fake-brands-backend';
import { createPriceVersionStore } from '@/features/pricing/composables/price-version-store';
import { createSheetAttentionStore } from '@/features/staff-cost/composables/sheet-attention-store';
import { createUnpricedCountStore } from '@/features/staff-cost/composables/unpriced-count-store';
import { createCommandPalette } from '@/features/search/composables/command-palette';
import { createFakeOrganizations } from '@/features/staff-organizations/api/fake-organizations-backend';
import { createFakeStaffNotificationsApi } from '@/features/staff-notifications/api/fake-staff-notifications';
import { createFakeOwnProfileApi } from '@/features/staff-profile/api/fake-own-profile-api';
import { createFakePeopleApi } from '@/features/people/api/fake-people-api';
import { createFakeStaffUsers } from '@/features/staff-users/api/fake-staff-users-backend';
import { createWaitingOrganizationsStore } from '@/features/staff-organizations/composables/waiting-organizations-store';
import { systemClock } from '@core/lib/business-clock';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { resetPerPersonStores } from './session-reset';
import type { Services } from './services';

// Only ever loaded through the dynamic import in create-services.ts, behind the dev/flag gate.
export function createFakeServices(): Services {
  const authApi = createFakeAuthApi();
  const currentUser = createCurrentUserStore(authApi, {
    onSignedOut: forgetRememberedListQuery,
    onSessionChanged: () => resetPerPersonStores(stores),
  });
  const actor = () => {
    const user = currentUser.user.value;
    return user ? { name: user.displayName, roles: user.staffRoles } : null;
  };
  // The fakes always answer normally in the running app; failure scenarios are test-only options.
  const scenario = (): FakeScenario => 'ready';
  const clock = systemClock;
  // The photo fake reads the price fake's catalog and the price fake shows its primary photos;
  // the brands fake reads the price list and the price fake checks the brands of manual products.
  let images: FakeProductImages | null = null;
  let brands: FakeBrandsBackend | null = null;
  let cost: ReturnType<typeof createFakeCostBackend> | null = null;
  const { pricingApi, catalogApi, view } = createFakePriceBackend({
    latencyMs: 250,
    scenario,
    primaryImage: (productCode) =>
      images?.primaryImage(productCode) ?? { imageUrl: null, imageLargeUrl: null },
    imageCount: (productCode) => images?.imageCount(productCode) ?? 0,
    brands: () => brands?.view.brands() ?? [],
    // The merge preview shows the sheet product's stock and cost, which the cost fake keeps.
    stock: (productCode) => ({
      stockQuantity: cost?.view.stockQuantity(productCode) ?? null,
      costUsd: cost?.view.latestCostUsd(productCode) ?? null,
    }),
  });
  images = createFakeProductImages({
    products: view.products,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    latencyMs: 400,
    scenario,
  });
  cost = createFakeCostBackend({
    view,
    latencyMs: 250,
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    actorName: () => currentUser.user.value?.displayName ?? 'Staff',
  });
  const { costApi, stockApi } = cost;
  // The post counts the demo organizations (created below), read when a post is asked for.
  let readOrganizations: () => Promise<readonly StaffOrganizationSummary[]> = () =>
    Promise.resolve([]);
  brands = createFakeBrandsBackend({
    pricingApi,
    organizations: () => readOrganizations(),
    latencyMs: 250,
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
  });
  const { brandsApi, priceListShareApi } = brands;
  const { successionsApi } = createFakeSuccessionsBackend({
    view,
    latencyMs: 250,
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    actor: () => {
      const user = currentUser.user.value;
      return user ? { id: user.id, name: user.displayName } : null;
    },
    now: () => clock.now(),
  });
  // Late-bound: the organizations fake is made below, the directory reads it at call time.
  let linkedOrganizations: () => readonly StaffOrganizationResponse[] = () => [];
  const { directoryApi, activityApi, recordActivity } = createFakeBackoffice({
    latencyMs: 250,
    clock,
    scenario,
    actor,
    linked: {
      snapshot: () => linkedOrganizations(),
      setStatus: (id, status) => organizations.organizationsApi.setStatus(id, status),
    },
  });
  const { ordersApi, driversApi, visibleSummaries, organizationBalanceApi } = createFakeStaffOrders(
    {
      latencyMs: 250,
      clock,
      scenario,
      actor,
      recordActivity,
      // The warehouse picks with the catalog's current code rule; one extra order demos scanning.
      productRule: view.productRule,
      stockTracked: view.stockTracked,
      pickingDemo: true,
    },
  );
  const organizations = createFakeOrganizations({
    latencyMs: 250,
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    now: () => clock.now(),
  });
  readOrganizations = () => organizations.organizationsApi.list();
  linkedOrganizations = organizations.snapshot;
  const staffUsers = createFakeStaffUsers({
    latencyMs: 250,
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    now: () => clock.now(),
  });
  const activityStore = createActivityStore(activityApi);
  const dashboardSummaryStore = createDashboardSummaryStore(
    createFakeDashboardSummaryApi({
      readOrders: visibleSummaries,
      clock,
      latencyMs: 250,
      scenario,
      roles: () => currentUser.user.value?.staffRoles ?? [],
    }),
  );
  const onChanged = (): void => {
    void activityStore.refresh();
    void dashboardSummaryStore.refreshIfShown();
  };

  const ordersStore = createOrdersStore(ordersApi, { onChanged });
  const orderDebtStore = createOrderDebtStore(ordersApi, { changes: ordersStore.revision });
  const customerSiteApi = createFakeCustomerSiteApi();
  const stores = {
    ordersStore,
    orderDebtStore,
    dashboardSummaryStore,
    activityStore,
    directoryStore: createDirectoryStore(directoryApi, { onChanged }),
    priceVersionStore: createPriceVersionStore(pricingApi),
    unpricedCountStore: createUnpricedCountStore(stockApi),
    sheetAttentionStore: createSheetAttentionStore(stockApi),
    waitingOrganizationsStore: createWaitingOrganizationsStore(organizations.organizationsApi),
    customerSiteStore: createCustomerSiteStore(customerSiteApi),
  };

  return {
    authApi,
    customerSiteApi,
    pricingApi,
    priceListShareApi,
    brandsApi,
    successionsApi,
    catalogApi,
    productImagesApi: images.productImagesApi,
    costApi,
    stockApi,
    byOrderApi: createFakeByOrderApi({
      orders: visibleSummaries,
      roles: () => currentUser.user.value?.staffRoles ?? [],
      latencyMs: 250,
      scenario,
    }),
    dashboardApi: createFakeDashboardApi({ clock, latencyMs: 250 }),
    currentUser,
    clock,
    ordersApi,
    driversApi,
    awaitingApproval: createAwaitingApproval(ordersStore, dashboardSummaryStore, clock),
    commandPalette: createCommandPalette(),
    organizationsApi: organizations.organizationsApi,
    organizationBalanceApi,
    staffUsersApi: staffUsers.staffUsersApi,
    peopleApi: createFakePeopleApi(() => currentUser.user.value?.staffRoles ?? []),
    staffAccountsApi: staffUsers.staffAccountsApi,
    staffNotificationsApi: createFakeStaffNotificationsApi(),
    ownProfileApi: createFakeOwnProfileApi(() => currentUser.user.value),
    activityHistoryApi: createFakeActivityHistoryApi({
      latencyMs: 250,
      roles: () => currentUser.user.value?.staffRoles ?? [],
    }),
    ...stores,
  };
}
