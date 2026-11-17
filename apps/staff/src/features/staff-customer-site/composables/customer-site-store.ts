import { shallowRef, type Ref } from 'vue';
import { setSiteHint } from '@core/lib/site-hint';
import type { CustomerSiteApi } from '../api/customer-site-api';

export interface CustomerSiteStore {
  /** The customer site, once known; null while unknown or when it cannot be opened from here. */
  readonly url: Readonly<Ref<string | null>>;
  /** Asks once per signed-in person; later calls reuse the answer. */
  ensureLoaded: () => Promise<void>;
  /**
   * The api just handed this person over to `siteUrl`: renew the hint without another request
   * (the handoff page is outside the shell, so the read above may never have run in this tab).
   */
  noteHandedOver: (siteUrl: string) => void;
  /** Forgets the answer (a different person signs in) and discards a read still in flight. */
  reset: () => void;
}

/**
 * Whether the "Customer site" entry is shown, and the hint that lets the customer site continue
 * by itself. A convenience only: a failed read just hides the entry and never blocks a screen.
 */
export function createCustomerSiteStore(
  api: CustomerSiteApi,
  /** Replaced in tests; the real one writes the non-secret hint cookie. */
  markBrowser: (customerSiteUrl: string) => void = setSiteHint,
): CustomerSiteStore {
  const url = shallowRef<string | null>(null);
  let run = 0;
  let pending: Promise<void> | null = null;

  function ensureLoaded(): Promise<void> {
    if (pending) return pending;
    const mine = ++run;
    pending = api
      .getSite()
      .then((found) => {
        if (mine !== run) return;
        url.value = found;
        // Every visit renews the hint, so it lives about as long as the session it speaks of.
        if (found !== null) markBrowser(found);
      })
      .catch(() => {
        // The entry stays hidden; the next sign-in or page load asks again.
        if (mine === run) pending = null;
      });
    return pending;
  }

  function noteHandedOver(siteUrl: string): void {
    markBrowser(siteUrl);
  }

  function reset(): void {
    run += 1;
    pending = null;
    url.value = null;
  }

  return { url, ensureLoaded, noteHandedOver, reset };
}
