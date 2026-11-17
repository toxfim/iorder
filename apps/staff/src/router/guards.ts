import type { RouteLocationRaw, RouteMeta, Router } from 'vue-router';
import { hasStaffAccess } from '@/features/auth/access';
import type { CurrentUser } from '@/features/auth/api/auth-api';
import type { CurrentUserStore } from '@/features/auth/composables/current-user-store';
import { firstStaffPage, staffRouteName } from '@/features/staff-shell/nav-config';

/** The screen of a Mini App launch Telegram could not sign in as staff (router/index.ts). */
export const TELEGRAM_REFUSED = 'telegram-refused';

/**
 * Where a signed-in user starts: their first staff page. Customers have their own app
 * (apps/customer), so a person without a staff role is denied here.
 */
export function homeFor(user: CurrentUser): RouteLocationRaw {
  const page = firstStaffPage(user.staffRoles);
  return page ? { name: staffRouteName(page) } : { name: 'forbidden' };
}

/**
 * Pure access decision for a navigation: `true` to proceed or a redirect.
 *
 * This only decides which screens the person sees. It is not a security boundary: the server
 * enforces permissions on every request (CLAUDE.md, Frontend conventions).
 */
export function resolveAccess(
  // Structural so both a navigation target and `router.resolve()` output can be checked.
  to: { readonly meta: RouteMeta; readonly name?: unknown; readonly fullPath: string },
  user: CurrentUser | null,
  /**
   * True while the tab holds Telegram's init data (the app runs as a Mini App and Telegram is the
   * way in). A person Telegram could not sign in as staff then gets the screen that says what to
   * do, never a bare login form; the form stays one button away on that screen.
   */
  viaTelegram = false,
): true | RouteLocationRaw {
  const area = to.meta.area ?? 'public';
  const isStaff = user !== null && hasStaffAccess(user);

  if (area === 'public') {
    // The refusal screen is only for someone Telegram did not sign in as staff. Without a
    // Telegram launch it has nothing to explain (a typed address, "back" after leaving it).
    if (to.name === TELEGRAM_REFUSED) {
      if (isStaff && user) return homeFor(user);
      if (!viaTelegram) return { name: user ? 'forbidden' : 'login' };
      return true;
    }
    // Signed in through Telegram without a staff role: one explanation, not two screens.
    if (viaTelegram && user && !isStaff && (to.name === 'login' || to.name === 'forbidden')) {
      return { name: TELEGRAM_REFUSED };
    }
    // A signed-in user has no business on the login screen.
    return to.name === 'login' && user ? homeFor(user) : true;
  }

  if (!user) {
    return { name: viaTelegram ? TELEGRAM_REFUSED : 'login', query: { redirect: to.fullPath } };
  }

  if (!isStaff) return { name: viaTelegram ? TELEGRAM_REFUSED : 'forbidden' };
  // `/`, /staff and every unknown URL have no page: send the person to the first entry their
  // roles allow.
  if (to.name === 'home' || to.name === 'staff-home') return homeFor(user);
  return hasStaffAccess(user, to.meta.staffRoles) ? true : { name: 'forbidden' };
}

/**
 * Runs the guards again for the page that is open (the person just signed out or their session
 * ended). A plain replace to the same URL is dropped by the router as a duplicate navigation.
 */
export function reevaluateCurrentRoute(router: Router): Promise<unknown> {
  const { path, query, hash } = router.currentRoute.value;
  return router.replace({ path, query, hash, force: true });
}

export function installGuards(
  router: Router,
  currentUser: CurrentUserStore,
  viaTelegram: () => boolean = () => false,
): void {
  router.beforeEach(async (to) => {
    // The retry screen asks again only when the person presses its button.
    if (to.name !== 'session-error') await currentUser.ensureLoaded();
    // The start-up read failed (not a 401): neither signed in nor signed out is known.
    if (
      currentUser.loadError.value !== null &&
      currentUser.user.value === null &&
      (to.meta.area ?? 'public') !== 'public'
    ) {
      return { name: 'session-error', query: { redirect: to.fullPath } };
    }
    return resolveAccess(to, currentUser.user.value, viaTelegram());
  });
}
