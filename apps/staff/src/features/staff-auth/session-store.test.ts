import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_SESSION_STORAGE_KEY, createStaffSessionStore, isTokenShaped } from './session-store';

const TOKEN = 'abc_-DEF012'.repeat(4).slice(0, 43);

// The storage rules themselves (fallback, shape check, other tabs) are tested with the shared
// store in @core/lib/session-token-store.test.ts; this pins what the staff app depends on.
describe('staff session store', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  // Owner, 2026-11-09: "I have to log in to the dashboard every time I open it". The token used
  // to live in sessionStorage, which a closed tab or browser throws away.
  it('keeps the token for the next visit: a closed tab or browser does not sign the person out', () => {
    createStaffSessionStore().set(TOKEN);

    // What a new tab or a restarted browser starts with: its own empty sessionStorage.
    window.sessionStorage.clear();
    expect(createStaffSessionStore().read()).toBe(TOKEN);
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBe(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('a person signed in before this change is not asked to sign in again', () => {
    window.sessionStorage.setItem(STAFF_SESSION_STORAGE_KEY, TOKEN);
    expect(createStaffSessionStore().read()).toBe(TOKEN);
  });

  it('signing out removes it from the device', () => {
    const store = createStaffSessionStore();
    store.set(TOKEN);
    store.clear();
    expect(store.read()).toBeNull();
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('refuses to keep a malformed token', () => {
    expect(() => createStaffSessionStore().set('nope')).toThrow();
    expect(isTokenShaped(TOKEN)).toBe(true);
    expect(isTokenShaped(null)).toBe(false);
  });
});
