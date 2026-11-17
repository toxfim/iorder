import { ORDER_STATUSES, type OrderStatus, type StaffRole } from '@iorder/shared';
import type {
  DashboardQueue,
  DashboardQueueKey,
  StaffDashboardSummary,
  StaffOrderSummary,
} from '@iorder/shared/staff-orders';
import { ApiError, PermissionDeniedError } from '@core/lib/api-errors';
import {
  businessParts,
  isSameBusinessDay,
  systemClock,
  type Clock,
} from '@core/lib/business-clock';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { sumMoney } from '@core/lib/money';
import type { DashboardSummaryApi } from './dashboard-summary-api';

// In-memory stand-in for GET /staff/dashboard/summary. It mirrors the server's rules, not just the
// shape: the sections a role may not see are ABSENT (no key), the warehouse and the driver get no
// money anywhere, every status is zero-filled, a queue exists only for the roles that work it,
// "today" leaves out rejected and cancelled orders, ages are whole minutes. It reads the same fake
// order list the other screens use (already scoped to the viewer), so the figures agree with the
// lists. Never part of a production bundle (check-bundle looks for its marker).

export const FAKE_DASHBOARD_MARKER = 'iorder-fake-dashboard-summary';

const MINUTE = 60_000;

/** The numbers that do not come from orders; fixed unless the wiring says otherwise. */
export interface FakeSummaryExtras {
  readonly organizationsAwaitingActivationCount: number;
  readonly unpricedProductsCount: number;
  readonly lastSheetSync: NonNullable<StaffDashboardSummary['lastSheetSync']>;
  readonly usdRate: NonNullable<StaffDashboardSummary['usdRate']>;
}

export interface FakeDashboardSummaryOptions {
  /** Every order the signed-in role may see (the fake order store's own read, no request). */
  readonly readOrders: () => readonly StaffOrderSummary[];
  readonly roles: () => readonly StaffRole[];
  readonly clock?: Clock;
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  readonly extras?: () => FakeSummaryExtras;
}

const QUEUES: readonly {
  readonly key: DashboardQueueKey;
  readonly roles: readonly StaffRole[];
  readonly matches: (order: StaffOrderSummary) => boolean;
}[] = [
  {
    key: 'AWAITING_MANAGER',
    roles: ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    matches: (o) => o.status === 'SUBMITTED',
  },
  {
    key: 'AWAITING_ACCOUNTING',
    roles: ['ACCOUNTANT', 'MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    matches: (o) => o.status === 'MANAGER_APPROVED',
  },
  {
    key: 'SKIPPED_ACCOUNTING_TO_REVIEW',
    roles: ['ACCOUNTANT'],
    matches: (o) =>
      o.detail === 'FULL' &&
      o.accounting.mode === 'SKIPPED_BY_MANAGER' &&
      o.status !== 'REJECTED' &&
      o.status !== 'CANCELLED' &&
      o.status !== 'RECEIVED',
  },
  {
    key: 'TO_PREPARE',
    roles: ['WAREHOUSE_MANAGER'],
    matches: (o) => o.status === 'MANAGER_APPROVED',
  },
  {
    key: 'TO_RELEASE',
    roles: ['WAREHOUSE_MANAGER', 'MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    matches: (o) => o.status === 'ACCOUNTING_CLEARED',
  },
  {
    key: 'TO_DELIVER',
    roles: ['DRIVER', 'WAREHOUSE_MANAGER', 'MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    matches: (o) => o.status === 'RELEASED',
  },
  {
    key: 'TO_RETURN',
    roles: ['WAREHOUSE_MANAGER'],
    matches: (o) => o.goodsReturn === 'PENDING',
  },
];

export const DEFAULT_FAKE_SUMMARY_EXTRAS: FakeSummaryExtras = {
  organizationsAwaitingActivationCount: 3, // the fake organizations fixture has three inactive groups
  unpricedProductsCount: 6,
  lastSheetSync: {
    status: 'OK',
    startedAt: '2026-10-19T03:00:00.000Z',
    finishedAt: '2026-10-19T03:00:12.000Z',
  },
  usdRate: { rate: '12650.0000', source: 'CBU', rateDate: '2026-10-19' },
};

const hasAny = (roles: readonly StaffRole[], allowed: readonly StaffRole[]): boolean =>
  roles.some((role) => allowed.includes(role));

const pad = (value: number): string => String(value).padStart(2, '0');

function businessDate(instant: Date): string {
  const parts = businessParts(instant);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function createFakeDashboardSummaryApi(
  options: FakeDashboardSummaryOptions,
): DashboardSummaryApi {
  const clock = options.clock ?? systemClock;
  const latencyMs = options.latencyMs ?? 0;
  const extras = options.extras ?? (() => DEFAULT_FAKE_SUMMARY_EXTRAS);

  function queueOf(
    key: DashboardQueueKey,
    waiting: readonly StaffOrderSummary[],
    now: Date,
  ): DashboardQueue {
    // The fake has no status history: the last update stands for "entered this status".
    const oldest = waiting.reduce<string | null>(
      (best, o) =>
        best === null || Date.parse(o.updatedAt) < Date.parse(best) ? o.updatedAt : best,
      null,
    );
    return {
      key,
      count: waiting.length,
      oldestWaitingSince: oldest,
      oldestAgeMinutes:
        oldest === null
          ? null
          : Math.max(0, Math.floor((now.getTime() - Date.parse(oldest)) / MINUTE)),
    };
  }

  return {
    async getSummary() {
      const scenario = options.scenario?.() ?? 'ready';
      if (scenario === 'loading') return new Promise<never>(() => undefined);
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (scenario === 'denied') throw new PermissionDeniedError();
      if (scenario === 'error') throw new ApiError(`${FAKE_DASHBOARD_MARKER}: simulated failure`);

      const roles = options.roles();
      if (roles.length === 0) throw new PermissionDeniedError();
      const now = clock.now();
      const orders = scenario === 'empty' ? [] : options.readOrders();

      const ordersByStatus: Partial<Record<OrderStatus, number>> = {};
      for (const status of ORDER_STATUSES) ordersByStatus[status] = 0;
      for (const order of orders) {
        ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
      }

      const summary: StaffDashboardSummary = {
        generatedAt: now.toISOString(),
        businessDate: businessDate(now),
        ordersByStatus,
        queues: QUEUES.filter((queue) => hasAny(roles, queue.roles)).map((queue) =>
          queueOf(queue.key, orders.filter(queue.matches), now),
        ),
      };
      if (!hasAny(roles, ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'])) return summary;

      const more = extras();
      const counted = orders.flatMap((o) =>
        o.detail === 'FULL' &&
        isSameBusinessDay(o.submittedAt, now) &&
        o.status !== 'REJECTED' &&
        o.status !== 'CANCELLED'
          ? [o]
          : [],
      );
      const withMoney: StaffDashboardSummary = {
        ...summary,
        today: {
          count: counted.length,
          totalAmount: sumMoney(counted.map((o) => o.totalAmount)),
          currency: 'UZS',
        },
        unpaidDeliveredCount: orders.filter(
          (o) =>
            o.detail === 'FULL' &&
            o.paymentStatus === 'UNPAID' &&
            (o.status === 'DELIVERED' || o.status === 'RECEIVED'),
        ).length,
        usdRate: more.usdRate,
      };
      if (!hasAny(roles, ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'])) return withMoney;
      return {
        ...withMoney,
        organizationsAwaitingActivationCount: more.organizationsAwaitingActivationCount,
        unpricedProductsCount: more.unpricedProductsCount,
        lastSheetSync: more.lastSheetSync,
      };
    },
  };
}
