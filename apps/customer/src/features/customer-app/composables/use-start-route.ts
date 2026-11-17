import { watch, type Ref } from 'vue';
import type { RouteLocationRaw, Router } from 'vue-router';
import { orderIdOfStartParam } from '@iorder/shared';
import { takeStartParam } from '@core/telegram/launch';
import type { SessionState } from '@/features/customer-session/composables/customer-session';

/**
 * Where a Mini App direct link (`t.me/<bot>/<app>?startapp=<param>`) opens. Only known values
 * move the person; anything else keeps the page Telegram opened. The parameter is unverified, so
 * it only chooses a screen: the server still decides what the screen may show.
 */
const START_ROUTES: Readonly<Record<string, RouteLocationRaw>> = {
  // The price list posts in the groups link here (owner request, 2026-10-28).
  prices: { name: 'customer-catalog' },
};

export function startRouteFor(param: string | null): RouteLocationRaw | null {
  if (param === null) return null;
  if (Object.hasOwn(START_ROUTES, param)) return START_ROUTES[param] ?? null;
  // The "open in the app" button under the bot's order messages ([C] 2026-11-09). An order of
  // another organization is still refused by the server: the page then shows "not found".
  const orderId = orderIdOfStartParam(param);
  return orderId === null ? null : { name: 'customer-order', params: { id: orderId } };
}

/**
 * Once the person is signed in, opens the screen the launch's start parameter names. The
 * parameter is taken only then, so a denied or failed sign-in leaves it for the retry.
 */
export function useStartRoute(
  state: Readonly<Ref<SessionState>>,
  router: Pick<Router, 'replace'>,
  take: () => string | null = takeStartParam,
): void {
  const stop = watch(
    state,
    (current) => {
      if (current !== 'ready') return;
      // Deferred: with `immediate` the first run happens before `stop` is assigned.
      queueMicrotask(() => stop());
      const target = startRouteFor(take());
      if (target !== null) void router.replace(target);
    },
    { immediate: true },
  );
}
