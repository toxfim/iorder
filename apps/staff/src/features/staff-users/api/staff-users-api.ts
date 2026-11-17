import { IDENTITY_ROUTES, staffUserResponseSchema, type StaffUserResponse } from '@iorder/shared';
import {
  STAFF_USER_ROUTES,
  blockUserResponseSchema,
  groupRemovalStatusResponseSchema,
  type BlockUserResponse,
  type GroupRemovalItem,
} from '@iorder/shared/staff-orders';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Blocking a person and what happens to their Telegram group membership (manager and admin).
 * Every refusal for a staff target is the same 403 as any other refusal, so the client cannot
 * tell "no such person" from "not allowed" for an administrator.
 */
export interface StaffUsersApi {
  /**
   * `removeFromGroups: true` also queues the removal from the person's Telegram group(s). Sending
   * it again for an already blocked person re-queues only the removals that FAILED (the server
   * does not queue a removal that is waiting or done).
   */
  blockUser: (userId: string, options: { removeFromGroups: boolean }) => Promise<BlockUserResponse>;
  /** Unblocking re-adds nobody to a group. */
  unblockUser: (userId: string) => Promise<StaffUserResponse>;
  /** Per Telegram group: PENDING, DONE or FAILED with a short code. Never cached. */
  removalStatus: (userId: string) => Promise<readonly GroupRemovalItem[]>;
}

export function createHttpStaffUsersApi(http: HttpClient): StaffUsersApi {
  return {
    blockUser: (userId, options) =>
      http.request(IDENTITY_ROUTES.blockUser, blockUserResponseSchema, {
        params: { id: userId },
        body: { removeFromGroups: options.removeFromGroups },
      }),
    unblockUser: (userId) =>
      http.request(IDENTITY_ROUTES.unblockUser, staffUserResponseSchema, {
        params: { id: userId },
      }),
    removalStatus: async (userId) =>
      (
        await http.request(STAFF_USER_ROUTES.userRemovalStatus, groupRemovalStatusResponseSchema, {
          params: { id: userId },
        })
      ).items,
  };
}

/**
 * Blocks (without touching the person's Telegram groups) or unblocks. Lives here so the blocking
 * vocabulary stays in the staff-users chunk (check:bundle) for callers in other features.
 */
export async function setUserActive(
  api: StaffUsersApi,
  userId: string,
  isActive: boolean,
): Promise<StaffUserResponse> {
  return isActive ? api.unblockUser(userId) : api.blockUser(userId, { removeFromGroups: false });
}
