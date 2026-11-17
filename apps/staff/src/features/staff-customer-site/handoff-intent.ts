// The handoff page acts only on an intent of the person (security review, 2026-11-10): any site
// could otherwise send a signed-in staff member to /handoff and have a viewer session created on
// the customer site behind their back. The intent is either the press on the sidebar card, kept
// in the tab (sessionStorage is copied into the tab the card opens and survives a sign-in on the
// way), or the customer site itself sending the person here, which only it can prove: the
// referrer origin, which no third-party page can forge.

export const HANDOFF_INTENT_KEY = 'iorder.staff.handoff.intent';

/** The sidebar card was pressed: the next visit of /handoff may go ahead by itself. */
export function markHandoffIntent(): void {
  try {
    window.sessionStorage.setItem(HANDOFF_INTENT_KEY, '1');
  } catch {
    // Without storage the page asks with its button instead.
  }
}

/** True once per intent: the mark is used up by the visit that reads it. */
export function takeHandoffIntent(): boolean {
  try {
    const found = window.sessionStorage.getItem(HANDOFF_INTENT_KEY) !== null;
    window.sessionStorage.removeItem(HANDOFF_INTENT_KEY);
    return found;
  } catch {
    return false;
  }
}

/** The customer site (the address the api names, never one from the request) sent the person. */
export function cameFromCustomerSite(referrer: string, customerSiteUrl: string | null): boolean {
  if (customerSiteUrl === null || referrer === '') return false;
  try {
    return new URL(referrer).origin === new URL(customerSiteUrl).origin;
  } catch {
    return false;
  }
}
