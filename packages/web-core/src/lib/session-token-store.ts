// Holds the Bearer token of a website sign-in. The token is the only credential a web app
// keeps, so it is handled narrowly:
//  - localStorage (since [C] 2026-11-09: a signed-in person is not asked again after closing the
//    browser; sessionStorage died with the tab), never a cookie or a URL. The trade-off: the token
//    stays on the device until sign-out or until the server ends the session, so a shared computer
//    needs a sign-out, and a script running on the page could read it (as it could before);
//  - an in-memory copy serves the page when storage is blocked (Telegram webviews, private mode);
//  - a stored value that does not look like a token is ignored, so a tampered value can never
//    become a header (the server still verifies the real token on every request);
//  - the value is never logged and never leaves the app except as the `Authorization` header.

// Opaque 32-byte token in base64url (auth contracts: 43 characters).
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionTokenStore {
  /** The token, or null when nobody signed in with a password, the widget or a handoff. */
  read: () => string | null;
  set: (token: string) => void;
  clear: () => void;
  /**
   * True while the token in use is one this page set itself (a sign-in made here), false for a
   * token found in storage from an earlier visit or another tab. Lets a page prefer a sign-in it
   * just made over another credential it was opened with (Telegram's init data), without letting
   * a stored one speak for whoever opened the page.
   */
  setInThisPage: () => boolean;
  /**
   * Changes whenever the token is set or cleared. A request remembers the value it was sent
   * under, so a late answer of an old session can be told apart from the current one.
   */
  generation: () => number;
  /**
   * Another tab of this browser signed in or out: the stored token is no longer the one this tab
   * started with. Returns the function that stops listening.
   */
  onExternalChange: (listener: () => void) => () => void;
}

export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

export function createSessionTokenStore(storageKey: string): SessionTokenStore {
  // Left in localStorage by a sign-out and removed by a sign-in: while it is there, no tab adopts
  // a stale copy an older version left in its sessionStorage (that would undo the sign-out).
  const signedOutKey = `${storageKey}.signedOut`;
  let memory: string | null = null;
  // The old copy is looked at once per page load; nothing is adopted twice.
  let legacyChecked = false;
  // Set when a write failed: storage then holds nothing (or something stale) and memory is the
  // only copy this page can trust.
  let memoryOnly = false;
  // The value this tab last saw or wrote: a change made by another tab is told apart by it.
  let known: string | null = null;
  let setHere = false;
  let generation = 0;

  /** The copy a version before 2026-11-09 kept per tab: adopted once, so nobody signs in again. */
  function takeLegacy(): string | null {
    if (legacyChecked) return null;
    legacyChecked = true;
    try {
      const legacy = window.sessionStorage.getItem(storageKey);
      if (legacy === null) return null;
      window.sessionStorage.removeItem(storageKey);
      if (!isTokenShaped(legacy)) return null;
      if (window.localStorage.getItem(signedOutKey) !== null) return null;
      window.localStorage.setItem(storageKey, legacy);
      return legacy;
    } catch {
      return null;
    }
  }

  function readStored(): string | null {
    if (memoryOnly) return memory;
    try {
      return window.localStorage.getItem(storageKey) ?? takeLegacy();
    } catch {
      return memory;
    }
  }

  return {
    read: () => {
      const found = readStored();
      known = isTokenShaped(found) ? found : null;
      return known;
    },
    set: (token) => {
      if (!isTokenShaped(token)) throw new Error('Refusing to keep a malformed session token');
      generation += 1;
      memory = token;
      known = token;
      setHere = true;
      try {
        window.localStorage.setItem(storageKey, token);
        window.localStorage.removeItem(signedOutKey);
        memoryOnly = false;
      } catch {
        // The in-memory copy still serves this page load.
        memoryOnly = true;
      }
    },
    clear: () => {
      generation += 1;
      memory = null;
      known = null;
      setHere = false;
      try {
        window.localStorage.removeItem(storageKey);
        window.sessionStorage.removeItem(storageKey);
        window.localStorage.setItem(signedOutKey, '1');
        memoryOnly = false;
      } catch {
        // Nothing could be removed; this page at least forgets its own copy.
        memoryOnly = true;
      }
    },
    generation: () => generation,
    setInThisPage: () => setHere && memory !== null,
    onExternalChange: (listener) => {
      const onStorage = (event: StorageEvent): void => {
        if (event.storageArea !== window.localStorage) return;
        // `key === null` is a whole-storage clear in the other tab.
        if (event.key !== null && event.key !== storageKey) return;
        const next = event.key !== null && isTokenShaped(event.newValue) ? event.newValue : null;
        if (next === known) return;
        memory = next;
        known = next;
        setHere = false;
        generation += 1;
        listener();
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    },
  };
}
