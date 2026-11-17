// Telegram Mini App launch parameters. Telegram appends them to the app URL as a fragment
// (`#tgWebAppData=<initData>&tgWebAppVersion=...`). The official telegram-web-app.js script is
// NOT loaded (no third-party request); the fragment is read directly.
//
// `initData` is opaque here: it is stored and sent as `Authorization: tma <initData>`, and only
// the server verifies its signature. Nothing in this file decides what the person may do.

export const INIT_DATA_STORAGE_KEY = 'iorder.tma.initData';
const FRAGMENT_PARAM = 'tgWebAppData';
const START_PARAM_FRAGMENT = 'tgWebAppStartParam';
const VERSION_FRAGMENT = 'tgWebAppVersion';
const VERSION_STORAGE_KEY = 'iorder.tma.version';
const LAUNCHED_STORAGE_KEY = 'iorder.tma.launched';
const NAME_MAX_LENGTH = 60;
// Telegram allows up to 512 characters of A-Z, a-z, 0-9, _ and - in a `startapp` parameter.
const START_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

// Kept in memory too: sessionStorage can be blocked in some webviews.
let memoryInitData: string | null = null;
// Memory only, on purpose: a start parameter acts once per launch, never again after a reload.
let pendingStartParam: string | null = null;
// Outlives the init data: after a sign-out the page is still inside Telegram's webview.
let launchedHere = false;

function validStartParam(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && START_PARAM_PATTERN.test(value) ? value : null;
}

function readSession(): string | null {
  try {
    return window.sessionStorage.getItem(INIT_DATA_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSession(value: string): void {
  try {
    window.sessionStorage.setItem(INIT_DATA_STORAGE_KEY, value);
  } catch {
    // Deliberately ignored: the in-memory copy still serves this page load.
  }
}

/**
 * Reads the launch fragment once at startup, stores the init data for the session and removes
 * the fragment from the address bar (it must not end up in copied links or history).
 */
export function captureLaunchParams(): void {
  const hash = window.location.hash;
  if (!hash.startsWith('#')) return;
  const found = new URLSearchParams(hash.slice(1)).get(FRAGMENT_PARAM);
  if (found === null || found === '') return;
  memoryInitData = found;
  writeSession(found);
  launchedHere = true;
  try {
    window.sessionStorage.setItem(LAUNCHED_STORAGE_KEY, '1');
  } catch {
    // The in-memory flag still serves this page load.
  }
  const version = new URLSearchParams(hash.slice(1)).get(VERSION_FRAGMENT);
  if (version !== null && /^\d+(\.\d+)*$/.test(version)) {
    try {
      window.sessionStorage.setItem(VERSION_STORAGE_KEY, version);
    } catch {
      // Only an optional feature check depends on it.
    }
  }
  // The direct link `t.me/<bot>/<app>?startapp=<param>` puts it in both places; the fragment
  // copy is read first, the one inside the init data is the fallback.
  pendingStartParam =
    validStartParam(new URLSearchParams(hash.slice(1)).get(START_PARAM_FRAGMENT)) ??
    validStartParam(new URLSearchParams(found).get('start_param'));
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
}

/** The Telegram client's Mini App version, kept for a reload; null when unknown. */
export function readClientVersion(): string | null {
  try {
    return window.sessionStorage.getItem(VERSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The init data of this session, or null when the page was not opened from Telegram. */
export function readInitData(): string | null {
  const stored = memoryInitData ?? readSession();
  return stored !== null && stored !== '' ? stored : null;
}

/**
 * The `startapp` parameter of this launch, once: the first call returns it and forgets it, so a
 * later navigation (or a second caller) does not act on it again. Unverified like the rest of
 * the fragment, so it may only choose a screen, never grant anything.
 */
export function takeStartParam(): string | null {
  const value = pendingStartParam;
  pendingStartParam = null;
  return value;
}

/**
 * True when Telegram opened this tab as a Mini App, also after a reload and after a sign-out
 * forgot the init data. It only shapes the screen (Telegram's back button, safe areas, which
 * screen explains a refusal); it is never a credential and grants nothing.
 */
export function isTelegramLaunch(): boolean {
  if (launchedHere) return true;
  try {
    return window.sessionStorage.getItem(LAUNCHED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Test helper: as if the tab had never been opened by Telegram. */
export function forgetLaunch(): void {
  forgetInitData();
  launchedHere = false;
  try {
    window.sessionStorage.removeItem(LAUNCHED_STORAGE_KEY);
    window.sessionStorage.removeItem(VERSION_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Test and sign-out helper. */
export function forgetInitData(): void {
  memoryInitData = null;
  pendingStartParam = null;
  try {
    window.sessionStorage.removeItem(INIT_DATA_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * The first name Telegram put in the init data, ONLY to greet the person while `/me` is loading.
 * The value is unverified: never use it for access decisions.
 */
export function readLaunchFirstName(initData: string | null): string | null {
  if (initData === null) return null;
  try {
    const raw = new URLSearchParams(initData).get('user');
    if (raw === null) return null;
    const user: unknown = JSON.parse(raw);
    if (typeof user !== 'object' || user === null || !('first_name' in user)) return null;
    const name = user.first_name;
    return typeof name === 'string' && name.trim() !== ''
      ? name.trim().slice(0, NAME_MAX_LENGTH)
      : null;
  } catch {
    return null;
  }
}

/**
 * The Telegram user id inside the init data, ONLY to show the person which id to give to whoever
 * links their account. The value is unverified: never use it for access decisions.
 */
export function readLaunchUserId(initData: string | null): string | null {
  if (initData === null) return null;
  try {
    const raw = new URLSearchParams(initData).get('user');
    if (raw === null) return null;
    const user: unknown = JSON.parse(raw);
    if (typeof user !== 'object' || user === null || !('id' in user)) return null;
    const id = typeof user.id === 'number' ? String(user.id) : user.id;
    return typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
