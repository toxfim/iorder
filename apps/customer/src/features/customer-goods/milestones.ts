import type { CustomerMilestones, CustomerTimelineEvent } from '@iorder/shared';
export function orderMilestones(
  events: readonly CustomerTimelineEvent[],
  orderedAt: string,
): CustomerMilestones {
  const rows = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return {
    orderedAt: rows.find((e) => e.type === 'SUBMITTED')?.occurredAt ?? orderedAt,
    confirmedAt:
      rows.find((e) => e.type === 'STATUS_CHANGED' && e.toStatus === 'MANAGER_APPROVED')
        ?.occurredAt ?? null,
    deliveredAt:
      rows.find((e) => e.type === 'STATUS_CHANGED' && e.toStatus === 'DELIVERED')?.occurredAt ??
      null,
  };
}
