import { z } from 'zod';
import { route } from './routes.js';
import { staffLoginSchema, newStaffPasswordSchema } from './website-auth.js';
export {
  passwordSignInRequestSchema as customerPasswordSignInSchema,
  telegramWidgetSignInRequestSchema as customerTelegramSignInSchema,
} from './website-auth.js';
export const customerCredentialsRequestSchema = z
  .strictObject({
    login: staffLoginSchema,
    password: newStaffPasswordSchema,
  })
  .refine(
    (value) => value.password.toLowerCase() !== value.login,
    'Password must differ from login',
  );
export type CustomerCredentialsRequest = z.infer<typeof customerCredentialsRequestSchema>;
export const customerCredentialsResponseSchema = z.strictObject({
  login: z.string().nullable(),
  canEdit: z.boolean().optional(),
});
export const CUSTOMER_AUTH_ROUTES = Object.freeze({
  password: route('POST', '/customer/auth/password-login'),
  telegram: route('POST', '/customer/auth/telegram-widget'),
  /** Public: exchanges a one-time handoff code for a session; a uniform 401 for every bad code. */
  handoff: route('POST', '/customer/auth/handoff'),
  /** Public: the page that can hand a signed-in company employee over to this site, or null. */
  handoffPage: route('GET', '/customer/auth/handoff'),
  credentials: route('GET', '/customer/auth/credentials'),
  setCredentials: route('PUT', '/customer/auth/credentials'),
  logout: route('POST', '/auth/logout'),
});

export const customerSignInResponseSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// ---------------------------------------------------------------------------------------
// One-time handoff from the company's own site ([C] 2026-11-09)
// ---------------------------------------------------------------------------------------

/** The handoff code arrives in the URL fragment as `#handoff=<code>` and is removed at once. */
export const HANDOFF_FRAGMENT_PARAM = 'handoff';
/** 32 random bytes in base64url, like a session token. */
export const HANDOFF_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Deliberately permissive (any string up to a bound): a malformed code must get the same answer
 * as an unknown, used or expired one, so the shape is checked by the service, not here.
 */
export const customerHandoffRequestSchema = z.strictObject({ code: z.string().max(256) });
export type CustomerHandoffRequest = z.infer<typeof customerHandoffRequestSchema>;

/** `url` is null when no such page is configured: the site then never sends anyone away. */
export const customerHandoffPageResponseSchema = z.strictObject({
  // http(s) only: the browser is sent there, so no other scheme is ever accepted.
  url: z.url({ protocol: /^https?$/ }).nullable(),
});
export type CustomerHandoffPageResponse = z.infer<typeof customerHandoffPageResponseSchema>;
