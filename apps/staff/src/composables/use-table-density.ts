import { ref, type Ref } from 'vue';

export type TableDensity = 'comfortable' | 'compact';

const STORAGE_KEY = 'iorder.table.density';

function read(): TableDensity {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    // Storage can be blocked (private window, embedded view): the default is fine.
    return 'comfortable';
  }
}

// One value for every table of the session, so a person who picked compact on the orders list
// finds the customers list compact too. A page-level convenience only: nothing depends on it.
const density = ref<TableDensity>(read());

export function useTableDensity(): {
  density: Ref<TableDensity>;
  setDensity: (next: TableDensity) => void;
} {
  function setDensity(next: TableDensity): void {
    density.value = next;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered; the choice still applies until the page is reloaded.
    }
  }
  return { density, setDensity };
}

/** Test hook: forget the module-level choice and read storage again. */
export function resetTableDensity(): void {
  density.value = read();
}
