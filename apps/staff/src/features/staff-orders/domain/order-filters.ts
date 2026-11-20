import type { OrderStatus, PaymentPlan, PaymentStatus } from '@iorder/shared';
import { ORDER_STATUSES, PAYMENT_PLANS, PAYMENT_STATUSES } from '@iorder/shared';
import type {
  StaffOrderCountsQuery,
  StaffOrderCountsResponse,
  StaffOrderListQuery,
} from '@iorder/shared/staff-orders';
import { sumMoney } from '@core/lib/money';
import {
  DEBT_FROM_STATUS,
  FULFILLMENT_STAGES,
  isFullSummary,
  stageIndex,
  type FulfillmentStage,
  type OrderSummary,
} from './order-model';

/** The URL is shared and bookmarked: an absurdly long search is cut, not trusted. */
const MAX_TEXT_LENGTH = 80;

/** `CLOSED` is the design's "Rad etilgan / bekor": rejected or cancelled orders. */
export type StageFilter = FulfillmentStage | 'CLOSED';
export type PeriodFilter = 'today' | 'debt';

export interface OrderFilters {
  readonly stage: StageFilter | null;
  readonly payment: PaymentStatus | null;
  /** The customer's payment plan ("To'lov turi"), FULL or DEFERRED. */
  readonly plan: PaymentPlan | null;
  readonly period: PeriodFilter | null;
  /** Free text (number, organization, person); matched by `matchesOrderText`. */
  readonly text: string | null;
}

export const NO_ORDER_FILTERS: OrderFilters = {
  stage: null,
  payment: null,
  plan: null,
  period: null,
  text: null,
};

type Query = Record<string, string | null | (string | null)[] | undefined>;

const first = (value: Query[string]): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/** Reads filters from the URL query; anything unknown is ignored, never trusted. */
export function parseOrderFilters(query: Query): OrderFilters {
  const stage = first(query.stage);
  const payment = first(query.pay);
  const plan = first(query.plan);
  const period = first(query.period);
  const text = first(query.q)?.trim() ?? '';
  return {
    stage:
      stage === 'CLOSED' || (FULFILLMENT_STAGES as readonly string[]).includes(stage ?? '')
        ? (stage as StageFilter)
        : null,
    payment: (PAYMENT_STATUSES as readonly string[]).includes(payment ?? '')
      ? (payment as PaymentStatus)
      : null,
    plan: (PAYMENT_PLANS as readonly string[]).includes(plan ?? '') ? (plan as PaymentPlan) : null,
    period: period === 'today' || period === 'debt' ? period : null,
    text: text === '' ? null : text.slice(0, MAX_TEXT_LENGTH),
  };
}

/** Query entries for the active filters only (an empty object means "no filters"). */
export function orderFiltersToQuery(filters: OrderFilters): Record<string, string> {
  return {
    ...(filters.stage ? { stage: filters.stage } : {}),
    ...(filters.payment ? { pay: filters.payment } : {}),
    ...(filters.plan ? { plan: filters.plan } : {}),
    ...(filters.period ? { period: filters.period } : {}),
    ...(filters.text ? { q: filters.text } : {}),
  };
}

/** Plan, period and payment live in the "Filtrlar" row; stage and text have their own controls. */
export const secondaryFilterCount = (filters: OrderFilters): number =>
  Number(filters.payment !== null) +
  Number(filters.plan !== null) +
  Number(filters.period !== null);

/**
 * The stage this role handles itself, shown right after "All" in the status tabs. Only the
 * manager has a step in the orders list; the other roles work from their own queue pages. A
 * highlight only: the list never opens on it by itself, so "All orders" stays all orders.
 */
export function ownStageFor(roles: readonly string[]): FulfillmentStage | null {
  return roles.includes('MANAGER') ? 'SUBMITTED' : null;
}

export interface StageTabCount {
  readonly value: StageFilter | 'all';
  readonly count: number;
}

export const hasOrderFilters = (filters: OrderFilters): boolean =>
  filters.stage !== null ||
  filters.payment !== null ||
  filters.plan !== null ||
  filters.period !== null ||
  filters.text !== null;

const CLOSED_STATUSES: readonly OrderStatus[] = ['REJECTED', 'CANCELLED'];
/** Debt is unpaid from DEBT_FROM_STATUS on (see order-model); closed orders are no debt. */
const DEBT_STATUSES: readonly OrderStatus[] = FULFILLMENT_STAGES.slice(
  stageIndex(DEBT_FROM_STATUS),
);

