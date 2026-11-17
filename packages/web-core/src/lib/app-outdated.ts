import { readonly, ref } from 'vue';

// The api answered with a payload our strict schema rejects: almost always the web app and the
// running server are on different versions. The generic "check your connection" text would be a
// lie then, so StateView asks this flag. It reflects the LAST exchange only: any other outcome
// (success, network failure, 5xx) clears it, so it never sticks after the problem is gone.
const outdated = ref(false);

export const appOutdated = readonly(outdated);

export function markAppOutdated(value: boolean): void {
  outdated.value = value;
}

function defaultReloader(): void {
  location.reload();
}

let reloader: () => void = defaultReloader;

/** Tests replace the reload (jsdom cannot navigate); pass nothing to restore the default. */
export function setPageReloader(fn?: () => void): void {
  reloader = fn ?? defaultReloader;
}

export function reloadPage(): void {
  reloader();
}
