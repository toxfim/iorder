import { fifoPlanOf } from '../api/fake-allocation';
import { describe, expect, it, vi } from 'vitest';
import { listAll, orderId, signedInServices, summaryByNumber } from '@/test-utils/orders';
import { ORDER_STATUSES, type OrderStatus } from '@iorder/shared';
import {
  NO_ORDER_FILTERS,
  hasOrderFilters,
  matchesOrderText,
  orderFiltersToQuery,
  orderListRequest,
  parseOrderFilters,
  stageTabCounts,
  totalsOf,
  type OrderFilters,
} from './order-filters';
import {
  DEBT_FROM_STATUS,
  FULFILLMENT_STAGES,
  canBeCancelled,
  canChangePaymentMethod,
  canChangePaymentPlan,
  compareNewestFirst,
  compareOldestFirst,
  isActiveOrder,
  isDebt,
  isFullSummary,
  isSkippedByManager,
  planTotalOf,
  stageIndex,
  totalOf,
  type FullOrderSummary,
  type OrderSummary,
} from './order-model';
import { eventTitleKey, progressSegments } from './order-presentation';
import { MANAGER_SCOPE } from './order-scopes';

async function loadOrders(identity = 'manager'): Promise<readonly OrderSummary[]> {
  const { services } = await signedInServices(identity);
  return listAll(services);
}

const find = (orders: readonly OrderSummary[], number: string): FullOrderSummary => {
  const found = orders.find((o) => o.orderNumber === number);
  if (!found || !isFullSummary(found)) throw new Error(`No FULL summary for ${number}`);
  return found;
};

