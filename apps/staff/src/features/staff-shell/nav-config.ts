import { STAFF_ROLES, type StaffRole } from '@iorder/shared';
import type { StaffIconName } from '@/components/ui/staff-icons';
import { ORGANIZATION_VIEW_ROLES } from './organizations-access';
import { COST_VIEW_ROLES, PRICE_ADMIN_VIEW_ROLES } from './price-access';

export type NavGroupKey = 'general' | 'warehouse' | 'sales' | 'system';

export interface StaffPage {
  readonly key: string;
  /** Child path under /staff, without a leading slash. */
  readonly path: string;
  /** Message key under nav.staff. */
  readonly labelKey: string;
  readonly group: NavGroupKey;
  /** Sidebar icon (design v8). Pages inside the Orders group use the group's icon. */
  readonly icon: StaffIconName;
  /** Who sees the entry and may enter the route. UI convenience only; the server decides. */
  readonly roles: readonly StaffRole[];
  /** Shown inside the sidebar "Orders" group (see ORDERS_NAV_CHILDREN), not as its own entry. */
  readonly inOrdersGroup?: boolean;
}

// Single source for both the sidebar and the router, so an entry cannot be visible yet
// unreachable (or the other way round). A new v8 page (activity history, bot settings, profile)
// is one entry here with its `group` ('system') and icon (StaffIcon has `history`, `bot` and
// `usercircle`), plus its component in the router.
//
// Visibility follows docs/private/design/v1/specs.md except staff accounts, which the owner opened to the
// manager too (the api lets admin and manager create accounts). Accountant, warehouse and driver
// each get their own queue (page-map A1, W1, D1).
export const STAFF_PAGES: readonly StaffPage[] = [
  {
    key: 'dashboard',
    path: 'dashboard',
    icon: 'dashboard',
    labelKey: 'nav.staff.dashboard',
    group: 'general',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    key: 'orders',
    path: 'orders',
    icon: 'bag',
    labelKey: 'nav.staff.orders',
    group: 'general',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
    inOrdersGroup: true,
  },
  {
    key: 'accounting',
    path: 'accounting',
    icon: 'bag',
    labelKey: 'nav.staff.accountingQueue',
    group: 'general',
    roles: ['ACCOUNTANT'],
    inOrdersGroup: true,
  },
  {
    key: 'warehouse',
    path: 'warehouse',
    icon: 'bag',
    labelKey: 'nav.staff.warehouse',
    group: 'general',
    roles: ['WAREHOUSE_MANAGER'],
    inOrdersGroup: true,
  },
  {
    key: 'deliveries',
    path: 'deliveries',
    icon: 'bag',
    labelKey: 'nav.staff.deliveries',
    group: 'general',
    roles: ['DRIVER'],
    inOrdersGroup: true,
  },
  {
    // Design v8 gives the stock its own "Ombor" section above "Savdo". Same roles as before: the
    // stock carries cost, so warehouse staff and drivers do not get it (hard rule 7).
    key: 'stock',
    path: 'stock',
    icon: 'warehouse',
    labelKey: 'nav.staff.stock',
    group: 'warehouse',
    roles: COST_VIEW_ROLES,
  },
  {
    // "Buyurtma orqali" [C, owner 2026-11-09]: the staff-added products without a sheet id, which
    // are brought when an order arrives, with what open orders wait for. Beside the stock, for the
    // same roles (the api's VIEW_COST_REFERENCE). Staff vocabulary: the customer app has no such page.
    key: 'byOrder',
    path: 'by-order',
    icon: 'package',
    labelKey: 'nav.staff.byOrder',
    group: 'warehouse',
    roles: COST_VIEW_ROLES,
  },
  {
    // The accountant reads the price list with its cost (never edits it, the api agrees).
    key: 'prices',
    path: 'prices',
    icon: 'tags',
    labelKey: 'nav.staff.prices',
    group: 'sales',
    roles: ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'PURCHASING_MANAGER'],
  },
  {
    // Products whose brand the name does not reveal (the price list file has one sheet per
    // brand): the people who change prices pick or create it, as the api allows (2026-10-28).
    key: 'brands',
    path: 'brands',
    icon: 'tag',
    labelKey: 'nav.staff.brands',
    group: 'sales',
    roles: PRICE_ADMIN_VIEW_ROLES,
  },
  {
    key: 'customers',
    path: 'customers',
    icon: 'users',
    labelKey: 'nav.staff.customers',
    group: 'sales',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    // Telegram groups: where a group the bot created is activated (manager and admin, the
    // server's EDIT_CUSTOMERS).
    key: 'organizations',
    path: 'organizations',
    icon: 'building',
    labelKey: 'nav.staff.organizations',
    group: 'sales',
    roles: ORGANIZATION_VIEW_ROLES,
  },
  {
    // Staff accounts: create, Telegram link, login and password. The server's
    // MANAGE_STAFF_ACCOUNTS is admin and manager; a manager cannot touch an administrator.
    key: 'employees',
    path: 'employees',
    icon: 'usercheck',
    labelKey: 'nav.staff.employees',
    group: 'system',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    // The audit trail (order_events + audit_log). No document says who reads it; design v8 shows
    // it to admin and manager, kept so until the owner decides. The api has no route for it yet.
    key: 'history',
    path: 'history',
    icon: 'history',
    labelKey: 'nav.staff.history',
    group: 'system',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    // Bot facts the web app really knows (its username, the person's own connection), design v8:
    // admin and manager.
    key: 'botSettings',
    path: 'bot-settings',
    icon: 'bot',
    labelKey: 'nav.staff.botSettings',
    group: 'system',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    // Every staff member sees their own profile.
    key: 'profile',
    path: 'profile',
    icon: 'usercircle',
    labelKey: 'nav.staff.profile',
    group: 'system',
    roles: STAFF_ROLES,
  },
];

