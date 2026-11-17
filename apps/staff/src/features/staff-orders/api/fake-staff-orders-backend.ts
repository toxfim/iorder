import {
  ORGANIZATION_ROLES,
  type CustomerTimelineResponse,
  type OrderActorRole,
  type OrderStatus,
  type PaymentPlan,
  type PaymentPlanChange,
  type PaymentStatus,
  type StaffRole,
} from '@iorder/shared';
import type {
  AccountingMode,
  GoodsReturnState,
  AllocationMode,
  AllocationRequestRow,
  ApproveOrderRequest,
  DeliveryContact,
  EditOrderItemsRequest,
  NotificationRecipientKind,
  NotificationType,
  OrderDecisionWithCommentRequest,
  OrderDecisionWithReasonRequest,
  OrderEventType,
  PaymentMethod,
  ReleaseOrderRequest,
  SetPaymentMethodRequest,
  SetPaymentPlanRequest,
  StaffOrder,
  StaffOrderCountsQuery,
  StaffOrderCountsResponse,
  StaffOrderListQuery,
  StaffOrderStatusCount,
  StaffOrderSummary,
  StaffTimelineEvent,
  StaffTimelineResponse,
  UnitCodeKind,
  UnitCodeRule,
} from '@iorder/shared/staff-orders';
import type { ActivityKind } from '@/features/activity/api/activity-api';
import {
  FAKE_BACKOFFICE_MARKER,
  FAKE_CUSTOMER_COMMENTS,
  FAKE_MEMBERS,
  FAKE_ORDER_PRODUCTS,
  FAKE_ORDER_SEEDS,
  FAKE_ORGANIZATIONS,
  FAKE_STAFF,
  type FakeOrderSeed,
} from '@/features/directory/api/fake-backoffice-fixtures';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import {
  businessInstant,
  businessParts,
  isSameBusinessDay,
  shiftBusinessDays,
  systemClock,
  type Clock,
} from '@core/lib/business-clock';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { fakeOrderId, fakeUuid } from '@core/lib/fake-ids';
import {
  fromCents,
  microsToMoney,
  microsToUsdExact,
  toCents,
  usdToMicros,
  usdToUzs,
  uzsToUsd,
  uzsToUsdExact,
} from '@core/lib/money';
import { isSameQuantity, lineTotal } from '@core/lib/quantity';
import { FAKE_PRODUCT_SEEDS } from '@/features/pricing/api/fake-price-fixtures';
import { createFakeOrganizationBalance } from '@/features/staff-organizations/api/fake-organization-balance';
import type { OrganizationBalanceApi } from '@/features/staff-organizations/api/organization-balance-api';
import type { DriversApi } from './drivers-api';
import { createFakeAllocation, type FakeSupplyLine } from './fake-allocation';
import { createFakePicking, NO_CODE_RULE } from './fake-picking';
import type { StaffOrdersApi } from './staff-orders-api';

// In-memory stand-in for the staff order endpoints. It mirrors what the real server decides, not
// just the shapes: required row version (a stale one is 409 ORDER_CHANGED), a reason for every
// reject and cancel, skip-accounting only as an option of the manager's approve, no workflow
// steps for the admin, FULL or FULFILMENT views by role, no phones for the accountant, a visible
// scope per role (warehouse from ACCOUNTING_CLEARED on, driver only assigned orders), a payment
// method required on approval and seen by manager and accountant only, and a timeline per audience. Never part of a production bundle (check-bundle looks for its names).

const MINUTE = 60_000;
const FAKE_ORDER_USD_RATE = '12650.0000';
const NO_DEFERRED_PRODUCT_NO = 11;
const PRICE_LIST_VERSION_ID = fakeUuid('price-list-version:15');

export interface FakeStaffOrdersOptions {
  readonly latencyMs?: number;
  readonly clock?: Clock;
  /** Who is signed in. Read at call time. */
  readonly actor?: () => { readonly name: string; readonly roles: readonly StaffRole[] } | null;
  /** Read at call time, so the page can switch scenarios without recreating the fake. */
  readonly scenario?: () => FakeScenario;
  /** The home page's recent-actions feed. */
  readonly recordActivity?: (kind: ActivityKind, params: Record<string, string>) => void;
  /** The delivery lines of a product; the default gives every product two with plenty of room. */
  readonly supplyLines?: (productId: string) => readonly FakeSupplyLine[];
  /**
   * The product's CURRENT per-unit code rule by product code (the catalog fake owns it). Without
   * it every product is quantity goods and nothing has to be scanned.
   */
  readonly productRule?: (productCode: string) => UnitCodeRule;
  /**
   * Whether the product's stock is tracked, by product code (the catalog fake owns it): false for
   * a staff-added product without a sheet «Товар_ID», which is outside the allocation plan.
   * Without it every product is tracked.
   */
  readonly stockTracked?: (productCode: string) => boolean;
  /**
   * Adds one more order waiting for the warehouse with a phone (IMEI + marking), a TV (serial)
   * and a cable (nothing to scan), so the dev server can demo the picking screen. Off in tests:
   * the seeded order counts stay as they are.
   */
  readonly pickingDemo?: boolean;
}

export interface FakeStaffOrders {
  readonly ordersApi: StaffOrdersApi;
  readonly driversApi: DriversApi;
  /**
   * Organization debt and payments over these same orders: RECEIVED orders count, and their
   * PAID / UNPAID follows from the payments ([C] 2026-10-26).
   */
  readonly organizationBalanceApi: OrganizationBalanceApi;
  /**
   * Every order the signed-in role may see, as list summaries, read straight from the store (no
   * request): the fake dashboard summary counts from it, so its figures agree with the lists.
   */
  readonly visibleSummaries: () => StaffOrderSummary[];
  /**
   * What the CUSTOMER of an order sees of its history: no accounting mode or skip marker, no
   * drivers, no notification rows, staff as roles only and the names of colleagues of the same
   * organization. The customer app does not exist yet; this keeps the two audiences side by side
   * so the staff timeline can be tested against the customer one.
   */
  readonly customerTimeline: (orderId: string) => CustomerTimelineResponse;
}

interface Person {
  readonly userId: string;
  readonly fullName: string;
  readonly phone: string | null;
}

interface Item {
  id: string;
  productId: string;
  productCode: string;
  name: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  fullUnitPrice: string;
  deferredUnitPrice: string | null;
  /** False for a staff-added product (no sheet «Товар_ID»): outside the allocation plan. */
  stockTracked: boolean;
}

interface Notification {
  id: string;
  type: NotificationType;
  recipientKind: NotificationRecipientKind;
  recipientRole: StaffRole | null;
  recipientUserId: string | null;
  recipientName: string | null;
  createdAt: string;
}

interface EventRecord {
  id: string;
  type: OrderEventType;
  occurredAt: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actorUserId: string | null;
  actorRole: OrderActorRole;
  actorName: string | null;
  comment: string | null;
  accountingMode: { from: AccountingMode | null; to: AccountingMode } | null;
  driverId: string | null;
  itemsChange: {
    oldTotal: string;
    newTotal: string;
    lines: {
      productCode: string;
      name: string;
      oldQuantity: string;
      newQuantity: string | null;
      oldLineTotal: string;
      newLineTotal: string | null;
    }[];
  } | null;
  paymentChange: { from: PaymentStatus; to: PaymentStatus } | null;
  paymentPlanChange: PaymentPlanChange | null;
  paymentMethodChange: { from: PaymentMethod | null; to: PaymentMethod } | null;
  notifications: Notification[];
}

interface OrderRecord {
  id: string;
  orderNumber: string;
  organizationId: string;
  organizationSource: string;
  placedBySource: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /** Null until the manager approves. */
  paymentMethod: PaymentMethod | null;
  paymentPlan: PaymentPlan;
  /** Frozen when the order was placed, like the server's `orders.usd_rate`. */
  usdRate: string;
  rowVersion: number;
  submittedAt: string;
  updatedAt: string;
  customerComment: string | null;
  managerApprovedAt: string | null;
  goodsReturnedAt: string | null;
  goodsReturnedBy: string | null;
  accountingMode: AccountingMode;
  clearedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  driverId: string | null;
  items: Item[];
  events: EventRecord[];
}

