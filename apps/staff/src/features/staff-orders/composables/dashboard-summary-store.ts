import { computed, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { StaffDashboardSummary } from '@iorder/shared/staff-orders';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { DashboardSummaryApi } from '../api/dashboard-summary-api';

export type SummaryState = 'loading' | 'ready' | 'error' | 'denied';

/** How often the numbers are re-read while the tab is in front. */
export const SUMMARY_REFRESH_MS = 60_000;
/** After failures the wait doubles up to this, so a down server is not hammered. */
export const SUMMARY_MAX_BACKOFF_MS = 10 * 60_000;

export interface DashboardSummaryStore {
  /** `loading` only until the first answer; later reads keep showing the last good numbers. */
  readonly state: ComputedRef<SummaryState>;
  readonly summary: Readonly<Ref<StaffDashboardSummary | null>>;
  /** A refresh failed but older numbers are on screen. */
  readonly stale: ComputedRef<boolean>;
  readonly refreshing: Readonly<Ref<boolean>>;
  /** Re-reads now. A call while a read is running joins it instead of sending a second request. */
  refresh: () => Promise<void>;
  /** For the order store: a change was answered, re-read only if a panel is showing the numbers. */
  refreshIfShown: () => Promise<void>;
  /**
   * Forgets everything: another person (or role) is signing in, so the last numbers must not
   * show, not even while the new person's first read is running or after it fails.
   */
  reset: () => void;
  /**
   * Starts the gentle automatic refresh: every minute, paused while the tab is hidden, slower
   * after errors, stopped for good once the server says the role may not read it. All callers share
   * ONE timer (it ends with the last stop), so starting it twice never doubles the reads.
   * Returns an idempotent stop function. The first read is the caller's business.
   */
  startAutoRefresh: () => () => void;
}

export function createDashboardSummaryStore(api: DashboardSummaryApi): DashboardSummaryStore {
  const summary = shallowRef<StaffDashboardSummary | null>(null);
  const failure = shallowRef<'error' | 'denied' | null>(null);
  // Bumped by reset(): a read that started for the previous person must not write its answer.
  let generation = 0;
  const refreshing = shallowRef(false);
  let inflight: Promise<void> | null = null;
  let consecutiveFailures = 0;
  let shown = 0;
  let changedWhileReading = false;
  let lastAttemptAt = Date.now();

  const state = computed<SummaryState>(() => {
    if (failure.value === 'denied') return 'denied';
    if (summary.value) return 'ready';
    if (failure.value === 'error') return 'error';
    return 'loading';
  });
  const stale = computed(() => failure.value === 'error' && summary.value !== null);

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    refreshing.value = true;
    lastAttemptAt = Date.now();
    const mine = generation;
    inflight = (async () => {
      try {
        // A change answered while this read was running makes its answer possibly older than the
        // change; read once more instead of keeping (and showing) the old numbers for a minute.
        do {
          changedWhileReading = false;
          const fresh = await api.getSummary();
          if (mine !== generation) return;
          summary.value = fresh;
          failure.value = null;
          consecutiveFailures = 0;
        } while (changedWhileReading);
      } catch (caught) {
        if (mine !== generation) return;
        consecutiveFailures += 1;
        // UnauthenticatedError (401, the session expired) is a PermissionDeniedError too, so
        // polling stops for it as well.
        if (caught instanceof PermissionDeniedError) {
          summary.value = null; // never keep numbers a role may no longer see
          failure.value = 'denied';
        } else {
          failure.value = 'error';
        }
      } finally {
        if (mine === generation) {
          refreshing.value = false;
          inflight = null;
        }
      }
    })();
    return inflight;
  }

  function reset(): void {
    generation += 1;
    summary.value = null;
    failure.value = null;
    refreshing.value = false;
    inflight = null;
    consecutiveFailures = 0;
    lastAttemptAt = Date.now();
    // A "denied" answer had stopped the loop; the next person may be allowed to read.
    loop?.reschedule();
  }

  // One shared loop for every subscriber (the staff shell and the summary panel both ask for
  // it), so the server is never read twice a minute; it lives while a subscriber is left.
  let loop: { stop: () => void; reschedule: () => void } | null = null;

  function startLoop(): { stop: () => void; reschedule: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const delay = (): number =>
      Math.min(SUMMARY_REFRESH_MS * 2 ** consecutiveFailures, SUMMARY_MAX_BACKOFF_MS);
    const hidden = (): boolean => document.visibilityState === 'hidden';

    function schedule(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (stopped || hidden() || failure.value === 'denied') return;
      timer = setTimeout(() => void tick(), delay());
    }

    async function tick(): Promise<void> {
      timer = null;
      if (stopped || hidden()) return;
      await refresh();
      schedule();
    }

    function onVisibility(): void {
      if (stopped) return;
      if (hidden()) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return;
      }
      // Back in front: read at once if the numbers are older than one wait, then carry on.
      if (Date.now() - lastAttemptAt >= delay() && failure.value !== 'denied') void tick();
      else schedule();
    }

    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return {
      reschedule: schedule,
      stop: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }

  function startAutoRefresh(): () => void {
    shown += 1;
    loop ??= startLoop();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      shown -= 1;
      if (shown === 0) {
        loop?.stop();
        loop = null;
      }
    };
  }

  const refreshIfShown = (): Promise<void> => {
    if (shown === 0) return Promise.resolve();
    if (inflight) changedWhileReading = true;
    return refresh();
  };

  return { state, summary, stale, refreshing, refresh, refreshIfShown, reset, startAutoRefresh };
}
