// Continuing on this site with a sign-in made on the company's own site ([C] 2026-11-09). The two
// sites are different origins and cannot see each other's session, so that site hands a signed-in
// employee over with a ONE-TIME code in the URL fragment, which this site exchanges for a session
// of its own. Two ways lead here:
//
//  1. The person pressed the entry on the other site: this page opens with `#handoff=<code>`.
//  2. The person opened this site directly. If the browser carries the other site's hint (a
//     non-secret cookie, see @core/lib/site-hint) and nobody is signed in here, the browser is
//     sent there ONCE; it comes back as in 1, or the person meets that site's sign-in page.
//
// Nothing here is a security boundary: the server decides what a code is worth, and both
// addresses come from the api's configuration, never from the URL, the cookie or storage.
import { HANDOFF_CODE_PATTERN, HANDOFF_FRAGMENT_PARAM } from '@iorder/shared';
import { readonly, ref } from 'vue';
import { leaveTo } from '@core/lib/leave-page';
import { hasAnySiteHint, hasSiteHintFor } from '@core/lib/site-hint';

const TELEGRAM_FRAGMENT_PARAM = 'tgWebAppData';
/**
 * "This browser already tried the automatic handoff" (localStorage, with the time): at most one
 * attempt per browser within HANDOFF_TRIED_SECONDS, whatever tab, so a refusal on the other side
 * cannot become a loop and a new tab cannot start it over at once (security review, 2026-11-10).
 */
const TRIED_KEY = 'iorder.customer.handoff.tried';
export const HANDOFF_TRIED_SECONDS = 60 * 60;
/**
 * "The person signed out here on purpose" (localStorage, with the time): no automatic attempt
 * for HANDOFF_OPT_OUT_SECONDS in any tab, so a sign-out is not undone by the next tab. A code the
 * person brings along (they pressed the entry on the other site) is still exchanged.
 */
const OPT_OUT_KEY = 'iorder.customer.handoff.optOut';
export const HANDOFF_OPT_OUT_SECONDS = 12 * 60 * 60;
/** The page the person asked for before being sent away, restored when they come back (per tab). */
const RETURN_KEY = 'iorder.customer.handoff.return';
const MAX_RETURN_LENGTH = 512;

/** What the start-up found in the URL fragment. */
export type HandoffArrival =
  | { readonly kind: 'none' }
  | { readonly kind: 'code'; readonly code: string }
  /** A handoff parameter that cannot be a code: refused here, the server is not asked. */
  | { readonly kind: 'malformed' };

// The sign-in page says once that continuing automatically did not work.
const failed = ref(false);
export const handoffFailed = readonly(failed);
export function markHandoffFailed(value: boolean): void {
  failed.value = value;
}

function readTab(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeTab(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Without storage the attempt is simply not remembered; see `sendToCompanySiteOnce`.
  }
}

function readBrowser(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeBrowser(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Without storage no attempt is remembered, and therefore none is made (see below).
  }
}

/** A time written by `writeBrowser` that is less than `seconds` old; false for anything else. */
function withinLast(key: string, seconds: number, nowMs: number): boolean {
  const stored = Number(readBrowser(key));
  return Number.isFinite(stored) && stored > 0 && nowMs - stored < seconds * 1000;
}

/** True when the browser can remember that it tried: without that, no automatic attempt is made. */
function canRemember(nowMs: number): boolean {
  if (readBrowser(TRIED_KEY) === null)
    writeBrowser(TRIED_KEY, String(nowMs - HANDOFF_TRIED_SECONDS * 1000 - 1));
  return readBrowser(TRIED_KEY) !== null;
}

/**
 * Called when the person signs out of this site on purpose: no automatic attempt for a while, so
 * the sign-out is not undone by the next tab that opens.
 */
export function suppressAutomaticHandoff(nowMs: number = Date.now()): void {
  writeBrowser(OPT_OUT_KEY, String(nowMs));
}

/**
 * Reads a handoff code from the URL fragment and removes the fragment from the address bar AT
 * ONCE, before anything else runs, so the code reaches neither the history, a copied link nor a
 * screenshot. A Mini App launch (Telegram's own fragment) is left alone: there the person is
 * signed in by Telegram, and a handoff has no place.
 */
