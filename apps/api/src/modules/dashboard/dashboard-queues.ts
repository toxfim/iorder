import type { StaffRole } from '@iorder/shared';
import type { DashboardQueue, DashboardQueueKey } from '@iorder/shared/staff-orders';
import type { OrderStats, StatusStat } from '../orders/index.js';

interface QueueDefinition {
  key: DashboardQueueKey;
  /** Roles that see the queue (those who work it, plus the roles that oversee everything). */
  roles: readonly StaffRole[];
  read: (stats: OrderStats) => StatusStat | null;
}

// Display order = the order an order travels. The count in each queue is already scoped to the
// orders the caller may see (the driver's TO_DELIVER is therefore their own deliveries).
const QUEUES: readonly QueueDefinition[] = [
  {
    key: 'AWAITING_MANAGER',
    roles: ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    read: (stats) => stats.byStatus.SUBMITTED,
  },
  {
    key: 'AWAITING_ACCOUNTING',
    roles: ['ACCOUNTANT', 'MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    read: (stats) => stats.byStatus.MANAGER_APPROVED,
  },
  {
    // The manager skipped accounting; the accountant still sees the order as new ([C] lifecycle 3.1).
    // PROVISIONAL [P]: nothing sets accounting_reviewed_at yet, so this queue never drains until the
    // manager answers Q14 (what the accountant does with skipped orders).
    key: 'SKIPPED_ACCOUNTING_TO_REVIEW',
    roles: ['ACCOUNTANT'],
    read: (stats) => stats.full?.skippedAccountingToReview ?? null,
  },
  {
    // The warehouse prepares and scans from the manager's approval on ([C] 2026-10-30). The
    // manager and the admin already have this status as AWAITING_ACCOUNTING.
    key: 'TO_PREPARE',
    roles: ['WAREHOUSE_MANAGER'],
    read: (stats) => stats.byStatus.MANAGER_APPROVED,
  },
  {
    key: 'TO_RELEASE',
    roles: ['WAREHOUSE_MANAGER', 'MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    read: (stats) => stats.byStatus.ACCOUNTING_CLEARED,
  },
  {
    key: 'TO_DELIVER',
    roles: ['DRIVER', 'WAREHOUSE_MANAGER', 'MANAGER', 'ADMIN', 'PURCHASING_MANAGER'],
    read: (stats) => stats.byStatus.RELEASED,
  },
  {
    key: 'TO_RETURN',
    roles: ['WAREHOUSE_MANAGER'],
    read: (stats) => stats.goodsToReturn,
  },
];

function ageInMinutes(since: Date, now: Date): number {
  // A clock step or a future-dated row must not produce a negative age.
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
}

/** The queues that matter to a person holding these roles, with the age of their oldest order. */
export function buildQueues(
  roles: readonly StaffRole[],
  stats: OrderStats,
  now: Date,
): DashboardQueue[] {
  const queues: DashboardQueue[] = [];
  for (const definition of QUEUES) {
    if (!definition.roles.some((role) => roles.includes(role))) continue;
    const stat = definition.read(stats);
    if (stat === null) continue;
    const oldest = stat.count === 0 ? null : stat.oldestWaitingSince;
    queues.push({
      key: definition.key,
      count: stat.count,
      oldestWaitingSince: oldest === null ? null : oldest.toISOString(),
      oldestAgeMinutes: oldest === null ? null : ageInMinutes(oldest, now),
    });
  }
  return queues;
}