type Viewer = { readonly name: string; readonly roles: readonly StaffRole[] };

const FULL_ROLES: readonly StaffRole[] = ['MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'];
/** Who gets phone numbers: the accountant never does (manager question 28). */
const CONTACT_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ADMIN',
  'WAREHOUSE_MANAGER',
  'DRIVER',
  'PURCHASING_MANAGER',
];
/** Who sees the payment method ([C] 2026-10-24): not the admin, not the warehouse or the driver. */
const PAYMENT_METHOD_ROLES: readonly StaffRole[] = ['MANAGER', 'ACCOUNTANT', 'PURCHASING_MANAGER'];
/** Where the manager may change the payment method (the api's list). */
const CHANGEABLE_METHOD_STATUSES: readonly OrderStatus[] = [
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
];
const hasAny = (viewer: Viewer, roles: readonly StaffRole[]): boolean =>
  viewer.roles.some((role) => roles.includes(role));

const validation = (path: string, message: string): ApiValidationError =>
  new ApiValidationError('Request validation failed', 'VALIDATION_FAILED', [{ path, message }]);

const changed = (currentStatus: OrderStatus): ApiConflictError =>
  new ApiConflictError(
    'The order was changed by someone else',
    'CONFLICT',
    { currentStatus },
    'ORDER_CHANGED',
  );

interface Rule {
  from: OrderStatus;
  to: OrderStatus;
  roles: readonly StaffRole[];
  reasonRequired: boolean;
}

// The staff-made moves of the lifecycle table (docs/domain/order-lifecycle.md section 3).
const RULES: readonly Rule[] = [
  { from: 'SUBMITTED', to: 'MANAGER_APPROVED', roles: ['MANAGER'], reasonRequired: false },
  { from: 'SUBMITTED', to: 'REJECTED', roles: ['MANAGER'], reasonRequired: true },
  { from: 'SUBMITTED', to: 'CANCELLED', roles: ['MANAGER'], reasonRequired: true },
  {
    from: 'MANAGER_APPROVED',
    to: 'ACCOUNTING_CLEARED',
    roles: ['ACCOUNTANT'],
    reasonRequired: false,
  },
  { from: 'MANAGER_APPROVED', to: 'REJECTED', roles: ['ACCOUNTANT'], reasonRequired: true },
  { from: 'MANAGER_APPROVED', to: 'CANCELLED', roles: ['MANAGER'], reasonRequired: true },
  {
    from: 'ACCOUNTING_CLEARED',
    to: 'RELEASED',
    roles: ['WAREHOUSE_MANAGER'],
    reasonRequired: false,
  },
  {
    from: 'ACCOUNTING_CLEARED',
    to: 'CANCELLED',
    roles: ['MANAGER'],
    reasonRequired: true,
  },
  { from: 'RELEASED', to: 'DELIVERED', roles: ['DRIVER'], reasonRequired: false },
];

/**
 * The payment method of the seeded approved orders (kept here, not in the directory fixtures: only
 * the staff-orders feature may use the staff contract). Missing approved seeds get CASH.
 */
const SEED_PAYMENT_METHODS: Readonly<
  Record<string, { chosen: PaymentMethod; changedTo?: PaymentMethod }>
> = {
  'IO-10489': { chosen: 'OFFICIAL' },
  'IO-10486': { chosen: 'CASH', changedTo: 'OFFICIAL' },
  'IO-10484': { chosen: 'CASH' },
  'IO-10488': { chosen: 'OFFICIAL' },
  'IO-10480': { chosen: 'CASH' },
  'IO-10477': { chosen: 'OFFICIAL' },
};

/** Who reads the unit codes (VIEW_UNIT_CODES): not the driver. */
const CODE_VIEW_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ACCOUNTANT',
  'ADMIN',
  'WAREHOUSE_MANAGER',
  'PURCHASING_MANAGER',
];

/** The dev-only picking demo order (see `pickingDemo`); product numbers of FAKE_ORDER_PRODUCTS. */
function pickingDemoSeed(template: FakeOrderSeed | undefined): FakeOrderSeed | null {
  if (!template) return null;
  return {
    id: 'IO-10500',
    organizationId: template.organizationId,
    placedBy: template.placedBy,
    lines: [
      [1, 2],
      [17, 1],
      [10, 3],
    ],
    paymentStatus: 'UNPAID',
    status: 'ACCOUNTING_CLEARED',
    daysAgo: 0,
    time: '08:40',
  };
}

const ORDER_STAGES: readonly OrderStatus[] = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
];

