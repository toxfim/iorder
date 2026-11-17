import { randomBytes } from 'node:crypto';
import { PERMISSION_ACTIONS, type PermissionAction } from '../../common/auth/permission-matrix.js';
import { hashSessionToken } from './session-token.js';

/**
 * The prefix tells an API token apart from a website session token in the same `Bearer` header,
 * and makes a leaked token recognisable in logs or a secret scanner.
 */
export const API_TOKEN_PREFIX = 'iot_';

/** `iot_` + 32 random bytes in base64url (43 characters). */
const API_TOKEN_PATTERN = /^iot_[A-Za-z0-9_-]{43}$/;

/**
 * The actions a token may be issued for. Deliberately short: a token is for one program's one job,
 * never a general key. [P] Add an action here only with a reviewed reason.
 */
export const API_TOKEN_SCOPES = [
  'MANAGE_PRODUCT_IMAGES',
] as const satisfies readonly PermissionAction[];
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Lifetime limits of a token, in days. [P] */
export const API_TOKEN_DEFAULT_DAYS = 7;
export const API_TOKEN_MAX_DAYS = 30;

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Same reasoning as website sessions: 256 random bits need no slow hash. */
export function hashApiToken(token: string): string {
  return hashSessionToken(token);
}

/** Cheap shape check done before any database lookup. */
export function isWellFormedApiToken(value: string): boolean {
  return API_TOKEN_PATTERN.test(value);
}

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * Stored scopes as the Actor uses them. An unknown value (an action renamed or removed later) is
 * dropped, so it can never grant anything.
 */
export function toActorScopes(stored: readonly string[]): PermissionAction[] {
  return stored.filter((value): value is PermissionAction =>
    (PERMISSION_ACTIONS as readonly string[]).includes(value),
  );
}
