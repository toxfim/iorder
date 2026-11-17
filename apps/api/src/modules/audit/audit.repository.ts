import { Injectable } from '@nestjs/common';
import type { Tx } from '../../common/database/db-client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditChanges } from './audit.types.js';

export interface AuditRow {
  /** null only for system actions (see SystemAuditEntry). */
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  changes: AuditChanges;
}

@Injectable()
export class AuditRepository {
  async insert(tx: Tx, row: AuditRow, createdAt: Date): Promise<void> {
    await tx.auditLog.create({ data: toData(row, createdAt) });
  }

  async insertMany(tx: Tx, rows: readonly AuditRow[], createdAt: Date): Promise<void> {
    if (rows.length === 0) return;
    await tx.auditLog.createMany({ data: rows.map((row) => toData(row, createdAt)) });
  }
}

function toData(row: AuditRow, createdAt: Date) {
  return {
    actorUserId: row.actorUserId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    // AuditValue admits only JSON-safe values; Prisma's InputJsonValue cannot see that through interfaces.
    diff: row.changes as unknown as Prisma.InputJsonObject,
    createdAt,
  };
}
