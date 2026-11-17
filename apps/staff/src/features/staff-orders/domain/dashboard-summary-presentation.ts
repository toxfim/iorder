import type { StaffRole } from '@iorder/shared';
import { readsAllOrders } from '@/features/staff-shell/orders-access';
import type { DashboardQueueKey } from '@iorder/shared/staff-orders';
import type { RouteLocationRaw } from 'vue-router';

export type AgeParts =
  | { readonly kind: 'underMinute' }
  | { readonly kind: 'minutes'; readonly minutes: number }
  | { readonly kind: 'hours'; readonly hours: number; readonly minutes: number }
  | { readonly kind: 'days'; readonly days: number; readonly hours: number };

const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * Splits a waiting time (whole minutes, as the api sends it) into the two units a person reads
 * aloud: minutes under an hour, hours and minutes under a day, days and hours beyond. A zero
 * second unit is kept (the caller leaves it out of the sentence).
 */
export function ageParts(totalMinutes: number): AgeParts {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  if (minutes < 1) return { kind: 'underMinute' };
  if (minutes < HOUR) return { kind: 'minutes', minutes };
  if (minutes < DAY)
    return { kind: 'hours', hours: Math.floor(minutes / HOUR), minutes: minutes % HOUR };
  return {
    kind: 'days',
    days: Math.floor(minutes / DAY),
    hours: Math.floor((minutes % DAY) / HOUR),
  };
}

/** Message key under `orders.summary.age` and its parameters, ready for `t()`. */
export function ageMessage(totalMinutes: number): {
  readonly key: string;
  readonly params: Record<string, number>;
} {
  const age = ageParts(totalMinutes);
  switch (age.kind) {
    case 'underMinute':
      return { key: 'underMinute', params: {} };
    case 'minutes':
      return { key: 'minutes', params: { minutes: age.minutes } };
    case 'hours':
      return age.minutes === 0
        ? { key: 'hours', params: { hours: age.hours } }
        : { key: 'hoursMinutes', params: { hours: age.hours, minutes: age.minutes } };
    case 'days':
      return age.hours === 0
        ? { key: 'days', params: { days: age.days } }
        : { key: 'daysHours', params: { days: age.days, hours: age.hours } };
  }
}

/**
 * After this many hours without a successful sheet sync the dashboard warns. [P]: not a confirmed
 * rule (question 8 in manager-questions.md); one named constant so the owner can change it.
 */
// 30 h, not 24: a daily run that finishes later than the day before must not flag stale.
export const SHEET_SYNC_STALE_HOURS = 30;

export type SheetSyncHealth = 'ok' | 'stale' | 'failed' | 'never';

/**
 * Whether the last sheet sync needs attention. A failed last run is a problem at once; a
 * successful one is a problem when it is older than the threshold (stock and cost are then old).
 */
export function sheetSyncHealth(
  run: { readonly status: 'OK' | 'FAILED'; readonly finishedAt: string } | null,
  now: Date,
  staleAfterHours: number = SHEET_SYNC_STALE_HOURS,
): SheetSyncHealth {
  if (run === null) return 'never';
  if (run.status === 'FAILED') return 'failed';
  const ageMs = now.getTime() - Date.parse(run.finishedAt);
  return ageMs > staleAfterHours * 60 * 60 * 1000 ? 'stale' : 'ok';
}

/** `2026-10-19` -> `19.10.2026`. A calendar date has no zone, so it must not go through a Date. */
export function formatCalendarDate(isoDate: string): string {
  return isoDate.split('-').reverse().join('.');
}

/**
 * Where a queue card leads. The managers and the admin have the whole order list, filtered by
 * the status; every other role has its own queue page; a role with neither gets no link (the
 * server would refuse the list anyway, so the link is only a convenience).
 */
export function queueLink(
  key: DashboardQueueKey,
  roles: readonly StaffRole[],
): RouteLocationRaw | null {
  const readsAll = readsAllOrders(roles);
  switch (key) {
    case 'AWAITING_MANAGER':
      return readsAll ? { name: 'staff-orders', query: { stage: 'SUBMITTED' } } : null;
    case 'AWAITING_ACCOUNTING':
      if (readsAll) return { name: 'staff-orders', query: { stage: 'MANAGER_APPROVED' } };
      return roles.includes('ACCOUNTANT') ? { name: 'staff-accounting' } : null;
    case 'SKIPPED_ACCOUNTING_TO_REVIEW':
      return roles.includes('ACCOUNTANT') ? { name: 'staff-accounting' } : null;
    case 'TO_PREPARE':
    case 'TO_RETURN':
      return roles.includes('WAREHOUSE_MANAGER') ? { name: 'staff-warehouse' } : null;
    case 'TO_RELEASE':
      if (readsAll) return { name: 'staff-orders', query: { stage: 'ACCOUNTING_CLEARED' } };
      return roles.includes('WAREHOUSE_MANAGER') ? { name: 'staff-warehouse' } : null;
    case 'TO_DELIVER':
      if (readsAll) return { name: 'staff-orders', query: { stage: 'RELEASED' } };
      return roles.includes('DRIVER') ? { name: 'staff-deliveries' } : null;
  }
}
