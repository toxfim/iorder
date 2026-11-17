// The staff Bearer token of this browser. How it is kept (localStorage since [C] 2026-11-09, an
// in-memory fallback, the shape check, the cross-tab notice) is the shared store of both web apps:
// see @core/lib/session-token-store for the rules and the trade-off.
import {
  createSessionTokenStore,
  isTokenShaped,
  type SessionTokenStore,
} from '@core/lib/session-token-store';

export const STAFF_SESSION_STORAGE_KEY = 'iorder.staff.session';

export type StaffSessionStore = SessionTokenStore;

export { isTokenShaped };

export function createStaffSessionStore(): StaffSessionStore {
  return createSessionTokenStore(STAFF_SESSION_STORAGE_KEY);
}
