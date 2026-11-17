import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { GroupRemovalItem } from '@iorder/shared/staff-orders';
import type { ViewState } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { StaffUsersApi } from '../api/staff-users-api';
import { isPending, latestPerOrganization } from '../domain/removal-reasons';

/** Gentle polling: the wait grows after each read and the whole watch ends after a while. */
export const POLL_DELAYS_MS: readonly number[] = [3000, 5000, 8000, 12000, 15000];
export const MAX_POLLS = 40;

export interface RemovalStatus {
  readonly items: Readonly<Ref<readonly GroupRemovalItem[]>>;
  readonly state: Ref<ViewState>;
  readonly error: Ref<unknown>;
  /** Something is still PENDING and the page keeps reading. */
  readonly watching: ComputedRef<boolean>;
  /** The watch gave up while something was still PENDING: the person must refresh by hand. */
  readonly stalled: Ref<boolean>;
  /** True while a read triggered by the refresh button is running. */
  readonly refreshing: Ref<boolean>;
  /** Reads once now and, if anything is PENDING, keeps reading until it settles. */
  refresh: () => Promise<void>;
}

/**
 * Reads `GET /staff/users/:id/removal-status` and keeps reading while a removal is PENDING.
 * It stops when everything is settled, after MAX_POLLS reads, on an error, or when the owning
 * component goes away (no timer outlives the page). Must be called inside a component's setup.
 */
export function useRemovalStatus(api: StaffUsersApi, userId: () => string): RemovalStatus {
  const items = shallowRef<readonly GroupRemovalItem[]>([]);
  const state = ref<ViewState>('loading');
  const error = shallowRef<unknown>(null);
  const stalled = ref(false);
  const refreshing = ref(false);
  const timerActive = ref(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let generation = 0;
  let polls = 0;

  function stopTimer(): void {
    clearTimeout(timer);
    timer = undefined;
    timerActive.value = false;
  }

  function schedule(): void {
    stopTimer();
    if (disposed) return;
    if (polls >= MAX_POLLS) {
      stalled.value = true;
      return;
    }
    const delay = POLL_DELAYS_MS[Math.min(polls, POLL_DELAYS_MS.length - 1)] ?? 15000;
    timerActive.value = true;
    timer = setTimeout(() => {
      timerActive.value = false;
      // A hidden tab does not read; it waits for the next turn instead of burning requests.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      polls += 1;
      void read();
    }, delay);
  }

  async function read(): Promise<void> {
    const mine = ++generation;
    try {
      const next = await api.removalStatus(userId());
      if (mine !== generation || disposed) return;
      items.value = latestPerOrganization(next);
      error.value = null;
      state.value = 'ready';
      if (items.value.some(isPending)) schedule();
      else stopTimer();
    } catch (caught) {
      if (mine !== generation || disposed) return;
      // The last known rows stay visible; the failure is shown beside them and polling stops.
      stopTimer();
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  async function refresh(): Promise<void> {
    stopTimer();
    stalled.value = false;
    polls = 0;
    refreshing.value = true;
    try {
      await read();
    } finally {
      refreshing.value = false;
    }
  }

  onScopeDispose(() => {
    disposed = true;
    stopTimer();
  });

  void refresh();

  return {
    items,
    state,
    error,
    watching: computed(() => timerActive.value),
    stalled,
    refreshing,
    refresh,
  };
}
