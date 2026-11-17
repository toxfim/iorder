/**
 * How hard the dispatcher tries. All numbers are one proposal [P]: change them here only.
 *
 * `attempts` counts claims. A row is claimed, sent and then either finished or scheduled again.
 * After a failed claim number k (1-based) the row waits RETRY_DELAYS_SECONDS[k - 1]; a failure of
 * the last allowed attempt marks the row FAILED.
 */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** Wait after failed attempt 1, 2, 3, 4, 5 (exponential, capped at 2 hours). */
export const RETRY_DELAYS_SECONDS: readonly number[] = Object.freeze([30, 120, 600, 1800, 7200]);

/**
 * A claimed row is invisible to other dispatchers for this long. It must outlast the slowest
 * normal batch (the Telegram client times out after 30 s per call, 20 rows by default). If the
 * process dies mid-batch the row becomes due again after this lease.
 */
export const CLAIM_LEASE_SECONDS = 600;

/** A 429 answer says when to come back; never wait longer than this, never less than 1 s. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 3600;
export const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;

/**
 * A 429 gives the attempt back, so a chat that stays rate limited would defer a row forever.
 * For group removals (KICK_MEMBER) the request is dropped after this age [P]: a removal done days
 * later is not what the manager asked for. Message rows keep their old behaviour (deferred until
 * delivered), because a late status update is still useful.
 */
export const KICK_MAX_RATE_LIMITED_AGE_SECONDS = 24 * 3600;

/**
 * A batch stops taking new rows after this long and gives the rest back, so a slow Telegram can
 * never keep a row longer than its lease (another dispatcher would send it a second time).
 * Well under CLAIM_LEASE_SECONDS: one more send (30 s timeout) may still follow the check.
 */
export const BATCH_TIME_BUDGET_SECONDS = 300;

export const DEFAULT_BATCH_SIZE = 20;
export const MAX_BATCH_SIZE = 100;

/** Seconds to wait before the next try, or null when `attemptsMade` was the last allowed attempt. */
export function retryDelaySeconds(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_DELIVERY_ATTEMPTS) return null;
  const index = Math.max(attemptsMade, 1) - 1;
  return RETRY_DELAYS_SECONDS[Math.min(index, RETRY_DELAYS_SECONDS.length - 1)] ?? null;
}

/** Honours Telegram's `retry_after`, within sane bounds. */
export function rateLimitWaitSeconds(retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) {
    return DEFAULT_RATE_LIMIT_WAIT_SECONDS;
  }
  return Math.min(Math.max(Math.ceil(retryAfterSeconds), 1), MAX_RATE_LIMIT_WAIT_SECONDS);
}

/** The short codes stored in `notification_outbox.last_error_code`. Never a message or a body. */
export const DELIVERY_ERROR_CODES = [
  'SEND_FAILED',
  'RETRIES_EXHAUSTED',
  'RATE_LIMITED',
  'RECIPIENT_UNREACHABLE',
  'MESSAGE_REJECTED',
  'NO_RECIPIENT',
  'ORGANIZATION_INACTIVE',
  'INVALID_PAYLOAD',
  // KICK_MEMBER (removal of a blocked person from a group), all final:
  'BOT_NOT_ADMIN',
  'NOT_A_MEMBER',
  'CHAT_NOT_FOUND',
  'CANNOT_REMOVE_MEMBER',
  'REMOVAL_NOT_ALLOWED',
  'REMOVAL_REJECTED',
  'UNBAN_FAILED',
  'CHAT_MIGRATED',
  'RATE_LIMITED_TOO_LONG',
  // PRICE_LIST_POST: nothing is published at send time (final).
  'NO_PRICE_LIST',
  // PRICE_LIST_POST: the organization's tier has no priced product at send time (final): an empty
  // file is never sent [P, review 2026-11-12].
  'NO_PRICED_ITEMS',
] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];
