import { shallowRef, type Ref } from 'vue';
import type { OrganizationsApi } from '../api/organizations-api';
import { countWaiting } from '../domain/organization-model';

export interface WaitingOrganizationsStore {
  /** Groups waiting for activation; null until known (or unreadable). */
  readonly count: Readonly<Ref<number | null>>;
  refresh: () => Promise<void>;
  /** Forgets the number (a different person signs in) and discards any read still in flight. */
  reset: () => void;
  /** Pages that already hold the list tell the store, so no second request is needed. */
  set: (count: number) => void;
}

/**
 * The number on the Tashkilotlar nav item. A hint only: a failed read keeps the last value and
 * never blocks a screen.
 */
export function createWaitingOrganizationsStore(api: OrganizationsApi): WaitingOrganizationsStore {
  const count = shallowRef<number | null>(null);
  let run = 0;

  async function refresh(): Promise<void> {
    const mine = ++run;
    try {
      const items = await api.list({ status: 'INACTIVE' });
      // An unbound one waits for its customer, not for staff: it is not counted.
      if (mine === run) count.value = countWaiting(items);
    } catch {
      // Keep the last known value.
    }
  }

  function reset(): void {
    run += 1;
    count.value = null;
  }

  function set(next: number): void {
    run += 1; // an older, slower read must not overwrite this fresher number
    count.value = next;
  }

  return { count, refresh, set, reset };
}
