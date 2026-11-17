import type { StaffOrganizationResponse, StaffOrganizationSummary } from '@iorder/shared';
import type { Services } from '@/app/services';
import { createActivityStore } from '@/features/activity/composables/activity-store';
import { createFakeActivityHistoryApi } from '@/features/activity-history/api/fake-activity-history';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { forgetRememberedListQuery } from '@/features/staff-orders/composables/orders-list-memory';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import type { CustomerSiteApi } from '@/features/staff-customer-site/api/customer-site-api';
import { createCustomerSiteStore } from '@/features/staff-customer-site/composables/customer-site-store';
import { createFakeDashboardApi } from '@/features/dashboard/api/fake-dashboard-api';
import { createFakeBackoffice } from '@/features/directory/api/fake-backoffice';
import { createDirectoryStore } from '@/features/directory/composables/directory-store';
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
import { createFakePeopleApi } from '@/features/people/api/fake-people-api';
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
import {
  createFakeStaffUsers,
  type FakeStaffUsersOptions,
} from '@/features/staff-users/api/fake-staff-users-backend';
import { createWaitingOrganizationsStore } from '@/features/staff-organizations/composables/waiting-organizations-store';
import type { Clock } from '@core/lib/business-clock';
import type { FakeScenario } from '@core/lib/fake-scenario';

/** 19 Oct 2026, 09:30 in Tashkent (04:30 UTC): the day the v1 design shows. */
export const TEST_NOW = new Date('2026-10-19T04:30:00.000Z');

export interface TestServicesOptions {
  readonly scenario?: FakeScenario;
  readonly clock?: Clock;
  readonly identityId?: string;
  /** Overrides of the blocking and staff accounts fake (how a removal ends, how many reads wait). */
  readonly staffUsers?: Pick<FakeStaffUsersOptions, 'removalOutcome' | 'pendingReads'>;
  /** Adds the picking demo order IO-10500 (phones, a TV and cables waiting for the warehouse). */
  readonly pickingDemo?: boolean;
  /** Which products the orders fake treats as stock-tracked, by code (default: all but generated codes). */
  readonly stockTracked?: (productCode: string) => boolean;
  /** The customer site the api names; none by default (the sidebar entry is then hidden). */
  readonly customerSiteUrl?: string | null;
}

/** What the test api answers for a handoff: the site with a code-shaped value in the fragment. */
export const TEST_HANDOFF_CODE = 'H'.repeat(43);

