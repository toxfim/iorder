import type {
  SheetSyncCostMismatch,
  SheetSyncRejectedRow,
  SheetSyncRunCounts,
  SheetSyncRunStatus,
  SheetSyncSkippedSupplier,
  SheetSyncTrigger,
} from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';

/** The latest runs kept in the table; older ones are pruned in the same transaction as an insert. */
export const SHEET_SYNC_RUNS_KEPT = 200;

/** What a run stores. No cost values and no cell contents (see the shared sheetSyncRunSchema). */
export interface SheetSyncRunRecord {
  startedAt: Date;
  finishedAt: Date;
  status: SheetSyncRunStatus;
  trigger: SheetSyncTrigger;
  counts: SheetSyncRunCounts;
  rejectedRows: SheetSyncRejectedRow[];
  skippedSuppliers: SheetSyncSkippedSupplier[];
  createdProducts: string[];
  pendingRemovalRequests: number;
  costMismatches: SheetSyncCostMismatch[];
  /** Set exactly when status is FAILED. */
  errorCode: string | null;
}

/** A stored run. The JSON columns are unvalidated here; the response mapper parses them. */
export interface SheetSyncRunRow {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  status: SheetSyncRunStatus;
  trigger: SheetSyncTrigger;
  counts: unknown;
  rejectedRows: unknown;
  skippedSuppliers: unknown;
  createdProducts: unknown;
  pendingRemovalRequests: number;
  costMismatches: unknown;
  errorCode: string | null;
}

@Injectable()
export class SheetSyncRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts one run and prunes the table to the latest `keep` runs, in ONE transaction. Newest =
   * started last; the UUIDv7 id breaks ties in time order.
   */
  async insertAndPrune(run: SheetSyncRunRecord, keep = SHEET_SYNC_RUNS_KEPT): Promise<void> {
    await runInTransaction(this.prisma, async (tx) => {
      await tx.sheetSyncRun.create({
        data: {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          status: run.status,
          trigger: run.trigger,
          counts: run.counts satisfies Prisma.InputJsonValue,
          rejectedRows: run.rejectedRows satisfies Prisma.InputJsonValue,
          skippedSuppliers: run.skippedSuppliers satisfies Prisma.InputJsonValue,
          createdProducts: run.createdProducts satisfies Prisma.InputJsonValue,
          pendingRemovalRequests: run.pendingRemovalRequests,
          costMismatches: run.costMismatches satisfies Prisma.InputJsonValue,
          errorCode: run.errorCode,
        },
      });
      await tx.$executeRaw`
        DELETE FROM sheet_sync_runs
        WHERE id NOT IN (
          SELECT id FROM sheet_sync_runs ORDER BY started_at DESC, id DESC LIMIT ${keep}
        )`;
    });
  }

  /** Newest first. */
  list(limit: number): Promise<SheetSyncRunRow[]> {
    return this.prisma.sheetSyncRun.findMany({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }
}
