import { shallowRef } from 'vue';

/**
 * The filters of the orders list as they were last seen. The order page links back with them, so
 * "back to the list" keeps the filters even when the page was opened from somewhere else (the
 * browser's own back button restores them anyway through the URL).
 */
export const rememberedListQuery = shallowRef<Record<string, string>>({});

/** Forgets the filters; called on sign-out so the next person does not inherit them. */
export function forgetRememberedListQuery(): void {
  rememberedListQuery.value = {};
}
