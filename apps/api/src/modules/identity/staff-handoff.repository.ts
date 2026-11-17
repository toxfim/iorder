import { Injectable } from '@nestjs/common';
import type { Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';

/** A handoff code row as the service needs it. The hash never leaves this file. */
export interface HandoffCodeRecord {
  id: string;
  userId: string;
  /** The staff session that asked for the code. */
  sessionId: string;
  expiresAt: Date;
}

/** Data access for the one-time codes of the customer site handoff. */
@Injectable()
export class StaffHandoffRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** In the CALLER'S transaction, so the code and its audit row commit together. Returns the id. */
  async insertCode(
    tx: Tx,
    row: { userId: string; sessionId: string; codeHash: string; createdAt: Date; expiresAt: Date },
  ): Promise<string> {
    const created = await tx.staffHandoffCode.create({ data: row, select: { id: true } });
    return created.id;
  }

  /**
   * Removes the codes of one person that were used, or expired, more than `before` ago. Codes are
   * not history (the audit log is), and the trigger allows exactly this deletion and no other.
   */
  async deleteStale(tx: Tx, userId: string, before: Date): Promise<number> {
    const result = await tx.staffHandoffCode.deleteMany({
      where: {
        userId,
        OR: [{ usedAt: { lt: before } }, { usedAt: null, expiresAt: { lt: before } }],
      },
    });
    return result.count;
  }

  /**
   * Uses the code up and returns its row, or null when no UNUSED code has this hash. One statement,
   * so of two requests with the same code exactly one gets the row (the other finds `used_at` set).
   * An expired code is used up too: the caller checks the time and refuses it.
   */
  async claimByHash(codeHash: string, usedAt: Date): Promise<HandoffCodeRecord | null> {
    const rows = await this.prisma.$queryRaw<
      { id: string; user_id: string; session_id: string; expires_at: Date }[]
    >`UPDATE staff_handoff_codes SET used_at = ${usedAt}
      WHERE code_hash = ${codeHash} AND used_at IS NULL
      RETURNING id, user_id, session_id, expires_at`;
    const row = rows[0];
    return row
      ? { id: row.id, userId: row.user_id, sessionId: row.session_id, expiresAt: row.expires_at }
      : null;
  }
}
