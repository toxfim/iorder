import type { StaffRole } from '@iorder/shared';
import { z } from 'zod';
import type { Tx } from '../database/db-client.js';

// Notices to staff that are not about one order (a customer group appeared, a person could not
// be added). They live in the same outbox as order messages but have no order. The rows are
// written by the module that observes the fact (inside its own transaction); the notifications
// module only delivers them. This file sits in `common` so the organizations module can write a
// notice without importing the notifications module, which already depends on it.

export const STAFF_NOTICE_TYPES = [
  'ORGANIZATION_PENDING',
  'MEMBERSHIP_CONFLICT',
  /** A staff-created organization's invite was used [P]: told to the staff member who created it. */
  'ORGANIZATION_LINKED',
] as const;
export type StaffNoticeType = (typeof STAFF_NOTICE_TYPES)[number];

/** Who is told: every ACTIVE holder of these roles. The owner decision: managers AND admins. */
export const STAFF_NOTICE_ROLES: readonly StaffRole[] = Object.freeze(['MANAGER', 'ADMIN']);

const text = (max: number) => z.string().trim().min(1).max(max);
const telegramUserId = z.string().regex(/^[1-9]\d{0,15}$/);

/**
 * Allow-lists of the payloads. Text comes from Telegram (untrusted): it is bounded here and the
 * templates print it as plain text. No phone, no cost data, nothing about orders.
 */
export const organizationPendingPayloadSchema = z.strictObject({
  organizationName: text(200),
  chatId: z.string().regex(/^-?[1-9]\d{0,15}$/),
  addedByName: text(200).optional(),
  addedByTelegramUserId: telegramUserId.optional(),
});
export type OrganizationPendingPayload = z.infer<typeof organizationPendingPayloadSchema>;

export const membershipConflictPayloadSchema = z.strictObject({
  personName: text(200),
  telegramUserId,
  organizationName: text(200),
});
export type MembershipConflictPayload = z.infer<typeof membershipConflictPayloadSchema>;

export const organizationLinkedPayloadSchema = z.strictObject({ organizationName: text(200) });
export type OrganizationLinkedPayload = z.infer<typeof organizationLinkedPayloadSchema>;

export const isStaffNoticeType = (value: string): value is StaffNoticeType =>
  (STAFF_NOTICE_TYPES as readonly string[]).includes(value);

export interface StaffNotice {
  type: StaffNoticeType;
  payload: Record<string, string>;
  /** Identifies the fact; the role is appended. A repeated notice with the same key is dropped. */
  dedupeKey: string;
}

/**
 * Adds one outbox row per notified role, inside the caller's transaction. Returns how many rows
 * were really new (0 = this exact notice was already written, so nothing repeats).
 */
export async function enqueueStaffNotice(tx: Tx, notice: StaffNotice, now: Date): Promise<number> {
  const result = await tx.notificationOutbox.createMany({
    data: STAFF_NOTICE_ROLES.map((role) => ({
      type: notice.type,
      recipientKind: 'ROLE' as const,
      recipientRole: role,
      payload: notice.payload,
      dedupeKey: `${notice.dedupeKey}:${role}`,
      createdAt: now,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * One notice row for ONE staff member (recipient USER), inside the caller's transaction. Returns 0
 * when this exact notice was already written.
 */
export async function enqueueUserNotice(
  tx: Tx,
  notice: {
    type: StaffNoticeType;
    userId: string;
    payload: Record<string, string>;
    dedupeKey: string;
  },
  now: Date,
): Promise<number> {
  const result = await tx.notificationOutbox.createMany({
    data: [
      {
        type: notice.type,
        recipientKind: 'USER' as const,
        recipientUserId: notice.userId,
        payload: notice.payload,
        dedupeKey: `${notice.dedupeKey}:USER:${notice.userId}`,
        createdAt: now,
      },
    ],
    skipDuplicates: true,
  });
  return result.count;
}
