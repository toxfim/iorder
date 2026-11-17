import { createFakeCustomerGoodsApi } from '@/features/customer-goods/api/fake-customer-goods';
import { orderMilestones } from '@/features/customer-goods/milestones';
import {
  CUSTOMER_ORDER_GROUP_STATUSES,
  DEFAULT_ORDER_PAGE_SIZE,
  changeOwnPaymentPlanRequestSchema,
  customerReceiveOrderRequestSchema,
  idempotencyKeySchema,
  setCartItemRequestSchema,
  submitOrderRequestSchema,
  setOwnContactRequestSchema,
  type CartLine,
  type CartResponse,
  type CustomerOrder,
  type CustomerOrderListResponse,
  type CustomerOrderSummary,
  type CustomerTimelineEvent,
  type CustomerTimelineResponse,
  type CustomerHomeRecommendationsResponse,
  type CustomerPriceListResponse,
  type CustomerRecommendationItem,
  type MeResponse,
  type OrderActorRole,
  type OrderStatus,
  type PaymentPlan,
  type PaymentStatus,
  type SubmitOrderRequest,
  USD_SETTLED_UNDER,
} from '@iorder/shared';
import type { CartApi } from '@/features/customer-cart/api/cart-api';
import type { CustomerBalanceApi } from '@/features/customer-balance/api/customer-balance-api';
import type { CustomerHomeApi } from '@/features/customer-home/api/customer-home-api';
import type { CustomerPriceApi } from '@/features/customer-catalog/api/customer-price-api';
import type {
  CustomerOrdersApi,
  OrderListQuery,
} from '@/features/customer-orders/api/customer-orders-api';
import type { MeApi } from '@/features/customer-session/api/me-api';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
  UnauthenticatedError,
  type FieldIssue,
} from '@core/lib/api-errors';
import type { Clock } from '@core/lib/business-clock';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import {
  fromCents,
  microsToMoney,
  sumMoney,
  usdToMicros,
  usdToUzs,
  uzsToUsdExact,
} from '@core/lib/money';
import { lineTotal, toMilli } from '@core/lib/quantity';
import {
  ACTIVE_ORGANIZATION_IDS,
  FAKE_ACCOUNTS,
  FAKE_CONFIRMED_SUCCESSIONS,
  FAKE_CUSTOMER_BACKEND_MARKER,
  FAKE_PRODUCTS,
  fakeProductPhoto,
  ORG_ACTIVE,
  type FakeAccount,
  type FakeProduct,
} from './fake-customer-data';

export interface FakeCustomerBackendOptions {
  readonly clock: Clock;
  /** The init data the app would send; read per call, like the real Authorization header. */
  readonly initData: () => string | null;
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  readonly pageSize?: number;
  /** The seller starts with an inactive product in the cart (shows the problem state). */
  readonly seedProblemCart?: boolean;
  readonly seedReceivedGoods?: boolean;
}

/** Owner rule 2026-10-30: 3 minutes; the real value is the server's. */
const FAKE_PLAN_CHANGE_WINDOW_MS = 3 * 60 * 1000;

interface FakePlanSnapshot {
  readonly totals: { readonly FULL: string; readonly DEFERRED: string | null };
  readonly lines: ReadonlyMap<
    string,
    Readonly<Record<PaymentPlan, { unitPrice: string | null; lineTotal: string | null }>>
  >;
}

interface OrderRecord {
  readonly id: string;
  readonly orderNumber: string;
  readonly organizationId: string;
  readonly placedBy: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  items: CustomerOrder['items'];
  totalAmount: string;
  paymentPlan: PaymentPlan;
  /** Set on orders made in this session, like the server's snapshots of both prices. */
  planSnapshot: FakePlanSnapshot | null;
  readonly submittedAt: string;
  updatedAt: string;
  rowVersion: number;
  readonly events: CustomerTimelineEvent[];
}

const CURRENCY = 'UZS' as const;
/** The server's rate, never sent to a customer; only this fake's debt arithmetic uses it. */
const FAKE_USD_RATE = '12650.0000';

function sorted<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(b).localeCompare(key(a)));
}

