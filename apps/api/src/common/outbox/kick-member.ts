import {
  GROUP_REMOVAL_ERROR_CODES,
  type GroupRemovalErrorCode,
  type GroupRemovalItem,
} from '@iorder/shared/staff-orders';
import { z } from 'zod';
import type { DbClient, Tx } from '../database/db-client.js';

// A request to remove one blocked person from one Telegram group. It lives in the same outbox as
// the messages (status, retries, rate-limit handling are shared) but sends no text. The row is
// written by the identity module in the transaction of the block; the notifications module only
// executes it. This file sits in `common` so identity can write the row without importing the
// notifications module, which already depends on identity (same pattern as staff-notices.ts).
//
// Row shape (the table's CHECK allows only one recipient column per kind): recipient_kind
// ORGANIZATION_CHAT with recipient_organization_id; the person is named in the payload.

export const KICK_MEMBER_TYPE = 'KICK_MEMBER';

export const isKickMemberType = (value: string): boolean => value === KICK_MEMBER_TYPE;

/**
 * The payload allow-list: ids and one reason code, nothing else (no name, phone or text of the
 * person). `requestedByUserId` and `requestedAt` say who asked and when (hard rule 12); the
 * block itself is the audit row (entity USER, action USER_BLOCKED) of the same transaction.
 */
export const kickMemberPayloadSchema = z.strictObject({
  userId: z.uuid(),
  telegramUserId: z.string().regex(/^[1-9]\d{0,15}$/),
  chatId: z.string().regex(/^-?[1-9]\d{0,15}$/),
  reason: z.literal('BLOCKED'),
  // The membership this job was written for. A person who left and joined again is a new
  // membership (new joinedAt) and must not be removed by an old job.
  joinedAt: z.iso.datetime(),
  requestedByUserId: z.uuid(),
  requestedAt: z.iso.datetime(),
});
export type KickMemberPayload = z.infer<typeof kickMemberPayloadSchema>;

export interface KickTarget {
  organizationId: string;
  organizationChatId: string;
  /** When this membership started: a person who joins again later is a new membership. */
  joinedAt: Date;
}

export interface KickRequest {
  userId: string;
  telegramUserId: string;
  requestedByUserId: string;
  targets: readonly KickTarget[];
}

export interface KickEnqueueResult {
  queued: number;
  /** Memberships that already have a waiting or finished removal. */
  alreadyRequested: number;
}

const keyPrefix = (userId: string, target: KickTarget): string =>
  `kick:${target.organizationId}:${userId}:${target.joinedAt.getTime()}:`;

/**
 * Adds one KICK_MEMBER row per target, inside the caller's transaction. Idempotent: a membership
 * that already has a PENDING or SENT request gets no second one. A FAILED request does not
 * block a new one (the manager may fix the cause, for example make the bot an administrator, and
 * block again), and the sequence number in the dedupe key keeps every request distinct.
 * The caller holds the user row lock, so two blocks of the same person serialize.
 */
export async function enqueueKickMembers(
  tx: Tx,
  request: KickRequest,
  now: Date,
): Promise<KickEnqueueResult> {
  let queued = 0;
  let alreadyRequested = 0;
  for (const target of request.targets) {
    const prefix = keyPrefix(request.userId, target);
    const earlier = await tx.notificationOutbox.findMany({
      where: { type: KICK_MEMBER_TYPE, dedupeKey: { startsWith: prefix } },
      select: { status: true },
    });
    if (earlier.some((row) => row.status !== 'FAILED')) {
      alreadyRequested += 1;
      continue;
    }
    const payload: KickMemberPayload = {
      userId: request.userId,
      telegramUserId: request.telegramUserId,
      chatId: target.organizationChatId,
      reason: 'BLOCKED',
      joinedAt: target.joinedAt.toISOString(),
      requestedByUserId: request.requestedByUserId,
      requestedAt: now.toISOString(),
    };
    await tx.notificationOutbox.create({
      data: {
        type: KICK_MEMBER_TYPE,
        recipientKind: 'ORGANIZATION_CHAT',
        recipientOrganizationId: target.organizationId,
        payload,
        dedupeKey: `${prefix}${earlier.length + 1}`,
        createdAt: now,
      },
    });
    queued += 1;
  }
  return { queued, alreadyRequested };
}

/**
 * Called when a person is unblocked: their waiting removal jobs are cancelled (FAILED with
 * REMOVAL_NOT_ALLOWED) in the same transaction, so a later block WITHOUT the removal flag cannot
 * revive an old request. Only the delivery columns change. Returns how many were cancelled.
 */
export async function cancelPendingKicks(tx: Tx, userId: string): Promise<number> {
  const result = await tx.notificationOutbox.updateMany({
    where: {
      type: KICK_MEMBER_TYPE,
      status: 'PENDING',
      payload: { path: ['userId'], equals: userId },
    },
    data: { status: 'FAILED', lastErrorCode: 'REMOVAL_NOT_ALLOWED', nextAttemptAt: null },
  });
  return result.count;
}

const isRemovalErrorCode = (value: string | null): value is GroupRemovalErrorCode =>
  value !== null && (GROUP_REMOVAL_ERROR_CODES as readonly string[]).includes(value);

/**
 * The state of every removal ever requested for one person, newest first, as the staff UI shows
 * it: PENDING (waiting or being retried), DONE (the bot removed the person) or FAILED with a
 * short code. Reads the outbox rows themselves, so it can never disagree with what the
 * dispatcher did.
 */
export async function readRemovalStatus(db: DbClient, userId: string): Promise<GroupRemovalItem[]> {
  const rows = await db.notificationOutbox.findMany({
    where: { type: KICK_MEMBER_TYPE, payload: { path: ['userId'], equals: userId } },
    select: {
      status: true,
      lastErrorCode: true,
      createdAt: true,
      sentAt: true,
      recipientOrganizationId: true,
      recipientOrganization: { select: { name: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.flatMap((row) => {
    if (row.recipientOrganizationId === null) return [];
    const failed = row.status === 'FAILED';
    const code = isRemovalErrorCode(row.lastErrorCode) ? row.lastErrorCode : null;
    return [
      {
        organizationId: row.recipientOrganizationId,
        organizationName: row.recipientOrganization?.name ?? '',
        status: failed
          ? ('FAILED' as const)
          : row.status === 'SENT'
            ? ('DONE' as const)
            : ('PENDING' as const),
        // A failed row always carries a code the UI can show; any other failure reads as rejected.
        errorCode: failed ? (code ?? 'REMOVAL_REJECTED') : row.status === 'SENT' ? null : code,
        requestedAt: row.createdAt.toISOString(),
        maybeBanned: failed && code === 'UNBAN_FAILED',
        completedAt: row.sentAt?.toISOString() ?? null,
      },
    ];
  });
}
