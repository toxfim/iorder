import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service.js';
import type { NotificationRecipientKind } from '../orders/index.js';
import { MAX_DELIVERY_ATTEMPTS, type DeliveryErrorCode } from './delivery-policy.js';

/** The columns the sender updates; the same list as the column-level grant in app-role-grants.sql. */
const DELIVERY_COLUMNS = [
  'status',
  'attempts',
  'sent_at',
  'next_attempt_at',
  'last_error_code',
  'delivered_chat_ids',
] as const;

/** A claimed outbox row: only what the dispatcher needs. */
export interface ClaimedNotification {
  id: string;
  type: string;
  recipientKind: NotificationRecipientKind;
  recipientUserId: string | null;
  recipientRole: string | null;
  recipientOrganizationId: string | null;
  orderId: string | null;
  payload: unknown;
  /** Claims so far, this one included. */
  attempts: number;
  deliveredChatIds: string[];
  createdAt: Date;
}

interface ClaimedRow {
  id: string;
  type: string;
  recipient_kind: NotificationRecipientKind;
  recipient_user_id: string | null;
  recipient_role: string | null;
  recipient_organization_id: string | null;
  order_id: string | null;
  payload: unknown;
  attempts: number;
  delivered_chat_ids: string[];
  created_at: Date;
}

/**
 * Reads and updates `notification_outbox` for the dispatcher. The application role may update
 * only the delivery bookkeeping columns (status, attempts, sent_at, next_attempt_at,
 * last_error_code, delivered_chat_ids); this repository touches nothing else, and every write
 * checks the row is still PENDING so a finished row can never be reopened.
 *
 * The orders module WRITES the rows (in its transition transaction); this module only delivers.
 */
@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims up to `limit` due PENDING rows in ONE statement: the rows are locked with
   * `FOR UPDATE SKIP LOCKED` (another dispatcher skips them instead of waiting), their attempt
   * counter goes up and `next_attempt_at` moves to the lease end. Because the lease is written
   * in the same statement, once this returns no other dispatcher will pick the rows up before
   * the lease ends, even though the claim transaction is already committed.
   */
  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<ClaimedNotification[]> {
    await this.failExhausted(now);
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE notification_outbox AS o
         SET attempts = o.attempts + 1, next_attempt_at = ${leaseUntil}::timestamptz
       WHERE o.id IN (
         SELECT id FROM notification_outbox
          WHERE status = 'PENDING'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}::timestamptz)
          ORDER BY created_at, id
          LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
      RETURNING o.id::text AS id, o.type, o.recipient_kind::text AS recipient_kind,
                o.recipient_user_id::text AS recipient_user_id, o.recipient_role,
                o.recipient_organization_id::text AS recipient_organization_id,
                o.order_id::text AS order_id, o.payload, o.attempts, o.delivered_chat_ids,
                o.created_at`;
    // RETURNING has no defined order; deliver oldest first.
    return rows
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        type: row.type,
        recipientKind: row.recipient_kind,
        recipientUserId: row.recipient_user_id,
        recipientRole: row.recipient_role,
        recipientOrganizationId: row.recipient_organization_id,
        orderId: row.order_id,
        payload: row.payload,
        attempts: row.attempts,
        deliveredChatIds: row.delivered_chat_ids,
        createdAt: row.created_at,
      }));
  }

  /**
   * A due row that already used its last allowed attempt is finished as FAILED instead of being
   * sent again. Normally the dispatcher decides this itself; this is the safety net for a row
   * whose bookkeeping write failed after the last attempt (lease expired, nothing recorded):
   * without it such a row would be sent again and again, and every time a different recipient
   * could get a duplicate.
   */
  private async failExhausted(now: Date): Promise<void> {
    const count = await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET status = 'FAILED', next_attempt_at = NULL, last_error_code = 'RETRIES_EXHAUSTED'
       WHERE id IN (
         SELECT id FROM notification_outbox
          WHERE status = 'PENDING' AND attempts >= ${MAX_DELIVERY_ATTEMPTS}
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}::timestamptz)
            FOR UPDATE SKIP LOCKED)`;
    if (count > 0) this.logger.warn(`${count} notification(s) failed: RETRIES_EXHAUSTED`);
  }

  /** Gives unprocessed claimed rows back (attempt returned) so they are due again at once. */
  async release(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = ${now}::timestamptz
       WHERE id = ANY(${[...ids]}::uuid[]) AND status = 'PENDING'`;
  }

  /**
   * The delivery columns the application role cannot UPDATE (empty = all granted). Lets a
   * deployment fail with a clear message instead of a half-working sender.
   */
  async findMissingUpdateGrants(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ column_name: string; granted: boolean }[]>`
      SELECT c AS column_name, has_column_privilege(current_user, 'notification_outbox', c, 'UPDATE') AS granted
        FROM unnest(${[...DELIVERY_COLUMNS]}::text[]) AS c`;
    return rows.filter((row) => !row.granted).map((row) => row.column_name);
  }

  /** Remembers that one chat got the message, so a retry skips it. */
  async recordDelivered(id: string, chatId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET delivered_chat_ids = array_append(delivered_chat_ids, ${chatId})
       WHERE id = ${id}::uuid AND status = 'PENDING' AND NOT (${chatId} = ANY(delivered_chat_ids))`;
  }

  async markSent(id: string, now: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET status = 'SENT', sent_at = ${now}::timestamptz, next_attempt_at = NULL,
             last_error_code = NULL
       WHERE id = ${id}::uuid AND status = 'PENDING'`;
  }

  async markFailed(id: string, code: DeliveryErrorCode): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET status = 'FAILED', next_attempt_at = NULL, last_error_code = ${code}
       WHERE id = ${id}::uuid AND status = 'PENDING'`;
  }

  /** Try again later; the attempt already counted. */
  async scheduleRetry(id: string, at: Date, code: DeliveryErrorCode): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET next_attempt_at = ${at}::timestamptz, last_error_code = ${code}
       WHERE id = ${id}::uuid AND status = 'PENDING'`;
  }

  /** Rate limited: not the message's fault, so the attempt is given back. */
  async deferWithoutAttempt(id: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notification_outbox
         SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = ${at}::timestamptz,
             last_error_code = 'RATE_LIMITED'
       WHERE id = ${id}::uuid AND status = 'PENDING'`;
  }
}
