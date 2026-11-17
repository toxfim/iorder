// The customer website Bearer token of this browser, kept the same way the staff app keeps its
// own: localStorage since [C] 2026-11-09 (a signed-in person is not asked again after closing the
// browser), an in-memory fallback, never a URL or a cookie. The rules and the trade-off are in
// @core/lib/session-token-store.
import { createSessionTokenStore } from '@core/lib/session-token-store';

const KEY = 'iorder.customer.session';

const store = createSessionTokenStore(KEY);

export function readCustomerToken(): string | null {
  return store.read();
}

export function setCustomerToken(token: string | null): void {
  if (token === null) store.clear();
  else store.set(token);
}

/**
 * Another tab of this browser signed in or out of the site: this tab no longer shows the person
 * the stored token belongs to. Returns the function that stops listening.
 */
export function onCustomerTokenChangedElsewhere(listener: () => void): () => void {
  return store.onExternalChange(listener);
}

/**
 * True while the token in use was set by this page (a sign-in made here), false for a token found
 * in storage. Inside Telegram a sign-in made here wins over the init data; a found token does not.
 */
export function isSetInThisPage(): boolean {
  return store.setInThisPage();
}
