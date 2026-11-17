import { inject, type InjectionKey } from 'vue';
import type { ActivityStore } from '@/features/activity/composables/activity-store';
import type { ActivityHistoryApi } from '@/features/activity-history/api/activity-history-api';
import type { AuthApi } from '@/features/auth/api/auth-api';
import type { CurrentUserStore } from '@/features/auth/composables/current-user-store';
import type { CatalogApi } from '@/features/catalog/api/catalog-api';
import type { CustomerSiteApi } from '@/features/staff-customer-site/api/customer-site-api';
import type { CustomerSiteStore } from '@/features/staff-customer-site/composables/customer-site-store';
import type { DashboardApi } from '@/features/dashboard/api/dashboard-api';
import type { DirectoryStore } from '@/features/directory/composables/directory-store';
import type { DriversApi } from '@/features/staff-orders/api/drivers-api';
import type { StaffOrdersApi } from '@/features/staff-orders/api/staff-orders-api';
import type { SheetAttentionStore } from '@/features/staff-cost/composables/sheet-attention-store';
import type { AwaitingApproval } from '@/features/staff-orders/composables/awaiting-approval';
import type { DashboardSummaryStore } from '@/features/staff-orders/composables/dashboard-summary-store';
import type { OrdersStore } from '@/features/staff-orders/composables/orders-store';
import type { OrderDebtStore } from '@/features/staff-orders/composables/order-debt-store';
import type { PeopleApi } from '@/features/people/api/people-api';
import type { PricingApi } from '@/features/pricing/api/pricing-api';
import type { OwnProfileApi } from '@/features/staff-profile/api/own-profile-api';
import type { ProductImagesApi } from '@/features/product-images/api/product-images-api';
import type { PriceListShareApi } from '@/features/pricing/api/price-list-share-api';
import type { SuccessionsApi } from '@/features/pricing/api/successions-api';
import type { BrandsApi } from '@/features/staff-brands/api/brands-api';
import type { CostApi } from '@/features/staff-cost/api/cost-api';
import type { ByOrderApi } from '@/features/staff-cost/api/by-order-api';
import type { StockApi } from '@/features/staff-cost/api/stock-api';
import type { UnpricedCountStore } from '@/features/staff-cost/composables/unpriced-count-store';
import type { PriceVersionStore } from '@/features/pricing/composables/price-version-store';
import type { CommandPalette } from '@/features/search/composables/command-palette';
import type { StaffAccountsApi } from '@/features/staff-users/api/staff-accounts-api';
import type { StaffUsersApi } from '@/features/staff-users/api/staff-users-api';
import type { StaffNotificationsApi } from '@/features/staff-notifications/api/staff-notifications-api';
import type { OrganizationsApi } from '@/features/staff-organizations/api/organizations-api';
import type { OrganizationBalanceApi } from '@/features/staff-organizations/api/organization-balance-api';
import type { WaitingOrganizationsStore } from '@/features/staff-organizations/composables/waiting-organizations-store';
import type { Clock } from '@core/lib/business-clock';

// Interfaces and the injection key only. This file must never import a fake adapter: it is part
// of the production bundle, and fakes ship demo identities (see fake-services.ts).
export interface Services {
  readonly authApi: AuthApi;
  readonly pricingApi: PricingApi;
  /** The published list as the groups' Excel file, and sending it to the groups now. */
  readonly priceListShareApi: PriceListShareApi;
  /** Staff-only brands of the price list file (manager, admin). */
  readonly brandsApi: BrandsApi;
  /** Staff-only newer-model pairs for the customer home: proposals, confirm, reject (manager, admin). */
  readonly successionsApi: SuccessionsApi;
  readonly catalogApi: CatalogApi;
  /** Product photos: list one product's, upload, switch the main one, remove (manager, admin). */
  readonly productImagesApi: ProductImagesApi;
  /** Staff-only cost reference and USD rate (hard rule 7). */
  readonly costApi: CostApi;
  /** Staff-only stock, unpriced products, sheet sync reports and removal requests. */
  readonly stockApi: StockApi;
  /** Staff-only: the products brought by order with what open orders wait for. */
  readonly byOrderApi: ByOrderApi;
  readonly dashboardApi: DashboardApi;
  readonly currentUser: CurrentUserStore;
  /** Business calendar source (Asia/Tashkent questions go through it, so tests can fake time). */
  readonly clock: Clock;
  /** Staff-only order endpoints (types only here: the staff area imports the contracts). */
  readonly ordersApi: StaffOrdersApi;
  /** The drivers the warehouse can assign. */
  readonly driversApi: DriversApi;
  readonly ordersStore: OrdersStore;
  /** Order debt from the server's counts: sidebar, home page, customers (FULL roles). */
  readonly orderDebtStore: OrderDebtStore;
  /** The single "waiting for approval" figure every screen shows (card, badge, quick filter). */
  readonly awaitingApproval: AwaitingApproval;
  /** The staff dashboard summary (queues, today, rate...): one read shared by every panel. */
  readonly dashboardSummaryStore: DashboardSummaryStore;
  readonly directoryStore: DirectoryStore;
  readonly activityStore: ActivityStore;
  readonly priceVersionStore: PriceVersionStore;
  /** Active products without a price: nav badge and dashboard (manager, admin). */
  readonly unpricedCountStore: UnpricedCountStore;
  /** Sheet sync leftovers for the Qoldiq badge: removal requests and new unpriced products. */
  readonly sheetAttentionStore: SheetAttentionStore;
  readonly commandPalette: CommandPalette;
  /** Staff-only organizations (Telegram groups): list, detail, activate and deactivate. */
  readonly organizationsApi: OrganizationsApi;
  /** Staff-only organization debt and payments (manager records, admin corrects, accountant reads). */
  readonly organizationBalanceApi: OrganizationBalanceApi;
  /** Staff-only: block a person (with or without leaving the Telegram group) and its status. */
  readonly staffUsersApi: StaffUsersApi;
  /** The hover card on a person's name (manager, accountant, admin). */
  readonly peopleApi: PeopleApi;
  /** Staff-only accounts: create, list, Telegram link, login and password (manager, admin). */
  readonly staffAccountsApi: StaffAccountsApi;
  /** The signed-in person's own bot notifications: status and the connect link (not ADMIN). */
  readonly staffNotificationsApi: StaffNotificationsApi;
  /** The signed-in person's own name and phone: read and change (every staff role). */
  readonly ownProfileApi: OwnProfileApi;
  /** Groups waiting for activation: the Tashkilotlar nav badge (manager, admin). */
  readonly waitingOrganizationsStore: WaitingOrganizationsStore;
  /** The audit trail of the history page (admin, manager); no api route yet, see its adapter. */
  readonly activityHistoryApi: ActivityHistoryApi;
  /** Continuing on the customer site with the dashboard sign-in: the site and the one-time code. */
  readonly customerSiteApi: CustomerSiteApi;
  /** Whether the "Customer site" entry is shown (viewer roles, a configured site). */
  readonly customerSiteStore: CustomerSiteStore;
}

export const servicesKey: InjectionKey<Services> = Symbol('services');

export function useServices(): Services {
  const services = inject(servicesKey);
  if (!services) throw new Error('Services were not provided to the app');
  return services;
}
