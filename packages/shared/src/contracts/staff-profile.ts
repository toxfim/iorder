import { z } from 'zod';
import { personNameSchema, typedPhoneSchema } from './identity.js';
import { route } from './routes.js';

// A staff member's OWN name and phone [C, 2026-11-09]: every person changes their own name and
// contact details from their profile. Both routes take no user id: the person is always the
// caller. Nothing else can be changed here (roles, login, Telegram id stay with the administrator
// and the manager). STAFF-ONLY entry: a customer has `PUT /me/contact` instead.
export const STAFF_PROFILE_ROUTES = Object.freeze({
  /** The caller's own name and phone (`GET /me` never carries a staff phone). */
  getOwnProfile: route('GET', '/staff/me/profile'),
  /** Replaces the caller's own name and phone. Throttled per person; audited with before/after. */
  updateOwnProfile: route('PUT', '/staff/me/profile'),
});

export const ownStaffProfileResponseSchema = z.strictObject({
  fullName: z.string(),
  /** Null when the person has no phone on their account. */
  phone: z.string().nullable(),
});
export type OwnStaffProfileResponse = z.infer<typeof ownStaffProfileResponseSchema>;

/**
 * Both fields are always sent. [P] A staff phone may be removed (null): it is optional when the
 * account is created, unlike a customer's, which an order needs.
 */
export const updateOwnStaffProfileRequestSchema = z.strictObject({
  fullName: personNameSchema,
  phone: typedPhoneSchema.nullable(),
});
export type UpdateOwnStaffProfileRequest = z.output<typeof updateOwnStaffProfileRequestSchema>;
