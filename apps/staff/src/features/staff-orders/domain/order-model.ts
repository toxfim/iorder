import type { OrderStatus, PaymentPlan } from '@iorder/shared';
import type { PaymentMethod, StaffOrder, StaffOrderSummary } from '@iorder/shared/staff-orders';
import { sumMoney } from '@core/lib/money';
import { lineTotal } from '@core/lib/quantity';

// The staff order shapes are the shared contract's (`@iorder/shared/staff-orders`): a FULL view for
// manager, accountant and admin, a FULFILMENT view (no prices, totals, payment or accounting) for
// the warehouse and the driver. Nothing here decides a business rule; these are display helpers
// and "what to offer" hints. The server enforces every transition and every permission.

export type OrderSummary = StaffOrderSummary;
/** Re-exported for staff screens outside this feature (only `features/staff*` may import the contract). */
export type { PaymentMethod };
export type FullOrderSummary = Extract<StaffOrderSummary, { detail: 'FULL' }>;
export type FulfilmentOrderSummary = Extract<StaffOrderSummary, { detail: 'FULFILMENT' }>;
export type OrderDetail = StaffOrder;
export type FullOrderDetail = Extract<StaffOrder, { detail: 'FULL' }>;
export type FulfilmentOrderDetail = Extract<StaffOrder, { detail: 'FULFILMENT' }>;

export const isFullSummary = (order: StaffOrderSummary): order is FullOrderSummary =>
  order.detail === 'FULL';
export const isFullDetail = (order: StaffOrder): order is FullOrderDetail =>
  order.detail === 'FULL';

/** The list entry of a detail the server just returned (after an action). */
export function summaryOf(order: StaffOrder): StaffOrderSummary {
  const { id, orderNumber, organizationId, organizationName, organizationType } = order;
  const { status, itemCount } = order;
  const { submittedAt, updatedAt, rowVersion, driver, goodsReturn, goodsReturnedAt } = order;
  const base = {
    id,
    orderNumber,
    organizationId,
    organizationName,
    organizationType,
    status,
    itemCount,
    submittedAt,
    updatedAt,
    rowVersion,
    driver,
    goodsReturn,
    goodsReturnedAt,
  };
  if (order.detail === 'FULFILMENT') return { ...base, detail: 'FULFILMENT' };
  return {
    ...base,
    detail: 'FULL',
    organizationLabel: order.organizationLabel,
    paymentStatus: order.paymentStatus,
    paymentPlan: order.paymentPlan,
    totalAmount: order.totalAmount,
    currency: order.currency,
    usdRate: order.usdRate,
    totalUsd: order.totalUsd,
    customerComment: order.customerComment,
    placedBy: order.placedBy,
    priceListVersionId: order.priceListVersionId,
    accounting: order.accounting,
    // Absent for the admin: kept absent, never turned into an explicit undefined or null.
    ...(order.paymentMethod === undefined ? {} : { paymentMethod: order.paymentMethod }),
  };
}

/**
 * The six fulfillment stages the v1 dashboard shows, in order. REJECTED and CANCELLED sit outside
 * the pipeline.
 */
export const FULFILLMENT_STAGES = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
] as const satisfies readonly OrderStatus[];
export type FulfillmentStage = (typeof FULFILLMENT_STAGES)[number];

/** Position in the pipeline, or -1 for REJECTED / CANCELLED. */
export function stageIndex(status: OrderStatus): number {
  return (FULFILLMENT_STAGES as readonly OrderStatus[]).indexOf(status);
}

export const isClosedWithoutDelivery = (status: OrderStatus): boolean =>
  status === 'REJECTED' || status === 'CANCELLED';

/** [C, 2026-10-26] An order joins the organization's debt once it is RECEIVED (lifecycle 4). */
export const DEBT_FROM_STATUS: FulfillmentStage = 'RECEIVED';

/** Unpaid and past the debt stage. Needs the payment status, so only FULL summaries can be debts. */
export function isDebt(order: FullOrderSummary): boolean {
  const index = stageIndex(order.status);
  return order.paymentStatus === 'UNPAID' && index >= stageIndex(DEBT_FROM_STATUS) && index !== -1;
}

/**
 * Newest first by submit instant, then by id. Compared as instants (ISO strings with different
 * zone offsets do not sort as text) and as plain code points (not `localeCompare`, which would
 * make the order depend on the browser's locale).
 */
export function compareNewestFirst(
  a: Pick<StaffOrderSummary, 'submittedAt' | 'id'>,
  b: Pick<StaffOrderSummary, 'submittedAt' | 'id'>,
): number {
  const byTime = Date.parse(b.submittedAt) - Date.parse(a.submittedAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The reverse: oldest first, ties by id ascending. */
export const compareOldestFirst = (
  a: Pick<StaffOrderSummary, 'submittedAt' | 'id'>,
  b: Pick<StaffOrderSummary, 'submittedAt' | 'id'>,
): number => compareNewestFirst(b, a);

/** Pending the manager's decision: the queue on the home page. */
export const isAwaitingManager = (order: StaffOrderSummary): boolean =>
  order.status === 'SUBMITTED';

/** Counted as "faol" in the distribution: in the pipeline and not yet received. */
export const isActiveOrder = (order: StaffOrderSummary): boolean => {
  const index = stageIndex(order.status);
  return index !== -1 && index < stageIndex('RECEIVED');
};

/** Cancelling is possible until the goods are released (lifecycle §3). A hint; the server decides. */
export const canBeCancelled = (status: OrderStatus): boolean => {
  const index = stageIndex(status);
  return index !== -1 && index < stageIndex('RELEASED');
};

/**
 * The manager may change the payment method once the order is approved, until it is rejected or
 * cancelled ([C] 2026-10-24). A hint for what to offer; the server decides.
 */
export const canChangePaymentMethod = (status: OrderStatus): boolean =>
  status !== 'SUBMITTED' && !isClosedWithoutDelivery(status);

/** Only while the manager still has the order (owner 2026-10-29). A hint; the server decides. */
export const canChangePaymentPlan = (status: OrderStatus): boolean => status === 'SUBMITTED';

/**
 * What the order would cost under a plan, from its OWN price snapshots, shown before the manager
 * confirms; the server recomputes it. Null: a line has no price for the plan, so it cannot be chosen.
 */
export function planTotalOf(
  items: readonly Pick<
    FullOrderDetail['items'][number],
    'quantity' | 'fullUnitPrice' | 'deferredUnitPrice'
  >[],
  plan: PaymentPlan,
): string | null {
  const totals: string[] = [];
  for (const item of items) {
    const price = plan === 'FULL' ? item.fullUnitPrice : item.deferredUnitPrice;
    if (price === null) return null;
    totals.push(lineTotal(price, item.quantity));
  }
  return sumMoney(totals);
}

/** The total of a FULL view; `null` for the warehouse and the driver, who see no money. */
export const totalOf = (order: StaffOrderSummary): string | null =>
  order.detail === 'FULL' ? order.totalAmount : null;

/** The manager let this order pass without the accountant (the accountant's "new" list). */
export const isSkippedByManager = (order: FullOrderSummary): boolean =>
  order.accounting.mode === 'SKIPPED_BY_MANAGER';
