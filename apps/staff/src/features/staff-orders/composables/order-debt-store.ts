import type { StaffOrderStatusCount } from '@iorder/shared/staff-orders';
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import type { ViewState } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { sumMoney } from '@core/lib/money';
import type { StaffOrdersApi } from '../api/staff-orders-api';
import { DEBT_QUERY, totalsOf } from '../domain/order-filters';
import { isFullSummary, type FullOrderSummary } from '../domain/order-model';

// The directory pages read per-organization debt through this store, without the contracts.
export type { StaffOrderStatusCount };

/** The home page lists the newest few debts. */
export const DEBT_PREVIEW_SIZE = 4;

export interface OrderDebtStore {
  readonly state: Ref<ViewState>;
  /** Unpaid orders past the debt stage (see DEBT_FROM_STATUS); null until read. */
  readonly count: ComputedRef<number | null>;
  /** Gross so'm total of those orders at their own prices; null until read. */
  readonly sum: ComputedRef<string | null>;
  /** Their gross USD total, each at its rate from submit; null until read. Not the balance. */
  readonly sumUsd: ComputedRef<string | null>;
  /** `sumUsd` at the current rate, from the server; null until read or while no rate is known. */
  readonly sumUzs: ComputedRef<string | null>;
  /** How many organizations owe; null until read. */
  readonly customers: ComputedRef<number | null>;
  /** Count and sum per organization that owes. */
  readonly byOrganization: ShallowRef<Readonly<Record<string, StaffOrderStatusCount>>>;
  /** The newest debts, for the home page. */
  readonly newest: ShallowRef<readonly FullOrderSummary[]>;
  refresh: () => Promise<void>;
  reset: () => void;
}

/**
 * The order debt every screen shows (sidebar quick filter, home page card and list, customers
 * page), from the server's counts: the browser never adds up the history itself. FULL roles only
 * (manager, accountant, admin): the others are refused the payment status. Reads again whenever
 * `changes` moves (an order changed).
 */
export function createOrderDebtStore(
  api: Pick<StaffOrdersApi, 'listOrders' | 'countOrders'>,
  options: { changes?: Readonly<Ref<number>> } = {},
): OrderDebtStore {
  const state = ref<ViewState>('loading');
  const byStatus = shallowRef<Parameters<typeof totalsOf>[0] | null>(null);
  const byOrganization = shallowRef<Readonly<Record<string, StaffOrderStatusCount>>>({});
  const newest = shallowRef<readonly FullOrderSummary[]>([]);
  let run = 0;
  let asked = false;

  const totals = computed(() =>
    byStatus.value === null ? null : totalsOf(byStatus.value, DEBT_QUERY.statuses),
  );
  const debtEntries = computed(() =>
    byStatus.value === null
      ? []
      : DEBT_QUERY.statuses.flatMap((status) => {
          const entry = byStatus.value?.[status];
          return entry === undefined ? [] : [entry];
        }),
  );

  async function refresh(): Promise<void> {
    const mine = ++run;
    asked = true;
    try {
      const [counted, page] = await Promise.all([
        api.countOrders({ ...DEBT_QUERY, groupBy: 'ORGANIZATION' }),
        api.listOrders({ ...DEBT_QUERY, limit: DEBT_PREVIEW_SIZE }),
      ]);
      if (mine !== run) return;
      byStatus.value = counted.byStatus;
      byOrganization.value = counted.byOrganization ?? {};
      newest.value = page.orders.filter(isFullSummary);
      state.value = 'ready';
    } catch (caught) {
      if (mine !== run) return;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  function reset(): void {
    run += 1;
    asked = false;
    state.value = 'loading';
    byStatus.value = null;
    byOrganization.value = {};
    newest.value = [];
  }

  if (options.changes) watch(options.changes, () => void (asked ? refresh() : undefined));

  return {
    state,
    count: computed(() => totals.value?.count ?? null),
    sum: computed(() => totals.value?.sum ?? null),
    sumUsd: computed(() =>
      byStatus.value === null ? null : sumMoney(debtEntries.value.map((e) => e.totalUsd ?? '0')),
    ),
    sumUzs: computed(() => {
      if (byStatus.value === null) return null;
      const known = debtEntries.value.flatMap((e) =>
        e.totalUzsEquivalent === undefined || e.totalUzsEquivalent === null
          ? []
          : [e.totalUzsEquivalent],
      );
      return known.length === debtEntries.value.length ? sumMoney(known) : null;
    }),
    customers: computed(() =>
      byStatus.value === null ? null : Object.keys(byOrganization.value).length,
    ),
    byOrganization,
    newest,
    refresh,
    reset,
  };
}