export function createFakeCustomerBackend(options: FakeCustomerBackendOptions) {
  const { clock } = options;
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? ((): FakeScenario => 'ready');
  const pageSize = options.pageSize ?? DEFAULT_ORDER_PAGE_SIZE;

  const products = new Map<string, FakeProduct>(FAKE_PRODUCTS.map((p) => [p.id, { ...p }]));
  // Like the server: a whole number of pieces, 0 = out of stock (blocks), null = no figure, no cap.
  const orderableStock = (p: FakeProduct): number | null => p.stock;
  const isOverStock = (p: FakeProduct, quantity: string): boolean => {
    const stock = orderableStock(p);
    return stock !== null && toMilli(quantity) > BigInt(stock) * 1000n;
  };
  const stockRefusal = (lines: readonly { productId: string; orderableStock: number }[]) =>
    new ApiConflictError(
      'More was asked for than can be ordered right now',
      'CONFLICT',
      { lines },
      'STOCK_LIMIT_EXCEEDED',
    );
  const carts = new Map<string, Map<string, string>>();
  const orders: OrderRecord[] = [];
  const idempotency = new Map<string, { userId: string; orderId: string }>();
  // What the customers typed at their first order (in memory only, like the rest of the fake).
  const contacts = new Map<string, { fullName: string; phone: string | null }>(
    FAKE_ACCOUNTS.map((a) => [a.id, { fullName: a.fullName, phone: a.phone }]),
  );
  let nextOrderNumber = 10492;
  let nextEvent = 1;
  const nowIso = (): string => clock.now().toISOString();

  // ---- seed -------------------------------------------------------------------------------

  const byInitData = (initData: string): FakeAccount => {
    const found = FAKE_ACCOUNTS.find((a) => a.initData === initData);
    if (!found) throw new Error(`Unknown fake account ${initData}`);
    return found;
  };
  const owner = byInitData('fake-owner');
  const seller = byInitData('fake-seller');
  const otherOrg = byInitData('fake-other-org');

  const productByCode = (code: string): FakeProduct => {
    const found = FAKE_PRODUCTS.find((p) => p.code === code);
    if (!found) throw new Error(`Unknown fake product ${code}`);
    return found;
  };

  function lineItems(specs: readonly (readonly [string, string])[]): CustomerOrder['items'] {
    return specs.map(([code, quantity]) => {
      const p = productByCode(code);
      const unitPrice = p.price ?? '0.00';
      return {
        id: fakeUuid(`customer-item:${code}:${quantity}:${nextEvent++}`),
        productId: p.id,
        productCode: p.code,
        name: p.name,
        unit: p.unit,
        quantity,
        unitPrice,
        lineTotal: lineTotal(unitPrice, quantity),
      };
    });
  }

  function event(
    record: OrderRecord,
    type: CustomerTimelineEvent['type'],
    hoursAgo: number,
    fields: Partial<CustomerTimelineEvent> & { actorRole?: OrderActorRole; actorName?: string },
  ): void {
    const { actorRole, actorName, ...rest } = fields;
    record.events.push({
      id: fakeUuid(`customer-event:${record.orderNumber}:${nextEvent++}`),
      type,
      occurredAt: new Date(clock.now().getTime() - hoursAgo * 3_600_000).toISOString(),
      fromStatus: null,
      toStatus: null,
      actor: actorRole ? { role: actorRole, name: actorName ?? null } : null,
      comment: null,
      itemsChange: null,
      paymentChange: null,
      paymentPlanChange: null,
      customerNotified: false,
      ...rest,
    });
  }

  const STAFF_PATH: readonly (readonly [OrderStatus, OrderActorRole])[] = [
    ['MANAGER_APPROVED', 'MANAGER'],
    ['ACCOUNTING_CLEARED', 'ACCOUNTANT'],
    ['RELEASED', 'WAREHOUSE_MANAGER'],
    ['DELIVERED', 'DRIVER'],
    ['RECEIVED', 'SHOP_OWNER'],
  ];

  function seedOrder(
    number: number,
    placedBy: FakeAccount,
    status: OrderStatus,
    hoursAgo: number,
    specs: readonly (readonly [string, string])[],
    extra: (record: OrderRecord) => void = () => undefined,
  ): OrderRecord {
    const items = lineItems(specs);
    const submittedAt = new Date(clock.now().getTime() - hoursAgo * 3_600_000).toISOString();
    const record: OrderRecord = {
      id: fakeUuid(`customer-order:IO-${number}`),
      orderNumber: `IO-${number}`,
      organizationId: placedBy.organizationId ?? ORG_ACTIVE,
      placedBy: placedBy.id,
      status,
      paymentStatus: 'UNPAID',
      items,
      totalAmount: sumMoney(items.map((i) => i.lineTotal)),
      paymentPlan: 'FULL',
      planSnapshot: null,
      submittedAt,
      updatedAt: submittedAt,
      rowVersion: 1,
      events: [],
    };
    event(record, 'SUBMITTED', hoursAgo, {
      toStatus: 'SUBMITTED',
      actorRole: placedBy.role ?? 'SHOP_OWNER',
      actorName: placedBy.fullName,
      customerNotified: true,
    });
    const reached = STAFF_PATH.findIndex(([s]) => s === status);
    const steps = reached < 0 ? 0 : reached + 1;
    let from: OrderStatus = 'SUBMITTED';
    STAFF_PATH.slice(0, steps).forEach(([to, role], index) => {
      event(record, 'STATUS_CHANGED', Math.max(hoursAgo - (index + 1), 0.1), {
        fromStatus: from,
        toStatus: to,
        actorRole: role,
        actorName: role === 'SHOP_OWNER' ? owner.fullName : undefined,
        customerNotified: role !== 'SHOP_OWNER',
      });
      from = to;
    });
    extra(record);
    record.status = status;
    const last = record.events[record.events.length - 1];
    record.updatedAt = last?.occurredAt ?? submittedAt;
    orders.push(record);
    return record;
  }

  seedOrder(10491, seller, 'SUBMITTED', 1, [
    ['BASEUS-20W', '10'],
    ['HOCO-USBC-1M', '25'],
  ]);
  seedOrder(10490, owner, 'MANAGER_APPROVED', 5, [['TECNO-SPARK20-128', '4']]);
  seedOrder(10489, owner, 'RELEASED', 26, [
    ['UGREEN-65W-GAN', '6'],
    ['BOROFONE-BW05', '12'],
  ]);
  seedOrder(10488, seller, 'DELIVERED', 50, [['HOCO-GLASS-A15', '40']]);
  seedOrder(10487, owner, 'DELIVERED', 52, [['HOCO-GLASS-A15', '3.5']]);
  seedOrder(10480, owner, 'RECEIVED', 120, [['BASEUS-20W', '5']], (record) => {
    event(record, 'ITEMS_EDITED', 118, {
      actorRole: 'MANAGER',
      comment: "Ombordagi qoldiq sababli miqdor o'zgartirildi",
      itemsChange: {
        oldTotal: '534000.00',
        newTotal: '445000.00',
        lines: [
          {
            productCode: 'BASEUS-20W',
            name: 'Baseus 20W zaryadlovchi',
            change: 'QUANTITY_CHANGED',
            oldQuantity: '6',
            newQuantity: '5',
            oldLineTotal: '534000.00',
            newLineTotal: '445000.00',
          },
        ],
      },
      customerNotified: true,
    });
    event(record, 'PAYMENT_STATUS_CHANGED', 100, {
      actorRole: 'ACCOUNTANT',
      paymentChange: { from: 'UNPAID', to: 'PAID' },
    });
    record.paymentStatus = 'PAID';
  });
  seedOrder(10470, owner, 'REJECTED', 200, [['TECNO-SPARK20-128', '2']], (record) => {
    event(record, 'STATUS_CHANGED', 198, {
      fromStatus: 'SUBMITTED',
      toStatus: 'REJECTED',
      actorRole: 'MANAGER',
      comment: 'Bu model omborda tugagan',
      customerNotified: true,
    });
  });
  seedOrder(10465, seller, 'CANCELLED', 240, [['HOCO-USBC-1M', '100']], (record) => {
    event(record, 'STATUS_CHANGED', 239, {
      fromStatus: 'SUBMITTED',
      toStatus: 'CANCELLED',
      actorRole: 'MANAGER',
      comment: "Mijoz so'rovi bilan bekor qilindi",
    });
  });
  seedOrder(10460, otherOrg, 'SUBMITTED', 3, [['UGREEN-65W-GAN', '1']]);

  if (options.seedProblemCart ?? true) {
    carts.set(seller.id, new Map([[productByCode('OLD-CHARGER-5W').id, '2']]));
  }

  // ---- plumbing ---------------------------------------------------------------------------

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  /** Read calls honour the dev scenario; writes behave normally so the flow can be tried. */
  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new Error(`${FAKE_CUSTOMER_BACKEND_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  function caller(): FakeAccount {
    const initData = options.initData();
    const found = FAKE_ACCOUNTS.find((a) => a.initData === initData);
    // Unknown people and a missing header look the same (the server answers identically).
    if (!found) throw new UnauthenticatedError();
    return found;
  }

  interface Member extends FakeAccount {
    readonly organizationId: string;
  }

  /** A member of an ACTIVE organization; staff and inactive organizations get a 403 here. */
  function member(): Member {
    const found = caller();
    if (
      found.organizationId === null ||
      !ACTIVE_ORGANIZATION_IDS.has(found.organizationId) ||
      found.staffRoles.length > 0
    ) {
      throw new PermissionDeniedError();
    }
    return { ...found, organizationId: found.organizationId };
  }

  /**
   * Whoever may browse and fill a cart: a customer member, or a staff viewer ([C] 2026-11-09).
   * The viewer has no organization. The fake gives each viewer a private space of their own, so
   * every organization-scoped read below is empty for them, and a test order (where ordering is
   * on) is seen by them alone, as the server shows a viewer only the orders they placed.
   */
  function shopper(): Member {
    const found = caller();
    if (found.staffViewer !== undefined) {
      return { ...found, organizationId: fakeUuid(`customer-viewer-space:${found.id}`) };
    }
    return member();
  }

  const issues = (error: { issues: readonly { path: PropertyKey[]; message: string }[] }) =>
    error.issues.map((i): FieldIssue => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));

  function validationError(error: unknown): ApiValidationError {
    const list =
      typeof error === 'object' && error !== null && 'issues' in error
        ? issues(error as { issues: readonly { path: PropertyKey[]; message: string }[] })
        : [];
    return new ApiValidationError('Validation failed', 'VALIDATION_FAILED', list);
  }

  // ---- cart -------------------------------------------------------------------------------

  function cartOf(user: Member): Map<string, string> {
    let cart = carts.get(user.id);
    if (!cart) {
      cart = new Map();
      carts.set(user.id, cart);
    }
    return cart;
  }

  function cartResponse(user: Member): CartResponse {
    const lines: CartLine[] = [];
    for (const [productId, quantity] of cartOf(user)) {
      const p = products.get(productId);
      if (!p) continue;
      const unorderable = !p.active ? 'INACTIVE' : p.price === null ? 'NOT_PRICED' : null;
      const priced = unorderable === null && p.price !== null;
      const deferred = unorderable === null ? p.deferredPrice : null;
      // Like the api: a line above the stock keeps its prices, only its quantity is wrong.
      const problem = unorderable ?? (isOverStock(p, quantity) ? 'STOCK_EXCEEDED' : null);
      lines.push({
        productId,
        productCode: p.code,
        name: p.name,
        unit: p.unit,
        quantity,
        unitPrice: priced ? p.price : null,
        lineTotal: priced ? lineTotal(p.price, quantity) : null,
        deferredUnitPrice: deferred,
        deferredLineTotal: deferred === null ? null : lineTotal(deferred, quantity),
        // Like the api: a line that cannot be ordered shows no price and no stock figure.
        rrp: unorderable === null ? p.rrp : null,
        orderableStock: unorderable === null ? orderableStock(p) : null,
        problem,
      });
    }
    const total = sumMoney(lines.flatMap((l) => (l.lineTotal === null ? [] : [l.lineTotal])));
    const deferredTotals = lines.flatMap((l) =>
      l.deferredLineTotal === null ? [] : [l.deferredLineTotal],
    );
    return {
      priceListVersionNumber: 15,
      lines,
      totalAmount: lines.length === 0 ? fromCents(0n) : total,
      deferredTotalAmount:
        lines.length > 0 && deferredTotals.length === lines.length
          ? sumMoney(deferredTotals)
          : null,
      currency: CURRENCY,
      canSubmit: lines.length > 0 && lines.every((l) => l.problem === null),
    };
  }

  function orderable(productId: string): FakeProduct {
    const p = products.get(productId);
    if (!p) {
      throw new ApiNotFoundError('Product not found', 'NOT_FOUND', { productIds: [productId] });
    }
    if (!p.active || p.price === null) {
      throw new ApiConflictError(
        'Product cannot be ordered',
        'CONFLICT',
        { productIds: [productId] },
        'PRODUCT_NOT_ORDERABLE',
      );
    }
    return p;
  }

  const cartApi: CartApi = {
    async get() {
      await beforeRead();
      return cartResponse(shopper());
    },
    async setItem(productId, request) {
      await delay();
      const user = shopper();
      const parsed = setCartItemRequestSchema.safeParse(request);
      if (!parsed.success) throw validationError(parsed.error);
      const product = orderable(productId);
      const stock = orderableStock(product);
      if (stock !== null && isOverStock(product, parsed.data.quantity)) {
        throw stockRefusal([{ productId, orderableStock: stock }]);
      }
      cartOf(user).set(productId, parsed.data.quantity);
      return cartResponse(user);
    },
    async removeItem(productId) {
      await delay();
      const user = shopper();
      cartOf(user).delete(productId);
      return cartResponse(user);
    },
  };

  // ---- price list -------------------------------------------------------------------------

  /** A product card as the customer price list and the home send it (no category on the home). */
  const cardOf = (p: FakeProduct & { price: string }): CustomerRecommendationItem => ({
    productId: p.id,
    productCode: p.code,
    unit: p.unit,
    name: p.name,
    price: p.price,
    deferredPrice: p.deferredPrice,
    rrp: p.rrp,
    orderableStock: orderableStock(p),
    currency: CURRENCY,
    imageUrl: fakeProductPhoto(p.code, 'thumb'),
    imageLargeUrl: fakeProductPhoto(p.code, 'large'),
  });
  /** The published, orderable products in the fixture order. */
  const listedProducts = (): (FakeProduct & { price: string })[] =>
    FAKE_PRODUCTS.flatMap((fixture) => {
      const p = products.get(fixture.id);
      return p && p.active && p.price !== null ? [{ ...p, price: p.price }] : [];
    });

  const priceApi: CustomerPriceApi = {
    async getCurrent() {
      const state = await beforeRead();
      shopper();
      if (state === 'empty') throw new ApiNotFoundError('No published price list', 'NOT_FOUND');
      const items = listedProducts().map((p) => ({ ...cardOf(p), category: p.category }));
      const list: CustomerPriceListResponse = {
        version: { number: 15, publishedAt: '2026-10-19T03:30:00.000Z' },
        items,
      };
      return list;
    },
  };

  // ---- home recommendations ---------------------------------------------------------------

  const receivedAtOf = (record: OrderRecord): string =>
    record.events.find((e) => e.type === 'STATUS_CHANGED' && e.toStatus === 'RECEIVED')
      ?.occurredAt ?? record.updatedAt;

  interface Bought {
    lastReceivedAt: string;
    lastQuantity: string;
    timesOrdered: number;
    category: string | null;
  }

  // Like the server: the organization's RECEIVED orders decide what was bought; the three blocks
  // come from the published list; the hero only from a confirmed pair whose older product was bought.
  const homeApi: CustomerHomeApi = {
    async getRecommendations(): Promise<CustomerHomeRecommendationsResponse> {
      const state = await beforeRead();
      const user = shopper();
      const none: CustomerHomeRecommendationsResponse = {
        reorder: [],
        matching: [],
        newerModel: null,
      };
      if (state === 'empty' || user.staffViewer !== undefined) return none;
      const bought = new Map<string, Bought>();
      for (const order of orders) {
        if (order.organizationId !== user.organizationId || order.status !== 'RECEIVED') continue;
        const receivedAt = receivedAtOf(order);
        for (const item of order.items) {
          const current = bought.get(item.productId);
          const later = current === undefined || receivedAt > current.lastReceivedAt;
          bought.set(item.productId, {
            lastReceivedAt: later ? receivedAt : current.lastReceivedAt,
            lastQuantity: later ? item.quantity : current.lastQuantity,
            timesOrdered: (current?.timesOrdered ?? 0) + 1,
            category: products.get(item.productId)?.category ?? null,
          });
        }
      }
      if (bought.size === 0) return none;
      const listed = listedProducts();
      const reorder = listed
        .flatMap((p) => {
          const stat = bought.get(p.id);
          return stat === undefined
            ? []
            : [
                {
                  ...cardOf(p),
                  usualQuantity: String(Math.max(Math.floor(Number(stat.lastQuantity)), 1)),
                  lastReceivedAt: stat.lastReceivedAt,
                  timesOrdered: stat.timesOrdered,
                },
              ];
        })
        .sort((a, b) => a.lastReceivedAt.localeCompare(b.lastReceivedAt));
      const pair = FAKE_CONFIRMED_SUCCESSIONS.map(([older, newer]) => ({
        older: productByCode(older),
        newer: listed.find((p) => p.code === newer),
      })).find(({ older, newer }) => bought.has(older.id) && newer && !bought.has(newer.id));
      const newerModel =
        pair?.newer === undefined
          ? null
          : {
              ...cardOf(pair.newer),
              replacesProductName: pair.older.name,
              replacesTimesOrdered: bought.get(pair.older.id)?.timesOrdered ?? 1,
            };
      const byCategory = new Map<string, { name: string; lastReceivedAt: string }>();
      for (const [productId, stat] of bought) {
        if (stat.category === null) continue;
        const current = byCategory.get(stat.category);
        if (current === undefined || stat.lastReceivedAt > current.lastReceivedAt) {
          byCategory.set(stat.category, {
            name: products.get(productId)?.name ?? '',
            lastReceivedAt: stat.lastReceivedAt,
          });
        }
      }
      const matching = listed
        .flatMap((p) => {
          const because = p.category === null ? undefined : byCategory.get(p.category);
          return because === undefined || bought.has(p.id) || p.id === newerModel?.productId
            ? []
            : [{ card: { ...cardOf(p), boughtProductName: because.name }, because }];
        })
        .sort(
          (a, b) =>
            b.because.lastReceivedAt.localeCompare(a.because.lastReceivedAt) ||
            a.card.name.localeCompare(b.card.name),
        )
        .map(({ card }) => card);
      return { reorder, matching, newerModel };
    },
  };

  // ---- orders -----------------------------------------------------------------------------

  function summaryOf(record: OrderRecord, user: Member): CustomerOrderSummary {
    const placer = FAKE_ACCOUNTS.find((a) => a.id === record.placedBy);
    return {
      id: record.id,
      orderNumber: record.orderNumber,
      status: record.status,
      paymentStatus: record.paymentStatus,
      paymentPlan: record.paymentPlan,
      totalAmount: record.totalAmount,
      currency: CURRENCY,
      itemCount: record.items.length,
      customerComment: null,
      placedByName: placer?.fullName ?? '',
      placedByMe: record.placedBy === user.id,
      submittedAt: record.submittedAt,
      updatedAt: record.updatedAt,
      rowVersion: record.rowVersion,
    };
  }

  /** The end of the customer's time to change the plan; null when it does not apply or is over. */
  function planChangeUntil(record: OrderRecord): string | null {
    if (record.status !== 'SUBMITTED' || record.planSnapshot === null) return null;
    const until = new Date(record.submittedAt).getTime() + FAKE_PLAN_CHANGE_WINDOW_MS;
    return clock.now().getTime() < until ? new Date(until).toISOString() : null;
  }

  const orderOf = (record: OrderRecord, user: Member): CustomerOrder => {
    // A staff viewer reads the test order but is never offered a plan change (like the server).
    const until = user.staffViewer === undefined ? planChangeUntil(record) : null;
    return {
      ...summaryOf(record, user),
      items: record.items,
      paymentPlanChangeableUntil: until,
      paymentPlanTotals:
        until === null || record.planSnapshot === null ? null : { ...record.planSnapshot.totals },
    };
  };

  /** A foreign order is indistinguishable from a missing one: 404, never 403. */
  function ownOrder(orderId: string, user: Member): OrderRecord {
    const found = orders.find((o) => o.id === orderId && o.organizationId === user.organizationId);
    if (!found) throw new ApiNotFoundError('Order not found', 'NOT_FOUND');
    return found;
  }

  function checkVersion(record: OrderRecord, expected: number | undefined): void {
    if (expected !== undefined && expected !== record.rowVersion) {
      throw new ApiConflictError(
        'The order was changed',
        'CONFLICT',
        { currentStatus: record.status },
        'ORDER_CHANGED',
      );
    }
  }

  function moveTo(record: OrderRecord, to: OrderStatus, user: Member, comment?: string): void {
    const from = record.status;
    record.status = to;
    record.rowVersion += 1;
    record.updatedAt = nowIso();
    record.events.push({
      id: fakeUuid(`customer-event:${record.orderNumber}:${nextEvent++}`),
      type: 'STATUS_CHANGED',
      occurredAt: record.updatedAt,
      fromStatus: from,
      toStatus: to,
      actor: { role: user.role ?? 'SELLER', name: user.fullName },
      comment: comment && comment !== '' ? comment : null,
      itemsChange: null,
      paymentChange: null,
      paymentPlanChange: null,
      customerNotified: false,
    });
  }

  const ordersApi: CustomerOrdersApi = {
    async submit(idempotencyKey, request: SubmitOrderRequest) {
      await delay();
      const user = shopper();
      // Like the server: a staff viewer orders only where a test organization is configured.
      if (user.staffViewer?.canOrder === false) {
        throw new ApiConflictError(
          'Staff members cannot place orders here',
          'CONFLICT',
          undefined,
          'STAFF_ORDERING_DISABLED',
        );
      }
      const key = idempotencyKeySchema.safeParse(idempotencyKey);
      if (!key.success) throw validationError(key.error);
      const body = submitOrderRequestSchema.safeParse(request);
      if (!body.success) throw validationError(body.error);
      const { paymentPlan, expectedTotalAmount } = body.data;
      const scoped = `${user.organizationId}:${key.data}`;
      const known = idempotency.get(scoped);
      if (known) {
        if (known.userId !== user.id) {
          throw new ApiConflictError(
            'Key already used',
            'CONFLICT',
            undefined,
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        const again = orders.find((o) => o.id === known.orderId);
        if (again) return orderOf(again, user);
      }
      // After the replay above, like the server: an existing order is returned either way.
      if (user.staffViewer === undefined && !contacts.get(user.id)?.phone) {
        throw new ApiConflictError('Contact required', 'CONFLICT', undefined, 'CONTACT_REQUIRED');
      }
      const cart = cartResponse(user);
      if (cart.lines.length === 0) {
        throw new ApiConflictError('The cart is empty', 'CONFLICT', undefined, 'EMPTY_CART');
      }
      const blocked = cart.lines
        .filter((l) => l.problem !== null && l.problem !== 'STOCK_EXCEEDED')
        .map((l) => l.productId);
      if (blocked.length > 0) {
        throw new ApiConflictError(
          'Some products cannot be ordered',
          'CONFLICT',
          { productIds: blocked },
          'PRODUCT_NOT_ORDERABLE',
        );
      }
      // The stock is read again at submit, like the server: a cart that was fine when shown is
      // refused once the stock fell below a line.
      const overStock = cart.lines.flatMap((l) =>
        l.problem === 'STOCK_EXCEEDED' && l.orderableStock !== null
          ? [{ productId: l.productId, orderableStock: l.orderableStock }]
          : [],
      );
      if (overStock.length > 0) throw stockRefusal(overStock);
      if (paymentPlan === 'DEFERRED' && cart.deferredTotalAmount === null) {
        throw new ApiConflictError(
          'Some products have no deferred price',
          'CONFLICT',
          {
            productIds: cart.lines
              .filter((l) => l.deferredUnitPrice === null)
              .map((l) => l.productId),
          },
          'DEFERRED_PRICE_UNAVAILABLE',
        );
      }
      const total =
        (paymentPlan === 'FULL' ? cart.totalAmount : cart.deferredTotalAmount) ?? '0.00';
      if (total !== expectedTotalAmount) {
        throw new ApiConflictError(
          'The total changed after the cart was read',
          'CONFLICT',
          { currentTotalAmount: total },
          'CART_TOTAL_CHANGED',
        );
      }
      const number = nextOrderNumber++;
      const items = cart.lines.map((l) => ({
        id: fakeUuid(`customer-item:new:${number}:${l.productId}`),
        productId: l.productId,
        productCode: l.productCode,
        name: l.name,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: (paymentPlan === 'FULL' ? l.unitPrice : l.deferredUnitPrice) ?? '0.00',
        lineTotal: (paymentPlan === 'FULL' ? l.lineTotal : l.deferredLineTotal) ?? '0.00',
      }));
      const submittedAt = nowIso();
      const record: OrderRecord = {
        id: fakeUuid(`customer-order:IO-${number}`),
        orderNumber: `IO-${number}`,
        organizationId: user.organizationId,
        placedBy: user.id,
        status: 'SUBMITTED',
        paymentStatus: 'UNPAID',
        items,
        totalAmount: total,
        paymentPlan,
        planSnapshot: {
          totals: { FULL: cart.totalAmount, DEFERRED: cart.deferredTotalAmount },
          lines: new Map(
            cart.lines.map((l) => [
              l.productId,
              {
                FULL: { unitPrice: l.unitPrice ?? '0.00', lineTotal: l.lineTotal ?? '0.00' },
                DEFERRED: { unitPrice: l.deferredUnitPrice, lineTotal: l.deferredLineTotal },
              },
            ]),
          ),
        },
        submittedAt,
        updatedAt: submittedAt,
        rowVersion: 1,
        events: [],
      };
      record.events.push({
        id: fakeUuid(`customer-event:${record.orderNumber}:${nextEvent++}`),
        type: 'SUBMITTED',
        occurredAt: submittedAt,
        fromStatus: null,
        toStatus: 'SUBMITTED',
        actor: { role: user.role ?? 'SELLER', name: user.fullName },
        comment: null,
        itemsChange: null,
        paymentChange: null,
        paymentPlanChange: null,
        customerNotified: true,
      });
      orders.push(record);
      cartOf(user).clear();
      idempotency.set(scoped, { userId: user.id, orderId: record.id });
      return orderOf(record, user);
    },

    async list(query: OrderListQuery = {}): Promise<CustomerOrderListResponse> {
      const state = await beforeRead();
      const user = shopper();
      if (state === 'empty') return { orders: [], nextCursor: null };
      const all = sorted(
        orders.filter(
          (o) =>
            o.organizationId === user.organizationId &&
            (query.status === undefined || o.status === query.status) &&
            (query.group === undefined ||
              (CUSTOMER_ORDER_GROUP_STATUSES[query.group] as readonly string[]).includes(
                o.status,
              )) &&
            (query.search === undefined ||
              o.orderNumber.toLowerCase().includes(query.search.toLowerCase())),
        ),
        (o) => o.submittedAt,
      );
      const start =
        query.cursor === undefined ? 0 : all.findIndex((o) => o.id === query.cursor) + 1;
      const size = query.limit ?? pageSize;
      const page = all.slice(start, start + size);
      const last = page[page.length - 1];
      return {
        orders: page.map((o) => summaryOf(o, user)),
        nextCursor: start + size < all.length && last ? last.id : null,
      };
    },

    async get(orderId) {
      await beforeRead();
      const user = shopper();
      return orderOf(ownOrder(orderId, user), user);
    },

    async changePaymentPlan(orderId, request) {
      await delay();
      const user = member();
      const body = changeOwnPaymentPlanRequestSchema.safeParse(request);
      if (!body.success) throw validationError(body.error);
      const record = ownOrder(orderId, user);
      if (record.status !== 'SUBMITTED') {
        throw new ApiConflictError(
          'The payment plan can only be changed while the order is SUBMITTED',
          'CONFLICT',
          { currentStatus: record.status },
          'PAYMENT_PLAN_NOT_CHANGEABLE',
        );
      }
      const snapshot = record.planSnapshot;
      if (planChangeUntil(record) === null || snapshot === null) {
        throw new ApiConflictError(
          'The time to change the payment plan is over',
          'CONFLICT',
          undefined,
          'PAYMENT_PLAN_WINDOW_ENDED',
        );
      }
      checkVersion(record, body.data.expectedRowVersion);
      const { paymentPlan } = body.data;
      if (paymentPlan === record.paymentPlan) return orderOf(record, user);
      const total = snapshot.totals[paymentPlan];
      if (total === null) {
        throw new ApiConflictError(
          'Some products have no deferred price',
          'CONFLICT',
          { productIds: [] },
          'DEFERRED_PRICE_UNAVAILABLE',
        );
      }
      const oldTotal = record.totalAmount;
      const oldPlan = record.paymentPlan;
      record.items = record.items.map((item) => {
        const line = snapshot.lines.get(item.productId)?.[paymentPlan];
        return {
          ...item,
          unitPrice: line?.unitPrice ?? item.unitPrice,
          lineTotal: line?.lineTotal ?? item.lineTotal,
        };
      });
      record.totalAmount = total;
      record.paymentPlan = paymentPlan;
      record.rowVersion += 1;
      record.updatedAt = nowIso();
      record.events.push({
        id: fakeUuid(`customer-event:${record.orderNumber}:${nextEvent++}`),
        type: 'PAYMENT_PLAN_CHANGED',
        occurredAt: record.updatedAt,
        fromStatus: null,
        toStatus: null,
        actor: { role: user.role ?? 'SELLER', name: user.fullName },
        comment: null,
        itemsChange: null,
        paymentChange: null,
        paymentPlanChange: { from: oldPlan, to: paymentPlan, oldTotal, newTotal: total },
        customerNotified: false,
      });
      return orderOf(record, user);
    },

    async timeline(orderId): Promise<CustomerTimelineResponse> {
      await beforeRead();
      const user = member();
      const record = ownOrder(orderId, user);
      return { orderId: record.id, events: [...record.events] };
    },

    async receive(orderId, request = {}) {
      await delay();
      const user = member();
      const record = ownOrder(orderId, user);
      const parsed = customerReceiveOrderRequestSchema.safeParse(request);
      if (!parsed.success) throw validationError(parsed.error);
      // A seller may confirm only an order they placed; the shop owner any of the organization.
      if (user.role !== 'SHOP_OWNER' && record.placedBy !== user.id) {
        throw new PermissionDeniedError();
      }
      checkVersion(record, parsed.data.expectedRowVersion);
      if (record.status !== 'DELIVERED') {
        throw new ApiConflictError(
          'Cannot receive in this status',
          'CONFLICT',
          { from: record.status, to: 'RECEIVED' },
          'ILLEGAL_ORDER_TRANSITION',
        );
      }
      const hadGoods = orders.some(
        (o) =>
          o.organizationId === user.organizationId &&
          o.status === 'RECEIVED' &&
          !(options.seedReceivedGoods === false && o.orderNumber === 'IO-10480'),
      );
      moveTo(record, 'RECEIVED', user, parsed.data.comment);
      if (!hadGoods) goodsApi.markFirstReceipt();
      return orderOf(record, user);
    },
  };

  function meOf(found: FakeAccount): MeResponse {
    const active =
      found.organizationId !== null && ACTIVE_ORGANIZATION_IDS.has(found.organizationId);
    const contact = contacts.get(found.id);
    const isStaff = found.staffRoles.length > 0;
    return {
      userId: found.id,
      fullName: contact?.fullName ?? found.fullName,
      locale: found.locale,
      staffRoles: [...found.staffRoles],
      membership:
        active && found.organizationId !== null && found.role !== null
          ? {
              organizationId: found.organizationId,
              role: found.role,
              organizationName:
                found.organizationId === ORG_ACTIVE ? 'Texno Plaza' : 'Zamon Telecom',
            }
          : null,
      contact:
        !isStaff && contact?.phone ? { fullName: contact.fullName, phone: contact.phone } : null,
      needsContact: !isStaff && !contact?.phone,
      staffViewer: found.staffViewer ?? null,
    };
  }

  const meApi: MeApi = {
    async getMe(): Promise<MeResponse> {
      await beforeRead();
      return meOf(caller());
    },
    async setContact(request): Promise<MeResponse> {
      await delay();
      const user = member();
      const parsed = setOwnContactRequestSchema.safeParse(request);
      if (!parsed.success) throw validationError(parsed.error);
      // Like the server: the first time and every later change are the same write.
      contacts.set(user.id, { fullName: parsed.data.fullName, phone: parsed.data.phone });
      return meOf(user);
    },
  };

  // Payments per organization in millionths of a USD, as the manager would have recorded them. The seeded PAID
  // received order was paid in full, so the figures start in line with the order badges.
  const paidByOrganization = new Map<string, bigint>();
  for (const order of orders) {
    if (order.status !== 'RECEIVED' || order.paymentStatus !== 'PAID') continue;
    const before = paidByOrganization.get(order.organizationId) ?? 0n;
    const usd = usdToMicros(uzsToUsdExact(order.totalAmount, FAKE_USD_RATE));
    paidByOrganization.set(order.organizationId, before + usd);
  }

  // GET /me/balance: the organization's received orders minus its payments, never below zero. Like
  // the server: counted in USD, answered in whole so'm at the current rate, only the amount.
  const balanceApi: CustomerBalanceApi = {
    async getBalance() {
      const state = await beforeRead();
      const user = shopper();
      if (state === 'empty') return { amountDue: fromCents(0n), currency: CURRENCY };
      const received = orders
        .filter((o) => o.organizationId === user.organizationId && o.status === 'RECEIVED')
        .reduce((sum, o) => sum + usdToMicros(uzsToUsdExact(o.totalAmount, FAKE_USD_RATE)), 0n);
      const paid = paidByOrganization.get(user.organizationId) ?? 0n;
      const settled = received - paid < usdToMicros(USD_SETTLED_UNDER);
      const dueUsd = microsToMoney(settled ? 0n : received - paid);
      return { amountDue: usdToUzs(dueUsd, FAKE_USD_RATE), currency: CURRENCY };
    },
  };

  const goodsApi = createFakeCustomerGoodsApi(
    async () => {
      const state = await beforeRead();
      const user = shopper();
      if (state === 'empty') return [];
      return orders
        .filter(
          (order) =>
            order.organizationId === user.organizationId &&
            order.status === 'RECEIVED' &&
            !(options.seedReceivedGoods === false && order.orderNumber === 'IO-10480'),
        )
        .map((order) => ({
          order: orderOf(order, user),
          milestones: orderMilestones(order.events, order.submittedAt),
          receivedAt:
            order.events.find((e) => e.type === 'STATUS_CHANGED' && e.toStatus === 'RECEIVED')
              ?.occurredAt ?? null,
        }));
    },
    () => {
      const user = shopper();
      return user.organizationId + ':' + user.id;
    },
  );

  return {
    meApi,
    goodsApi,
    priceApi,
    cartApi,
    ordersApi,
    balanceApi,
    homeApi,
    /** Test handle: the manager records a payment for an organization (amount in so'm). */
    recordPayment(organizationId: string, amount: string): void {
      const before = paidByOrganization.get(organizationId) ?? 0n;
      paidByOrganization.set(
        organizationId,
        before + usdToMicros(uzsToUsdExact(amount, FAKE_USD_RATE)),
      );
    },
    /** Dev and test handle: a product that stops being orderable while it sits in carts. */
    deactivateProduct(code: string): void {
      const p = FAKE_PRODUCTS.find((f) => f.code === code);
      const current = p ? products.get(p.id) : undefined;
      if (p && current) products.set(p.id, { ...current, active: false });
    },
    /**
     * Dev and test handle: the stock of a product moves while it sits in carts (a sync, or another
     * customer's approved order). 0 = out of stock; null = no figure and no cap.
     */
    setStock(code: string, stock: number | null): void {
      const p = FAKE_PRODUCTS.find((f) => f.code === code);
      const current = p ? products.get(p.id) : undefined;
      if (p && current) products.set(p.id, { ...current, stock });
    },
    /** Test handle: another actor changes an order (bumps the version). */
    touchOrder(orderNumber: string): void {
      const record = orders.find((o) => o.orderNumber === orderNumber);
      if (record) record.rowVersion += 1;
    },
  };
}

export type FakeCustomerBackend = ReturnType<typeof createFakeCustomerBackend>;
