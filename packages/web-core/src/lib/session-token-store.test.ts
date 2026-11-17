import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTokenStore, isTokenShaped } from './session-token-store';

const KEY = 'iorder.test.session';
const TOKEN = 'abc_-DEF012'.repeat(4).slice(0, 43);
const OTHER = 'zyx_-CBA987'.repeat(4).slice(0, 43);

/** What another tab of the same site does to the shared storage, as this tab hears of it. */
function fromAnotherTab(key: string | null, newValue: string | null): void {
  if (key !== null) {
    if (newValue === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, newValue);
  }
  window.dispatchEvent(
    new StorageEvent('storage', { key, newValue, storageArea: window.localStorage }),
  );
}

describe('session token store', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // [C] 2026-11-09: a signed-in person is not asked again after closing the browser. The
  // sessionStorage of a tab dies with the tab, so the token lives in localStorage.
  it('keeps the token where it survives a closed tab or browser, and never in the URL', () => {
    const store = createSessionTokenStore(KEY);
    store.set(TOKEN);

    expect(window.localStorage.getItem(KEY)).toBe(TOKEN);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TOKEN);
    // A new tab or a new browser start: a fresh store, an empty sessionStorage.
    expect(createSessionTokenStore(KEY).read()).toBe(TOKEN);
  });

  it('clear removes it everywhere', () => {
    const store = createSessionTokenStore(KEY);
    store.set(TOKEN);
    store.clear();
    expect(store.read()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(createSessionTokenStore(KEY).read()).toBeNull();
  });

  it('moves a token an earlier version left in sessionStorage, once', () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const store = createSessionTokenStore(KEY);
    expect(store.read()).toBe(TOKEN);
    expect(window.localStorage.getItem(KEY)).toBe(TOKEN);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    // Signing out afterwards must not bring the old copy back.
    store.clear();
    expect(createSessionTokenStore(KEY).read()).toBeNull();
  });

  // Security review, 2026-11-10: a stale sessionStorage copy in another tab must not bring a
  // signed-out person back.
  it('adopts the old copy once per page load, and never again after a sign-out in this browser', () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const store = createSessionTokenStore(KEY);
    expect(store.read()).toBe(TOKEN);
    // Signing out anywhere in this browser leaves a marker that blocks every later adoption.
    store.clear();
    window.sessionStorage.setItem(KEY, TOKEN);
    expect(store.read()).toBeNull();
    expect(createSessionTokenStore(KEY).read()).toBeNull();
    // A new sign-in lifts the marker.
    store.set(OTHER);
    expect(createSessionTokenStore(KEY).read()).toBe(OTHER);
  });

  it('a second tab that still holds the old copy cannot resurrect a signed-out state', () => {
    // Tab A adopted and then signed out.
    window.sessionStorage.setItem(KEY, TOKEN);
    const tabA = createSessionTokenStore(KEY);
    expect(tabA.read()).toBe(TOKEN);
    tabA.clear();
    // Tab B (its own sessionStorage still holds the old copy) loads after that.
    window.sessionStorage.setItem(KEY, TOKEN);
    const tabB = createSessionTokenStore(KEY);
    expect(tabB.read()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('looks at the old copy only once per page load', () => {
    const store = createSessionTokenStore(KEY);
    expect(store.read()).toBeNull();
    window.sessionStorage.setItem(KEY, TOKEN);
    expect(store.read()).toBeNull();
  });

  it('falls back to memory when storage throws (blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const store = createSessionTokenStore(KEY);

    expect(() => store.set(TOKEN)).not.toThrow();
    expect(store.read()).toBe(TOKEN);
    expect(() => store.clear()).not.toThrow();
    expect(store.read()).toBeNull();
  });

  it('keeps serving this page from memory when only writing is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const store = createSessionTokenStore(KEY);
    store.set(TOKEN);
    expect(store.read()).toBe(TOKEN);
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('ignores a stored value that is not shaped like a token (it can never become a header)', () => {
    for (const bad of ['short', `${TOKEN}\r\nX-Evil: 1`, 'x'.repeat(44), ' '.repeat(43), '']) {
      window.localStorage.setItem(KEY, bad);
      expect(createSessionTokenStore(KEY).read()).toBeNull();
    }
  });

  it('refuses to keep a malformed token', () => {
    expect(() => createSessionTokenStore(KEY).set('nope')).toThrow();
    expect(isTokenShaped(TOKEN)).toBe(true);
    expect(isTokenShaped(null)).toBe(false);
  });

  it('knows whether the token in use was set by this page or found in storage', () => {
    createSessionTokenStore(KEY).set(TOKEN);
    const found = createSessionTokenStore(KEY);
    expect(found.read()).toBe(TOKEN);
    expect(found.setInThisPage()).toBe(false);
    const own = createSessionTokenStore(KEY);
    own.set(OTHER);
    expect(own.setInThisPage()).toBe(true);
    own.clear();
    expect(own.setInThisPage()).toBe(false);
    own.set(OTHER);
    const stop = own.onExternalChange(() => undefined);
    fromAnotherTab(KEY, TOKEN);
    expect(own.setInThisPage()).toBe(false);
    stop();
  });

  it('counts a generation for every sign-in and sign-out of this tab', () => {
    const store = createSessionTokenStore(KEY);
    const start = store.generation();
    store.set(TOKEN);
    store.clear();
    expect(store.generation()).toBe(start + 2);
  });

  describe('another tab of the same browser', () => {
    it('signing out there is seen here: the token is gone and the listener is told', () => {
      const store = createSessionTokenStore(KEY);
      store.set(TOKEN);
      const listener = vi.fn();
      const before = store.generation();
      const stop = store.onExternalChange(listener);

      fromAnotherTab(KEY, null);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.read()).toBeNull();
      expect(store.generation()).toBe(before + 1);
      stop();
    });

    it('signing in there (also as somebody else) is seen here', () => {
      const store = createSessionTokenStore(KEY);
      store.set(TOKEN);
      const listener = vi.fn();
      const stop = store.onExternalChange(listener);

      fromAnotherTab(KEY, OTHER);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.read()).toBe(OTHER);
      stop();
    });

    it('is noticed by a tab that only read the token it found at start', () => {
      createSessionTokenStore(KEY).set(TOKEN);
      const store = createSessionTokenStore(KEY);
      expect(store.read()).toBe(TOKEN);
      const listener = vi.fn();
      const stop = store.onExternalChange(listener);

      fromAnotherTab(KEY, TOKEN);
      expect(listener).not.toHaveBeenCalled();
      fromAnotherTab(KEY, null);
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
    });

    it('clearing the whole storage there counts as signing out', () => {
      const store = createSessionTokenStore(KEY);
      store.set(TOKEN);
      const listener = vi.fn();
      const stop = store.onExternalChange(listener);
      window.localStorage.clear();
      fromAnotherTab(null, null);
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
    });

    it('says nothing about other keys, the same token again, or after unsubscribing', () => {
      const store = createSessionTokenStore(KEY);
      store.set(TOKEN);
      const listener = vi.fn();
      const stop = store.onExternalChange(listener);

      fromAnotherTab('iorder.theme', 'dark');
      fromAnotherTab(KEY, TOKEN);
      expect(listener).not.toHaveBeenCalled();

      stop();
      fromAnotherTab(KEY, null);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
