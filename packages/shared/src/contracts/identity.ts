import { z } from 'zod';
import { ORGANIZATION_ROLES, STAFF_ROLES } from '../roles.js';
import { isoInstantSchema, languageCodeSchema } from './common.js';

// Telegram ids are 64-bit in the database. They travel as DECIMAL STRINGS in JSON and in the
// contract, never as JS numbers, so a large id can never lose precision on the way.

/** A Telegram user id: a positive integer that is also a safe JS integer (Telegram ids fit in 52 bits). */
// One refine (not regex + refine): zod 4 runs every check, so a second check must not assume
// the first one passed. Number() is exact up to 2^53 and never throws on garbage.
export const telegramUserIdSchema = z
  .string()
  .refine(
    (value) => /^[1-9]\d{0,15}$/.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER,
    'Expected a positive integer Telegram id (at most 2^53 - 1) as a string',
  );
export type TelegramUserId = z.infer<typeof telegramUserIdSchema>;

/** A Telegram chat id. Group ids are negative (-100...). Zero is not a chat. */
export const telegramChatIdSchema = z
  .string()
  .regex(/^-?[1-9]\d{0,15}$/, 'Expected a non-zero integer Telegram chat id as a string');

/**
 * Machine-readable reasons of a 409 on the identity and organization endpoints. They are kept
 * apart from CONFLICT_REASONS (the list the web client reads and maps exhaustively). LAST_ADMIN,
 * TELEGRAM_ID_REQUIRED, ORGANIZATION_NOT_LINKED, ORGANIZATION_ALREADY_LINKED,
 * PERSON_ORGANIZATION and ORGANIZATION_ARCHIVED are in both, because the staff screens show them; a client that does
 * not know a reason falls back to the generic conflict message. Merge the others into
 * CONFLICT_REASONS together with the screens that show them.
 * - STAFF_HAS_MEMBERSHIP: assigning a staff role to a user with an ACTIVE organization membership
 * - MEMBER_IS_STAFF: giving a user who holds a staff role an organization membership
 * - ALREADY_MEMBER_ELSEWHERE: the user has an ACTIVE membership in another organization
 * - SHOP_OWNER_EXISTS: the organization already has an ACTIVE shop owner
 * - LAST_ADMIN: the action would leave the system without an ACTIVE administrator
 * - USER_BLOCKED: the person is BLOCKED and cannot be made a shop owner
 * - ORGANIZATION_INACTIVE: the organization is INACTIVE and cannot get a shop owner
 * - TELEGRAM_ID_REQUIRED: a person with no Telegram id must keep a staff role (they cannot become a customer or member)
 * - ORGANIZATION_NOT_LINKED: a staff-created organization has no Telegram chat yet, so it cannot be activated by hand
 * - ORGANIZATION_ALREADY_LINKED: the organization already has its chat, so it needs no invite link
 * - PERSON_ORGANIZATION: a PERSON organization keeps its bound person as the only shop owner (no role changes)
 * - ORGANIZATION_ARCHIVED: the organization is archived; nothing on it changes until an admin restores it
 */
export const MEMBERSHIP_CONFLICT_REASONS = [
  'STAFF_HAS_MEMBERSHIP',
  'MEMBER_IS_STAFF',
  'ALREADY_MEMBER_ELSEWHERE',
  'SHOP_OWNER_EXISTS',
  'LAST_ADMIN',
  'USER_BLOCKED',
  'ORGANIZATION_INACTIVE',
  'TELEGRAM_ID_REQUIRED',
  'ORGANIZATION_NOT_LINKED',
  'ORGANIZATION_ALREADY_LINKED',
  'PERSON_ORGANIZATION',
  'ORGANIZATION_ARCHIVED',
] as const;
export type MembershipConflictReason = (typeof MEMBERSHIP_CONFLICT_REASONS)[number];
export const membershipConflictReasonSchema = z.enum(MEMBERSHIP_CONFLICT_REASONS);

export const staffRoleSchema = z.enum(STAFF_ROLES);
export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);

export const USER_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export type UserStatusName = (typeof USER_STATUSES)[number];
export const userStatusSchema = z.enum(USER_STATUSES);

/**
 * International phone, normalized: "+" and 7 to 15 digits (E.164). A person types their own
 * number (UNVERIFIED, owner decision 2026-10-23) and may change it later in their profile
 * [C, 2026-11-09]; staff can correct it too. A phone appears only in staff responses and in the
 * caller's OWN profile answers.
 */
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone must look like +998901234567');

// Control (Cc) and format (Cf) characters (bidi overrides, zero-width, soft hyphen) would let a
// name look different from what is stored or break staff screens and Telegram messages.
export const personNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Name must not contain control characters');