export function takeHandoffArrival(): HandoffArrival {
  const hash = window.location.hash;
  if (!hash.startsWith('#')) return { kind: 'none' };
  const params = new URLSearchParams(hash.slice(1));
  const found = params.get(HANDOFF_FRAGMENT_PARAM);
  if (found === null || params.has(TELEGRAM_FRAGMENT_PARAM)) return { kind: 'none' };
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  return HANDOFF_CODE_PATTERN.test(found) ? { kind: 'code', code: found } : { kind: 'malformed' };
}

/** A path of this site and nothing else: our own storage is still not a place to trust blindly. */
function safeReturnPath(value: string | null): string | null {
  if (value === null || value.length > MAX_RETURN_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** Puts the remembered page back into the address bar before the router starts. */
function restoreReturnPath(): void {
  const path = safeReturnPath(readTab(RETURN_KEY));
  writeTab(RETURN_KEY, null);
  if (path === null) return;
  const here = `${window.location.pathname}${window.location.search}`;
  if (path !== here) window.history.replaceState(window.history.state, '', path);
}

export interface HandoffDeps {
  /** Exchanges the code for a session of this site (it keeps the token itself). */
  readonly exchange: (code: string) => Promise<void>;
  /** Ends a session of this site on the server by its token (the one a handoff replaced). */
  readonly revokeSession: (token: string) => Promise<void>;
  /** The other site's page that can hand a person over, from the api; null when there is none. */
  readonly handoffPage: () => Promise<string | null>;
  /** Somebody is already signed in on this site in this browser. */
  readonly hasSession: () => boolean;
  /** The token of that session, so it can be ended once a handoff has replaced it. */
  readonly currentToken: () => string | null;
  /** Opened as a Telegram Mini App: Telegram signs the person in. */
  readonly inTelegram: () => boolean;
  /** The clock, in milliseconds (tests move it). */
  readonly now: () => number;
}

/**
 * Start-up step of the real app, before it mounts. Returns `leaving` when the browser was sent
 * to the other site (the caller then does not mount anything); otherwise the app starts as usual,
 * signed in or not.
 */
export async function continueFromCompanySite(
  arrival: HandoffArrival,
  deps: HandoffDeps,
): Promise<'leaving' | 'stay'> {
  if (deps.inTelegram()) return 'stay';

  if (arrival.kind !== 'none') {
    // Whatever happens next, this browser does not try by itself again for a while.
    writeBrowser(TRIED_KEY, String(deps.now()));
    if (arrival.kind === 'malformed') {
      markHandoffFailed(!deps.hasSession());
      return 'stay';
    }
    const replaced = deps.currentToken();
    try {
      await deps.exchange(arrival.code);
      restoreReturnPath();
      // The session the handoff replaced is ended on the server too, so no live session is left
      // behind (6c). Afterwards, so a refused code never costs the person the session they had.
      if (replaced !== null) {
        deps.revokeSession(replaced).catch(() => {
          // Best effort: the idle limit ends it otherwise.
        });
      }
    } catch {
      // One answer for every refusal (used, expired, unknown code, throttled, no network). A
      // person who was already signed in here simply stays signed in.
      writeTab(RETURN_KEY, null);
      markHandoffFailed(!deps.hasSession());
    }
    return 'stay';
  }

  return (await sendToCompanySiteOnce(deps)) ? 'leaving' : 'stay';
}

/**
 * The automatic attempt for a person who opened this site directly. Only when nobody is signed
 * in here, the browser has not tried for a while, nobody signed out here recently, and the browser
 * carries the other site's hint; a visitor without the hint is never sent anywhere and causes no
 * request at all.
 */
async function sendToCompanySiteOnce(deps: HandoffDeps): Promise<boolean> {
  const nowMs = deps.now();
  if (deps.hasSession()) return false;
  if (withinLast(TRIED_KEY, HANDOFF_TRIED_SECONDS, nowMs)) return false;
  if (withinLast(OPT_OUT_KEY, HANDOFF_OPT_OUT_SECONDS, nowMs)) return false;
  if (!hasAnySiteHint()) return false;
  // No way to remember the attempt means no way to stop a loop: do not start one.
  if (!canRemember(nowMs)) return false;

  let page: string | null;
  try {
    page = await deps.handoffPage();
  } catch {
    return false;
  }
  // Asked once per browser and hour, whatever the answer.
  writeBrowser(TRIED_KEY, String(nowMs));
  // The hint must be the one of THIS installation's site (the address the api just named).
  if (page === null || !hasSiteHintFor(page)) return false;

  writeTab(RETURN_KEY, `${window.location.pathname}${window.location.search}`);
  if (leaveTo(page)) return true;
  writeTab(RETURN_KEY, null);
  return false;
}
