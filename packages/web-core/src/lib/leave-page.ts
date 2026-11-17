// Leaving the app for another site (the handoff between the company site and the customer site).
// One function so tests can watch it: jsdom cannot navigate.

function defaultLeaver(url: string): void {
  // `replace`, not `assign`: the page that sends the browser on must not stay in the history,
  // or the Back button would send the person straight forward again.
  window.location.replace(url);
}

let leaver: (url: string) => void = defaultLeaver;

/** Tests replace the navigation; pass nothing to restore the default. */
export function setPageLeaver(fn?: (url: string) => void): void {
  leaver = fn ?? defaultLeaver;
}

/**
 * Sends the browser to an http(s) address and returns true; anything else (a `javascript:` URL,
 * a relative path, nonsense) is refused and returns false. The callers pass addresses the api
 * built from its own configuration; this is the last check before the browser moves.
 */
export function leaveTo(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  leaver(parsed.href);
  return true;
}