export function createFakeStaffOrders(options: FakeStaffOrdersOptions = {}): FakeStaffOrders {
  const clock = options.clock ?? systemClock;
  const latencyMs = options.latencyMs ?? 0;
  let counter = 0;
  const nextId = (kind: string): string => fakeUuid(`${kind}:${(counter += 1)}`);

  const staffById = new Map(FAKE_STAFF.map((s) => [s.id, s]));
  const memberBySource = new Map(FAKE_MEMBERS.map((m) => [m.id, m]));
  const orgBySource = new Map(FAKE_ORGANIZATIONS.map((o) => [o.id, o]));
  const orders = new Map<string, OrderRecord>();
  const picking = createFakePicking({
    rule: options.productRule ?? (() => NO_CODE_RULE),
    allocationsOf: (orderId, item) => allocation.allocationsOf(orderId, item),
    now: () => clock.now(),
    nextId,
  });

  // Two deliveries per product, or what a test asks for.
  const allocation = createFakeAllocation(
    (productId): readonly FakeSupplyLine[] =>
      options.supplyLines?.(productId) ?? [
        {
          id: fakeUuid(`line:old:${productId}`),
          productId,
          deliveryRef: `SP-${productId.slice(-4)}-1`,
          deliveredAt: '2026-09-01T06:00:00.000Z',
          available: 30_000n,
          removed: false,
        },
        {
          id: fakeUuid(`line:new:${productId}`),
          productId,
          deliveryRef: `SP-${productId.slice(-4)}-2`,
          deliveredAt: '2026-10-01T06:00:00.000Z',
          available: 500_000n,
          removed: false,
        },
      ],
  );

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  // Reads honour the dev scenario (`?state=`); writes always behave normally.
  async function beforeRead(): Promise<'empty' | null> {
    const current = options.scenario?.() ?? 'ready';
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_BACKOFFICE_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  function viewer(): Viewer {
    const who = options.actor?.();
    if (!who) throw new PermissionDeniedError();
    return who;
  }

  // --- people ------------------------------------------------------------------------------------

  function staffPerson(userId: string, withPhones: boolean): Person | null {
    const staff = staffById.get(userId);
    return staff ? { userId, fullName: staff.name, phone: withPhones ? staff.phone : null } : null;
  }

  function memberPerson(source: string, withPhones: boolean): Person {
    const member = memberBySource.get(source);
    return {
      userId: source,
      fullName: member?.name ?? '',
      phone: withPhones ? (member?.phone ?? null) : null,
    };
  }

  function deliveryContact(order: OrderRecord, withPhones: boolean): DeliveryContact {
    const org = orgBySource.get(order.organizationSource);
    const owners = FAKE_MEMBERS.filter(
      (m) => m.organizationId === order.organizationSource && m.role === 'SHOP_OWNER' && m.isActive,
    );
    const sources = [...new Set([order.placedBySource, ...owners.map((m) => m.id)])];
    return {
      organizationName: org?.name ?? '',
      contacts: sources.map((source) => {
        const person = memberPerson(source, withPhones);
        return {
          userId: person.userId,
          fullName: person.fullName,
          phone: person.phone,
          placedTheOrder: source === order.placedBySource,
          isShopOwner: memberBySource.get(source)?.role === 'SHOP_OWNER',
        };
      }),
    };
  }

  // --- seeding -----------------------------------------------------------------------------------

  function wallTime(daysAgo: number, time: string): number {
    const [hour = '0', minute = '0'] = time.split(':');
    const day = businessParts(shiftBusinessDays(clock.now(), daysAgo));
    return businessInstant(day, Number(hour), Number(minute)).getTime();
  }

  const totalOfItems = (items: readonly Item[]): string =>
    fromCents(items.reduce((sum, i) => sum + toCents(lineTotal(i.unitPrice, i.quantity)), 0n));

  function recipients(
    order: OrderRecord,
    type: NotificationType,
    at: string,
    targets: readonly ('MANAGERS' | 'ACCOUNTANTS' | 'WAREHOUSE' | 'DRIVER' | 'CUSTOMER')[],
    driverId: string | null,
  ): Notification[] {
    return targets.map((target): Notification => {
      const base = { id: nextId('notification'), type, createdAt: at };
      const role = (r: StaffRole): Notification => ({
        ...base,
        recipientKind: 'ROLE',
        recipientRole: r,
        recipientUserId: null,
        recipientName: null,
      });
      switch (target) {
        case 'MANAGERS':
          return role('MANAGER');
        case 'ACCOUNTANTS':
          return role('ACCOUNTANT');
        case 'WAREHOUSE':
          return role('WAREHOUSE_MANAGER');
        case 'DRIVER':
          return {
            ...base,
            recipientKind: 'USER',
            recipientRole: null,
            recipientUserId: driverId,
            recipientName: (driverId && staffById.get(driverId)?.name) || null,
          };
        case 'CUSTOMER':
          return {
            ...base,
            recipientKind: 'ORGANIZATION_CHAT',
            recipientRole: null,
            recipientUserId: null,
            recipientName: orgBySource.get(order.organizationSource)?.name ?? null,
          };
      }
    });
  }

  function addEvent(
    order: OrderRecord,
    at: number,
    event: Partial<EventRecord> & {
      type: OrderEventType;
      actorRole: OrderActorRole;
      notify?: readonly ('MANAGERS' | 'ACCOUNTANTS' | 'WAREHOUSE' | 'DRIVER' | 'CUSTOMER')[];
      notificationType?: NotificationType;
    },
  ): EventRecord {
    const { notify = [], notificationType, ...rest } = event;
    const iso = new Date(at).toISOString();
    const record: EventRecord = {
      id: nextId('event'),
      occurredAt: iso,
      fromStatus: null,
      toStatus: null,
      actorUserId: null,
      actorName: null,
      comment: null,
      accountingMode: null,
      driverId: null,
      itemsChange: null,
      paymentChange: null,
      paymentMethodChange: null,
      paymentPlanChange: null,
      notifications: [],
      ...rest,
    };
    if (notificationType && notify.length > 0) {
      record.notifications = recipients(order, notificationType, iso, notify, record.driverId);
    }
    order.events.push(record);
    return record;
  }

  const SEED_MANAGER = FAKE_STAFF.find(
    (s) => s.roles.includes('MANAGER') && s.name === 'Aziza Yusupova',
  );
  const seedStaff = (role: StaffRole): { id: string; name: string } => {
    const found = FAKE_STAFF.find((s) => s.roles.includes(role) && s.isActive);
    return { id: found?.id ?? '', name: found?.name ?? '' };
  };

  const demoSeed = options.pickingDemo
    ? pickingDemoSeed(FAKE_ORDER_SEEDS.find((s) => s.status === 'ACCOUNTING_CLEARED'))
    : null;
  for (const seed of demoSeed ? [...FAKE_ORDER_SEEDS, demoSeed] : FAKE_ORDER_SEEDS) {
    const member = memberBySource.get(seed.placedBy);
    const seedMethod = SEED_PAYMENT_METHODS[seed.id];
    const created = wallTime(seed.daysAgo, seed.time);
    const reached = ORDER_STAGES.indexOf(seed.status);
    const order: OrderRecord = {
      id: fakeOrderId(seed.id),
      orderNumber: seed.id,
      organizationId: seed.organizationId,
      organizationSource: seed.organizationId,
      placedBySource: seed.placedBy,
      status: seed.status,
      paymentStatus: seed.paymentStatus,
      paymentMethod: null,
      paymentPlan: 'FULL',
      usdRate: FAKE_ORDER_USD_RATE,
      rowVersion: 1,
      submittedAt: new Date(created).toISOString(),
      updatedAt: new Date(created).toISOString(),
      customerComment: FAKE_CUSTOMER_COMMENTS[seed.id] ?? null,
      accountingMode: 'PENDING',
      managerApprovedAt: reached >= 1 ? new Date(created).toISOString() : null,
      goodsReturnedAt: null,
      goodsReturnedBy: null,
      clearedAt: null,
      reviewedAt: null,
      reviewedByUserId: null,
      driverId: null,
      items: seed.lines.map(([productNo, quantity]) => {
        const product = FAKE_ORDER_PRODUCTS[productNo] ?? ['', '0.00'];
        // The same code the price list and the sheet use (the «Товар_ID»), not an own scheme (F-16).
        const productCode =
          FAKE_PRODUCT_SEEDS.find((p) => p.names.UZ === product[0])?.productCode ??
          String(productNo);
        return {
          id: nextId('item'),
          productId: fakeUuid(`product:${productCode}`),
          productCode,
          name: product[0],
          unit: 'dona',
          quantity: String(quantity),
          unitPrice: product[1],
          fullUnitPrice: product[1],
          // The silicone case has no pay-in-parts price, so the demo also shows that case.
          deferredUnitPrice:
            productNo === NO_DEFERRED_PRODUCT_NO
              ? null
              : fromCents((toCents(product[1]) * 11n) / 10n),
          stockTracked: options.stockTracked?.(productCode) ?? true,
        };
      }),
      events: [],
    };
    const customerRole: OrderActorRole = member?.role ?? 'SELLER';
    const customer = { actorUserId: seed.placedBy, actorName: member?.name ?? null };
    const manager = { id: SEED_MANAGER?.id ?? null, name: SEED_MANAGER?.name ?? null };

    addEvent(order, created, {
      type: 'SUBMITTED',
      actorRole: customerRole,
      toStatus: 'SUBMITTED',
      ...customer,
      notify: ['MANAGERS'],
      notificationType: 'ORDER_SUBMITTED',
    });
    if (reached >= 1) {
      order.rowVersion += 1;
      // Every approved order has a method; the seeds name it, CASH covers one that does not.
      const chosen = seedMethod?.chosen ?? 'CASH';
      order.paymentMethod = seedMethod?.changedTo ?? chosen;
      addEvent(order, created + 12 * MINUTE, {
        type: 'STATUS_CHANGED',
        actorRole: 'MANAGER',
        fromStatus: 'SUBMITTED',
        toStatus: 'MANAGER_APPROVED',
        actorUserId: manager.id,
        actorName: manager.name,
        paymentMethodChange: { from: null, to: chosen },
        notify: ['ACCOUNTANTS', 'CUSTOMER'],
        notificationType: 'ORDER_MANAGER_APPROVED',
      });
    }
    if (reached >= 2) {
      const skipped = seed.skipAccounting === true;
      const accountant = seedStaff('ACCOUNTANT');
      const at = created + (skipped ? 12 : 50) * MINUTE;
      order.accountingMode = skipped ? 'SKIPPED_BY_MANAGER' : 'APPROVED';
      order.clearedAt = new Date(at).toISOString();
      if (!skipped) {
        order.reviewedAt = order.clearedAt;
        order.reviewedByUserId = accountant.id;
      }
      addEvent(order, at, {
        type: skipped ? 'ACCOUNTING_SKIPPED' : 'STATUS_CHANGED',
        actorRole: skipped ? 'MANAGER' : 'ACCOUNTANT',
        fromStatus: 'MANAGER_APPROVED',
        toStatus: 'ACCOUNTING_CLEARED',
        actorUserId: skipped ? manager.id : accountant.id,
        actorName: skipped ? manager.name : accountant.name,
        accountingMode: { from: 'PENDING', to: order.accountingMode },
        notify: ['WAREHOUSE', 'CUSTOMER'],
        notificationType: 'ORDER_ACCOUNTING_CLEARED',
      });
    }
    if (reached >= 3) {
      const warehouse = seedStaff('WAREHOUSE_MANAGER');
      order.driverId = fakeUuid('s-06');
      addEvent(order, created + 3 * 60 * MINUTE, {
        type: 'STATUS_CHANGED',
        actorRole: 'WAREHOUSE_MANAGER',
        fromStatus: 'ACCOUNTING_CLEARED',
        toStatus: 'RELEASED',
        actorUserId: warehouse.id,
        actorName: warehouse.name,
        driverId: order.driverId,
        notify: ['DRIVER', 'CUSTOMER'],
        notificationType: 'ORDER_RELEASED',
      });
    }
    if (reached >= 4) {
      addEvent(order, created + 6 * 60 * MINUTE, {
        type: 'STATUS_CHANGED',
        actorRole: 'DRIVER',
        fromStatus: 'RELEASED',
        toStatus: 'DELIVERED',
        actorUserId: order.driverId,
        actorName: (order.driverId && staffById.get(order.driverId)?.name) || null,
        notify: ['CUSTOMER'],
        notificationType: 'ORDER_DELIVERED',
      });
    }
    if (reached >= 5) {
      addEvent(order, created + 24 * 60 * MINUTE, {
        type: 'STATUS_CHANGED',
        actorRole: customerRole,
        fromStatus: 'DELIVERED',
        toStatus: 'RECEIVED',
        ...customer,
        notify: ['MANAGERS'],
        notificationType: 'ORDER_RECEIVED',
      });
    }
    if (reached >= 1 && seedMethod?.changedTo !== undefined) {
      addEvent(order, created + 20 * MINUTE, {
        type: 'PAYMENT_METHOD_CHANGED',
        actorRole: 'MANAGER',
        actorUserId: manager.id,
        actorName: manager.name,
        paymentMethodChange: {
          from: seedMethod?.chosen ?? 'CASH',
          to: seedMethod?.changedTo,
        },
      });
    }
    if (seed.paymentStatus === 'PAID') {
      const last = order.events[order.events.length - 1];
      addEvent(order, Date.parse(last?.occurredAt ?? order.submittedAt) + 30 * MINUTE, {
        type: 'PAYMENT_STATUS_CHANGED',
        actorRole: 'MANAGER',
        actorUserId: manager.id,
        actorName: manager.name,
        paymentChange: { from: 'UNPAID', to: 'PAID' },
      });
    }
    const lastEvent = order.events[order.events.length - 1];
    order.updatedAt = lastEvent?.occurredAt ?? order.submittedAt;
    if (reached >= 1) {
      picking.createUnits(order);
      // One demo order stays as approved before holds existed ("Not allocated").
      if (order.orderNumber !== 'IO-10489') allocation.seed(order);
    }
    if (reached >= 2) {
      // Orders that already left the warehouse were picked: their codes are there.
      if (reached >= 3) picking.fillDemoCodes(order);
    }
    orders.set(order.id, order);
  }

  // --- views ---------------------------------------------------------------------------------------

  function summaryOf(order: OrderRecord, who: Viewer): StaffOrderSummary {
    const withPhones = hasAny(who, CONTACT_ROLES);
    const base = {
      id: order.id,
      orderNumber: order.orderNumber,
      organizationId: order.organizationId,
      organizationName: orgBySource.get(order.organizationSource)?.name ?? '',
      status: order.status,
      itemCount: order.items.length,
      submittedAt: order.submittedAt,
      updatedAt: order.updatedAt,
      rowVersion: order.rowVersion,
      driver: order.driverId ? staffPerson(order.driverId, withPhones) : null,
      goodsReturn: goodsReturnOf(order),
      goodsReturnedAt: order.goodsReturnedBy === null ? null : order.goodsReturnedAt,
    };
    if (!hasAny(who, FULL_ROLES)) return { ...base, detail: 'FULFILMENT' };
    return {
      ...base,
      detail: 'FULL',
      paymentStatus: order.paymentStatus,
      paymentPlan: order.paymentPlan,
      totalAmount: totalOfItems(order.items),
      currency: 'UZS',
      usdRate: order.usdRate,
      totalUsd: uzsToUsd(totalOfItems(order.items), order.usdRate),
      customerComment: order.customerComment,
      placedBy: memberPerson(order.placedBySource, withPhones),
      priceListVersionId: PRICE_LIST_VERSION_ID,
      accounting: {
        mode: order.accountingMode,
        clearedAt: order.clearedAt,
        reviewedAt: order.reviewedAt,
        reviewedByUserId: order.reviewedByUserId,
      },
      // Left out entirely for the admin (the contract's "absent"), not sent as null.
      ...(hasAny(who, PAYMENT_METHOD_ROLES) ? { paymentMethod: order.paymentMethod } : {}),
    };
  }

  function orderView(order: OrderRecord, who: Viewer): StaffOrder {
    const summary = summaryOf(order, who);
    const withPhones = hasAny(who, CONTACT_ROLES);
    if (summary.detail === 'FULFILMENT') {
      return {
        ...summary,
        items: order.items.map(
          ({ id, productId, productCode, name, unit, quantity, stockTracked }) => ({
            id,
            productId,
            productCode,
            name,
            unit,
            quantity,
            stockTracked,
            // As the api: the driver's lines do not have the field.
            ...(hasAny(who, ['DRIVER'])
              ? {}
              : { allocations: allocation.allocationsOf(order.id, { id, productId }) }),
          }),
        ),
        deliveryContact: deliveryContact(order, withPhones),
      };
    }
    return {
      ...summary,
      items: order.items.map((item) => ({
        ...item,
        lineTotal: lineTotal(item.unitPrice, item.quantity),
        allocations: allocation.allocationsOf(order.id, item),
      })),
      deliveryContact: withPhones ? deliveryContact(order, withPhones) : null,
    };
  }

  /** As the api's goodsReturnStateOf. A time without a person: closed before the rule existed. */
  function goodsReturnOf(order: OrderRecord): GoodsReturnState {
    const closed = order.status === 'REJECTED' || order.status === 'CANCELLED';
    if (!closed || order.managerApprovedAt === null) return 'NOT_NEEDED';
    if (order.goodsReturnedBy !== null) return 'RETURNED';
    return order.goodsReturnedAt === null ? 'PENDING' : 'NOT_NEEDED';
  }

  /** The orders a role may see (the lifecycle's visibility row). */
  function mayView(order: OrderRecord, who: Viewer): boolean {
    if (hasAny(who, FULL_ROLES)) return true;
    if (who.roles.includes('WAREHOUSE_MANAGER')) return order.managerApprovedAt !== null;
    if (who.roles.includes('DRIVER')) {
      const me = FAKE_STAFF.find((s) => s.name === who.name);
      return me !== undefined && order.driverId === me.id;
    }
    return false;
  }

  function requireVisible(orderId: string, who: Viewer): OrderRecord {
    const order = orders.get(orderId);
    if (!order || !mayView(order, who)) throw new ApiNotFoundError('Order not found', 'NOT_FOUND');
    return order;
  }

  /** An edit as the timeline shows it; the money is left out for audiences that see no prices. */
  function itemsChangeView(change: NonNullable<EventRecord['itemsChange']>, withMoney: boolean) {
    return {
      oldTotal: withMoney ? change.oldTotal : null,
      newTotal: withMoney ? change.newTotal : null,
      lines: change.lines.map((line) => ({
        productCode: line.productCode,
        name: line.name,
        change: line.newQuantity === null ? ('REMOVED' as const) : ('QUANTITY_CHANGED' as const),
        oldQuantity: line.oldQuantity,
        newQuantity: line.newQuantity,
        oldLineTotal: withMoney ? line.oldLineTotal : null,
        newLineTotal: withMoney ? line.newLineTotal : null,
      })),
    };
  }

  function timelineOf(order: OrderRecord, who: Viewer): StaffTimelineResponse {
    const full = hasAny(who, FULL_ROLES);
    const withPhones = hasAny(who, CONTACT_ROLES);
    const seesMethod = hasAny(who, PAYMENT_METHOD_ROLES);
    const visible: readonly OrderEventType[] = full
      ? [
          'SUBMITTED',
          'STATUS_CHANGED',
          'ACCOUNTING_SKIPPED',
          'ITEMS_EDITED',
          'PAYMENT_STATUS_CHANGED',
          'PAYMENT_PLAN_CHANGED',
          'ALLOCATION_CHANGED',
          'GOODS_RETURNED',
          ...(seesMethod ? (['PAYMENT_METHOD_CHANGED'] as const) : []),
        ]
      : ['SUBMITTED', 'STATUS_CHANGED', 'ACCOUNTING_SKIPPED', 'ITEMS_EDITED', 'GOODS_RETURNED'];
    const events = order.events
      .filter((e) => visible.includes(e.type))
      .map((e): StaffTimelineEvent => {
        const foldedSkip = e.type === 'ACCOUNTING_SKIPPED' && !full;
        const commentVisible =
          full ||
          e.type === 'GOODS_RETURNED' ||
          (e.toStatus !== null &&
            ['RELEASED', 'DELIVERED', 'CANCELLED', 'REJECTED'].includes(e.toStatus));
        return {
          id: e.id,
          type: foldedSkip ? 'STATUS_CHANGED' : e.type,
          occurredAt: e.occurredAt,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actor: full
            ? { userId: e.actorUserId, role: e.actorRole, name: e.actorName }
            : { userId: null, role: e.actorRole, name: null },
          comment: commentVisible ? e.comment : null,
          accountingMode: full ? e.accountingMode : null,
          driver: e.driverId ? staffPerson(e.driverId, withPhones) : null,
          itemsChange: e.itemsChange ? itemsChangeView(e.itemsChange, full) : null,
          paymentChange: e.paymentChange,
          paymentMethodChange: seesMethod ? e.paymentMethodChange : null,
          paymentPlanChange: full ? e.paymentPlanChange : null,
          notifications: full
            ? e.notifications.map((n) => ({
                ...n,
                status: 'SENT' as const,
                attempts: 1,
                sentAt: new Date(Date.parse(n.createdAt) + 2_000).toISOString(),
              }))
            : [],
        };
      });
    return { orderId: order.id, detail: full ? 'FULL' : 'FULFILMENT', events };
  }

  function customerTimelineOf(order: OrderRecord): CustomerTimelineResponse {
    const visible: readonly OrderEventType[] = [
      'SUBMITTED',
      'STATUS_CHANGED',
      'ACCOUNTING_SKIPPED',
      'ITEMS_EDITED',
      'PAYMENT_STATUS_CHANGED',
      'PAYMENT_PLAN_CHANGED',
    ];
    const events = order.events
      .filter((e) => visible.includes(e.type))
      .map((e) => {
        // A skipped accounting step is shown as the manager's own plain status move.
        const foldedSkip = e.type === 'ACCOUNTING_SKIPPED';
        const role: OrderActorRole = foldedSkip ? 'MANAGER' : e.actorRole;
        const isColleague = (ORGANIZATION_ROLES as readonly string[]).includes(role);
        const reasonShown =
          e.toStatus === 'REJECTED' ||
          e.toStatus === 'CANCELLED' ||
          e.type === 'ITEMS_EDITED' ||
          e.type === 'PAYMENT_PLAN_CHANGED' ||
          isColleague;
        return {
          id: e.id,
          type: foldedSkip
            ? ('STATUS_CHANGED' as const)
            : (e.type as
                | 'SUBMITTED'
                | 'STATUS_CHANGED'
                | 'ITEMS_EDITED'
                | 'PAYMENT_STATUS_CHANGED'
                | 'PAYMENT_PLAN_CHANGED'),
          occurredAt: e.occurredAt,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actor: { role, name: isColleague ? e.actorName : null },
          comment: reasonShown ? e.comment : null,
          itemsChange: e.itemsChange ? itemsChangeView(e.itemsChange, true) : null,
          paymentChange: e.paymentChange,
          paymentPlanChange: e.paymentPlanChange,
          customerNotified: e.notifications.some((n) => n.recipientKind === 'ORGANIZATION_CHAT'),
        };
      });
    return { orderId: order.id, events };
  }

  // --- commands ------------------------------------------------------------------------------------

  /** The coarse gate of the controller: a wrong role is 403 before anything else is looked at. */
  function gate(roles: readonly StaffRole[]): Viewer {
    const who = viewer();
    if (!hasAny(who, roles)) throw new PermissionDeniedError();
    return who;
  }

  function actorOf(who: Viewer): { userId: string | null; name: string } {
    const staff = FAKE_STAFF.find((s) => s.name === who.name);
    return { userId: staff?.id ?? null, name: who.name };
  }

  function checkVersion(order: OrderRecord, expectedRowVersion: number): void {
    if (expectedRowVersion !== order.rowVersion) throw changed(order.status);
  }

  interface MoveInput {
    to: OrderStatus;
    roles: readonly StaffRole[];
    expectedRowVersion: number;
    reason?: string | undefined;
    comment?: string | undefined;
    skipAccounting?: boolean;
    paymentMethod?: PaymentMethod;
    plan?: { allocationMode: AllocationMode; allocations: readonly AllocationRequestRow[] };
    driverUserId?: string;
    orderId: string;
  }

  function assertAllocationReadable(order: OrderRecord, allowed: readonly OrderStatus[]): void {
    if (!allowed.includes(order.status)) {
      throw new ApiConflictError(
        'Stock cannot be held for this order',
        'CONFLICT',
        { currentStatus: order.status },
        'ALLOCATION_NOT_CHANGEABLE',
      );
    }
  }

  function move(input: MoveInput): StaffOrder {
    const who = gate(input.roles);
    const order = requireVisible(input.orderId, who);
    checkVersion(order, input.expectedRowVersion);
    const rule = RULES.find((r) => r.from === order.status && r.to === input.to);
    if (!rule) {
      // Someone got there first: the order already is at the wanted stage, or beyond it.
      const reached = ORDER_STAGES.indexOf(order.status);
      const target = ORDER_STAGES.indexOf(input.to);
      if (reached !== -1 && target !== -1 && reached >= target) throw changed(order.status);
      throw new ApiConflictError(
        `An order cannot move from ${order.status} to ${input.to}`,
        'CONFLICT',
        { from: order.status, to: input.to },
        'ILLEGAL_ORDER_TRANSITION',
      );
    }
    const actingRole = rule.roles.find((r) => who.roles.includes(r));
    if (!actingRole) throw new PermissionDeniedError();
    const reason = (input.reason ?? input.comment ?? '').trim();
    if (rule.reasonRequired && reason === '') throw validation('reason', 'A reason is required');
    if (input.to === 'MANAGER_APPROVED' && input.paymentMethod === undefined) {
      throw validation('paymentMethod', 'A payment method is required');
    }
    if (input.to === 'MANAGER_APPROVED') {
      if (input.plan === undefined) throw validation('allocations', 'A plan is required');
      allocation.store(
        order.id,
        allocation.judge(order, input.plan.allocationMode, input.plan.allocations),
      );
    }
    if (input.to === 'RELEASED' || input.to === 'REJECTED' || input.to === 'CANCELLED') {
      allocation.end(order.id);
    }
    let driverId: string | null = null;
    if (input.to === 'RELEASED') {
      const driver = staffById.get(input.driverUserId ?? '');
      if (!driver || !driver.isActive || !driver.roles.includes('DRIVER')) {
        throw validation('driverUserId', 'The driver must be an active user with the driver role');
      }
      driverId = input.driverUserId ?? null;
      // The release gate: every code the products' current rules ask for must be scanned.
      const incomplete = picking.incomplete(order);
      if (incomplete.length > 0) {
        throw new ApiConflictError(
          'Unit codes are missing',
          'CONFLICT',
          { items: incomplete },
          'UNIT_CODES_INCOMPLETE',
        );
      }
    }

    const now = clock.now().getTime();
    const person = actorOf(who);
    const from = order.status;
    const withReason = reason === '' ? null : reason;
    const skip = input.skipAccounting === true && input.to === 'MANAGER_APPROVED';
    order.rowVersion += 1;
    order.updatedAt = new Date(now).toISOString();

    const base = { actorRole: actingRole, actorUserId: person.userId, actorName: person.name };
    switch (input.to) {
      case 'MANAGER_APPROVED': {
        order.status = 'MANAGER_APPROVED';
        order.managerApprovedAt = new Date(now).toISOString();
        order.paymentMethod = input.paymentMethod ?? null;
        picking.createUnits(order);
        const approved = addEvent(order, now, {
          ...base,
          type: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: 'MANAGER_APPROVED',
          comment: withReason,
          paymentMethodChange: input.paymentMethod ? { from: null, to: input.paymentMethod } : null,
          notify: ['ACCOUNTANTS', 'CUSTOMER'],
          notificationType: 'ORDER_MANAGER_APPROVED',
        });
        // As the server: a skip gets one warehouse message, "ready", from the clearing step below.
        if (!skip) {
          approved.notifications.push(
            ...recipients(
              order,
              'ORDER_READY_TO_PREPARE',
              approved.occurredAt,
              ['WAREHOUSE'],
              null,
            ),
          );
        }
        if (skip) {
          // One transaction, two steps: the skip is recorded as its own event (lifecycle 3.1).
          order.status = 'ACCOUNTING_CLEARED';
          order.accountingMode = 'SKIPPED_BY_MANAGER';
          order.clearedAt = new Date(now).toISOString();
          addEvent(order, now, {
            ...base,
            type: 'ACCOUNTING_SKIPPED',
            fromStatus: 'MANAGER_APPROVED',
            toStatus: 'ACCOUNTING_CLEARED',
            accountingMode: { from: 'PENDING', to: 'SKIPPED_BY_MANAGER' },
            notify: ['WAREHOUSE', 'CUSTOMER'],
            notificationType: 'ORDER_ACCOUNTING_CLEARED',
          });
          picking.createUnits(order);
        }
        options.recordActivity?.(skip ? 'ORDER_APPROVED_SKIP_ACCOUNTING' : 'ORDER_APPROVED', {
          orderId: order.orderNumber,
        });
        break;
      }
      case 'ACCOUNTING_CLEARED':
        order.status = 'ACCOUNTING_CLEARED';
        order.accountingMode = 'APPROVED';
        order.clearedAt = new Date(now).toISOString();
        order.reviewedAt = order.clearedAt;
        order.reviewedByUserId = person.userId;
        addEvent(order, now, {
          ...base,
          type: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: 'ACCOUNTING_CLEARED',
          comment: withReason,
          accountingMode: { from: 'PENDING', to: 'APPROVED' },
          notify: ['WAREHOUSE', 'CUSTOMER'],
          notificationType: 'ORDER_ACCOUNTING_CLEARED',
        });
        picking.createUnits(order);
        break;
      case 'REJECTED':
      case 'CANCELLED': {
        order.status = input.to;
        picking.voidCodes(order.id);
        const type: NotificationType =
          input.to === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER_CANCELLED';
        const targets =
          input.to === 'REJECTED'
            ? from === 'MANAGER_APPROVED'
              ? (['MANAGERS', 'WAREHOUSE', 'CUSTOMER'] as const)
              : (['CUSTOMER'] as const)
            : from === 'MANAGER_APPROVED'
              ? (['ACCOUNTANTS', 'WAREHOUSE', 'CUSTOMER'] as const)
              : from === 'ACCOUNTING_CLEARED'
                ? (['WAREHOUSE', 'CUSTOMER'] as const)
                : (['CUSTOMER'] as const);
        addEvent(order, now, {
          ...base,
          type: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: input.to,
          comment: withReason,
          notify: targets,
          notificationType: type,
        });
        options.recordActivity?.(input.to === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER_CANCELLED', {
          orderId: order.orderNumber,
          reason: reason,
        });
        break;
      }
      case 'RELEASED':
        order.status = 'RELEASED';
        order.driverId = driverId;
        addEvent(order, now, {
          ...base,
          type: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: 'RELEASED',
          comment: withReason,
          driverId,
          notify: ['DRIVER', 'CUSTOMER'],
          notificationType: 'ORDER_RELEASED',
        });
        options.recordActivity?.('ORDER_RELEASED', {
          orderId: order.orderNumber,
          driver: (driverId && staffById.get(driverId)?.name) || '',
        });
        break;
      case 'DELIVERED':
        order.status = 'DELIVERED';
        addEvent(order, now, {
          ...base,
          type: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: 'DELIVERED',
          comment: withReason,
          notify: ['CUSTOMER'],
          notificationType: 'ORDER_DELIVERED',
        });
        break;
      case 'SUBMITTED':
      case 'RECEIVED':
        break;
    }
    return orderView(order, who);
  }

  // The server's staff filters: scope, payment status (FULL roles only), organization, the
  // business day, and a search over the number, the organization and (FULL roles) the placer.
  function matching(
    query: Omit<StaffOrderCountsQuery, 'statuses' | 'groupBy'>,
    who: Viewer,
  ): OrderRecord[] {
    const full = hasAny(who, FULL_ROLES);
    if ((query.paymentStatus || query.placedByUserId) && !full) throw new PermissionDeniedError();
    const needle = query.search?.toLowerCase();
    const now = clock.now();
    return [...orders.values()]
      .filter((o) => mayView(o, who))
      .filter((o) => (query.paymentStatus ? o.paymentStatus === query.paymentStatus : true))
      .filter((o) => (query.organizationId ? o.organizationId === query.organizationId : true))
      .filter((o) => {
        if (!query.placedByUserId) return true;
        const summary = summaryOf(o, who);
        return summary.detail === 'FULL' && summary.placedBy.userId === query.placedByUserId;
      })
      .filter((o) => (query.period === 'TODAY' ? isSameBusinessDay(o.submittedAt, now) : true))
      .filter((o) => {
        if (!needle) return true;
        const summary = summaryOf(o, who);
        const placer = summary.detail === 'FULL' ? summary.placedBy.fullName : '';
        return [o.orderNumber, summary.organizationName, placer].some((text) =>
          text.toLowerCase().includes(needle),
        );
      });
  }

  const ordersApi: StaffOrdersApi = {
    async countOrders(query: StaffOrderCountsQuery = {}) {
      const state = await beforeRead();
      const who = viewer();
      const byStatus: StaffOrderCountsResponse['byStatus'] = {};
      const byOrganization: Record<string, StaffOrderStatusCount> = {};
      const grouped = query.groupBy === 'ORGANIZATION';
      const answer = () => (grouped ? { byStatus, byOrganization } : { byStatus });
      if (state === 'empty') return answer();
      const full = hasAny(who, FULL_ROLES);
      const usdSums = new Map<string, bigint>();
      const add = (key: string, seen: StaffOrderStatusCount | undefined, order: OrderRecord) => {
        if (!full) return { count: (seen?.count ?? 0) + 1 };
        const usd =
          (usdSums.get(key) ?? 0n) +
          usdToMicros(uzsToUsdExact(totalOfItems(order.items), order.usdRate));
        usdSums.set(key, usd);
        const totalUsd = microsToMoney(usd);
        return {
          count: (seen?.count ?? 0) + 1,
          totalAmount: fromCents(
            toCents(seen?.totalAmount ?? '0') + toCents(totalOfItems(order.items)),
          ),
          totalUsd,
          totalUzsEquivalent: usdToUzs(microsToUsdExact(usd), FAKE_ORDER_USD_RATE),
        };
      };
      for (const order of matching(query, who)) {
        if (query.statuses && !query.statuses.includes(order.status)) continue;
        byStatus[order.status] = add(order.status, byStatus[order.status], order);
        if (grouped) {
          byOrganization[order.organizationId] = add(
            order.organizationId,
            byOrganization[order.organizationId],
            order,
          );
        }
      }
      return answer();
    },

    async listOrders(query: StaffOrderListQuery = {}) {
      const state = await beforeRead();
      const who = viewer();
      if (state === 'empty') return { orders: [], nextCursor: null };
      const statuses = query.status ? [query.status] : query.statuses;
      const sorted = matching(query, who)
        .filter((o) => (statuses ? statuses.includes(o.status) : true))
        .filter((o) => (query.goodsReturn ? goodsReturnOf(o) === query.goodsReturn : true))
        .sort(
          (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt) || (a.id < b.id ? 1 : -1),
        );
      const start = query.cursor ? sorted.findIndex((o) => o.id === query.cursor) + 1 : 0;
      const limit = query.limit ?? 25;
      const page = sorted.slice(start, start + limit);
      const last = page[page.length - 1];
      const hasMore = start + limit < sorted.length;
      return {
        orders: page.map((o) => summaryOf(o, who)),
        nextCursor: hasMore && last ? last.id : null,
      };
    },

    async getOrder(orderId) {
      const state = await beforeRead();
      const who = viewer();
      if (state === 'empty') throw new ApiNotFoundError('Order not found', 'NOT_FOUND');
      return orderView(requireVisible(orderId, who), who);
    },

    async getTimeline(orderId) {
      const state = await beforeRead();
      const who = viewer();
      if (state === 'empty') throw new ApiNotFoundError('Order not found', 'NOT_FOUND');
      return timelineOf(requireVisible(orderId, who), who);
    },

    async approve(orderId, request: ApproveOrderRequest) {
      await delay();
      return move({
        orderId,
        to: 'MANAGER_APPROVED',
        roles: ['MANAGER'],
        expectedRowVersion: request.expectedRowVersion,
        comment: request.comment,
        skipAccounting: request.skipAccounting === true,
        paymentMethod: request.paymentMethod,
        plan: { allocationMode: request.allocationMode, allocations: request.allocations },
      });
    },
    async getAllocationPreview(orderId) {
      await delay();
      const order = requireVisible(orderId, gate(['MANAGER']));
      assertAllocationReadable(order, ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED']);
      return allocation.preview(order);
    },
    async setAllocations(orderId, request) {
      await delay();
      const who = gate(['MANAGER']);
      const order = requireVisible(orderId, who);
      checkVersion(order, request.expectedRowVersion);
      assertAllocationReadable(order, ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED']);
      allocation.store(
        order.id,
        allocation.judge(order, request.allocationMode, request.allocations),
      );
      const person = actorOf(who);
      addEvent(order, clock.now().getTime(), {
        actorRole: 'MANAGER',
        actorUserId: person.userId,
        actorName: person.name,
        type: 'ALLOCATION_CHANGED',
        fromStatus: null,
        toStatus: null,
        comment: request.comment ?? null,
      });
      return allocation.preview(order);
    },
    async reject(orderId, request: OrderDecisionWithReasonRequest) {
      await delay();
      return move({
        orderId,
        to: 'REJECTED',
        roles: ['MANAGER'],
        expectedRowVersion: request.expectedRowVersion,
        reason: request.reason,
      });
    },
    async cancel(orderId, request: OrderDecisionWithReasonRequest) {
      await delay();
      return move({
        orderId,
        to: 'CANCELLED',
        roles: ['MANAGER'],
        expectedRowVersion: request.expectedRowVersion,
        reason: request.reason,
      });
    },
    async accountingApprove(orderId, request: OrderDecisionWithCommentRequest) {
      await delay();
      return move({
        orderId,
        to: 'ACCOUNTING_CLEARED',
        roles: ['ACCOUNTANT'],
        expectedRowVersion: request.expectedRowVersion,
        comment: request.comment,
      });
    },
    async accountingReject(orderId, request: OrderDecisionWithReasonRequest) {
      await delay();
      return move({
        orderId,
        to: 'REJECTED',
        roles: ['ACCOUNTANT'],
        expectedRowVersion: request.expectedRowVersion,
        reason: request.reason,
      });
    },
    async release(orderId, request: ReleaseOrderRequest) {
      await delay();
      return move({
        orderId,
        to: 'RELEASED',
        roles: ['WAREHOUSE_MANAGER'],
        expectedRowVersion: request.expectedRowVersion,
        comment: request.comment,
        driverUserId: request.driverUserId,
      });
    },
    async markGoodsReturned(orderId, request: OrderDecisionWithCommentRequest) {
      await delay();
      const who = gate(['WAREHOUSE_MANAGER']);
      const order = requireVisible(orderId, who);
      checkVersion(order, request.expectedRowVersion);
      if (goodsReturnOf(order) !== 'PENDING') {
        throw new ApiConflictError(
          'This order has no goods waiting to be returned',
          'CONFLICT',
          { currentStatus: order.status },
          'GOODS_RETURN_NOT_PENDING',
        );
      }
      const now = clock.now().getTime();
      const person = actorOf(who);
      order.goodsReturnedAt = new Date(now).toISOString();
      order.goodsReturnedBy = person.userId;
      order.rowVersion += 1;
      order.updatedAt = order.goodsReturnedAt;
      addEvent(order, now, {
        type: 'GOODS_RETURNED',
        actorRole: 'WAREHOUSE_MANAGER',
        actorUserId: person.userId,
        actorName: person.name,
        comment: request.comment?.trim() || null,
      });
      return orderView(order, who);
    },

    async deliver(orderId, request: OrderDecisionWithCommentRequest) {
      await delay();
      return move({
        orderId,
        to: 'DELIVERED',
        roles: ['DRIVER'],
        expectedRowVersion: request.expectedRowVersion,
        comment: request.comment,
      });
    },

    async editItems(orderId, request: EditOrderItemsRequest) {
      await delay();
      const who = gate(['MANAGER']);
      const order = requireVisible(orderId, who);
      checkVersion(order, request.expectedRowVersion);
      if (order.status !== 'SUBMITTED') {
        throw new ApiConflictError(
          'The items of an order can only be edited while it is SUBMITTED',
          'CONFLICT',
          { currentStatus: order.status },
          'ORDER_NOT_EDITABLE',
        );
      }
      const byId = new Map(order.items.map((item) => [item.id, item]));
      request.changes.forEach((change, index) => {
        if (!byId.has(change.itemId)) {
          throw validation(`changes.${index}.itemId`, 'This line does not belong to the order');
        }
      });
      const before = order.items.map((item) => ({ ...item }));
      const wanted = new Map(request.changes.map((c) => [c.itemId, c.quantity]));
      const after = before.flatMap((item): Item[] => {
        if (!wanted.has(item.id)) return [item];
        const quantity = wanted.get(item.id);
        return quantity === null || quantity === undefined ? [] : [{ ...item, quantity }];
      });
      const lines = before.flatMap((item) => {
        const kept = after.find((a) => a.id === item.id);
        if (kept && isSameQuantity(kept.quantity, item.quantity)) return [];
        return [
          {
            productCode: item.productCode,
            name: item.name,
            oldQuantity: item.quantity,
            newQuantity: kept?.quantity ?? null,
            oldLineTotal: lineTotal(item.unitPrice, item.quantity),
            newLineTotal: kept ? lineTotal(kept.unitPrice, kept.quantity) : null,
          },
        ];
      });
      if (lines.length === 0) return orderView(order, who);
      if (after.length === 0) {
        throw validation(
          'changes',
          'An order must keep at least one line; reject or cancel it instead',
        );
      }
      const now = clock.now().getTime();
      const person = actorOf(who);
      order.items = after;
      order.rowVersion += 1;
      order.updatedAt = new Date(now).toISOString();
      addEvent(order, now, {
        type: 'ITEMS_EDITED',
        actorRole: 'MANAGER',
        actorUserId: person.userId,
        actorName: person.name,
        comment: request.reason?.trim() || null,
        itemsChange: { oldTotal: totalOfItems(before), newTotal: totalOfItems(after), lines },
        notify: ['CUSTOMER'],
        notificationType: 'ORDER_ITEMS_EDITED',
      });
      options.recordActivity?.('ORDER_ITEMS_EDITED', {
        orderId: order.orderNumber,
        count: String(lines.length),
      });
      return orderView(order, who);
    },

    async setPaymentPlan(orderId, request: SetPaymentPlanRequest) {
      await delay();
      const who = gate(['MANAGER']);
      const order = requireVisible(orderId, who);
      checkVersion(order, request.expectedRowVersion);
      if (order.status !== 'SUBMITTED') {
        throw new ApiConflictError(
          'The payment plan can only be changed while the order is SUBMITTED',
          'CONFLICT',
          { currentStatus: order.status },
          'PAYMENT_PLAN_NOT_CHANGEABLE',
        );
      }
      if (order.paymentPlan === request.paymentPlan) return orderView(order, who);
      const next = order.items.map((item) => ({
        item,
        price: request.paymentPlan === 'FULL' ? item.fullUnitPrice : item.deferredUnitPrice,
      }));
      const missing = next.filter(({ price }) => price === null);
      if (missing.length > 0) {
        throw new ApiConflictError(
          'Some products have no deferred price',
          'CONFLICT',
          { productIds: missing.map(({ item }) => item.productId) },
          'DEFERRED_PRICE_UNAVAILABLE',
        );
      }
      const now = clock.now().getTime();
      const person = actorOf(who);
      const change = {
        from: order.paymentPlan,
        to: request.paymentPlan,
        oldTotal: totalOfItems(order.items),
        newTotal: '0.00',
      };
      order.items = next.map(({ item, price }) => ({
        ...item,
        unitPrice: price ?? item.unitPrice,
      }));
      change.newTotal = totalOfItems(order.items);
      order.paymentPlan = request.paymentPlan;
      order.rowVersion += 1;
      order.updatedAt = new Date(now).toISOString();
      addEvent(order, now, {
        type: 'PAYMENT_PLAN_CHANGED',
        actorRole: 'MANAGER',
        actorUserId: person.userId,
        actorName: person.name,
        comment: request.reason?.trim() || null,
        paymentPlanChange: change,
        notify: ['CUSTOMER'],
        notificationType: 'ORDER_PAYMENT_PLAN_CHANGED',
      });
      return orderView(order, who);
    },

    async setPaymentMethod(orderId, request: SetPaymentMethodRequest) {
      await delay();
      return changePaymentMethod(orderId, request);
    },

    async getPicking(orderId) {
      const state = await beforeRead();
      const who = viewer();
      if (state === 'empty') throw new ApiNotFoundError('Order not found', 'NOT_FOUND');
      const order = requireCodesVisible(orderId, who);
      return picking.view(order, codesEditable(order, who));
    },

    async recordUnitCode(orderId, unitId, request) {
      await delay();
      const who = viewer();
      const order = requireScannable(orderId, who);
      picking.record(order, unitId, request);
      return picking.view(order, codesEditable(order, who));
    },

    async clearUnitCode(orderId, unitId, kind: UnitCodeKind, slot) {
      await delay();
      const who = viewer();
      const order = requireScannable(orderId, who);
      picking.clear(order, unitId, kind, slot);
      return picking.view(order, codesEditable(order, who));
    },
  };

  // --- picking (the order of checks of the api's PickingService) -------------------------------

  function requireCodesVisible(orderId: string, who: Viewer): OrderRecord {
    const order = requireVisible(orderId, who);
    if (!hasAny(who, CODE_VIEW_ROLES)) throw new PermissionDeniedError();
    return order;
  }

  const isScannable = (order: OrderRecord): boolean =>
    order.status === 'MANAGER_APPROVED' || order.status === 'ACCOUNTING_CLEARED';

  function codesEditable(order: OrderRecord, who: Viewer): boolean {
    return isScannable(order) && who.roles.includes('WAREHOUSE_MANAGER');
  }

  function requireScannable(orderId: string, who: Viewer): OrderRecord {
    const order = requireCodesVisible(orderId, who);
    if (!isScannable(order)) {
      throw new ApiConflictError(
        'Codes are scanned only between the approval and the release',
        'CONFLICT',
        { currentStatus: order.status },
        'UNIT_CODES_NOT_EDITABLE',
      );
    }
    if (!who.roles.includes('WAREHOUSE_MANAGER')) throw new PermissionDeniedError();
    return order;
  }

  /** The payment method's own rules ([C] 2026-10-24), as the server decides them. */
  function changePaymentMethod(orderId: string, request: SetPaymentMethodRequest): StaffOrder {
    const who = gate(['MANAGER']);
    const order = requireVisible(orderId, who);
    // Changeable once approved, until rejected or cancelled; the same 409 reason as the api.
    if (!CHANGEABLE_METHOD_STATUSES.includes(order.status) || order.paymentMethod === null) {
      throw new ApiConflictError(
        'The payment method of this order cannot be changed',
        'CONFLICT',
        { currentStatus: order.status },
        'PAYMENT_METHOD_NOT_CHANGEABLE',
      );
    }
    if (order.paymentMethod === request.paymentMethod) return orderView(order, who);
    const now = clock.now().getTime();
    const person = actorOf(who);
    const from = order.paymentMethod;
    order.paymentMethod = request.paymentMethod;
    order.updatedAt = new Date(now).toISOString();
    addEvent(order, now, {
      type: 'PAYMENT_METHOD_CHANGED',
      actorRole: 'MANAGER',
      actorUserId: person.userId,
      actorName: person.name,
      comment: request.comment?.trim() || null,
      paymentMethodChange: { from, to: request.paymentMethod },
    });
    return orderView(order, who);
  }

  const driversApi: DriversApi = {
    async listActiveDrivers() {
      await delay();
      // Like GET /staff/drivers: id and name of active drivers, nothing else.
      return FAKE_STAFF.filter((s) => s.isActive && s.roles.includes('DRIVER')).map((s) => ({
        id: s.id,
        fullName: s.name,
      }));
    },
  };

  const organizationBalanceApi = createFakeOrganizationBalance({
    latencyMs,
    ...(options.scenario ? { scenario: options.scenario } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    now: () => clock.now(),
    seedRecorderName: seedStaff('MANAGER').name,
    orders: () =>
      [...orders.values()].map((order) => ({
        organizationId: order.organizationId,
        status: order.status,
        submittedAt: order.submittedAt,
        totalUsd: uzsToUsdExact(totalOfItems(order.items), order.usdRate),
        paymentStatus: order.paymentStatus,
        setPaymentStatus: (status: PaymentStatus) => {
          order.paymentStatus = status;
        },
      })),
  });

  return {
    ordersApi,
    driversApi,
    organizationBalanceApi,
    visibleSummaries: () => {
      const who = viewer();
      return [...orders.values()].filter((o) => mayView(o, who)).map((o) => summaryOf(o, who));
    },
    customerTimeline: (orderId) => {
      const order = orders.get(orderId);
      if (!order) throw new ApiNotFoundError('Order not found', 'NOT_FOUND');
      return customerTimelineOf(order);
    },
  };
}