export const NAV_GROUP_ORDER: readonly NavGroupKey[] = ['general', 'warehouse', 'sales', 'system'];

export function staffRouteName(page: StaffPage): string {
  return `staff-${page.key}`;
}

export function visibleStaffPages(roles: readonly StaffRole[]): StaffPage[] {
  return STAFF_PAGES.filter((page) => page.roles.some((role) => roles.includes(role)));
}

export type OrdersNavChildKey =
  'all' | 'awaitingManager' | 'awaitingAccounting' | 'toRelease' | 'toDeliver';

export interface OrdersNavChild {
  readonly key: OrdersNavChildKey;
  /** Message key of the label. */
  readonly labelKey: string;
  /** Route name of the target page. */
  readonly routeName: string;
  /** Query that pre-filters the orders list (the list's own `stage` filter). */
  readonly query?: Readonly<Record<string, string>>;
  /** Key of the dashboard summary queue that holds this child's badge number, if it has one. */
  readonly queue?: string;
  readonly roles: readonly StaffRole[];
}

// The "Orders" group: first the whole list, then the one step this role handles. The role queue
// pages (accounting, warehouse, driver) are those own-step views, so they keep their routes.
// Admin and the purchasing manager perform no workflow step, so they only get "All orders". The accountant, warehouse and
// driver have no all-orders child because the web route /staff/orders is ADMIN and MANAGER only.
// On the server the accountant already has an unscoped VIEW_ORDER; the warehouse is scoped by
// status (STATUS_VISIBLE_TO_WAREHOUSE, plus cancelled orders that had been cleared) and the
// driver by assignment (ASSIGNED_TO_ACTOR). For them the queue page is the only child. UI
// convenience only; the server decides what each role may read.
export const ORDERS_NAV_CHILDREN: readonly OrdersNavChild[] = [
  {
    key: 'all',
    labelKey: 'nav.ordersGroup.all',
    routeName: 'staff-orders',
    roles: ['ADMIN', 'MANAGER', 'PURCHASING_MANAGER'],
  },
  {
    key: 'awaitingManager',
    labelKey: 'nav.ordersGroup.awaitingManager',
    routeName: 'staff-orders',
    query: { stage: 'SUBMITTED' },
    roles: ['MANAGER'],
  },
  {
    key: 'awaitingAccounting',
    labelKey: 'nav.ordersGroup.awaitingAccounting',
    routeName: 'staff-accounting',
    queue: 'AWAITING_ACCOUNTING',
    roles: ['ACCOUNTANT'],
  },
  {
    key: 'toRelease',
    labelKey: 'nav.ordersGroup.toRelease',
    routeName: 'staff-warehouse',
    queue: 'TO_RELEASE',
    roles: ['WAREHOUSE_MANAGER'],
  },
  {
    key: 'toDeliver',
    labelKey: 'nav.ordersGroup.toDeliver',
    routeName: 'staff-deliveries',
    queue: 'TO_DELIVER',
    roles: ['DRIVER'],
  },
];

export function ordersNavFor(roles: readonly StaffRole[]): OrdersNavChild[] {
  return ORDERS_NAV_CHILDREN.filter((child) => child.roles.some((role) => roles.includes(role)));
}

/** True when a child of the Orders group shows a count that comes from the dashboard summary. */
export function hasSummaryQueueChild(roles: readonly StaffRole[]): boolean {
  return ordersNavFor(roles).some((child) => child.queue !== undefined);
}

export interface NavGroup {
  readonly group: NavGroupKey;
  /** Plain entries; pages that live inside the Orders group are not repeated here. */
  readonly pages: readonly StaffPage[];
  /** Children of the Orders group, which follows the general pages; empty for other sections. */
  readonly ordersChildren: readonly OrdersNavChild[];
}

export function navGroupsFor(roles: readonly StaffRole[]): NavGroup[] {
  const visible = visibleStaffPages(roles);
  const orders = ordersNavFor(roles);
  return NAV_GROUP_ORDER.map((group) => ({
    group,
    pages: visible.filter((page) => page.group === group && !page.inOrdersGroup),
    // v8: the Orders group opens the general section, right under the dashboard.
    ordersChildren: group === 'general' ? orders : [],
  })).filter((entry) => entry.pages.length > 0 || entry.ordersChildren.length > 0);
}

/** Where a staff member lands after signing in: the first entry they may open. */
export function firstStaffPage(roles: readonly StaffRole[]): StaffPage | undefined {
  return visibleStaffPages(roles)[0];
}
