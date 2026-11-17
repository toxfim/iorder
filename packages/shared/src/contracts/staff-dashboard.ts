import { z } from 'zod';
import { ORDER_STATUSES } from '../order-status.js';
import { decimalStringSchema, isoInstantSchema } from './common.js';
import { amountSchema, currencySchema } from './order-parts.js';
import { route } from './routes.js';
import { SHEET_SYNC_RUN_STATUSES } from './sheet-sync-runs.js';

// STAFF-ONLY dashboard summary (GET /staff/dashboard/summary). Part of the `staff-orders` entry so
// the customer bundle never sees it. Every optional section is left out by the api (the key is
// absent, not null) when the caller's role may not see it: the warehouse and the driver therefore
// receive no money key at all. A section that is present but has no data yet is null (e.g. the
// sheet never synced).

const count = z.number().int().nonnegative();

/** Work waiting for somebody, in the order a role handles it. */
export const DASHBOARD_QUEUE_KEYS = [
  'AWAITING_MANAGER',
  'AWAITING_ACCOUNTING',
  'SKIPPED_ACCOUNTING_TO_REVIEW',
  /** Warehouse: approved by the manager, accounting still pending. Prepare and scan. */
  'TO_PREPARE',
  'TO_RELEASE',
  'TO_DELIVER',
  /** Warehouse: rejected or cancelled after approval, the goods have to come back. */
  'TO_RETURN',
] as const;
export type DashboardQueueKey = (typeof DASHBOARD_QUEUE_KEYS)[number];

export const dashboardQueueSchema = z.strictObject({
  key: z.enum(DASHBOARD_QUEUE_KEYS),
  count,
  /**
   * When the longest-waiting order ENTERED the queue's status (the latest event that moved it
   * there), not when it was submitted; null when the queue is empty. For
   * SKIPPED_ACCOUNTING_TO_REVIEW this is when the manager skipped accounting, and the queue is
   * PROVISIONAL [P]: nothing marks an order as reviewed yet (manager question Q14), so it does
   * not drain.
   */
  oldestWaitingSince: isoInstantSchema.nullable(),
  /** Whole minutes since `oldestWaitingSince` at `generatedAt`; null when the queue is empty. */
  oldestAgeMinutes: count.nullable(),
});
export type DashboardQueue = z.infer<typeof dashboardQueueSchema>;

/** Orders submitted today (Asia/Tashkent), without REJECTED and CANCELLED ones. */
export const dashboardTodaySchema = z.strictObject({
  count,
  totalAmount: amountSchema,
  currency: currencySchema,
});

export const dashboardUsdRateSchema = z.strictObject({
  rate: decimalStringSchema({ maxIntegerDigits: 14, maxFractionDigits: 4 }),
  source: z.enum(['CHANNEL', 'MANUAL', 'CBU']),
  /** The day a Central Bank rate is valid for, YYYY-MM-DD; null for a manual rate. */
  rateDate: z.iso.date().nullable(),
});

/** Only the outcome and the times of the last sheet sync: never rows, values or error text. */
export const dashboardSheetSyncSchema = z.strictObject({
  status: z.enum(SHEET_SYNC_RUN_STATUSES),
  startedAt: isoInstantSchema,
  finishedAt: isoInstantSchema,
});

export const staffDashboardSummarySchema = z.strictObject({
  generatedAt: isoInstantSchema,
  /** The business day (Asia/Tashkent) `today` refers to, YYYY-MM-DD. */
  businessDate: z.iso.date(),
  /** Count per status among the orders the caller may see; a status they cannot see reads 0. */
  ordersByStatus: z.partialRecord(z.enum(ORDER_STATUSES), count),
  /** Queues relevant to the caller's roles. */
  queues: z.array(dashboardQueueSchema),
  /** Manager, accountant, admin only. */
  today: dashboardTodaySchema.optional(),
  /** Delivered (DELIVERED or RECEIVED) orders still UNPAID. Manager, accountant, admin only. */
  unpaidDeliveredCount: count.optional(),
  /** Inactive organizations, which is how a new Telegram group waits. Manager, admin only. */
  organizationsAwaitingActivationCount: count.optional(),
  /** Active products without a price in the published list. Manager, admin only. */
  unpricedProductsCount: count.optional(),
  /** Manager, admin only. */
  lastSheetSync: dashboardSheetSyncSchema.nullable().optional(),
  /** Manager, accountant, admin only; null before any rate exists. */
  usdRate: dashboardUsdRateSchema.nullable().optional(),
});
export type StaffDashboardSummary = z.infer<typeof staffDashboardSummarySchema>;

export const STAFF_DASHBOARD_ROUTES = Object.freeze({
  summary: route('GET', '/staff/dashboard/summary'),
});