/** The server query for every debt: the debt statuses, unpaid. */
export const DEBT_QUERY: { readonly statuses: OrderStatus[]; readonly paymentStatus: 'UNPAID' } = {
  statuses: [...DEBT_STATUSES],
  paymentStatus: 'UNPAID',
};

/** The statuses a stage tab shows. */
export function stageStatuses(stage: StageFilter | 'all'): readonly OrderStatus[] {
  if (stage === 'all') return ORDER_STATUSES;
  return stage === 'CLOSED' ? CLOSED_STATUSES : [stage];
}

/**
 * What the server is asked for: the page query, and the counts query with the statuses those
 * counts may add up (a count is per status, the stage tabs and the debt period are sets of them).
 * `list` is null when no order can match (a debt on an early stage, a PAID debt).
 */
export interface OrderListRequest {
  readonly list: StaffOrderListQuery | null;
  readonly counts: StaffOrderCountsQuery;
  readonly countable: readonly OrderStatus[];
}

export function orderListRequest(filters: OrderFilters): OrderListRequest {
  const debt = filters.period === 'debt';
  const countable = debt ? DEBT_STATUSES : ORDER_STATUSES;
  const payment = debt ? 'UNPAID' : filters.payment;
  const counts: StaffOrderCountsQuery = {
    ...(payment ? { paymentStatus: payment } : {}),
    ...(filters.plan ? { paymentPlan: filters.plan } : {}),
    ...(filters.period === 'today' ? { period: 'TODAY' } : {}),
    ...(filters.text ? { search: filters.text } : {}),
  };
  const statuses = stageStatuses(filters.stage ?? 'all').filter((s) => countable.includes(s));
  const none = statuses.length === 0 || (debt && filters.payment === 'PAID');
  const everything = statuses.length === ORDER_STATUSES.length;
  return {
    list: none ? null : { ...counts, ...(everything ? {} : { statuses }) },
    counts,
    countable: none ? [] : countable,
  };
}

/** Every order of one organization or one person, newest first (directory pages). */
export function ordersOfRequest(
  filter: Pick<StaffOrderCountsQuery, 'organizationId' | 'placedByUserId'>,
): OrderListRequest {
  return { list: { ...filter }, counts: { ...filter }, countable: ORDER_STATUSES };
}

export interface ListTotals {
  readonly count: number;
  /** Null when the counts carry no money (warehouse, driver). */
  readonly sum: string | null;
}

/** Count and sum of the given statuses; rejected and cancelled orders earn nothing. */
export function totalsOf(
  byStatus: StaffOrderCountsResponse['byStatus'],
  statuses: readonly OrderStatus[],
): ListTotals {
  const entries = statuses.flatMap((status) => {
    const entry = byStatus[status];
    return entry === undefined ? [] : [{ status, ...entry }];
  });
  const money = entries.some((e) => e.totalAmount !== undefined);
  return {
    count: entries.reduce((sum, e) => sum + e.count, 0),
    sum: money
      ? sumMoney(
          entries
            .filter((e) => !CLOSED_STATUSES.includes(e.status))
            .map((e) => e.totalAmount ?? '0'),
        )
      : null,
  };
}

/**
 * Counts for the status tabs: what each tab would show if pressed now, so payment, period and
 * text still apply but the stage does not. The tab counts then always add up with the list.
 */
export function stageTabCounts(
  byStatus: StaffOrderCountsResponse['byStatus'],
  countable: readonly OrderStatus[],
): StageTabCount[] {
  const count = (stage: StageFilter | 'all'): number =>
    totalsOf(
      byStatus,
      stageStatuses(stage).filter((s) => countable.includes(s)),
    ).count;
  return [
    { value: 'all', count: count('all') },
    ...FULFILLMENT_STAGES.map((stage) => ({ value: stage, count: count(stage) })),
    { value: 'CLOSED', count: count('CLOSED') },
  ];
}

/** Free-text match on number, organization and who placed the order (the design's quick search). */
export function matchesOrderText(order: OrderSummary, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === '') return true;
  const placer = isFullSummary(order) ? order.placedBy.fullName : '';
  return `${order.orderNumber} ${order.organizationName} ${placer}`.toLowerCase().includes(needle);
}
