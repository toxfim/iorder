import { customRef, type Ref } from 'vue';

/**
 * A boolean the tab remembers for the session (sessionStorage). Storage can be missing or throw
 * (private window, blocked site data), so the flag then simply lives in memory.
 */
export function useSessionFlag(storageKey: string, fallback: boolean): Ref<boolean> {
  let current = read(storageKey, fallback);
  return customRef((track, trigger) => ({
    get: () => {
      track();
      return current;
    },
    set: (next: boolean) => {
      current = next;
      write(storageKey, next);
      trigger();
    },
  }));
}

function read(storageKey: string, fallback: boolean): boolean {
  try {
    const stored = sessionStorage.getItem(storageKey);
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

function write(storageKey: string, value: boolean): void {
  try {
    sessionStorage.setItem(storageKey, value ? '1' : '0');
  } catch {
    // Remembering is a convenience; the group still opens and closes.
  }
}