describe('order model', () => {
  it('keeps the six pipeline stages of the design in order, closed orders outside', () => {
    expect(FULFILLMENT_STAGES.map(stageIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(stageIndex('REJECTED')).toBe(-1);
    expect(stageIndex('CANCELLED')).toBe(-1);
  });

  it('reads the total from the server summary, and only a FULL view has one', async () => {
    const orders = await loadOrders();
    expect(totalOf(find(orders, 'IO-10491'))).toBe('23570000.00');
    expect(find(orders, 'IO-10491').itemCount).toBe(4);
    const forWarehouse = await loadOrders('warehouse');
    expect(forWarehouse.length).toBeGreaterThan(0);
    for (const order of forWarehouse) expect(totalOf(order)).toBeNull();
  });

  it('cancelling is possible until release; debt starts at the assumed status', async () => {
    const orders = await loadOrders();
    expect(canBeCancelled(find(orders, 'IO-10491').status)).toBe(true);
    expect(canBeCancelled(find(orders, 'IO-10484').status)).toBe(true);
    expect(canBeCancelled(find(orders, 'IO-10488').status)).toBe(false);
    expect(DEBT_FROM_STATUS).toBe('RECEIVED');
    // the payment method changes after the approval, never before nor on a closed order
    expect(canChangePaymentMethod('SUBMITTED')).toBe(false);
    for (const status of [
      'MANAGER_APPROVED',
      'ACCOUNTING_CLEARED',
      'RELEASED',
      'RECEIVED',
    ] as const)
      expect(canChangePaymentMethod(status)).toBe(true);
    expect(canChangePaymentMethod('REJECTED')).toBe(false);
    expect(canChangePaymentMethod('CANCELLED')).toBe(false);
    expect(isDebt(find(orders, 'IO-10470'))).toBe(true);
    expect(isDebt(find(orders, 'IO-10477'))).toBe(false); // delivered, not yet received
    expect(isDebt(find(orders, 'IO-10488'))).toBe(false); // released but PAID
    expect(isDebt(find(orders, 'IO-10491'))).toBe(false); // unpaid but still with the manager
    expect(isActiveOrder(find(orders, 'IO-10470'))).toBe(false); // received
  });

  it('knows which orders the manager passed without the accountant', async () => {
    const orders = await loadOrders();
    expect(isSkippedByManager(find(orders, 'IO-10484'))).toBe(true);
    expect(isSkippedByManager(find(orders, 'IO-10477'))).toBe(false);
  });
});

describe('order filters', () => {
  it('reads filters from the URL and ignores anything it does not know', () => {
    expect(
      parseOrderFilters({ stage: 'SUBMITTED', pay: 'UNPAID', plan: 'DEFERRED', period: 'today' }),
    ).toEqual({
      stage: 'SUBMITTED',
      payment: 'UNPAID',
      plan: 'DEFERRED',
      period: 'today',
      text: null,
    });
    expect(
      parseOrderFilters({ stage: 'nonsense', pay: 'x', plan: 'LATER', period: ['debt'] }),
    ).toEqual({
      stage: null,
      payment: null,
      plan: null,
      period: 'debt',
      text: null,
    });
    expect(parseOrderFilters({})).toEqual(NO_ORDER_FILTERS);
  });

  it('round-trips through the query and reports whether any filter is on', () => {
    const filters = parseOrderFilters({ stage: 'CLOSED', period: 'debt' });
    expect(orderFiltersToQuery(filters)).toEqual({ stage: 'CLOSED', period: 'debt' });
    expect(hasOrderFilters(filters)).toBe(true);
    expect(hasOrderFilters(NO_ORDER_FILTERS)).toBe(false);
    expect(orderFiltersToQuery(NO_ORDER_FILTERS)).toEqual({});
  });

  // The server filters (the fake backend plays it); the list comes newest first.
  async function serverList(filters: OrderFilters, identity = 'manager'): Promise<string[]> {
    const { services } = await signedInServices(identity);
    const { list } = orderListRequest(filters);
    if (list === null) return [];
    const page = await services.ordersApi.listOrders({ ...list, limit: 100 });
    return page.orders.map((o) => o.orderNumber);
  }

  it('asks the server for the design filters; the list comes newest first', async () => {
    const numbers = (filters: Partial<OrderFilters> = {}) =>
      serverList({ ...NO_ORDER_FILTERS, ...filters });
    expect(await numbers({ stage: 'SUBMITTED' })).toEqual(['IO-10491', 'IO-10490', 'IO-10487']);
    expect(await numbers({ period: 'today' })).toEqual(['IO-10491', 'IO-10490']);
    expect(await numbers({ period: 'debt' })).toEqual(['IO-10470']);
    expect((await numbers({ payment: 'PAID' })).sort()).toEqual([
      'IO-10455',
      'IO-10480',
      'IO-10486',
      'IO-10488',
    ]);
    expect(await numbers({ stage: 'CLOSED' })).toEqual([]);
    // The payment plan splits the list in two; it reaches the server as `paymentPlan`.
    const plans = [...(await numbers({ plan: 'FULL' })), ...(await numbers({ plan: 'DEFERRED' }))];
    expect(plans.sort()).toEqual((await numbers()).sort());
    expect(orderListRequest({ ...NO_ORDER_FILTERS, plan: 'DEFERRED' }).counts).toEqual({
      paymentPlan: 'DEFERRED',
    });
    // A debt is never on an early stage, nor PAID: nothing is asked for.
    expect(
      orderListRequest({ ...NO_ORDER_FILTERS, period: 'debt', stage: 'SUBMITTED' }).list,
    ).toBeNull();
    expect(
      orderListRequest({ ...NO_ORDER_FILTERS, period: 'debt', payment: 'PAID' }).list,
    ).toBeNull();
    const all = await numbers();
    expect(all[0]).toBe('IO-10491');
    expect(all).toHaveLength(12);
  });

  it('maps the filters to the server query and adds the tabs up from the counts', () => {
    expect(orderListRequest(NO_ORDER_FILTERS)).toEqual({
      list: {},
      counts: {},
      countable: ORDER_STATUSES,
    });
    const debt = orderListRequest({ ...NO_ORDER_FILTERS, period: 'debt', text: 'alpha' });
    expect(debt.list).toEqual({
      paymentStatus: 'UNPAID',
      search: 'alpha',
      statuses: ['RECEIVED'],
    });
    expect(debt.counts).toEqual({ paymentStatus: 'UNPAID', search: 'alpha' });
    expect(
      orderListRequest({ ...NO_ORDER_FILTERS, stage: 'CLOSED', period: 'today' }).list,
    ).toEqual({
      period: 'TODAY',
      statuses: ['REJECTED', 'CANCELLED'],
    });

    const byStatus = {
      SUBMITTED: { count: 2, totalAmount: '100.00' },
      RELEASED: { count: 1, totalAmount: '50.50' },
      CANCELLED: { count: 3, totalAmount: '999.00' },
    };
    const tabs = (countable: readonly OrderStatus[]) =>
      Object.fromEntries(stageTabCounts(byStatus, countable).map((tab) => [tab.value, tab.count]));
    expect(tabs(ORDER_STATUSES)).toMatchObject({ all: 6, SUBMITTED: 2, RELEASED: 1, CLOSED: 3 });
    expect(tabs(debt.countable)).toMatchObject({ all: 0, SUBMITTED: 0, RELEASED: 0, CLOSED: 0 });
    // Cancelled and rejected orders count, but earn nothing.
    expect(totalsOf(byStatus, ORDER_STATUSES)).toEqual({ count: 6, sum: '150.50' });
    expect(totalsOf({ SUBMITTED: { count: 2 } }, ORDER_STATUSES)).toEqual({ count: 2, sum: null });
  });

  it('keeps the search text in the URL, trimmed and cut, and the server applies it', async () => {
    const filters = parseOrderFilters({ q: '  mobile center ' });
    expect(filters.text).toBe('mobile center');
    expect(orderFiltersToQuery(filters)).toEqual({ q: 'mobile center' });
    expect(hasOrderFilters(filters)).toBe(true);
    expect(parseOrderFilters({ q: '   ' }).text).toBeNull();
    expect(parseOrderFilters({ q: 'x'.repeat(500) }).text).toHaveLength(80);
    const orders = await loadOrders();
    const found = await serverList(filters);
    expect(found.length).toBeGreaterThan(0);
    for (const number of found) {
      expect(find(orders, number).organizationName.toLowerCase()).toContain('mobile center');
    }
    // The placer's name is a FULL-view fact: the warehouse cannot search by it.
    expect(await serverList({ ...NO_ORDER_FILTERS, text: 'akmal' })).not.toEqual([]);
    expect(await serverList({ ...NO_ORDER_FILTERS, text: 'akmal' }, 'warehouse')).toEqual([]);
    expect(await serverList({ ...filters, text: 'zzz' })).toEqual([]);
  });

  it('matches free text on number, organization and person', async () => {
    const orders = await loadOrders();
    const order = find(orders, 'IO-10490');
    expect(matchesOrderText(order, 'mobile center')).toBe(true);
    expect(matchesOrderText(order, 'akmal')).toBe(true);
    expect(matchesOrderText(order, '10490')).toBe(true);
    expect(matchesOrderText(order, 'xyz')).toBe(false);
    expect(matchesOrderText(order, '  ')).toBe(true);
  });
});

describe('orders store', () => {
  it('keeps the manager queue as the base and reads the debt from the server counts (v1 seed data)', async () => {
    const { services } = await signedInServices('manager');
    const store = services.ordersStore;
    await store.loadBase(MANAGER_SCOPE);
    expect(store.truncated.value).toBe(false);
    expect(store.pending.value.map((o) => o.orderNumber)).toEqual([
      'IO-10487',
      'IO-10490',
      'IO-10491',
    ]);
    // Only the queue is held: no page downloads the history.
    expect(store.orders.value.every((o) => o.status === 'SUBMITTED')).toBe(true);
    const debt = services.orderDebtStore;
    await debt.refresh();
    expect(debt.count.value).toBe(1);
    expect(debt.customers.value).toBe(1);
    expect(debt.newest.value.map((o) => o.orderNumber)).toEqual(['IO-10470']);
    expect(debt.sum.value).toBe(debt.newest.value[0]?.totalAmount);
  });

  it('reads every page of a queue and says when it had to stop', async () => {
    const { services } = await signedInServices('manager');
    const calls: (string | undefined)[] = [];
    const real = services.ordersApi.listOrders.bind(services.ordersApi);
    services.ordersApi.listOrders = (query) => {
      calls.push(query?.cursor);
      return real({ ...query, limit: 1 });
    };
    await services.ordersStore.loadFor({ queue: ['SUBMITTED'], recent: [] });
    expect(calls.length).toBe(3); // 3 waiting orders in pages of 1
    expect(services.ordersStore.orders.value).toHaveLength(3);
    expect(services.ordersStore.truncated.value).toBe(false);
  });

  it('keeps a change when a slower reload that started before it answers afterwards', async () => {
    const { services } = await signedInServices('manager');
    const store = services.ordersStore;
    await store.loadBase(MANAGER_SCOPE);
    const order = summaryByNumber(services, 'IO-10491');
    if (!order) throw new Error('missing');
    const real = services.ordersApi.listOrders.bind(services.ordersApi);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    services.ordersApi.listOrders = async (query) => {
      calls += 1;
      // The first read is taken before the approval but delivered after it.
      if (calls === 1) {
        const stale = await real(query);
        await gate;
        return stale;
      }
      return real(query);
    };
    const reload = store.load({ silent: true });
    await store.approve(order, {
      skipAccounting: false,
      paymentMethod: 'CASH',
      plan: await fifoPlanOf(services.ordersApi, order.id),
    });
    release();
    await reload;
    // The stale answer (still SUBMITTED) was dropped and the queue read again: the approved order
    // has left it instead of coming back as waiting.
    expect(summaryByNumber(services, 'IO-10491')).toBeUndefined();
    expect(store.pending.value.map((o) => o.orderNumber)).not.toContain('IO-10491');
    expect(calls).toBeGreaterThan(1);
  });

  it('asks the server by status for a role scope and never for the whole list', async () => {
    const { services } = await signedInServices('warehouse');
    const queries: (string | undefined)[] = [];
    const real = services.ordersApi.listOrders.bind(services.ordersApi);
    services.ordersApi.listOrders = (query) => {
      queries.push(query?.status);
      return real(query);
    };
    await services.ordersStore.loadFor({ queue: ['ACCOUNTING_CLEARED'], recent: ['DELIVERED'] });
    expect(queries.sort()).toEqual(['ACCOUNTING_CLEARED', 'DELIVERED']);
    expect(
      services.ordersStore.orders.value.every((o) =>
        ['ACCOUNTING_CLEARED', 'DELIVERED'].includes(o.status),
      ),
    ).toBe(true);
  });

  it('reads a role page scope together with the base, never dropping the base', async () => {
    const { services } = await signedInServices('manager');
    await services.ordersStore.loadBase(MANAGER_SCOPE);
    await services.ordersStore.loadFor({ queue: ['RELEASED'], recent: [] });
    expect([...new Set(services.ordersStore.orders.value.map((o) => o.status))].sort()).toEqual([
      'RELEASED',
      'SUBMITTED',
    ]);
    expect(services.ordersStore.pending.value).toHaveLength(3);
  });

  it('sends the row version the person saw and replaces the order with the answer', async () => {
    const { services } = await signedInServices('manager');
    await services.ordersStore.loadBase(MANAGER_SCOPE);
    await services.activityStore.refresh();
    const before = services.activityStore.entries.value.length;
    const order = summaryByNumber(services, 'IO-10491');
    if (!order) throw new Error('missing');
    const approve = vi.spyOn(services.ordersApi, 'approve');
    const plan = await fifoPlanOf(services.ordersApi, order.id);
    await services.ordersStore.approve(order, {
      skipAccounting: false,
      paymentMethod: 'CASH',
      plan,
    });
    expect(approve).toHaveBeenCalledWith(orderId('IO-10491'), {
      expectedRowVersion: order.rowVersion,
      paymentMethod: 'CASH',
      ...plan,
    });
    const after = summaryByNumber(services, 'IO-10491');
    expect(after?.status).toBe('MANAGER_APPROVED');
    expect(after?.rowVersion).toBe(order.rowVersion + 1);
    expect(services.ordersStore.pending.value).toHaveLength(2);
    // The feed is re-read through the onChanged hook of createOrdersStore.
    await vi.waitFor(() =>
      expect(services.activityStore.entries.value[0]?.params.orderId).toBe('IO-10491'),
    );
    expect(services.activityStore.entries.value.length).toBe(Math.min(before + 1, 8));
  });
});

describe('progress segments', () => {
  it('marks accounting skipped by the manager apart from a real clearance', () => {
    expect(progressSegments('ACCOUNTING_CLEARED', 'SKIPPED_BY_MANAGER')).toEqual([
      'done',
      'done',
      'skipped',
      'next',
      'todo',
      'todo',
    ]);
    expect(progressSegments('ACCOUNTING_CLEARED', 'APPROVED')[2]).toBe('done');
    expect(progressSegments('ACCOUNTING_CLEARED')[2]).toBe('done');
  });

  it('shows nothing for a closed order, even with the skip flag', () => {
    expect(progressSegments('REJECTED', 'SKIPPED_BY_MANAGER')).toEqual(Array(6).fill('todo'));
  });

  it('shows where a closed order stopped once the status it left is known', () => {
    expect(progressSegments('REJECTED', undefined, 'SUBMITTED')).toEqual([
      'done',
      'closed',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(progressSegments('CANCELLED', 'SKIPPED_BY_MANAGER', 'ACCOUNTING_CLEARED')).toEqual([
      'done',
      'done',
      'skipped',
      'closed',
      'todo',
      'todo',
    ]);
    expect(progressSegments('CANCELLED', undefined, null)).toEqual(Array(6).fill('todo'));
  });
});

describe('timeline event titles', () => {
  const event = (
    type: Parameters<typeof eventTitleKey>[0]['type'],
    toStatus: Parameters<typeof eventTitleKey>[0]['toStatus'],
    role: Parameters<typeof eventTitleKey>[0]['actor']['role'],
  ) =>
    eventTitleKey({
      id: 'e',
      type,
      occurredAt: '2026-10-19T04:00:00.000Z',
      fromStatus: null,
      toStatus,
      actor: { userId: null, role, name: null },
      comment: null,
      accountingMode: null,
      driver: null,
      itemsChange: null,
      paymentChange: null,
      paymentPlanChange: null,
      paymentMethodChange: null,
      notifications: [],
    });

  it('names a status move by its target status and acting role', () => {
    expect(event('STATUS_CHANGED', 'MANAGER_APPROVED', 'MANAGER')).toBe('MANAGER_APPROVED');
    expect(event('STATUS_CHANGED', 'ACCOUNTING_CLEARED', 'ACCOUNTANT')).toBe('ACCOUNTING_APPROVED');
    expect(event('STATUS_CHANGED', 'ACCOUNTING_CLEARED', 'MANAGER')).toBe('ACCOUNTING_CLEARED');
    expect(event('STATUS_CHANGED', 'REJECTED', 'ACCOUNTANT')).toBe('ACCOUNTING_REJECTED');
    expect(event('STATUS_CHANGED', 'REJECTED', 'MANAGER')).toBe('REJECTED');
    expect(event('ACCOUNTING_SKIPPED', 'ACCOUNTING_CLEARED', 'MANAGER')).toBe('ACCOUNTING_SKIPPED');
    expect(event('PAYMENT_STATUS_CHANGED', null, 'MANAGER')).toBe('PAYMENT_CHANGED');
    expect(event('PAYMENT_METHOD_CHANGED', null, 'MANAGER')).toBe('PAYMENT_METHOD_CHANGED');
  });
});

describe('order sorting', () => {
  const at = (id: string, submittedAt: string) => ({ id, submittedAt });

  it('sorts newest first by instant, then by id, without locale collation', () => {
    const list = [
      at('IO-2', '2026-10-19T04:00:00Z'),
      at('IO-10', '2026-10-19T04:00:00Z'),
      at('IO-1', '2026-10-19T05:00:00Z'),
      // the same instant written with an offset: 08:30+05:00 is 03:30Z, the oldest
      at('IO-3', '2026-10-19T08:30:00+05:00'),
    ];
    expect([...list].sort(compareNewestFirst).map((o) => o.id)).toEqual([
      'IO-1',
      'IO-2',
      'IO-10',
      'IO-3',
    ]);
    expect([...list].sort(compareOldestFirst).map((o) => o.id)).toEqual([
      'IO-3',
      'IO-10',
      'IO-2',
      'IO-1',
    ]);
  });
});

describe('payment plan hints', () => {
  const item = (quantity: string, full: string, deferred: string | null) => ({
    quantity,
    fullUnitPrice: full,
    deferredUnitPrice: deferred,
  });

  it('offers the change only while the order is SUBMITTED', () => {
    expect(canChangePaymentPlan('SUBMITTED')).toBe(true);
    for (const status of ['MANAGER_APPROVED', 'RELEASED', 'REJECTED', 'CANCELLED'] as const) {
      expect(canChangePaymentPlan(status)).toBe(false);
    }
  });

  it('previews both totals from the snapshots of the order', () => {
    const items = [item('2', '100.00', '120.00'), item('1', '50.50', '60.25')];
    expect(planTotalOf(items, 'FULL')).toBe('250.50');
    expect(planTotalOf(items, 'DEFERRED')).toBe('300.25');
  });

  it('has no deferred total when a line has no deferred price', () => {
    const items = [item('2', '100.00', '120.00'), item('1', '50.50', null)];
    expect(planTotalOf(items, 'DEFERRED')).toBeNull();
    expect(planTotalOf(items, 'FULL')).toBe('250.50');
  });
});
