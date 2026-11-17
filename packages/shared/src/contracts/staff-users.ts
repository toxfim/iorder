import { z } from 'zod';
import { isoInstantSchema } from './common.js';
import { staffUserResponseSchema } from './identity.js';
import { route } from './routes.js';

// STAFF-ONLY: blocking a customer together with removing them from their Telegram group(s).
// Part of the `staff-orders` entry so the customer bundle never sees this vocabulary. The request
// schema is strict: an unknown field is rejected, never ignored.

export const STAFF_USER_ROUTES = Object.freeze({
  /** Per Telegram group: has the bot removed the blocked person yet, and if not, why. */
  userRemovalStatus: route('GET', '/staff/users/:id/removal-status'),
});

/**
 * Body of POST /staff/users/:id/block. The body itself is optional (a missing body means
 * `removeFromGroups: false`), so existing callers keep working.
 */
export const blockUserRequestSchema = z.preprocess(
  (value) => value ?? {},
  z.strictObject({ removeFromGroups: z.boolean().default(false) }),
);
export type BlockUserRequest = z.output<typeof blockUserRequestSchema>;

/** Why a removal is not done: short codes the UI maps to texts. Never Telegram's wording. */
export const GROUP_REMOVAL_ERROR_CODES = [
  /** The bot is not an administrator of the group (or lacks the "ban users" right). */
  'BOT_NOT_ADMIN',
  /** Telegram says the person is not in the group (already gone). */
  'NOT_A_MEMBER',
  /** The group does not exist for the bot any more (deleted, or the bot was removed). */
  'CHAT_NOT_FOUND',
  /** Telegram refuses to remove this person (the group's creator or another administrator). */
  'CANNOT_REMOVE_MEMBER',
  /** The bot refused by itself: the person is staff, is no longer blocked or the ids differ. */
  'REMOVAL_NOT_ALLOWED',
  /**
   * The person was banned from the group but the unban failed: they may still be on the group's
   * ban list and cannot be invited back until a group admin unbans them.
   */
  'UNBAN_FAILED',
  /** The bot stayed rate limited by Telegram for a whole day, so the request was dropped. */
  'RATE_LIMITED_TOO_LONG',
  /** The group was upgraded to a supergroup: the stored chat id is outdated. */
  'CHAT_MIGRATED',
  /** Telegram rejected the request for another reason. */
  'REMOVAL_REJECTED',
  /** The person's Telegram account or the group is no longer known. */
  'NO_RECIPIENT',
  /** Still failing after the allowed number of tries. */
  'RETRIES_EXHAUSTED',
  'INVALID_PAYLOAD',
] as const;
export type GroupRemovalErrorCode = (typeof GROUP_REMOVAL_ERROR_CODES)[number];

export const GROUP_REMOVAL_STATUSES = ['PENDING', 'DONE', 'FAILED'] as const;
export type GroupRemovalStatus = (typeof GROUP_REMOVAL_STATUSES)[number];

export const groupRemovalItemSchema = z.strictObject({
  organizationId: z.uuid(),
  organizationName: z.string(),
  status: z.enum(GROUP_REMOVAL_STATUSES),
  /** Set for FAILED, and for PENDING while a retry waits (the last failure so far). */
  errorCode: z.enum(GROUP_REMOVAL_ERROR_CODES).nullable(),
  /** True when the person may be banned in that group right now (code UNBAN_FAILED). */
  maybeBanned: z.boolean(),
  requestedAt: isoInstantSchema,
  completedAt: isoInstantSchema.nullable(),
});
export type GroupRemovalItem = z.infer<typeof groupRemovalItemSchema>;

export const groupRemovalStatusResponseSchema = z.strictObject({
  items: z.array(groupRemovalItemSchema),
});
export type GroupRemovalStatusResponse = z.infer<typeof groupRemovalStatusResponseSchema>;

/**
 * Answer of the block endpoint: the usual staff user plus what was queued for the group removal.
 * An extension of the old answer, so callers that ignore `groupRemoval` keep working.
 */
export const blockUserResponseSchema = staffUserResponseSchema.extend({
  /** Present only when the request asked for the removal (`removeFromGroups: true`). */
  groupRemoval: z
    .strictObject({
      requested: z.boolean(),
      /** Removals queued by THIS call (0 when the person is in no group). */
      queued: z.number().int().nonnegative(),
      /** Memberships that already had a removal waiting or done, so nothing new was queued. */
      alreadyRequested: z.number().int().nonnegative(),
    })
    .optional(),
});
export type BlockUserResponse = z.infer<typeof blockUserResponseSchema>;
