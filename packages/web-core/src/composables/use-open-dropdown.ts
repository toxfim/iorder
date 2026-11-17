import { ref } from 'vue';

/** Id of the dropdown whose menu is open right now, or null. At most one at a time. */
export const openDropdownId = ref<string | null>(null);
