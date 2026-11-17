import { computed, watch, type ComputedRef } from 'vue';
import type { Clock } from '@core/lib/business-clock';
import type { DashboardSummaryStore } from './dashboard-summary-store';
import type { OrdersStore } from './orders-store';

export interface AwaitingApproval {
  /**
   * Orders waiting for the manager. The one number the card, the sidebar badge and the quick filter
   * show. null when neither the list nor the summary has answered: show a dash, never a 0.
   */
  readonly count: ComputedRef<number | null>;
  /** Whole minutes the oldest one has waited; null when nothing waits or it is unknown (never a time next to a 0). */
  readonly oldestAgeMinutes: ComputedRef<number | null>;
}

const MINUTE_MS = 60_000;

/**
 * One source for "waiting for approval". The loaded order list changes the moment the server
 * answers an approval, while the dashboard summary is re-read a moment later; reading each place
 * from a different one made the card say 0 while the badge said 2. The list is exact unless it
 * was cut at the page cap, and only then can the (uncapped) server summary be larger.
 * While the list has not been read (loading, failed, denied) it is empty, not zero: the summary
 * queue answers instead, and with neither the count is unknown (null).
 *
 * The list is read once when the staff area opens, so an order a customer places afterwards is not
 * in it, while the summary is re-read every minute. A summary that disagrees with a whole, loaded
 * list therefore means the list is behind (the card said 0 with an order waiting): it is read
 * again, silently, so the page keeps what it shows meanwhile.
 */
export function createAwaitingApproval(
  ordersStore: Pick<OrdersStore, 'pending' | 'truncated' | 'state' | 'load'>,
  summaryStore: Pick<DashboardSummaryStore, 'summary'>,
  clock: Clock,
): AwaitingApproval {
  const queue = computed(() =>
    summaryStore.summary.value?.queues.find((q) => q.key === 'AWAITING_MANAGER'),
  );
  const listLoaded = computed(
    () => ordersStore.state.value === 'ready' || ordersStore.state.value === 'empty',
  );
  // The disagreement the last re-read was started for. If the list comes back and the two still
  // differ by the same numbers, reading again would change nothing: without this memory a lasting
  // difference cost one request a minute for as long as the page stayed open.
  let unresolved: string | null = null;
  // Every summary answer is checked, not only a changed number: the list may have moved meanwhile.
  watch(summaryStore.summary, () => {
    const live = queue.value?.count;
    // A cut list is a lower bound by design, and a read that is running or failed is not "behind".
    if (live === undefined || !listLoaded.value || ordersStore.truncated.value) return;
    const listed = ordersStore.pending.value.length;
    if (live === listed) {
      unresolved = null;
      return;
    }
    const disagreement = `${live}:${listed}`;
    if (disagreement === unresolved) return;
    unresolved = disagreement;
    void ordersStore.load({ silent: true });
  });
  const count = computed<number | null>(() => {
    if (!listLoaded.value) return queue.value?.count ?? null;
    const listed = ordersStore.pending.value.length;
    return ordersStore.truncated.value ? Math.max(listed, queue.value?.count ?? 0) : listed;
  });
  const oldestAgeMinutes = computed(() => {
    if (count.value === null || count.value === 0) return null;
    const oldest = listLoaded.value ? ordersStore.pending.value[0] : undefined;
    if (oldest) {
      return Math.max(
        0,
        Math.floor((clock.now().getTime() - Date.parse(oldest.submittedAt)) / MINUTE_MS),
      );
    }
    return queue.value?.oldestAgeMinutes ?? null;
  });
  return { count, oldestAgeMinutes };
}
