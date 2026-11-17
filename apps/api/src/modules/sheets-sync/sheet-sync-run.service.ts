import {
  sheetSyncRunSchema,
  type SheetSyncRequestResponse,
  type SheetSyncRun,
} from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { AuditService } from '../audit/index.js';
import { SheetSyncQueue } from './sheet-sync-queue.js';
import { SheetSyncRunRepository, type SheetSyncRunRow } from './sheet-sync-run.repository.js';

const SHEET_SYNC_ENTITY = 'SHEET_SYNC';

/**
 * Explicit allow-list mapper. The row is parsed with the shared (strict) schema, so a column or a
 * JSON field added later never reaches the response unreviewed. A stored row that no longer fits
 * the schema throws (a 500, no details): history is never half-shown.
 */
export function toSheetSyncRunResponse(row: SheetSyncRunRow): SheetSyncRun {
  return sheetSyncRunSchema.parse({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    status: row.status,
    trigger: row.trigger,
    counts: row.counts,
    rejectedRows: row.rejectedRows,
    skippedSuppliers: row.skippedSuppliers,
    createdProducts: row.createdProducts,
    pendingRemovalRequests: row.pendingRemovalRequests,
    costMismatches: row.costMismatches,
    errorCode: row.errorCode,
  });
}

/** Staff reads of the persisted sync reports (manager, accountant, admin). */
@Injectable()
export class SheetSyncRunService {
  constructor(
    private readonly repository: SheetSyncRunRepository,
    private readonly queue: SheetSyncQueue,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * "Sync now" (manager, admin): puts one run in the worker's queue and records who asked for it
   * (hard rule 12: every action leaves a trace). The sync itself runs in the worker and writes its
   * own `sheet_sync_runs` row with trigger MANUAL; nothing is read from the sheet here.
   */
  async request(actor: Actor): Promise<SheetSyncRequestResponse> {
    if (!can(actor, 'RUN_SHEET_SYNC')) throw new ForbiddenError('Access denied');
    const outcome = await this.queue.request();
    await runInTransaction(this.prisma, (tx) =>
      this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: SHEET_SYNC_ENTITY,
        entityId: 'cost-reference',
        action: 'SHEET_SYNC_REQUESTED',
        changes: { outcome: { from: null, to: outcome } },
      }),
    );
    return { outcome };
  }

  async list(actor: Actor, limit: number): Promise<SheetSyncRun[]> {
    this.assertMayView(actor);
    return (await this.repository.list(limit)).map(toSheetSyncRunResponse);
  }

  async last(actor: Actor): Promise<SheetSyncRun> {
    this.assertMayView(actor);
    const [row] = await this.repository.list(1);
    if (!row) throw new NotFoundError('The sheet sync has not run yet');
    return toSheetSyncRunResponse(row);
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
  }
}
