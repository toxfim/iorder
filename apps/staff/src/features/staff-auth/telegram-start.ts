import { orderIdOfStartParam } from '@iorder/shared';
import { takeStartParam } from '@core/telegram/launch';

/**
 * The page a Mini App direct link (`t.me/<bot>/<app>?startapp=<param>`) asks for, as a path of
 * this app. Only a known parameter moves the person; anything else keeps the page Telegram
 * opened. The parameter is unverified text of the link, so it only chooses a screen: the route
 * guard and the server still decide whether the person may see it.
 */
export function startPathFor(param: string | null): string | null {
  if (param === null) return null;
  // The "Open in the Mini App" button under a staff bot message names one order, with the same
  // start value the customer Mini App uses for an order (one definition in @iorder/shared).
  const orderId = orderIdOfStartParam(param);
  return orderId === null ? null : `/staff/orders/${orderId}`;
}

/**
 * Puts the page the launch asked for into the address before the router reads it, so the first
 * navigation (and the return path of a sign-in, if one is needed) is already that page. The
 * start parameter acts once: a reload stays on the page the person is on.
 */
export function openStartPage(take: () => string | null = takeStartParam): void {
  const path = startPathFor(take());
  if (path !== null) window.history.replaceState(window.history.state, '', path);
}
