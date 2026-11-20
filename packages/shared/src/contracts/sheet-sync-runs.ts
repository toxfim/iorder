import { z } from 'zod';
import { isoInstantSchema } from './common.js';

// STAFF-ONLY report history of the sheet sync (data-model §6.4). A run holds NO cost values and NO
// cell contents: a rejected row names a sheet header and a reason, a cost mismatch only a
// percentage, a failed run only an error code (never a message or a stack).

export const SHEET_SYNC_RUN_STATUSES = ['OK', 'FAILED'] as const;
export type SheetSyncRunStatus = (typeof SHEET_SYNC_RUN_STATUSES)[number];

/** MANUAL: a person started it (the CLI or the "sync now" button). SCHEDULED: the worker's cron did. */
export const SHEET_SYNC_TRIGGERS = ['MANUAL', 'SCHEDULED'] as const;
export type SheetSyncTrigger = (typeof SHEET_SYNC_TRIGGERS)[number];

/**
 * Answer of `POST /staff/sheet-sync/runs` ("sync now", manager and admin). The sync itself runs in
 * the worker: QUEUED when this request put a job in the queue, ALREADY_QUEUED when a run was
 * already waiting or going (the queue holds at most one). The result appears as a new run in the
 * history; a 409 SHEET_SYNC_QUEUE_UNAVAILABLE means the worker jobs are switched off on this api.
 */
export const SHEET_SYNC_REQUEST_OUTCOMES = ['QUEUED', 'ALREADY_QUEUED'] as const;
export type SheetSyncRequestOutcome = (typeof SHEET_SYNC_REQUEST_OUTCOMES)[number];
export const sheetSyncRequestResponseSchema = z.strictObject({
  outcome: z.enum(SHEET_SYNC_REQUEST_OUTCOMES),
});
export type SheetSyncRequestResponse = z.infer<typeof sheetSyncRequestResponseSchema>;

/** Most runs `GET /staff/sheet-sync/runs` returns; the table keeps the latest 200. */
export const SHEET_SYNC_RUNS_MAX_LIMIT = 50;
export const SHEET_SYNC_RUNS_DEFAULT_LIMIT = 20;

const count = z.number().int().nonnegative();

/** True totals of the run (the stored lists below are capped; these are not). */
export const sheetSyncRunCountsSchema = z.strictObject({
  rowsRead: count,
  created: count,
  updated: count,
  unchanged: count,
  rejected: count,
  skippedRows: count,
  staleRefs: count,
  mismatches: count,
  createdProducts: count,
  removalsRequested: count,
  removalsDismissed: count,
  reappearedAfterRemoval: count,
  /** Rows stored with "cost pending" because their cost cells were only partly filled; absent on runs before 2026-11-18. */
  incompleteCosts: count.optional(),
});
export type SheetSyncRunCounts = z.infer<typeof sheetSyncRunCountsSchema>;

/** `header` is the sheet's column header (or `deliveryRef`-style path), never a cell value. */
export const sheetSyncRejectedRowSchema = z.strictObject({
  header: z.string(),
  reason: z.string(),
  productCode: z.string().optional(),
  deliveryRef: z.string().optional(),
});
export type SheetSyncRejectedRow = z.infer<typeof sheetSyncRejectedRowSchema>;

export const sheetSyncSkippedSupplierSchema = z.strictObject({
  supplier: z.string(),
  // PRODUCT_NOT_SELECTED since 2026-11-17 (rows chosen by «Товар_ID»); the other two stay for the
  // runs stored before it.
  reason: z.enum(['PRODUCT_NOT_SELECTED', 'SUPPLIER_NOT_SELECTED', 'BEFORE_DATE_LIMIT']),
  count,
  hasInvisibleCharacters: z.boolean(),
});
export type SheetSyncSkippedSupplier = z.infer<typeof sheetSyncSkippedSupplierSchema>;

export const sheetSyncCostMismatchSchema = z.strictObject({
  productCode: z.string(),
  deliveryRef: z.string(),
  differencePercent: z.string().nullable(),
});
export type SheetSyncCostMismatch = z.infer<typeof sheetSyncCostMismatchSchema>;

export const sheetSyncRunSchema = z
  .strictObject({
    id: z.uuid(),
    startedAt: isoInstantSchema,
    finishedAt: isoInstantSchema,
    status: z.enum(SHEET_SYNC_RUN_STATUSES),
    trigger: z.enum(SHEET_SYNC_TRIGGERS),
    counts: sheetSyncRunCountsSchema,
    rejectedRows: z.array(sheetSyncRejectedRowSchema),
    skippedSuppliers: z.array(sheetSyncSkippedSupplierSchema),
    /** Codes of the products this run created from the sheet. */
    createdProducts: z.array(z.string()),
    pendingRemovalRequests: count,
    costMismatches: z.array(sheetSyncCostMismatchSchema),
    /** Set exactly when status is FAILED. */
    errorCode: z.string().nullable(),
  })
  .refine((run) => (run.status === 'FAILED') === (run.errorCode !== null), {
    message: 'errorCode is set exactly when the run failed',
    path: ['errorCode'],
  });
export type SheetSyncRun = z.infer<typeof sheetSyncRunSchema>;

export const sheetSyncRunsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SHEET_SYNC_RUNS_MAX_LIMIT)
    .default(SHEET_SYNC_RUNS_DEFAULT_LIMIT),
});
export type SheetSyncRunsQuery = z.output<typeof sheetSyncRunsQuerySchema>;

/** Newest first. */
export const sheetSyncRunsResponseSchema = z.strictObject({ items: z.array(sheetSyncRunSchema) });
export type SheetSyncRunsResponse = z.infer<typeof sheetSyncRunsResponseSchema>;
