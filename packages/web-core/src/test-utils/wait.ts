import { expect, vi } from 'vitest';

// The first navigation to a route lazy-loads and compiles its component. Under CPU load (the whole
// suite, or the api tests in parallel) that takes longer than vi.waitFor's default 1000 ms.
const WAIT_TIMEOUT_MS = 5000;

export function waitFor<T>(check: () => T | Promise<T>, timeout = WAIT_TIMEOUT_MS): Promise<T> {
  return vi.waitFor(check, { timeout, interval: 20 });
}

/** Waits until the router has finished a (lazy) navigation to `path`. */
export function arrivedAt(
  router: { currentRoute: { value: { path: string } } },
  path: string,
): Promise<void> {
  return waitFor(() => expect(router.currentRoute.value.path).toBe(path), 10_000);
}
