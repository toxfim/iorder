import type { PlanChoice } from '../domain/allocation-plan';
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { OrderStatus, PaymentPlan } from '@iorder/shared';
import type {
  PaymentMethod,
  StaffOrder,
  StaffOrderListQuery,
  StaffOrderSummary,
} from '@iorder/shared/staff-orders';
import type { ViewState } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { StaffOrdersApi } from '../api/staff-orders-api';
import {
  compareOldestFirst,
  isAwaitingManager,
  isFullSummary,
  summaryOf,
  type FullOrderSummary,
} from '../domain/order-model';

/** What a command needs to know about the order: the version the person saw. */
export type OrderRef = Pick<StaffOrderSummary, 'id' | 'rowVersion'>;

/** One page of a queue is at most 100 orders (the contract's limit); at most this many pages. */
export const LIST_PAGE_SIZE = 100;
export const MAX_LIST_PAGES = 20;
/** A "recent" status is read as one short page: the role pages show a handful. */
export const RECENT_PAGE_SIZE = 25;

/**
 * What a role page needs, asked from the server by status so it never downloads the whole history.
 * `queue` statuses are read to the end (the page must show them whole); `recent` statuses only
 * as the newest page (the page shows a handful).
 */
export interface OrdersScope {
  readonly queue: readonly OrderStatus[];
  readonly recent: readonly OrderStatus[];
  /** Also read every order whose goods still have to come back, whatever its age. */
  readonly goodsReturnPending?: boolean;
}

const NOTHING: OrdersScope = { queue: [], recent: [] };

/** Both scopes together; a status read whole in one is read whole. */
export function mergeScopes(a: OrdersScope, b: OrdersScope): OrdersScope {
  const queue = [...new Set([...a.queue, ...b.queue])];
  const recent = [...new Set([...a.recent, ...b.recent])].filter((s) => !queue.includes(s));
  return a.goodsReturnPending || b.goodsReturnPending
    ? { queue, recent, goodsReturnPending: true }
    : { queue, recent };
}

export interface OrdersStore {
  readonly state: Ref<ViewState>;
  readonly error: Ref<unknown>;
  /** The orders of the scopes asked for (never the whole history: lists page on the server). */
  readonly orders: Readonly<Ref<readonly StaffOrderSummary[]>>;
  /**
   * True when a queue that must be read whole was cut at MAX_LIST_PAGES pages: what is computed
   * from it is then a lower bound. Totals come from the server's counts and summary instead.
   */
  readonly truncated: Ref<boolean>;
  /** Waiting for the manager, oldest first. FULL views only (they carry the money). */
  readonly pending: ComputedRef<readonly FullOrderSummary[]>;
  /** Moves on every change the server answered: server-paged lists read again when it moves. */
  readonly revision: Readonly<Ref<number>>;
  /** Reloads what was last asked for. */
  load: (options?: { silent?: boolean }) => Promise<void>;
  /** Forgets everything (a different person signs in) and discards any read still in flight. */
  reset: () => void;
  /**
   * The scope every page keeps (the shell sets it: the manager's queue feeds the badge and the
   * home page). Later page scopes are read together with it, so a role page never drops it.
   */
  loadBase: (scope: OrdersScope) => Promise<void>;
  /** A role page's own server-filtered read, together with the base scope. */
  loadFor: (scope: OrdersScope) => Promise<void>;
  approve: (
    order: OrderRef,
    options: {
      skipAccounting: boolean;
      paymentMethod: PaymentMethod;
      plan: PlanChoice;
      comment?: string;
    },
  ) => Promise<StaffOrder>;
  reject: (order: OrderRef, reason: string) => Promise<StaffOrder>;
  cancel: (order: OrderRef, reason: string) => Promise<StaffOrder>;
  setPaymentMethod: (orderId: string, method: PaymentMethod) => Promise<StaffOrder>;
  setPaymentPlan: (order: OrderRef, plan: PaymentPlan) => Promise<StaffOrder>;
  editItems: (
    order: OrderRef,
    changes: readonly { itemId: string; quantity: string | null }[],
  ) => Promise<StaffOrder>;
  accountingApprove: (order: OrderRef, comment?: string) => Promise<StaffOrder>;
  accountingReject: (order: OrderRef, reason: string) => Promise<StaffOrder>;
  release: (order: OrderRef, driverUserId: string, comment?: string) => Promise<StaffOrder>;
  deliver: (order: OrderRef, comment?: string) => Promise<StaffOrder>;
  markGoodsReturned: (order: OrderRef) => Promise<StaffOrder>;
}

/**
 * The orders every staff screen shares (home page, list, role queues, sidebar badge). The server
 * decides every change; the store only replaces what the server answered and tells the activity
 * feed to refresh. Every command sends the row version of the order the person saw.
 */
