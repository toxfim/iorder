import { z } from 'zod';
import { isoInstantSchema, languageCodeSchema } from './common.js';
import {
  phoneSchema,
  staffRoleSchema,
  telegramUserIdSchema,
  userStatusSchema,
} from './identity.js';
import { STAFF_ROLES } from '../roles.js';
import { route } from './routes.js';

// STAFF sign-in contracts for the website (owner decision 2026-10-22). Customers sign in through
// the Telegram Mini App only and never use these. Deliberately NOT re-exported from the package
// barrel: the customer bundle must not contain staff sign-in vocabulary. Every request schema is
// strict: an unknown field is rejected, never ignored.

export const STAFF_AUTH_ROUTES = Object.freeze({
  /** Body: the Telegram Login Widget payload. Public; answers 200 with a session or a uniform 401. */
  telegramWidgetSignIn: route('POST', '/auth/telegram-widget'),
  /** Body: login + password. Public; answers 200 with a session or a uniform 401. */
  passwordSignIn: route('POST', '/auth/password-login'),
  /** `Authorization: Bearer <token>`: who am I, and when does the session end. */
  currentSession: route('GET', '/auth/session'),
  /** Revokes the session the request was made with. 204. */
  signOut: route('POST', '/auth/logout'),
  /** Manager or admin: set or reset a staff member's login and password. */
  setCredentials: route('PUT', '/staff/users/:id/credentials'),
  /** Manager or admin: create a staff account (a manager cannot create an administrator). */
  createAccount: route('POST', '/staff/users'),
  /** Manager or admin: the staff accounts with their login and sign-in facts. */
  listAccounts: route('GET', '/staff/accounts'),
  /** Who works here, for a reader: no login, no password fact, no Telegram id. */
  staffDirectory: route('GET', '/staff/accounts/directory'),
  /** Manager or admin: link or unlink the Telegram id of a staff account. */
  setTelegram: route('PUT', '/staff/users/:id/telegram'),
  /** Whether this session can open the customer site, and where that site is. */
  customerSite: route('GET', '/staff/customer-site'),
  /** A one-time code to continue on the customer site; answers the address to open. */
  customerSiteHandoff: route('POST', '/staff/customer-site/handoff'),
});

// ---------------------------------------------------------------------------------------
// Continuing on the customer site with the dashboard sign-in ([C] 2026-11-09)
// ---------------------------------------------------------------------------------------

/**
 * `url` is the customer site, or null when this caller cannot be handed over to it (the site is
 * not configured, or the request came without a website session). The staff app shows its
 * "Customer site" entry only for a non-null answer.
 */
/** An http(s) address: what a browser may be sent to (never `javascript:` or another scheme). */
const siteUrlSchema = z.url({ protocol: /^https?$/ });

export const customerSiteResponseSchema = z.strictObject({ url: siteUrlSchema.nullable() });
export type CustomerSiteResponse = z.infer<typeof customerSiteResponseSchema>;

/**
 * Deliberately empty and strict: where the browser goes next is decided by the server's own
 * configuration, never by the request, so there is no "return to" field to tamper with.
 */
export const customerSiteHandoffRequestSchema = z.strictObject({});

/**
 * `url` is the customer site with the one-time code in the URL FRAGMENT (never the query string,
 * so it reaches neither a server log nor a referrer). The code works once, until `expiresAt`.
 */
export const customerSiteHandoffResponseSchema = z.strictObject({
  url: siteUrlSchema,
  expiresAt: isoInstantSchema,
});
export type CustomerSiteHandoffResponse = z.infer<typeof customerSiteHandoffResponseSchema>;

// ---------------------------------------------------------------------------------------
// Login and password rules (the database CHECK repeats the login format)
// ---------------------------------------------------------------------------------------

export {
  STAFF_LOGIN_PATTERN,
  STAFF_LOGIN_EMAIL_PATTERN,
  STAFF_LOGIN_MAX_LENGTH,
  STAFF_PASSWORD_MIN_LENGTH,
  STAFF_PASSWORD_MAX_LENGTH,
  isStaffLogin,
  staffLoginSchema,
  newStaffPasswordSchema,
  telegramWidgetSignInRequestSchema,
  passwordSignInRequestSchema,
  staffSessionInfoSchema,
  staffSignInResponseSchema,
  staffCurrentSessionResponseSchema,
} from './website-auth.js';
export type {
  TelegramWidgetSignInRequest,
  PasswordSignInRequest,
  StaffSessionInfo,
  StaffSignInResponse,
  StaffCurrentSessionResponse,
} from './website-auth.js';
import { staffLoginSchema, newStaffPasswordSchema } from './website-auth.js';

