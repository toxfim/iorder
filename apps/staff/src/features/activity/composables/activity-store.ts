import { ref, shallowRef, type Ref } from 'vue';
import type { ViewState } from '@core/composables/use-async-view';
import type { ActivityApi, ActivityEntry } from '../api/activity-api';

/** The home page shows the last 8 actions (v1: `slice(0, 8)`). */
export const ACTIVITY_LIMIT = 8;

export interface ActivityStore {
  readonly state: Ref<ViewState>;
  readonly entries: Readonly<Ref<readonly ActivityEntry[]>>;
  /** Re-reads the feed; called after every change made through a store. */
  refresh: () => Promise<void>;
  /** Forgets the feed (a different person signs in) and discards any read still in flight. */
  reset: () => void;
}

export function createActivityStore(api: ActivityApi): ActivityStore {
  const entries = shallowRef<readonly ActivityEntry[]>([]);
  const state = ref<ViewState>('loading');

  let generation = 0;

  function reset(): void {
    generation += 1;
    entries.value = [];
    state.value = 'loading';
  }

  async function refresh(): Promise<void> {
    const mine = generation;
    try {
      const found = await api.listRecent(ACTIVITY_LIMIT);
      if (mine !== generation) return;
      entries.value = found;
      state.value = entries.value.length === 0 ? 'empty' : 'ready';
    } catch {
      if (mine !== generation) return;
      // The feed is secondary information: keep what is shown rather than failing the page.
      if (entries.value.length === 0) state.value = 'error';
    }
  }

  return { state, entries, refresh, reset };
}