// ---------------------------------------------------------------------------------------
// GET /me: the caller's own actor summary. No Telegram id, no cost data. The phone is the
// caller's OWN contact only (never another user's).
// ---------------------------------------------------------------------------------------

/**
 * A phone as a person types it: spaces, dashes and brackets are dropped before the format check,
 * so the stored value is always `+<digits>`.
 */
export const typedPhoneSchema = z
  .string()
  .max(40)
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .pipe(phoneSchema);

/** The contact a customer typed themselves. UNVERIFIED: nobody checked the number. */
export const ownContactSchema = z.strictObject({
  fullName: z.string(),
  phone: phoneSchema,
});
export type OwnContact = z.infer<typeof ownContactSchema>;

/**
 * What a staff viewer may do in the customer app. `canOrder` is true only where the api names a
 * test organization for staff orders (staging); the order is then written to `organizationName`.
 */
export const staffViewerSchema = z.strictObject({
  canOrder: z.boolean(),
  /** The organization a staff order is written to; null whenever `canOrder` is false. */
  organizationName: z.string().nullable(),
});
export type StaffViewerInfo = z.infer<typeof staffViewerSchema>;

export const meResponseSchema = z.strictObject({
  userId: z.uuid(),
  fullName: z.string(),
  locale: languageCodeSchema,
  /** Empty for customers. A person with a staff role never has a membership. */
  staffRoles: z.array(staffRoleSchema),
  membership: z
    .strictObject({
      organizationId: z.uuid(),
      organizationName: z.string().optional(),
      role: organizationRoleSchema,
    })
    .nullable(),
  /** The caller's own contact; null until a customer has entered a phone (always null for staff). */
  contact: ownContactSchema.nullable(),
  /** True for a customer without a phone: the first order asks for it. Always false for staff. */
  needsContact: z.boolean(),
  /**
   * Present (not null) for a staff member who may use the CUSTOMER app as a viewer
   * [C, 2026-11-09]: prices and the cart, no organization. The customer app shows viewer mode
   * from this block alone; it never reasons about `staffRoles`. Absent or null: not a viewer.
   */
  staffViewer: staffViewerSchema.nullable().optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * PUT /me/contact: a customer's OWN name and phone. Entered at the first order and changed later
 * from the profile, as often as needed [C, 2026-11-09]. Both fields are always sent (the phone
 * cannot be removed: an order needs it). Staff use their own route (`@iorder/shared/staff-auth`).
 */
export const setOwnContactRequestSchema = z.strictObject({
  fullName: personNameSchema,
  phone: typedPhoneSchema,
});
export type SetOwnContactRequest = z.output<typeof setOwnContactRequestSchema>;

// ---------------------------------------------------------------------------------------
// Staff user endpoints
// ---------------------------------------------------------------------------------------

export const staffUserListQuerySchema = z.strictObject({
  /** Case-insensitive match over name, phone and Telegram id. */
  search: z.string().trim().min(1).max(100).optional(),
  status: userStatusSchema.optional(),
  /** Only users holding this staff role. */
  role: staffRoleSchema.optional(),
});
export type StaffUserListQuery = z.output<typeof staffUserListQuerySchema>;

export const updateUserRequestSchema = z
  .strictObject({
    fullName: personNameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    language: languageCodeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change');
export type UpdateUserRequest = z.output<typeof updateUserRequestSchema>;

export const staffUserResponseSchema = z.strictObject({
  id: z.uuid(),
  /** Null for a staff account not linked yet, and for a role that may not know Telegram ids. */
  telegramUserId: telegramUserIdSchema.nullable(),
  fullName: z.string(),
  phone: z.string().nullable(),
  language: languageCodeSchema,
  status: userStatusSchema,
  staffRoles: z.array(staffRoleSchema),
  membership: z
    .strictObject({
      organizationId: z.uuid(),
      organizationName: z.string(),
      role: organizationRoleSchema,
      joinedAt: isoInstantSchema,
    })
    .nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type StaffUserResponse = z.infer<typeof staffUserResponseSchema>;

/**
 * The small card shown when a staff member hovers a person's name in the dashboard. Allow-listed:
 * no Telegram id, no language, no timestamps. A person is staff when `staffRoles` is not empty.
 */
export const staffPersonCardSchema = z.strictObject({
  id: z.uuid(),
  fullName: z.string(),
  phone: z.string().nullable(),
  status: userStatusSchema,
  staffRoles: z.array(staffRoleSchema),
  /** The ACTIVE organization membership of a customer; always null for staff. */
  membership: z
    .strictObject({ organizationName: z.string(), role: organizationRoleSchema })
    .nullable(),
});
export type StaffPersonCard = z.infer<typeof staffPersonCardSchema>;

export const staffUserListResponseSchema = z.strictObject({
  items: z.array(staffUserResponseSchema),
});
export type StaffUserListResponse = z.infer<typeof staffUserListResponseSchema>;
