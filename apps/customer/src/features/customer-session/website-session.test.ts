import { afterEach, describe, expect, it } from 'vitest';
import { isSetInThisPage, readCustomerToken, setCustomerToken } from './website-session';

// The storage rules themselves (fallback, shape check, other tabs) are tested with the shared
// store in @core/lib/session-token-store.test.ts; this pins what the customer site depends on.

const TOKEN = 'o'.repeat(43);

function setUrl(pathAndMore: string): void {
  window.history.replaceState(null, '', pathAndMore);
}

afterEach(() => {
  setCustomerToken(null);
  window.sessionStorage.clear();
  window.localStorage.clear();
  setUrl('/');
});

describe('the customer website session', () => {
  // [C] 2026-11-09: whoever opens the site once in two weeks is not asked to sign in again, also
  // after closing the browser. sessionStorage, where the token used to live, dies with the tab.
  it('is kept for the next visit: a closed tab or browser does not sign the person out', () => {
    setCustomerToken(TOKEN);
    // What a new tab or a restarted browser starts with: its own empty sessionStorage.
    window.sessionStorage.clear();
    expect(readCustomerToken()).toBe(TOKEN);
    expect(window.localStorage.getItem('iorder.customer.session')).toBe(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('signing out removes it from the device', () => {
    setCustomerToken(TOKEN);
    setCustomerToken(null);
    expect(readCustomerToken()).toBeNull();
    expect(window.localStorage.getItem('iorder.customer.session')).toBeNull();
  });

  it('refuses to keep a malformed token', () => {
    expect(() => setCustomerToken('nope')).toThrow();
    expect(readCustomerToken()).toBeNull();
  });
});

describe('a crafted link that looks like a Telegram launch', () => {
  // Security review, 2026-11-10: the fragment alone must not sign the person out of every tab;
  // inside Telegram the init data simply wins over a stored token (customer-http.test.ts).
  it('does not touch the stored website session', () => {
    setCustomerToken(TOKEN);
    setUrl('/#tgWebAppData=whatever-a-link-says');
    expect(readCustomerToken()).toBe(TOKEN);
    expect(window.localStorage.getItem('iorder.customer.session')).toBe(TOKEN);
    expect(isSetInThisPage()).toBe(true);
  });

  it('a token found in storage is known to be found, not made here', () => {
    window.localStorage.setItem('iorder.customer.session', TOKEN);
    expect(readCustomerToken()).toBe(TOKEN);
    expect(isSetInThisPage()).toBe(false);
  });
});
