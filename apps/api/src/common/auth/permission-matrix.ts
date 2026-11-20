import type { OrderStatus, OrganizationRole, StaffRole } from '@iorder/shared';
import type { Actor, OrganizationMembership, ResourceContext } from './actor.js';

// Source: docs/domain/order-lifecycle.md §5 (status [P], with [C] marks noted there).
// This file is DATA plus the small named conditions the data refers to. `can.ts` only
// evaluates it. Anything not listed here is denied. All of it is deep-frozen at load.

export const PERMISSION_ACTIONS = [
  'BROWSE_PRICE_LIST',
  'USE_CART',
  'SUBMIT_ORDER',
  'CREATE_ORDER_FOR_CUSTOMER',
  'VIEW_ORDER',
  'EDIT_ORDER_ITEMS',
  'CANCEL_ORDER',
  'MANAGER_DECIDE_ORDER',
  'MANAGE_ORDER_ALLOCATION',
  'ACCOUNTING_DECIDE_ORDER',
  'SKIP_ACCOUNTING',
  'RELEASE_ORDER',
  'RECORD_UNIT_CODES',
  'VIEW_UNIT_CODES',
  'MARK_GOODS_RETURNED',
  'VIEW_PERSON_CARD',
  'FIND_PERSON_BY_TELEGRAM',
  'VIEW_TELEGRAM_IDS',
  'VIEW_STAFF_PHONE',
  'MARK_DELIVERED',
  'CONFIRM_RECEIPT',
  'VIEW_ORGANIZATION_BALANCE',
  'RECORD_ORGANIZATION_PAYMENT',
  'CORRECT_ORGANIZATION_PAYMENT',
  'VIEW_OWN_BALANCE',
  'VIEW_PAYMENT_METHOD',
  'SET_PAYMENT_METHOD',
  'SET_PAYMENT_PLAN',
  'CHANGE_OWN_PAYMENT_PLAN',
  'UPDATE_PRICE_LIST',
  'VIEW_COST_REFERENCE',
  'VIEW_PRICE_ADMIN',
  'SET_USD_RATE',
  'DECIDE_SUPPLY_REMOVAL',
  'SET_SUPPLY_PARTY',
  'RUN_SHEET_SYNC',
  'CONFIGURE_TELEGRAM_SCHEDULE',
  'EDIT_CUSTOMERS',
  'CHANGE_ORGANIZATION_LABEL',
  'ARCHIVE_ORGANIZATION',
  'VIEW_CUSTOMERS',
  'LIST_DRIVERS',
  'MANAGE_STAFF',
  'MANAGE_STAFF_CREDENTIALS',
  'MANAGE_STAFF_ACCOUNTS',
  'VIEW_STAFF_DIRECTORY',
  'CONNECT_BOT_NOTIFICATIONS',
  'VIEW_MARKED_ORDER_NOTIFICATIONS',
  'OPEN_CUSTOMER_SITE',
  'VIEW_OWN_PROFILE',
  'SET_OWN_CONTACT',
  'EDIT_OWN_STAFF_PROFILE',
  'MANAGE_OWN_CUSTOMER_LOGIN',
  'VIEW_RECEIVED_GOODS',
  'MANAGE_PRODUCT_IMAGES',
  'VIEW_OWN_RECOMMENDATIONS',
  'DECIDE_PRODUCT_SUCCESSION',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * Actions whose grants have no conditions, so `can` needs no resource context for them.
 * The compiler uses this to force a context for every other action; a unit test checks the
 * list against the matrix so the two cannot drift apart.
 */
export type ContextFreeAction =
  | 'BROWSE_PRICE_LIST'
  | 'USE_CART'
  | 'CREATE_ORDER_FOR_CUSTOMER'
  | 'MANAGER_DECIDE_ORDER'
  | 'MANAGE_ORDER_ALLOCATION'
  | 'SKIP_ACCOUNTING'
  | 'ACCOUNTING_DECIDE_ORDER'
  | 'VIEW_ORGANIZATION_BALANCE'
  | 'RECORD_ORGANIZATION_PAYMENT'
  | 'CORRECT_ORGANIZATION_PAYMENT'
  | 'VIEW_OWN_BALANCE'
  | 'VIEW_PAYMENT_METHOD'
  | 'SET_PAYMENT_METHOD'
  | 'UPDATE_PRICE_LIST'
  | 'VIEW_COST_REFERENCE'
  | 'VIEW_PRICE_ADMIN'
  | 'SET_USD_RATE'
  | 'DECIDE_SUPPLY_REMOVAL'
  | 'SET_SUPPLY_PARTY'
  | 'RUN_SHEET_SYNC'
  | 'CONFIGURE_TELEGRAM_SCHEDULE'
  | 'EDIT_CUSTOMERS'
  | 'CHANGE_ORGANIZATION_LABEL'
  | 'ARCHIVE_ORGANIZATION'
  | 'VIEW_CUSTOMERS'
  | 'LIST_DRIVERS'
  | 'MANAGE_STAFF'
  | 'MANAGE_STAFF_CREDENTIALS'
  | 'MANAGE_STAFF_ACCOUNTS'
  | 'VIEW_STAFF_DIRECTORY'
  | 'CONNECT_BOT_NOTIFICATIONS'
  | 'VIEW_MARKED_ORDER_NOTIFICATIONS'
  | 'OPEN_CUSTOMER_SITE'
  | 'VIEW_OWN_PROFILE'
  | 'SET_OWN_CONTACT'
  | 'EDIT_OWN_STAFF_PROFILE'
  | 'MANAGE_OWN_CUSTOMER_LOGIN'
  | 'VIEW_UNIT_CODES'
  | 'VIEW_PERSON_CARD'
  | 'FIND_PERSON_BY_TELEGRAM'
  | 'VIEW_TELEGRAM_IDS'
  | 'VIEW_STAFF_PHONE'
  | 'VIEW_RECEIVED_GOODS'
  | 'MANAGE_PRODUCT_IMAGES'
  | 'VIEW_OWN_RECOMMENDATIONS'
  | 'DECIDE_PRODUCT_SUCCESSION';

// ---------------------------------------------------------------------------------------
// Status sets used by conditions. One definition feeds both `can` (predicate) and
// `scopeFor` (query filter), so list endpoints and single-resource checks cannot disagree.
// ---------------------------------------------------------------------------------------

// Warehouse view (lifecycle §5, [C] 2026-10-30): from MANAGER_APPROVED onward, plus orders the
// manager approved and that were later CANCELLED or, [P], REJECTED by the accountant. Those two
// are visible only together with the fact "was approved" (MANAGER_WAS_APPROVED); it is not
// derivable from the status, and a missing fact means hidden: an order the manager refused or
// cancelled before approving never reached the warehouse.
//
// Manager cancel (lifecycle §3 transition table): limited to the statuses that have a CANCELLED
// transition. Cancelling after RELEASED is "not allowed in MVP", and terminal orders cannot move.
//
// Release and mark-delivered are gated by the status their transition starts from. The
// state machine stays the authority on legality; this only stops an actor from probing
// orders they may not even see.
const STATUS_SETS = {
  STATUS_SUBMITTED: ['SUBMITTED'],
  STATUS_ACCOUNTING_CLEARED: ['ACCOUNTING_CLEARED'],
  STATUS_BEING_PICKED: ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED'],
  STATUS_RELEASED: ['RELEASED'],
  STATUS_CLOSED_WITHOUT_DELIVERY: ['REJECTED', 'CANCELLED'],
  STATUS_DELIVERED: ['DELIVERED'],
  STATUS_STAFF_CANCELLABLE: ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'],
  STATUS_VISIBLE_TO_WAREHOUSE: [
    'MANAGER_APPROVED',
    'ACCOUNTING_CLEARED',
    'RELEASED',
    'DELIVERED',
    'RECEIVED',
  ],
} as const satisfies Record<string, readonly OrderStatus[]>;

type StatusConditionName = keyof typeof STATUS_SETS;
type IdentityConditionName =
  'SAME_ORGANIZATION' | 'PLACED_BY_ACTOR' | 'ASSIGNED_TO_ACTOR' | 'STAFF_ORDERING_ORGANIZATION';
type FactConditionName = 'MANAGER_WAS_APPROVED';
export type ConditionName = StatusConditionName | IdentityConditionName | FactConditionName;

export function isStatusCondition(name: ConditionName): name is StatusConditionName {
  return name in STATUS_SETS;
}

export function statusesFor(name: StatusConditionName): readonly OrderStatus[] {
  return STATUS_SETS[name];
}

/**
 * Staff are never organization members ([C] 2026-10-20). Any staff role voids `membership`, so
 * a staff person can never receive customer grants even if the resolver set it by mistake.
 */
export function effectiveMembership(actor: Actor): OrganizationMembership | undefined {
  // A staff viewer is still a staff person: the same rule, even if a membership slipped in.
  return actor.staffRoles.length === 0 && actor.staffViewer === undefined
    ? actor.membership
    : undefined;
}

/**
 * A staff member in the customer app ([C] 2026-11-09). Both halves are required: an actor that
 * somehow carries staff roles AND the viewer block gets neither the viewer grants here nor a
 * membership above, and keeps only what its staff roles grant.
 */
export function isStaffViewer(actor: Actor): boolean {
  return actor.staffViewer !== undefined && actor.staffRoles.length === 0;
}

/**
 * Identity comparison that fails closed: both sides must be non-empty strings. Without this,
 * `undefined === undefined` or `'' === ''` (a fact that was not loaded) would grant access.
 */
function sameKnownId(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === 'string' && left !== '' && left === right;
}

export const CONDITIONS: Record<
  ConditionName,
  (actor: Actor, context: ResourceContext) => boolean
> = {
  SAME_ORGANIZATION: (actor, context) =>
    sameKnownId(effectiveMembership(actor)?.organizationId, context.organizationId),
  PLACED_BY_ACTOR: (actor, context) => sameKnownId(actor.userId, context.placedByUserId),
  ASSIGNED_TO_ACTOR: (actor, context) => sameKnownId(actor.userId, context.assignedDriverId),
  // The resource belongs to the one organization configured for staff orders. Unset (production)
  // the left side is null and nothing ever matches.
  STAFF_ORDERING_ORGANIZATION: (actor, context) =>
    sameKnownId(actor.staffViewer?.orderingOrganizationId, context.organizationId),
  STATUS_SUBMITTED: statusIn('STATUS_SUBMITTED'),
  STATUS_ACCOUNTING_CLEARED: statusIn('STATUS_ACCOUNTING_CLEARED'),
  STATUS_BEING_PICKED: statusIn('STATUS_BEING_PICKED'),
  STATUS_RELEASED: statusIn('STATUS_RELEASED'),
  STATUS_CLOSED_WITHOUT_DELIVERY: statusIn('STATUS_CLOSED_WITHOUT_DELIVERY'),
  STATUS_DELIVERED: statusIn('STATUS_DELIVERED'),
  // Strictly true: a fact that was not loaded must not grant anything.
  MANAGER_WAS_APPROVED: (_actor, context) => context.wasManagerApproved === true,
  STATUS_STAFF_CANCELLABLE: statusIn('STATUS_STAFF_CANCELLABLE'),
  STATUS_VISIBLE_TO_WAREHOUSE: statusIn('STATUS_VISIBLE_TO_WAREHOUSE'),
};

function statusIn(name: StatusConditionName): (actor: Actor, context: ResourceContext) => boolean {
  const allowed: readonly OrderStatus[] = STATUS_SETS[name];
  return (_actor, context) => context.status !== undefined && allowed.includes(context.status);
}

// ---------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------

export type Grant =
  | { kind: 'staff'; role: StaffRole; when: readonly ConditionName[] }
  | { kind: 'organization'; role: OrganizationRole; when: readonly ConditionName[] }
  | { kind: 'staffViewer'; when: readonly ConditionName[] };

const staff = (role: StaffRole, when: readonly ConditionName[] = []): Grant =>
  Object.freeze({ kind: 'staff', role, when: Object.freeze([...when]) });
const member = (role: OrganizationRole, when: readonly ConditionName[] = []): Grant =>
  Object.freeze({ kind: 'organization', role, when: Object.freeze([...when]) });

// A staff member in the customer app. Deliberately on very few rows: every row without it stays
// closed to a viewer, whatever staff roles the person holds.
const viewer = (when: readonly ConditionName[] = []): Grant =>
  Object.freeze({ kind: 'staffViewer', when: Object.freeze([...when]) });

function grants(...list: Grant[]): readonly Grant[] {
  return Object.freeze(list);
}

// A grant applies when the actor holds its role AND every listed condition holds.
// `Record<PermissionAction, ...>` makes the compiler reject a matrix that misses an action.
export const PERMISSION_MATRIX: Readonly<Record<PermissionAction, readonly Grant[]>> =
  Object.freeze({
    BROWSE_PRICE_LIST: grants(
      member('SHOP_OWNER'),
      member('SELLER'),
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('ADMIN'),
      staff('PURCHASING_MANAGER'),
      // [C] 2026-11-09: the published list through the customer DTOs, no organization terms.
      viewer(),
    ),

    // The cart routes. Customers keep the cart of their own organization (the service still
    // checks SUBMIT_ORDER for it); a staff viewer has a personal cart that belongs to no
    // organization, so the cart works where no order is possible ([C] 2026-11-09).
    USE_CART: grants(member('SHOP_OWNER'), member('SELLER'), viewer()),

    // Customers only, and only into their own organization. Staff (even admin) cannot place
    // orders: the matrix has no staff checkmark in this row. The one exception [C, 2026-11-09]
    // is a staff viewer where an organization for staff orders is configured (staging only):
    // into that organization and no other. Unconfigured, the condition can never hold.
    SUBMIT_ORDER: grants(
      member('SHOP_OWNER', ['SAME_ORGANIZATION']),
      member('SELLER', ['SAME_ORGANIZATION']),
      viewer(['STAFF_ORDERING_ORGANIZATION']),
    ),

    // [C, owner 2026-11-20] the manager creates an order on behalf of a customer from the staff
    // app; the member it is placed for is checked against the organization in the orders service.
    // Not the admin (management only), not the purchasing manager (read-only), nobody else.
    CREATE_ORDER_FOR_CUSTOMER: grants(staff('MANAGER')),

    // Seller sees all orders of their organization [C]. Customers see their organization's
    // orders in every status, including REJECTED and CANCELLED. Warehouse and driver are
    // scoped.
    VIEW_ORDER: grants(
      member('SHOP_OWNER', ['SAME_ORGANIZATION']),
      member('SELLER', ['SAME_ORGANIZATION']),
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('ADMIN'),
      // [C] 2026-10-30: reads what the manager reads, every order, and acts on none.
      staff('PURCHASING_MANAGER'),
      staff('WAREHOUSE_MANAGER', ['STATUS_VISIBLE_TO_WAREHOUSE']),
      staff('WAREHOUSE_MANAGER', ['STATUS_CLOSED_WITHOUT_DELIVERY', 'MANAGER_WAS_APPROVED']),
      staff('DRIVER', ['ASSIGNED_TO_ACTOR']),
      // [P] A staff viewer reads only the test orders they placed themselves in the configured
      // organization (the confirmation page after a staging order needs it). Nothing else of
      // that organization, nothing of any other, and nothing at all where it is unconfigured.
      viewer(['STAFF_ORDERING_ORGANIZATION', 'PLACED_BY_ACTOR']),
    ),

    // Lifecycle §3.2 [C]: items and quantities change only while SUBMITTED.
    EDIT_ORDER_ITEMS: grants(staff('MANAGER', ['STATUS_SUBMITTED'])),

    // [C] 2026-10-22: ONLY the manager cancels. Customers (shop owner, seller) and admin never
    // do. The placer is notified by the orders module.
    CANCEL_ORDER: grants(staff('MANAGER', ['STATUS_STAFF_CANCELLABLE'])),

    // Manager and accounting steps are not status-gated here; the state machine
    // (orders module) owns their legality. Those roles may see every order anyway.
    MANAGER_DECIDE_ORDER: grants(staff('MANAGER')),
    // [C] 2026-10-30: the manager picks the delivery lines an order holds, at the approval and until
    // the release. Not the admin: a workflow step.
    MANAGE_ORDER_ALLOCATION: grants(staff('MANAGER')),
    // Manager ticks "skip accounting" while approving ([C], lifecycle §3.1). MANAGER only; ADMIN
    // is not granted pending the product owner's decision on Q14.
    SKIP_ACCOUNTING: grants(staff('MANAGER')),
    ACCOUNTING_DECIDE_ORDER: grants(staff('ACCOUNTANT')),
    RELEASE_ORDER: grants(staff('WAREHOUSE_MANAGER', ['STATUS_ACCOUNTING_CLEARED'])),
    // [C] 2026-10-25, opened earlier on 2026-10-30: the warehouse scans IMEI / SN / marking per unit
    // while picking, from the manager's approval until the release (RELEASE_ORDER above still waits
    // for accounting). Nobody else enters codes.
    RECORD_UNIT_CODES: grants(staff('WAREHOUSE_MANAGER', ['STATUS_BEING_PICKED'])),
    // [P] The warehouse says the goods of a rejected or cancelled order are back on the shelf. That
    // it happens only once, and not for orders closed before this rule, is the service's check.
    MARK_GOODS_RETURNED: grants(
      staff('WAREHOUSE_MANAGER', ['STATUS_CLOSED_WITHOUT_DELIVERY', 'MANAGER_WAS_APPROVED']),
    ),
    // Staff who see the full order also see its unit codes; the warehouse through its own order
    // visibility (VIEW_ORDER is checked as well). The driver does not (spec-serial-tracking §7).
    VIEW_UNIT_CODES: grants(
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('ADMIN'),
      staff('PURCHASING_MANAGER'),
      staff('WAREHOUSE_MANAGER'),
    ),
    MARK_DELIVERED: grants(staff('DRIVER', ['ASSIGNED_TO_ACTOR', 'STATUS_RELEASED'])),

    // Shop owner confirms for the organization, seller only for their own order.
    CONFIRM_RECEIPT: grants(
      member('SHOP_OWNER', ['SAME_ORGANIZATION', 'STATUS_DELIVERED']),
      member('SELLER', ['SAME_ORGANIZATION', 'PLACED_BY_ACTOR', 'STATUS_DELIVERED']),
    ),

    // Organization payments ([C] 2026-10-26): the debt is per organization and the orders' PAID /
    // UNPAID follows from the payments (nobody sets it by hand any more). Only the manager records
    // a payment; only the admin corrects or voids one. The accountant may look [P]. The customer
    // (shop owner and seller) sees the amount their own organization owes.
    VIEW_ORGANIZATION_BALANCE: grants(
      staff('MANAGER'),
      staff('ADMIN'),
      staff('ACCOUNTANT'),
      staff('PURCHASING_MANAGER'),
    ),
    RECORD_ORGANIZATION_PAYMENT: grants(staff('MANAGER')),
    CORRECT_ORGANIZATION_PAYMENT: grants(staff('ADMIN')),
    // A staff viewer has no organization: the service answers zero without reading any balance.
    VIEW_OWN_BALANCE: grants(member('SHOP_OWNER'), member('SELLER'), viewer()),
    // [C] 2026-10-24: the manager chooses the payment method (CASH / OFFICIAL) on approval and may
    // change it later; only manager, accountant and, [C] 2026-10-30, the purchasing manager see it
    // (not admin, warehouse, driver, customers).
    // The status rules (not before approval, not on REJECTED/CANCELLED) live in the orders service.
    VIEW_PAYMENT_METHOD: grants(staff('MANAGER'), staff('ACCOUNTANT'), staff('PURCHASING_MANAGER')),
    SET_PAYMENT_METHOD: grants(staff('MANAGER')),
    SET_PAYMENT_PLAN: grants(staff('MANAGER', ['STATUS_SUBMITTED'])),
    // [C] 2026-10-30: the customer may change the plan shortly after submitting; the time window
    // lives in the orders service. Any member who sees the order [P], unlike receipt.
    CHANGE_OWN_PAYMENT_PLAN: grants(
      member('SHOP_OWNER', ['SAME_ORGANIZATION', 'STATUS_SUBMITTED']),
      member('SELLER', ['SAME_ORGANIZATION', 'STATUS_SUBMITTED']),
    ),
    UPDATE_PRICE_LIST: grants(staff('MANAGER'), staff('ADMIN')),

    // Cost data is staff-only (hard rule 7, data-model §6.2) [C, 2026-10-20]: manager, accountant
    // and admin may VIEW the cost reference and the USD rate; only manager and admin may CHANGE the
    // rate. The accountant can never change selling prices (UPDATE_PRICE_LIST stays manager and
    // admin only). Customers, warehouse and driver never see cost.
    VIEW_COST_REFERENCE: grants(
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('ADMIN'),
      staff('PURCHASING_MANAGER'),
    ),
    // The reads of the price management pages (products, categories, brands, versions, a product's
    // price history), split from UPDATE_PRICE_LIST so a reader gets them without any write. Not the
    // accountant, who reads the current list only.
    VIEW_PRICE_ADMIN: grants(staff('MANAGER'), staff('ADMIN'), staff('PURCHASING_MANAGER')),
    SET_USD_RATE: grants(staff('MANAGER'), staff('ADMIN')),
    // Confirm or dismiss the removal of a delivery line that vanished from the sheet. The accountant
    // may VIEW the pending list (VIEW_COST_REFERENCE) but never decide.
    DECIDE_SUPPLY_REMOVAL: grants(staff('MANAGER'), staff('ADMIN')),
    // [C] 2026-10-30: the party number on a whole supply is the manager's alone, admin included out.
    SET_SUPPLY_PARTY: grants(staff('MANAGER')),
    // "Sync now" with the sheet (owner request 2026-10-28). Read-only towards the sheet (hard
    // rule 10); the accountant may read the reports but not start a run. [P]
    RUN_SHEET_SYNC: grants(staff('MANAGER'), staff('ADMIN'), staff('PURCHASING_MANAGER')),
    CONFIGURE_TELEGRAM_SCHEDULE: grants(staff('MANAGER'), staff('ADMIN')),
    EDIT_CUSTOMERS: grants(staff('MANAGER'), staff('ADMIN')),
    // [C, owner 2026-11-12] changing an organization's label AFTER it was created is the admin's
    // alone (the label decides the price tier); at creation the manager still chooses it.
    CHANGE_ORGANIZATION_LABEL: grants(staff('ADMIN')),
    // [C, owner 2026-11-13] "deleting" an organization archives it (never a hard delete: its
    // orders, payments and history stay); archiving and restoring are the admin's alone.
    ARCHIVE_ORGANIZATION: grants(staff('ADMIN')),
    // Reading customers and organizations, split from EDIT_CUSTOMERS. The service hides staff people
    // from a reader without EDIT_CUSTOMERS.
    VIEW_CUSTOMERS: grants(staff('MANAGER'), staff('ADMIN'), staff('PURCHASING_MANAGER')),
    // The id + name list of active drivers, needed to choose a driver when releasing an order.
    // Narrower than EDIT_CUSTOMERS (no phone, no Telegram id), so the warehouse manager, who
    // releases orders but may not read the user directory, can hold it.
    LIST_DRIVERS: grants(staff('MANAGER'), staff('ADMIN'), staff('WAREHOUSE_MANAGER')),
    // The hover card on a person's name: name, phone, role. [P] The roles that already see names and
    // phones next to orders; warehouse and driver see roles only, so they do not get it. The
    // purchasing manager follows the manager's pages, and the card has no credential and no Telegram id.
    VIEW_PERSON_CARD: grants(
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('ADMIN'),
      staff('PURCHASING_MANAGER'),
    ),
    // The same card looked up by a Telegram id. Apart because the lookup itself tells who an id
    // belongs to, so a role that must not know Telegram ids cannot have it.
    FIND_PERSON_BY_TELEGRAM: grants(staff('MANAGER'), staff('ACCOUNTANT'), staff('ADMIN')),
    // A staff member's phone on the card. Not the purchasing manager, who reads customer phones only.
    VIEW_STAFF_PHONE: grants(staff('MANAGER'), staff('ACCOUNTANT'), staff('ADMIN')),
    // Telegram ids in the customer and organization responses. The editors, who link and correct
    // them; a reader (VIEW_CUSTOMERS alone) gets those fields as null and cannot search by an id.
    VIEW_TELEGRAM_IDS: grants(staff('MANAGER'), staff('ADMIN')),
    MANAGE_STAFF: grants(staff('ADMIN')),
    // Set or reset a staff member's website login and password. Manager and admin; the service
    // adds the rule that a manager cannot touch an administrator (no escalation). [P]
    MANAGE_STAFF_CREDENTIALS: grants(staff('MANAGER'), staff('ADMIN')),
    // Create staff accounts (POST /staff/users), list them and link their Telegram id. Owner request
    // 2026-10-22: ONLY admin and manager. The service adds that a manager can neither grant ADMIN nor
    // touch an administrator. [P]
    MANAGE_STAFF_ACCOUNTS: grants(staff('MANAGER'), staff('ADMIN')),
    // Who works here: name, roles and status, never a login, a password fact or a Telegram id.
    VIEW_STAFF_DIRECTORY: grants(staff('MANAGER'), staff('ADMIN'), staff('PURCHASING_MANAGER')),
    // [C] 2026-10-25: every staff member except an administrator gets bot messages for the order
    // updates of their role, so connects the bot (and their Telegram id) from the staff app.
    CONNECT_BOT_NOTIFICATIONS: grants(
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('WAREHOUSE_MANAGER'),
      staff('DRIVER'),
      staff('PURCHASING_MANAGER'),
    ),

    // [C] 2026-10-31: the purchasing manager's in-app list of orders with marked goods.
    VIEW_MARKED_ORDER_NOTIFICATIONS: grants(staff('PURCHASING_MANAGER')),

    // [C] 2026-11-09: continue on the customer site with the dashboard sign-in (a one-time code
    // that opens a VIEWER session there). The staff roles that may be viewers, i.e. the staff
    // grants of BROWSE_PRICE_LIST (a unit test keeps the two equal). Deliberately no `viewer()`
    // grant: a viewer session can never ask for a code.
    OPEN_CUSTOMER_SITE: grants(
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('ADMIN'),
      staff('PURCHASING_MANAGER'),
    ),

    // `GET /me`: every authenticated person may read their OWN actor summary. The route reads the
    // actor the guard resolved, never an id from the request.
    VIEW_OWN_PROFILE: grants(
      member('SHOP_OWNER'),
      member('SELLER'),
      staff('ADMIN'),
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('WAREHOUSE_MANAGER'),
      staff('DRIVER'),
      staff('PURCHASING_MANAGER'),
      viewer(),
    ),
    // `PUT /me/contact`: a customer's own name and phone, entered at the first order (owner
    // decision 2026-10-23) and changed later from the profile [C, 2026-11-09]. Organization
    // members only: a staff member, also as a viewer of the customer app, has the staff route.
    SET_OWN_CONTACT: grants(member('SHOP_OWNER'), member('SELLER')),
    // `GET/PUT /staff/me/profile` [C, 2026-11-09]: every staff member reads and changes their OWN
    // name and phone. The route takes no id, so nobody else can be the target; roles, logins and
    // Telegram ids stay with MANAGE_STAFF and the account routes.
    EDIT_OWN_STAFF_PROFILE: grants(
      staff('ADMIN'),
      staff('MANAGER'),
      staff('ACCOUNTANT'),
      staff('WAREHOUSE_MANAGER'),
      staff('DRIVER'),
      staff('PURCHASING_MANAGER'),
    ),
    // `GET/PUT /customer/auth/credentials`: a customer's own website login. Organization members
    // only: a staff member keeps the one staff login the manager set, also as a viewer of the
    // customer app ([C] 2026-11-09), so the guard turns them away before the handler.
    MANAGE_OWN_CUSTOMER_LOGIN: grants(member('SHOP_OWNER'), member('SELLER')),
    // My Products ([C] 2026-10-25): goods received by the caller's OWN organization. The service
    // scopes every query by the actor's membership; staff never get it. A staff viewer has no
    // organization and gets empty answers from the service, without a query.
    VIEW_RECEIVED_GOODS: grants(member('SHOP_OWNER'), member('SELLER'), viewer()),
    // The customer home recommendations ([C] 2026-11-09): computed from the caller's OWN
    // organization's received orders and the published list. A staff viewer has no organization
    // and gets empty blocks from the service, without a query.
    VIEW_OWN_RECOMMENDATIONS: grants(member('SHOP_OWNER'), member('SELLER'), viewer()),
    // Newer-model pairs ([C] 2026-11-09): manager and admin confirm or reject the proposals and
    // start the generator. Reading the list is VIEW_PRICE_ADMIN (the purchasing manager reads).
    DECIDE_PRODUCT_SUCCESSION: grants(staff('MANAGER'), staff('ADMIN')),
    // Product photos (owner 2026-10-29): manager and admin in the staff app; the bulk upload by an
    // API token runs as one of them, limited to this action by the token's scopes.
    MANAGE_PRODUCT_IMAGES: grants(staff('MANAGER'), staff('ADMIN')),
  });

export function actorHoldsRole(actor: Actor, grant: Grant): boolean {
  switch (grant.kind) {
    case 'staff':
      return actor.staffRoles.includes(grant.role);
    case 'organization':
      return effectiveMembership(actor)?.role === grant.role;
    case 'staffViewer':
      return isStaffViewer(actor);
  }
}
