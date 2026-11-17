// The `startapp` values of the customer Mini App direct link (`t.me/<bot>/<app>?startapp=<value>`).
// The api writes them into bot buttons and the customer app maps them to a screen, so both read the
// same definition. Telegram allows only A-Z, a-z, 0-9, `_` and `-` (at most 512 characters).
//
// The value is unverified input for the app: it may only choose a screen, never grant anything.

const ORDER_PREFIX = 'order_';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The start value that opens one order, or null when the id is not an order id (a UUID). */
export function orderStartParam(orderId: string): string | null {
  return UUID_PATTERN.test(orderId) ? `${ORDER_PREFIX}${orderId}` : null;
}

/** The order a start value names, or null when the value is anything else. */
export function orderIdOfStartParam(param: string): string | null {
  if (!param.startsWith(ORDER_PREFIX)) return null;
  const orderId = param.slice(ORDER_PREFIX.length);
  return UUID_PATTERN.test(orderId) ? orderId : null;
}
