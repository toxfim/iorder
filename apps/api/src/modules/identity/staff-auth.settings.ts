import type { Env } from '../../config/env.js';

/**
 * Idle limit: a session unused for this long dies. [C] 2026-11-09 (owner: "make it two weeks"): a
 * person who opens the site at least once in two weeks is not asked to sign in again. One table
 * holds the staff, the customer and the viewer sessions, so the limit is the same for all three.
 */
export const STAFF_SESSION_IDLE_SECONDS = 14 * 24 * 60 * 60;
/**
 * Absolute limit: a session never lives longer than this, however busy. [P] 90 days: long enough
 * that the two-week rule above is what people meet, short enough that a copied token stops
 * working by itself within a quarter even if its owner keeps the site open every day.
 */
export const STAFF_SESSION_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;
/** Login Widget proof freshness. [P] */
export const TELEGRAM_LOGIN_MAX_AGE_SECONDS = 5 * 60;
/**
 * `last_seen_at` is written at most this often, so an open page polling the api does not turn
 * every request into a database write. The idle limit is therefore accurate to this many seconds.
 */
export const SESSION_TOUCH_INTERVAL_SECONDS = 5 * 60;

/** Consecutive wrong passwords for one login before it locks. [P] */
export const PASSWORD_LOCK_THRESHOLD = 5;
/** First lock lasts this long and doubles with every further failure, up to the maximum. [P] */
export const PASSWORD_LOCK_BASE_SECONDS = 60;
export const PASSWORD_LOCK_MAX_SECONDS = 15 * 60;

/**
 * A failure counter older than this (no wrong password since) starts again from zero. A lock that
 * has been served also starts a new round, so one stray guess after the lock cannot re-lock the
 * login at the cap: a stranger who only knows the login can hold it for about a minute per five
 * guesses, never indefinitely with one request per lock. [P]
 */
export const PASSWORD_FAILURE_DECAY_SECONDS = 30 * 60;

/** True when the failures counted so far no longer count: quiet for too long, or the lock was served. */
export function failureRoundIsOver(
  credential: { lastFailedAt: Date | null; lockedUntil: Date | null },
  now: Date,
): boolean {
  if (credential.lockedUntil !== null && credential.lockedUntil.getTime() <= now.getTime()) {
    return true;
  }
  return (
    credential.lastFailedAt !== null &&
    now.getTime() - credential.lastFailedAt.getTime() > PASSWORD_FAILURE_DECAY_SECONDS * 1000
  );
}

/** Failed sign-in attempts per window (a successful sign-in gives its slot back). [P] */
export const SIGN_IN_WINDOW_SECONDS = 15 * 60;
export const SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER = 10;
export const SIGN_IN_LIMIT_PER_IP = 60;

/**
 * Customer site handoff ([C] 2026-11-09): a one-time code lives this long. [P] A minute covers a
 * redirect on a slow connection; the code is useless afterwards.
 */
export const HANDOFF_CODE_TTL_SECONDS = 60;
/** Codes one person may ask for per window. [P] Each visit of the customer site needs one. */
export const HANDOFF_ISSUE_LIMIT_PER_ACTOR = 10;
export const HANDOFF_ISSUE_WINDOW_SECONDS = 60;

/** Staff account creations and Telegram links per actor per window. [P] */
export const STAFF_WRITE_LIMIT_PER_ACTOR = 10;
export const STAFF_WRITE_WINDOW_SECONDS = 60;

/**
 * Failed sign-ins of the whole service per minute after which every sign-in answers 429 at once,
 * before any database or scrypt work. [P]
 */
export const GLOBAL_FAILURE_LIMIT = 300;
export const GLOBAL_FAILURE_WINDOW_SECONDS = 60;
/** Failures matching no account are written to the audit log at most once per reason per bucket. */
export const FAILURE_BUCKET_SECONDS = 60;

export interface StaffAuthSettings {
  idleSeconds: number;
  absoluteSeconds: number;
  loginMaxAgeSeconds: number;
}

/** Defaults apply when the environment says nothing; the idle limit can never exceed the absolute one. */
export function resolveStaffAuthSettings(
  env: Partial<
    Pick<
      Env,
      | 'STAFF_SESSION_IDLE_SECONDS'
      | 'STAFF_SESSION_ABSOLUTE_SECONDS'
      | 'TELEGRAM_LOGIN_MAX_AGE_SECONDS'
    >
  >,
): StaffAuthSettings {
  const absoluteSeconds = env.STAFF_SESSION_ABSOLUTE_SECONDS ?? STAFF_SESSION_ABSOLUTE_SECONDS;
  return {
    absoluteSeconds,
    idleSeconds: Math.min(
      env.STAFF_SESSION_IDLE_SECONDS ?? STAFF_SESSION_IDLE_SECONDS,
      absoluteSeconds,
    ),
    loginMaxAgeSeconds: env.TELEGRAM_LOGIN_MAX_AGE_SECONDS ?? TELEGRAM_LOGIN_MAX_AGE_SECONDS,
  };
}

/** Pure expiry maths so it can be tested with a fake clock. */
export function sessionExpiry(
  session: { createdAt: Date; lastSeenAt: Date; expiresAt: Date },
  idleSeconds: number,
): { expiresAt: Date; idleExpiresAt: Date } {
  const idleEnd = session.lastSeenAt.getTime() + idleSeconds * 1000;
  return {
    expiresAt: session.expiresAt,
    idleExpiresAt: new Date(Math.min(idleEnd, session.expiresAt.getTime())),
  };
}

export function isSessionLive(
  session: { lastSeenAt: Date; expiresAt: Date; revokedAt: Date | null },
  now: Date,
  idleSeconds: number,
): boolean {
  if (session.revokedAt !== null) return false;
  if (now.getTime() >= session.expiresAt.getTime()) return false;
  return now.getTime() < session.lastSeenAt.getTime() + idleSeconds * 1000;
}

/** Lock length after the Nth consecutive failure (0 = no lock yet). */
export function lockSecondsAfterFailures(failures: number): number {
  if (failures < PASSWORD_LOCK_THRESHOLD) return 0;
  const doublings = failures - PASSWORD_LOCK_THRESHOLD;
  // 2 ** 20 is far past the cap, which keeps the shift finite for a huge counter.
  return Math.min(
    PASSWORD_LOCK_BASE_SECONDS * 2 ** Math.min(doublings, 20),
    PASSWORD_LOCK_MAX_SECONDS,
  );
}
