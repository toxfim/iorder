import type { GroupRemovalErrorCode, GroupRemovalItem } from '@iorder/shared/staff-orders';

// Plain-language reasons for a removal that did not happen. The server sends short codes only,
// never Telegram's wording; a code this client does not know falls back to a generic text.

const KNOWN_REASONS: readonly GroupRemovalErrorCode[] = [
  'BOT_NOT_ADMIN',
  'NOT_A_MEMBER',
  'CHAT_NOT_FOUND',
  'CANNOT_REMOVE_MEMBER',
  'REMOVAL_REJECTED',
  'REMOVAL_NOT_ALLOWED',
  'UNBAN_FAILED',
  'CHAT_MIGRATED',
  'RATE_LIMITED_TOO_LONG',
  'RETRIES_EXHAUSTED',
  'NO_RECIPIENT',
  'INVALID_PAYLOAD',
];

/** Message key (under `staffUsers.removal.reason`) for a failed or retrying item. */
export function reasonKey(code: GroupRemovalErrorCode | null): string {
  return code !== null && KNOWN_REASONS.includes(code) ? code : 'UNKNOWN';
}

// [P] Codes where blocking again with the flag can help once the cause is fixed (the bot was made
// an administrator, Telegram was busy, the stored chat id was corrected). Not offered for
// NOT_A_MEMBER (nothing left to do), CANNOT_REMOVE_MEMBER (Telegram refuses this person),
// NO_RECIPIENT and INVALID_PAYLOAD (the stored data is wrong, asking again repeats it),
// REMOVAL_NOT_ALLOWED (the bot refused by itself) or UNBAN_FAILED (the person already left the
// group, so there is no active membership to queue again; a group admin must unban by hand).
const RETRYABLE: readonly GroupRemovalErrorCode[] = [
  'BOT_NOT_ADMIN',
  'REMOVAL_REJECTED',
  'RATE_LIMITED_TOO_LONG',
  'RETRIES_EXHAUSTED',
  'CHAT_MIGRATED',
];

export const isRetryable = (item: GroupRemovalItem): boolean =>
  item.status === 'FAILED' && item.errorCode !== null && RETRYABLE.includes(item.errorCode);

export const isPending = (item: GroupRemovalItem): boolean => item.status === 'PENDING';

/** The person may still be banned in the group: staff must unban by hand. */
export const maybeBanned = (item: GroupRemovalItem): boolean =>
  item.maybeBanned || item.errorCode === 'UNBAN_FAILED';

/**
 * The server lists every attempt (one outbox row each), newest first. The screen shows one row
 * per group: the newest attempt, so a retry hides the failure it replaced. The newest is chosen
 * by `requestedAt`, not by position, so it does not depend on the server's order.
 */
export function latestPerOrganization(
  items: readonly GroupRemovalItem[],
): readonly GroupRemovalItem[] {
  const latest = new Map<string, GroupRemovalItem>();
  for (const item of items) {
    const known = latest.get(item.organizationId);
    if (!known || Date.parse(item.requestedAt) > Date.parse(known.requestedAt)) {
      latest.set(item.organizationId, item);
    }
  }
  return [...latest.values()];
}
