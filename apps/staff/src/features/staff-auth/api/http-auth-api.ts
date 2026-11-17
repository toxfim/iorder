import {
  STAFF_AUTH_ROUTES,
  staffCurrentSessionResponseSchema,
  staffSignInResponseSchema,
} from '@iorder/shared/staff-auth';
import type { MeResponse } from '@iorder/shared';
import type { AuthApi, CurrentUser } from '@/features/auth/api/auth-api';
import { UnauthenticatedError } from '@core/lib/api-errors';
import type { HttpClient } from '@core/lib/http-client';
import type { StaffSessionStore } from '../session-store';

export interface HttpAuthApiOptions {
  /** Signed-in calls (session, logout). */
  readonly http: HttpClient;
  /** The two public sign-in routes (no `Authorization` header). */
  readonly signInHttp: HttpClient;
  readonly session: StaffSessionStore;
  readonly readInitData: () => string | null;
  /** Forgets the Mini App init data of this tab (sign-out ends the Telegram-launched session too). */
  readonly forgetInitData: () => void;
}

/**
 * The roles come from the server's answer and nowhere else. A person with an organization
 * membership is a customer: the staff app does not show their organization, so such a person
 * has no staff roles and lands on the permission-denied screen.
 */
function toCurrentUser(me: MeResponse): CurrentUser {
  return {
    id: me.userId,
    displayName: me.fullName,
    staffRoles: me.staffRoles,
    organization: null,
  };
}

/** Website sign-in (password, Telegram widget), the session read and sign-out of staff. */
export function createHttpAuthApi(options: HttpAuthApiOptions): AuthApi {
  const { http, signInHttp, session } = options;

  async function readCurrentUser(): Promise<CurrentUser | null> {
    // Nothing to present: skip the request instead of provoking a 401.
    if (session.read() === null && options.readInitData() === null) return null;
    const sentUnder = session.generation();
    // A token found in storage is sent only when the tab holds no init data (staff-http).
    const sentSession =
      session.read() !== null && (session.setInThisPage() || options.readInitData() === null);
    try {
      const answer = await http.request(
        STAFF_AUTH_ROUTES.currentSession,
        staffCurrentSessionResponseSchema,
      );
      return toCurrentUser(answer.me);
    } catch (caught) {
      if (!(caught instanceof UnauthenticatedError)) throw caught;
      // An expired or revoked token must not be tried again on the next page load. Only the
      // token that was really sent: a refused init data says nothing about the website session.
      // Only if no sign-in or sign-out happened meanwhile: a late 401 of an old token must not
      // remove the token of the person who signed in since.
      if (sentSession && session.generation() === sentUnder) session.clear();
      // The website session of this tab ended, but Telegram opened the tab: its init data is
      // the credential the client sends next, so ask once more before the person is treated
      // as signed out. (The second call sends no session, so it cannot come back here.)
      if (sentSession && session.read() === null && options.readInitData() !== null) {
        return readCurrentUser();
      }
      return null;
    }
  }

  return {
    getCurrentUser: readCurrentUser,

    async signInWithPassword(credentials) {
      const answer = await signInHttp.request(
        STAFF_AUTH_ROUTES.passwordSignIn,
        staffSignInResponseSchema,
        { body: { login: credentials.login, password: credentials.password } },
      );
      session.set(answer.token);
      return toCurrentUser(answer.me);
    },

    async signInWithTelegramWidget(payload) {
      const answer = await signInHttp.request(
        STAFF_AUTH_ROUTES.telegramWidgetSignIn,
        staffSignInResponseSchema,
        // Untouched: the signature covers exactly these fields.
        { body: payload },
      );
      session.set(answer.token);
      return toCurrentUser(answer.me);
    },

    async signOut() {
      // Best effort on the server (a session that is already gone answers 401 and the idle limit
      // ends any other one); the local credentials are dropped whatever happens.
      try {
        if (session.read() !== null) await http.requestVoid(STAFF_AUTH_ROUTES.signOut);
      } catch {
        // Deliberately not rethrown: the person asked to leave, and every local credential is
        // removed below. The token is unreadable to anyone but the server now.
      } finally {
        session.clear();
        options.forgetInitData();
      }
    },
  };
}