export function createOrdersStore(
  api: StaffOrdersApi,
  options: { onChanged?: () => void } = {},
): OrdersStore {
  const orders = shallowRef<readonly StaffOrderSummary[]>([]);
  const state = ref<ViewState>('loading');
  const error = shallowRef<unknown>(null);
  const truncated = ref(false);
  const revision = ref(0);
  // `run` moves on every load AND every change the server answered, so a read that started
  // before a change can tell its answer may be older than the summary the change stored.
  // `loadRun` moves on loads only: the newest load owns the state.
  let run = 0;
  let loadRun = 0;
  let base: OrdersScope = NOTHING;
  let requested: OrdersScope = NOTHING;

  async function readPages(
    filter: Pick<StaffOrderListQuery, 'status' | 'goodsReturn'>,
    firstPageOnly: boolean,
  ): Promise<{ list: StaffOrderSummary[]; cut: boolean }> {
    const list: StaffOrderSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await api.listOrders({
        ...filter,
        limit: firstPageOnly ? RECENT_PAGE_SIZE : LIST_PAGE_SIZE,
        cursor,
      });
      list.push(...result.orders);
      if (result.nextCursor === null) return { list, cut: false };
      if (firstPageOnly) return { list, cut: false };
      cursor = result.nextCursor;
    }
    return { list, cut: true };
  }

  async function readRequested(): Promise<{ list: StaffOrderSummary[]; cut: boolean }> {
    const parts = await Promise.all([
      ...requested.queue.map((status) => readPages({ status }, false)),
      ...requested.recent.map((status) => readPages({ status }, true)),
      ...(requested.goodsReturnPending ? [readPages({ goodsReturn: 'PENDING' }, false)] : []),
    ]);
    const byId = new Map(parts.flatMap((part) => part.list).map((o) => [o.id, o]));
    return { list: [...byId.values()], cut: parts.some((part) => part.cut) };
  }

  async function load({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const mine = ++run;
    const myLoad = ++loadRun;
    if (!silent) state.value = 'loading';
    try {
      const { list, cut } = await readRequested();
      if (myLoad !== loadRun) return;
      // A change landed while this read was in flight: the list may predate it, and writing it
      // would bring back the old summary. Read again instead; the state stays as it is meanwhile.
      if (mine !== run) return load({ silent: true });
      orders.value = list;
      truncated.value = cut;
      error.value = null;
      state.value = list.length === 0 ? 'empty' : 'ready';
    } catch (caught) {
      if (myLoad !== loadRun) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  function reset(): void {
    run += 1;
    loadRun += 1;
    base = NOTHING;
    requested = NOTHING;
    orders.value = [];
    truncated.value = false;
    error.value = null;
    state.value = 'loading';
  }

  const pending = computed(() =>
    orders.value.filter(isFullSummary).filter(isAwaitingManager).slice().sort(compareOldestFirst),
  );

  function replace(updated: StaffOrder): StaffOrder {
    run += 1;
    const summary = summaryOf(updated);
    const known = orders.value.some((o) => o.id === summary.id);
    orders.value = known
      ? orders.value.map((o) => (o.id === summary.id ? summary : o))
      : [summary, ...orders.value];
    return updated;
  }

  async function mutate(request: Promise<StaffOrder>): Promise<StaffOrder> {
    const updated = replace(await request);
    revision.value += 1;
    options.onChanged?.();
    return updated;
  }

  const withVersion = (order: OrderRef): { expectedRowVersion: number } => ({
    expectedRowVersion: order.rowVersion,
  });
  // `comment` is left out of the body when empty (the contract trims and allows it to be absent).
  const optionalComment = (comment: string | undefined): { comment?: string } => {
    const text = comment?.trim();
    return text ? { comment: text } : {};
  };

  return {
    state,
    error,
    orders,
    truncated,
    pending,
    revision,
    load,
    reset,
    loadBase: (scope) => {
      base = scope;
      requested = mergeScopes(base, requested);
      return load();
    },
    loadFor: (scope) => {
      requested = mergeScopes(base, scope);
      return load();
    },
    approve: (order, approveOptions) =>
      mutate(
        api.approve(order.id, {
          ...withVersion(order),
          paymentMethod: approveOptions.paymentMethod,
          allocationMode: approveOptions.plan.allocationMode,
          allocations: [...approveOptions.plan.allocations],
          ...optionalComment(approveOptions.comment),
          // Sent only when ticked: the field is an option of the manager's approve.
          ...(approveOptions.skipAccounting ? { skipAccounting: true } : {}),
        }),
      ),
    reject: (order, reason) => mutate(api.reject(order.id, { reason, ...withVersion(order) })),
    cancel: (order, reason) => mutate(api.cancel(order.id, { reason, ...withVersion(order) })),
    setPaymentMethod: (orderId, paymentMethod) =>
      mutate(api.setPaymentMethod(orderId, { paymentMethod })),
    setPaymentPlan: (order, paymentPlan) =>
      mutate(api.setPaymentPlan(order.id, { paymentPlan, ...withVersion(order) })),
    editItems: (order, changes) =>
      mutate(api.editItems(order.id, { changes: [...changes], ...withVersion(order) })),
    accountingApprove: (order, comment) =>
      mutate(
        api.accountingApprove(order.id, { ...optionalComment(comment), ...withVersion(order) }),
      ),
    accountingReject: (order, reason) =>
      mutate(api.accountingReject(order.id, { reason, ...withVersion(order) })),
    release: (order, driverUserId, comment) =>
      mutate(
        api.release(order.id, { driverUserId, ...optionalComment(comment), ...withVersion(order) }),
      ),
    deliver: (order, comment) =>
      mutate(api.deliver(order.id, { ...optionalComment(comment), ...withVersion(order) })),
    markGoodsReturned: (order) => mutate(api.markGoodsReturned(order.id, withVersion(order))),
  };
}
