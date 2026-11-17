import { z } from 'zod';
import { isoInstantSchema } from './common.js';
import { meResponseSchema } from './identity.js';

/**
 * Legacy login shape, still valid for rows stored before the owner asked for email-like logins
 * (2026-10-22). New logins may use either shape; the database CHECK accepts both.
 */
export const STAFF_LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
/**
 * Email-like login, `local@domain.tld`, lowercase ASCII. It is only an identifier: no email is ever
 * sent to it. The local part starts and ends with a letter or digit; domain labels do not start or
 * end with a hyphen; the last label is letters only. Consecutive dots and the length limit are
 * checked in `isStaffLogin` (the database CHECK repeats all of it).
 */
export const STAFF_LOGIN_EMAIL_PATTERN =
  /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
export const STAFF_LOGIN_MAX_LENGTH = 64;
export const STAFF_PASSWORD_MIN_LENGTH = 8;
/** Upper bound so an enormous body cannot be used to burn hashing time. */
export const STAFF_PASSWORD_MAX_LENGTH = 128;

export function isStaffLogin(value: string): boolean {
  if (STAFF_LOGIN_PATTERN.test(value)) return true;
  return (
    value.length <= STAFF_LOGIN_MAX_LENGTH &&
    !value.includes('..') &&
    STAFF_LOGIN_EMAIL_PATTERN.test(value)
  );
}

/** A login being SET: lowercase only, so the stored value is the typed value. */
export const staffLoginSchema = z
  .string()
  .refine(
    isStaffLogin,
    'Login must look like name@iorder.uz (lowercase a-z 0-9 . _ + -, at most 64 characters)',
  );

/** A password being SET. Length counts characters, not bytes. No composition rules (NIST 800-63B). */
export const newStaffPasswordSchema = z
  .string()
  .min(
    STAFF_PASSWORD_MIN_LENGTH,
    `Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters`,
  )
  .max(STAFF_PASSWORD_MAX_LENGTH);

// ---------------------------------------------------------------------------------------
// Sign-in requests
// ---------------------------------------------------------------------------------------

/**
 * The Telegram Login Widget callback object (https://core.telegram.org/widgets/login). `id` and
 * `auth_date` arrive as numbers from the widget's JavaScript callback; digit strings are accepted
 * too (the redirect flavour). The signature covers every field present, so only these names exist.
 */
const digits = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,15}$/)]);
export const telegramWidgetSignInRequestSchema = z.strictObject({
  id: digits,
  first_name: z.string().min(1).max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().max(2048).optional(),
  auth_date: digits,
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});
export type TelegramWidgetSignInRequest = z.output<typeof telegramWidgetSignInRequestSchema>;

/**
 * Deliberately permissive on the password (any non-empty string up to a bound): a wrong or old
 * password must look exactly like any other failure, so the policy is not revealed here.
 */
export const passwordSignInRequestSchema = z.strictObject({
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type PasswordSignInRequest = z.output<typeof passwordSignInRequestSchema>;

// ---------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------

export const staffSessionInfoSchema = z.strictObject({
  /** The session dies at the earlier of this and `idleExpiresAt`. */
  expiresAt: isoInstantSchema,
  /** Moves forward while the session is used; capped by `expiresAt`. */
  idleExpiresAt: isoInstantSchema,
});
export type StaffSessionInfo = z.infer<typeof staffSessionInfoSchema>;

/** Sign-in answer. The token is shown ONCE and is not retrievable later. */
export const staffSignInResponseSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  session: staffSessionInfoSchema,
  me: meResponseSchema,
});
export type StaffSignInResponse = z.infer<typeof staffSignInResponseSchema>;

/** `session` is null when the request was authenticated some other way (Mini App init data). */
export const staffCurrentSessionResponseSchema = z.strictObject({
  session: staffSessionInfoSchema.nullable(),
  me: meResponseSchema,
});
export type StaffCurrentSessionResponse = z.infer<typeof staffCurrentSessionResponseSchema>;
