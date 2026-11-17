import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes = 256 bits, base64url = 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new opaque session token. The only copy is the one handed to the browser. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database stores and looks up: the hex SHA-256 of the token. The token is already
 * 256 bits of randomness, so a plain fast hash is enough (a slow password hash would only slow
 * down every request), and a leaked table cannot be turned back into working tokens.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap shape check done before any database lookup. */
export function isWellFormedSessionToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
