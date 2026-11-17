/** After this many failures of the same update the webhook stops asking Telegram to redeliver it. */
export const MAX_UPDATE_FAILURES = 3;
/** Safety cap on remembered update ids; the oldest are dropped first. */
const MAX_TRACKED_UPDATES = 500;

/**
 * Counts how often the handling of one Telegram update (by `update_id`) failed.
 *
 * Why: an update that always fails (a poison update) would otherwise be answered 5xx and
 * redelivered by Telegram again and again, flooding the logs and the database. TRADEOFF: after
 * `MAX_UPDATE_FAILURES` failures the webhook answers 200 and that update is dropped for good, so a
 * database outage that outlasts three redeliveries of an update loses it. The count is in memory
 * on purpose (small, bounded, no new table): a restart or a second process forgets it, which
 * only means a few more redeliveries. Every handler is idempotent, so redelivery is always safe.
 */
export class UpdateFailureTracker {
  private readonly counts = new Map<number, number>();

  /** Records one more failure and returns how many failures this update has now. */
  recordFailure(updateId: number): number {
    const next = (this.counts.get(updateId) ?? 0) + 1;
    // Re-insert so the oldest update is first in iteration order.
    this.counts.delete(updateId);
    this.counts.set(updateId, next);
    for (const key of this.counts.keys()) {
      if (this.counts.size <= MAX_TRACKED_UPDATES) break;
      this.counts.delete(key);
    }
    return next;
  }

  /** The update was handled: forget it. */
  clear(updateId: number): void {
    this.counts.delete(updateId);
  }

  get size(): number {
    return this.counts.size;
  }
}