/** Complete Services over the in-memory fakes with zero latency and a fixed clock. */
export function createTestServices(options: TestServicesOptions = {}) {
  const clock = options.clock ?? { now: () => TEST_NOW };
  const scenario = () => options.scenario ?? 'ready';
  const authApi = createFakeAuthApi({ initialIdentityId: options.identityId });
  const currentUser = createCurrentUserStore(authApi, {
    onSignedOut: forgetRememberedListQuery,
    onSessionChanged: () => dashboardSummaryStore.reset(),
  });
  const actor = () => {
    const user = currentUser.user.value;
    return user ? { name: user.displayName, roles: user.staffRoles } : null;
  };
  let images: FakeProductImages | null = null;
  let brands: FakeBrandsBackend | null = null;
  let cost: ReturnType<typeof createFakeCostBackend> | null = null;
  const price = createFakePriceBackend({
    scenario,
    primaryImage: (productCode) =>
      images?.primaryImage(productCode) ?? { imageUrl: null, imageLargeUrl: null },
    imageCount: (productCode) => images?.imageCount(productCode) ?? 0,
    brands: () => brands?.view.brands() ?? [],
    stock: (productCode) => ({
      stockQuantity: cost?.view.stockQuantity(productCode) ?? null,
      costUsd: cost?.view.latestCostUsd(productCode) ?? null,
    }),
  });
  images = createFakeProductImages({
    products: price.view.products,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    scenario,
    now: () => TEST_NOW,
  });
  cost = createFakeCostBackend({
    view: price.view,
    scenario,
    now: () => TEST_NOW,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    actorName: () => currentUser.user.value?.displayName ?? 'Staff',
  });
  // The post counts the demo organizations (created below), read when a post is asked for.
  let readOrganizations: () => Promise<readonly StaffOrganizationSummary[]> = () =>
    Promise.resolve([]);
  brands = createFakeBrandsBackend({
    pricingApi: price.pricingApi,
    organizations: () => readOrganizations(),
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
  });
  const successions = createFakeSuccessionsBackend({
    view: price.view,
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
  const back = createFakeBackoffice({
    clock,
    scenario,
    actor,
    linked: {
      snapshot: () => linkedOrganizations(),
      setStatus: (id, status) => organizations.organizationsApi.setStatus(id, status),
    },
  });
  const orders = createFakeStaffOrders({
    clock,
    scenario,
    actor,
    recordActivity: back.recordActivity,
    productRule: price.view.productRule,
    stockTracked: options.stockTracked ?? price.view.stockTracked,
    pickingDemo: options.pickingDemo === true,
  });
  const organizations = createFakeOrganizations({
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    now: () => clock.now(),
  });
  readOrganizations = () => organizations.organizationsApi.list();
  linkedOrganizations = organizations.snapshot;
  const staffUsers = createFakeStaffUsers({
    scenario,
    roles: () => currentUser.user.value?.staffRoles ?? [],
    now: () => clock.now(),
    ...options.staffUsers,
  });
  const activityStore = createActivityStore(back.activityApi);
  const dashboardSummaryStore = createDashboardSummaryStore(
    createFakeDashboardSummaryApi({
      readOrders: orders.visibleSummaries,
      clock,
      scenario,
      roles: () => currentUser.user.value?.staffRoles ?? [],
    }),
  );
  const onChanged = (): void => {
    void activityStore.refresh();
    void dashboardSummaryStore.refreshIfShown();
  };
  const ordersStore = createOrdersStore(orders.ordersApi, { onChanged });
  const orderDebtStore = createOrderDebtStore(orders.ordersApi, {
    changes: ordersStore.revision,
  });
  // No customer site by default, so its sidebar entry does not appear in every shell test.
  const customerSiteUrl = options.customerSiteUrl ?? null;
  const customerSiteApi: CustomerSiteApi = {
    getSite: () => Promise.resolve(customerSiteUrl),
    requestHandoff: () =>
      customerSiteUrl === null
        ? Promise.reject(new Error('no customer site in this test'))
        : Promise.resolve(`${customerSiteUrl}/#handoff=${TEST_HANDOFF_CODE}`),
  };
  const services: Services = {
    authApi,
    customerSiteApi,
    // The hint cookie is not written in tests that do not ask for it.
    customerSiteStore: createCustomerSiteStore(customerSiteApi, () => undefined),
    pricingApi: price.pricingApi,
    priceListShareApi: brands.priceListShareApi,
    brandsApi: brands.brandsApi,
    successionsApi: successions.successionsApi,
    catalogApi: price.catalogApi,
    productImagesApi: images.productImagesApi,
    costApi: cost.costApi,
    stockApi: cost.stockApi,
    byOrderApi: createFakeByOrderApi({
      orders: orders.visibleSummaries,
      roles: () => currentUser.user.value?.staffRoles ?? [],
      scenario,
    }),
    dashboardApi: createFakeDashboardApi({ clock }),
    currentUser,
    clock,
    ordersApi: orders.ordersApi,
    driversApi: orders.driversApi,
    dashboardSummaryStore,
    ordersStore,
    orderDebtStore,
    awaitingApproval: createAwaitingApproval(ordersStore, dashboardSummaryStore, clock),
    directoryStore: createDirectoryStore(back.directoryApi, { onChanged }),
    activityStore,
    priceVersionStore: createPriceVersionStore(price.pricingApi),
    unpricedCountStore: createUnpricedCountStore(cost.stockApi),
    sheetAttentionStore: createSheetAttentionStore(cost.stockApi),
    commandPalette: createCommandPalette(),
    organizationsApi: organizations.organizationsApi,
    organizationBalanceApi: orders.organizationBalanceApi,
    staffUsersApi: staffUsers.staffUsersApi,
    peopleApi: createFakePeopleApi(() => currentUser.user.value?.staffRoles ?? []),
    staffAccountsApi: staffUsers.staffAccountsApi,
    // Connected by default, so the reminder does not appear in every shell test.
    staffNotificationsApi: createFakeStaffNotificationsApi({
      telegramLinked: true,
      botConnected: true,
    }),
    ownProfileApi: createFakeOwnProfileApi(() => currentUser.user.value),
    waitingOrganizationsStore: createWaitingOrganizationsStore(organizations.organizationsApi),
    activityHistoryApi: createFakeActivityHistoryApi({
      roles: () => currentUser.user.value?.staffRoles ?? [],
    }),
  };
  return { services, price, cost, brands, back, orders, organizations, staffUsers, images };
}