// ---------------------------------------------------------------------------------------
// Credentials management (manager, admin)
// ---------------------------------------------------------------------------------------

export const setStaffCredentialsRequestSchema = z
  .strictObject({
    login: staffLoginSchema.optional(),
    password: newStaffPasswordSchema.optional(),
  })
  .refine(
    (value) => value.login !== undefined || value.password !== undefined,
    'Provide a login, a password, or both',
  );
export type SetStaffCredentialsRequest = z.output<typeof setStaffCredentialsRequestSchema>;

/** Never contains the password or its hash. */
export const staffCredentialsResponseSchema = z.strictObject({
  userId: z.uuid(),
  login: z.string(),
  passwordChangedAt: isoInstantSchema,
});
export type StaffCredentialsResponse = z.infer<typeof staffCredentialsResponseSchema>;

// ---------------------------------------------------------------------------------------
// Staff accounts (manager, admin): create, list, link Telegram
// ---------------------------------------------------------------------------------------

/**
 * Creates a person who works for the company. At least one staff role is required, so this can never
 * create a customer. Only an administrator may grant ADMIN (enforced by the service).
 *
 * The Telegram id is mandatory [C, 2026-10-28]: the bot recognises staff in customer groups only
 * by their id, so an account without one would be recorded as a customer member the first time
 * the person writes in a group. Linking later is kept only for accounts created before this rule.
 */
export const createStaffAccountRequestSchema = z.strictObject({
  fullName: z.string().trim().min(1).max(200),
  login: staffLoginSchema,
  password: newStaffPasswordSchema,
  roles: z
    .array(staffRoleSchema)
    .min(1)
    .max(STAFF_ROLES.length)
    .refine((roles) => new Set(roles).size === roles.length, 'Each role at most once'),
  phone: phoneSchema.optional(),
  language: languageCodeSchema.optional(),
  telegramUserId: telegramUserIdSchema,
});
export type CreateStaffAccountRequest = z.output<typeof createStaffAccountRequestSchema>;

/** Never contains the password or its hash. */
export const staffAccountResponseSchema = z.strictObject({
  id: z.uuid(),
  fullName: z.string(),
  login: z.string().nullable(),
  roles: z.array(staffRoleSchema),
  status: userStatusSchema,
  hasPassword: z.boolean(),
  telegramLinked: z.boolean(),
  /** The newest website sign-in of any kind; null when the person never signed in on the website. */
  lastSignInAt: isoInstantSchema.nullable(),
  createdAt: isoInstantSchema,
});
export type StaffAccountResponse = z.infer<typeof staffAccountResponseSchema>;

export const staffAccountListResponseSchema = z.strictObject({
  items: z.array(staffAccountResponseSchema),
});
export type StaffAccountListResponse = z.infer<typeof staffAccountListResponseSchema>;

/** The read-only list of the staff: strict, so no credential fact can slip in. */
export const staffDirectoryEntrySchema = z.strictObject({
  id: z.uuid(),
  fullName: z.string(),
  roles: z.array(staffRoleSchema),
  status: userStatusSchema,
  createdAt: isoInstantSchema,
});
export type StaffDirectoryEntry = z.infer<typeof staffDirectoryEntrySchema>;

export const staffDirectoryResponseSchema = z.strictObject({
  items: z.array(staffDirectoryEntrySchema),
});
export type StaffDirectoryResponse = z.infer<typeof staffDirectoryResponseSchema>;

/**
 * Replaces the Telegram id. Sign-in through Telegram works only while the id matches. Removing the
 * id is not possible [C, 2026-10-28]: an unlinked staff member would be taken for a customer in a
 * Telegram group.
 */
export const setStaffTelegramRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
});
export type SetStaffTelegramRequest = z.output<typeof setStaffTelegramRequestSchema>;
