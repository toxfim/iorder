import { createHttpClient, type HttpClient } from '@core/lib/http-client';
import type { StaffSessionStore } from '../session-store';

export interface StaffHttpOptions {
  readonly baseUrl: string;
  readonly session: StaffSessionStore;
  /** Telegram Mini App init data of this tab, when staff opened the app from Telegram. */
  readonly readInitData: () => string | null;
  /** Injected so tests can run without a network. */
  readonly fetchImpl?: typeof fetch;
  /**
   * A 401 on a signed-in call: the server no longer accepts the credential the call carried, a
   * website session (`session`) or the Mini App init data of the tab (`telegram`).
   */
  readonly onUnauthenticated?: (credential: RefusedCredential) => void;
}

export type RefusedCredential = 'session' | 'telegram';

// The two public sign-in routes answer 401 for a wrong password. That is an ordinary failure of
// the form, not an expired session, so it must not clear the session or move the user.
const SIGN_IN_PATHS: readonly string[] = ['/auth/password-login', '/auth/telegram-widget'];

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return raw;
  }
}

const isSignInPath = (path: string): boolean => SIGN_IN_PATHS.some((p) => path.endsWith(p));

/**
 * The credential of the next request. A website sign-in made in THIS tab wins (the person asked
 * for it); otherwise, while the tab holds Telegram's init data (`tma`), Telegram says who the
 * person is and the init data wins over a token found in storage. The token outlives the webview
 * (localStorage, [C] 2026-11-09), so the old "stored token first" order would let a website
 * sign-in made earlier on this device speak for whoever opens the Mini App next (security review,
 * 2026-11-10). The server verifies either one on every call; the client never inspects them.
 */
export function authorizationHeader(
  session: StaffSessionStore,
  readInitData: () => string | null,
): Record<string, string> {
  const token = session.read();
  if (token !== null && session.setInThisPage()) return { Authorization: `Bearer ${token}` };
  const initData = readInitData();
  if (initData !== null) return { Authorization: `tma ${initData}` };
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/** Which credential a request carried, read from its own headers, so a 401 ends the right one. */
function refusedCredential(init: RequestInit | undefined): RefusedCredential | null {
  const header = new Headers(init?.headers).get('Authorization') ?? '';
  if (/^bearer /i.test(header)) return 'session';
  if (/^tma /i.test(header)) return 'telegram';
  return null;
}

/** The client of every signed-in staff call (and of the Mini App launch of a staff member). */
export function createStaffHttpClient(options: StaffHttpOptions): HttpClient {
  return createHttpClient({
    baseUrl: options.baseUrl,
    defaultHeaders: () => authorizationHeader(options.session, options.readInitData),
    fetchImpl: async (input, init) => {
      const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
      // The session this request was sent under: a 401 that arrives after the person signed out
      // (or another person signed in) belongs to a session that is already gone and must not end
      // the current one.
      const sentUnder = options.session.generation();
      const response = await doFetch(input, init);
      const credential = refusedCredential(init);
      if (
        response.status === 401 &&
        credential !== null &&
        !isSignInPath(pathOf(input)) &&
        options.session.generation() === sentUnder
      ) {
        options.onUnauthenticated?.(credential);
      }
      return response;
    },
  });
}

/**
 * The client of the two public sign-in routes. It never sends an `Authorization` header: a stale
 * token must not influence a fresh sign-in, and these routes answer from the body alone.
 */
export function createSignInHttpClient(baseUrl: string, fetchImpl?: typeof fetch): HttpClient {
  return createHttpClient({ baseUrl, ...(fetchImpl ? { fetchImpl } : {}) });
}
