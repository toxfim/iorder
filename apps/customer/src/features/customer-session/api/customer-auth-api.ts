import {
  CUSTOMER_AUTH_ROUTES,
  customerCredentialsResponseSchema,
  customerHandoffPageResponseSchema,
  customerSignInResponseSchema,
  type CustomerCredentialsRequest,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';
import { forgetInitData, readInitData } from '@core/telegram/launch';
import { setCustomerToken } from '../website-session';
export interface CustomerAuthApi {
  password: (login: string, password: string) => Promise<void>;
  telegram: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Exchanges a one-time handoff code for a session of this site ([C] 2026-11-09). */
  handoff: (code: string) => Promise<void>;
  /** The page of the company's own site that can hand a person over; null when there is none. */
  handoffPage: () => Promise<string | null>;
  /** Ends a session of this site on the server by its token: the one a handoff replaced. */
  revokeSession: (token: string) => Promise<void>;
  credentials: () => Promise<{ login: string | null; canEdit?: boolean }>;
  setCredentials: (
    input: CustomerCredentialsRequest,
  ) => Promise<{ login: string | null; canEdit?: boolean }>;
  logout: () => Promise<void>;
}
export function createCustomerAuthApi(http: HttpClient, publicHttp: HttpClient): CustomerAuthApi {
  async function signIn(method: 'password' | 'telegram' | 'handoff', body: unknown): Promise<void> {
    const answer = await publicHttp.request(
      CUSTOMER_AUTH_ROUTES[method],
      customerSignInResponseSchema,
      { body },
    );
    forgetInitData();
    setCustomerToken(answer.token);
  }
  return {
    password: (login, password) => signIn('password', { login, password }),
    telegram: (payload) => signIn('telegram', payload),
    handoff: (code) => signIn('handoff', { code }),
    revokeSession: (token) =>
      publicHttp.requestVoid(CUSTOMER_AUTH_ROUTES.logout, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    handoffPage: async () => {
      const answer = await publicHttp.request(
        CUSTOMER_AUTH_ROUTES.handoffPage,
        customerHandoffPageResponseSchema,
      );
      return answer.url;
    },
    credentials: () =>
      http.request(CUSTOMER_AUTH_ROUTES.credentials, customerCredentialsResponseSchema),
    setCredentials: async (input) => {
      const answer = await http.request(
        CUSTOMER_AUTH_ROUTES.setCredentials,
        customerCredentialsResponseSchema,
        { body: input },
      );
      if (readInitData() === null) setCustomerToken(null);
      return answer;
    },
    logout: async () => {
      try {
        await http.requestVoid(CUSTOMER_AUTH_ROUTES.logout);
      } finally {
        setCustomerToken(null);
        forgetInitData();
      }
    },
  };
}
