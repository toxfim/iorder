import {
  STAFF_AUTH_ROUTES,
  staffAccountListResponseSchema,
  staffAccountResponseSchema,
  staffDirectoryResponseSchema,
  staffCredentialsResponseSchema,
  type CreateStaffAccountRequest,
  type SetStaffCredentialsRequest,
  type StaffAccountResponse,
  type StaffCredentialsResponse,
  type StaffDirectoryEntry,
} from '@iorder/shared/staff-auth';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Staff accounts (manager and admin). The server enforces who may touch whom: a manager can
 * neither grant ADMIN nor change an administrator's login, password or Telegram link. Passwords
 * only ever travel in a request body; no answer contains one.
 */
export interface StaffAccountsApi {
  list: () => Promise<readonly StaffAccountResponse[]>;
  /** The reader's list: no login, password fact or Telegram id. */
  directory: () => Promise<readonly StaffDirectoryEntry[]>;
  create: (input: CreateStaffAccountRequest) => Promise<StaffAccountResponse>;
  /** Links or replaces the Telegram id; removing it is not possible. */
  setTelegram: (userId: string, telegramUserId: string) => Promise<StaffAccountResponse>;
  /** A new password ends every session of that person and clears their lockout. */
  setCredentials: (
    userId: string,
    input: SetStaffCredentialsRequest,
  ) => Promise<StaffCredentialsResponse>;
}

export function createHttpStaffAccountsApi(http: HttpClient): StaffAccountsApi {
  return {
    list: async () =>
      (await http.request(STAFF_AUTH_ROUTES.listAccounts, staffAccountListResponseSchema)).items,
    directory: async () =>
      (await http.request(STAFF_AUTH_ROUTES.staffDirectory, staffDirectoryResponseSchema)).items,
    create: (input) =>
      http.request(STAFF_AUTH_ROUTES.createAccount, staffAccountResponseSchema, { body: input }),
    setTelegram: (userId, telegramUserId) =>
      http.request(STAFF_AUTH_ROUTES.setTelegram, staffAccountResponseSchema, {
        params: { id: userId },
        body: { telegramUserId },
      }),
    setCredentials: (userId, input) =>
      http.request(STAFF_AUTH_ROUTES.setCredentials, staffCredentialsResponseSchema, {
        params: { id: userId },
        body: input,
      }),
  };
}
