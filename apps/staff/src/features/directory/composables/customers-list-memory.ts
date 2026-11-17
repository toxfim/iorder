import type { RouteLocationRaw } from 'vue-router';

// The Mijozlar list remembers its address (filters in the query) when a person is opened from
// it, so the person's back link returns to the same list. One list, this tab only.
let listPath: string | null = null;

export function rememberCustomersList(fullPath: string): void {
  listPath = fullPath;
}

export function forgetCustomersList(): void {
  listPath = null;
}

/** The list as it was left, or null when the person was not opened from Mijozlar. */
export function customersListLocation(): RouteLocationRaw | null {
  return listPath;
}
