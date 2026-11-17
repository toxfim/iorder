import { productCodeKey, productCodeSchema } from '@iorder/shared';
import type {
  SheetSyncRejectedRow,
  SheetSyncRunCounts,
  SheetSyncTrigger,
} from '@iorder/shared/staff-cost';
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock/clock.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CatalogService } from '../catalog/index.js';
import {
  MAX_DELIVERIES_PER_UPSERT,
  PriceReferenceService,
  SupplyRemovalService,
  type CostDeliveryInput,
} from '../pricing/index.js';
import { checkCostUzs } from './cost-consistency.js';
import { createCostSourceRowSchema } from './cost-source-row.js';
import { DeliveryCostSource } from './delivery-cost-source.js';
import { collectSheetRates, withDerivedUsdCost } from './derived-usd-cost.js';
import { readRequiredColumns, SHEET_COLUMNS, type SheetRecord } from './sheet-columns.js';
import { SheetSyncRunRepository, type SheetSyncRunRecord } from './sheet-sync-run.repository.js';
import { SheetRowSelection } from './product-code-selection.js';
import { capStoredSupplier, normalizeSheetText } from './sheet-values.js';
import { describeErrorSafely, safeErrorCode, toSyncError } from './sync-error.js';

export interface RejectedRow {
  /** Position of the data row in the source (0-based, header excluded). */
  index: number;
  /** Paths (sheet header names) and messages only: cell values are never reported or logged. */
  issues: { path: string; message: string }[];
  /** Only when the cell is a valid product code (never raw cell content). */
  productCode?: string;
  /** Only when the cell is a plausible delivery id (at most 100 characters). */
  deliveryRef?: string;
}

export interface SyncReport {
  /** Data rows in the source, before any filter. */
  rowsRead: number;
  /**
   * Rows that were NOT read, as distinct NORMALIZED supplier values with counts (staff-only report
   * data: it is not logged and never reaches a customer; it contains no cost values). A typo such
   * as "alpha trade import." or a look-alike letter shows up as its own entry, so a silently skipped
   * supplier is visible.
   */
  skippedBySupplierFilter: SkippedSupplier[];
  created: number;
  updated: number;
  unchanged: number;
  /**
   * Codes (as stored) of the products this sync CREATED because the sheet names a product code
   * that had no product yet [C, 2026-10-21]. Codes only: no names, no cost values. Such a product
   * has no price, so no customer can see it.
   */
  createdProducts: string[];
  /** Rows that failed validation, or repeated an earlier productCode + delivery in the same read. */
  rejected: RejectedRow[];
  /**
   * Deliveries stored for the product codes that were read but absent from this read. OPEN PRODUCT
   * DECISION: whether such rows should be deleted, flagged or kept is not decided, so they are
   * only REPORTED (refs, never cost values) and nothing in the table is touched.
   */
  staleRefs: { productCode: string; deliveryRef: string }[];
  /**
   * Rows whose UZS cost is not USD x rate within COST_UZS_RELATIVE_TOLERANCE. OPEN PRODUCT
   * DECISION (who owns the number): reported only, the row is stored as the sheet gave it.
   */
  mismatches: { productCode: string; deliveryRef: string; differencePercent: string | null }[];
  /** Rows stored with a USD cost computed from UZS and the nearest sheet rate (see derived-usd-cost). */
  derivedUsdCosts: { productCode: string; deliveryRef: string }[];
  /** The stock aggregate rewrites triggered by this sync (per product, not per delivery line). */
  stock: { created: number; updated: number; unchanged: number };
  /** Products whose category changed (it follows the product's latest delivery line). */
  categoriesChanged: number;
  /**
   * Manager-confirmation requests for stored lines that vanished from the sheet: opened (PENDING)
   * and automatically dismissed because the line came back. The sync deletes and changes NOTHING
   * itself; while a request is PENDING the line keeps counting for stock and cost history.
   */
  removals: { requested: number; dismissed: number };
  /** Lines in this read that a manager already CONFIRMED as removed: not revived, only listed. */
  reappearedAfterRemoval: { productCode: string; deliveryRef: string }[];
}

export interface SkippedSupplier {
  /** Whitespace-collapsed; case differences are merged under the first spelling seen. */
  supplier: string;
  /** Why the rows were skipped: their «Товар_ID» is not in the selection (product-code-selection.ts). */
  reason: 'PRODUCT_NOT_SELECTED';
  count: number;
  /** True when the value contains zero-width/format characters that are invisible when printed. */
  hasInvisibleCharacters: boolean;
}

type ValidRow = ReturnType<ReturnType<typeof createCostSourceRowSchema>['parse']>;

const refKey = (productCode: string, deliveryRef: string): string =>
  JSON.stringify([productCode, deliveryRef]);

/** A persisted run keeps at most this many of each list (the counts hold the true totals). */
const STORED_LIST_CAP = 1000;
const STORED_CREATED_PRODUCTS_CAP = 5000;
const MAX_STORED_REASON_LENGTH = 200;
const MAX_STORED_DELIVERY_REF_LENGTH = 100;

function newReport(): SyncReport {
  return {
    rowsRead: 0,
    skippedBySupplierFilter: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    createdProducts: [],
    rejected: [],
    staleRefs: [],
    mismatches: [],
    derivedUsdCosts: [],
    stock: { created: 0, updated: 0, unchanged: 0 },
    categoriesChanged: 0,
    removals: { requested: 0, dismissed: 0 },
    reappearedAfterRemoval: [],
  };
}

/**
 * Reads the «Поставка» table from a read-only source and stores the selected delivery lines in
 * `price_reference`, plus the stock aggregate in `stock_cache`. A product code the sheet names that
 * has no product yet gets a product (no price, no unit) in the same transaction as its first
 * delivery lines. A system action: no actor, audit rows carry a null actor and SHEET_SYNC_* names.
 * Every run (also a failed one) leaves one row in `sheet_sync_runs`. Scheduled runs (trigger
 * SCHEDULED) come from the `sheet-sync` job of the worker (modules/jobs; off by default); the
 * first real run is made by hand with `sheets:sync-once`.
 *
 * Writes are committed in chunks of MAX_DELIVERIES_PER_UPSERT rows, each in its own transaction
 * (a first sync of thousands of rows must not hit the transaction timeout). Every row is
 * idempotent, so after a failed chunk the earlier chunks stay and a re-run finishes the job.
 * The advisory lock is per chunk, not across the whole sync: a lock that outlived a transaction
 * would pin a pooled connection for minutes, and interleaving two syncs is safe because each
 * chunk re-reads the current rows under the lock. The stock aggregate and the category of a
 * chunk's products are recomputed INSIDE that chunk's transaction, from all stored lines.
 */
@Injectable()
export class SheetsSyncService {
  private readonly logger = new Logger(SheetsSyncService.name);

  constructor(
    private readonly source: DeliveryCostSource,
    private readonly catalog: CatalogService,
    private readonly priceReference: PriceReferenceService,
    private readonly clock: Clock,
    private readonly removals: SupplyRemovalService,
    private readonly runs: SheetSyncRunRepository,
    private readonly selection: SheetRowSelection,
  ) {}

  async syncCostReference(trigger: SheetSyncTrigger = 'MANUAL'): Promise<SyncReport> {
    const startedAt = this.clock.now();
    const report = newReport();
    try {
      await this.execute(report);
    } catch (error) {
      await this.recordFailedRun(report, startedAt, trigger, error);
      throw error;
    }
    // A success is recorded in its own transaction too; if recording fails the data is already
    // committed, so the error surfaces (the report would otherwise be lost silently).
    await this.runs.insertAndPrune(await this.toRunRecord(report, startedAt, trigger, null));
    return report;
  }

  private async execute(report: SyncReport): Promise<void> {
    // Throws SheetFormatError (naming the missing headers) when a required column is absent:
    // the whole read fails rather than syncing with a column silently missing.
    const records = readRequiredColumns(await this.source.readDeliveryTable());
    report.rowsRead = records.length;

    const { valid, mentioned } = this.selectAndValidate(records, report);
    const { known, codeById, skippedRemoved } = await this.writeInChunks(valid, report);
    for (const r of skippedRemoved) {
      const productCode = codeById.get(r.productId);
      if (productCode !== undefined) {
        report.reappearedAfterRemoval.push({ productCode, deliveryRef: r.deliveryRef });
      }
    }
    // After the chunks: it reads every product's category, also those this run did not touch.
    await this.catalog.adoptMarkedSheetCategories();
    const missing = await this.findStale(known, codeById, mentioned, report);
    // Stored lines that vanished get a PENDING request; PENDING requests of lines that are back in
    // the sheet are dismissed. Nothing else changes.
    report.removals = await this.removals.syncDetected({
      missing,
      present: known.map((k) => ({ productId: k.productId, deliveryRef: k.deliveryRef })),
    });
  }

  /**
   * Product-code selection first (rows of other products are skipped without being validated, so
   * their broken cells cause no noise; skipped rows are still counted per supplier), then zod validation row by row: one bad row is reported, not
   * fatal. A row with a UZS cost but no USD cost and no rate gets them derived before validation.
   */
  private selectAndValidate(
    records: readonly SheetRecord[],
    report: SyncReport,
  ): { valid: ValidRow[]; mentioned: Set<string> } {
    const now = this.clock.now();
    const rowSchema = createCostSourceRowSchema(now);
    const sheetRates = collectSheetRates(records, now);
    const skipped = new Map<string, SkippedSupplier>();
    const skip = (rawSupplier: unknown): void => {
      const supplier = normalizeSheetText(rawSupplier) ?? '(empty)';
      const key = supplier.toLowerCase();
      const entry = skipped.get(key) ?? {
        supplier,
        reason: 'PRODUCT_NOT_SELECTED',
        count: 0,
        hasInvisibleCharacters: /[\u200b-\u200f\u2060\ufeff]/.test(supplier),
      };
      entry.count += 1;
      skipped.set(key, entry);
    };

    // DECIDED BY THE PRODUCT OWNER LATER (open): a second line with the same (product code,
    // delivery ref) is rejected as a duplicate, first one wins. Whether that is right (two lines of
    // one request for the same product?) is not decided.
    const seen = new Set<string>();
    // Keys of rows that were REJECTED but still name a product code + delivery: they must not
    // look stale. Built with the same normalization as valid rows.
    const mentioned = new Set<string>();
    const valid: ValidRow[] = [];
    records.forEach((record, index) => {
      if (!this.selection.isSelected(record[SHEET_COLUMNS.productCode])) {
        skip(record[SHEET_COLUMNS.supplier]);
        return;
      }
      const effective = withDerivedUsdCost(record, sheetRates);
      const parsed = rowSchema.safeParse(effective);
      if (!parsed.success) {
        const code = record[SHEET_COLUMNS.productCode];
        const ref = normalizeSheetText(record[SHEET_COLUMNS.deliveryRef]);
        report.rejected.push({
          index,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
          ...rejectedIdentity(code, ref),
        });
        if (typeof code === 'string' && ref !== null) {
          mentioned.add(refKey(productCodeKey(code), ref));
        }
        return;
      }
      const key = refKey(productCodeKey(parsed.data.productCode), parsed.data.deliveryRef);
      if (seen.has(key)) {
        report.rejected.push({
          index,
          issues: [
            { path: 'deliveryRef', message: 'Duplicate productCode and deliveryRef in one read' },
          ],
          ...rejectedIdentity(parsed.data.productCode, parsed.data.deliveryRef),
        });
        return;
      }
      seen.add(key);
      valid.push(parsed.data);
      if (effective !== record) {
        report.derivedUsdCosts.push({
          productCode: parsed.data.productCode,
          deliveryRef: parsed.data.deliveryRef,
        });
      }
    });
    report.skippedBySupplierFilter = [...skipped.values()].sort(
      (a, b) => b.count - a.count || a.supplier.localeCompare(b.supplier),
    );
    return { valid, mentioned };
  }

  // Lines that vanished from the sheet get a manager-confirmation request (see
  // SupplyRemovalService); until a manager CONFIRMS it, such a line still counts here.
  // OPEN (product owner): lines that vanished from the sheet (stale) and lines whose NEWEST sheet
  // values are invalid (rejected, so the stored older values stay) keep counting toward the stock
  // aggregate, because the aggregate sums what is stored. Whether they should be excluded or
  // flagged is not decided; nothing is deleted without the removal confirmation.
  private async writeInChunks(
    valid: readonly ValidRow[],
    report: SyncReport,
  ): Promise<{
    known: CostDeliveryInput[];
    codeById: Map<string, string>;
    skippedRemoved: { productId: string; deliveryRef: string }[];
  }> {
    const known: CostDeliveryInput[] = [];
    const codeById = new Map<string, string>();
    const skippedRemoved: { productId: string; deliveryRef: string }[] = [];
    const chunks = Math.ceil(valid.length / MAX_DELIVERIES_PER_UPSERT);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const rows = valid.slice(
        chunk * MAX_DELIVERIES_PER_UPSERT,
        (chunk + 1) * MAX_DELIVERIES_PER_UPSERT,
      );
      try {
        // Assigned (never appended) inside the transaction callbacks, and merged into the report
        // only after the commit: a failed chunk contributes nothing.
        let resolved: CostDeliveryInput[] = [];
        let chunkCodes = new Map<string, string>();
        let createdCodes: string[] = [];
        let stock = { created: 0, updated: 0, unchanged: 0 };
        let categoriesChanged = 0;
        const result = await this.priceReference.upsertDeliveriesResolved(
          async (tx) => {
            // First the products the sheet names but we do not have yet, then the lines.
            const ensured = await this.catalog.ensureProductsFromSheet(
              tx,
              rows.map((r) => ({ productCode: r.productCode, name: r.productName })),
            );
            const productByKey = new Map(
              ensured.products.map((p) => [productCodeKey(p.productCode), p]),
            );
            createdCodes = ensured.createdCodes;
            chunkCodes = new Map(ensured.products.map((p) => [p.id, p.productCode]));
            resolved = rows.map((row) => {
              const product = productByKey.get(productCodeKey(row.productCode));
              if (!product) throw new Error('A product is missing right after it was ensured');
              return toDelivery(row, product.id);
            });
            return resolved;
          },
          async (tx, productIds) => {
            // Inside the chunk's transaction: sum over ALL stored lines of the touched products,
            // then replace their aggregate through the catalog service (no cross-module table
            // access); the category follows the product's latest delivery line.
            const totals = await this.priceReference.availableTotals(tx, productIds);
            stock = await this.catalog.replaceStock(tx, totals);
            categoriesChanged = await this.catalog.setCategories(
              tx,
              await this.priceReference.latestCategories(tx, productIds),
            );
          },
        );
        report.created += result.created;
        report.updated += result.updated;
        report.unchanged += result.unchanged;
        skippedRemoved.push(...result.skippedRemoved);
        report.stock.created += stock.created;
        report.stock.updated += stock.updated;
        report.stock.unchanged += stock.unchanged;
        report.categoriesChanged += categoriesChanged;
        report.createdProducts.push(...createdCodes);
        known.push(...resolved);
        for (const [id, code] of chunkCodes) codeById.set(id, code);
        for (const delivery of resolved) {
          // A cost-pending line (all three cost cells empty) has nothing to check yet.
          if (
            delivery.costUsd === null ||
            delivery.usdRateUsed === null ||
            delivery.costUzs === null
          ) {
            continue;
          }
          const check = checkCostUzs({
            costUsd: delivery.costUsd,
            usdRateUsed: delivery.usdRateUsed,
            costUzs: delivery.costUzs,
          });
          if (!check.consistent) {
            report.mismatches.push({
              productCode: chunkCodes.get(delivery.productId) ?? '',
              deliveryRef: delivery.deliveryRef,
              differencePercent: check.differencePercent,
            });
          }
        }
      } catch (error) {
        // Never rethrow the database error: its text can contain the failing cost row.
        throw toSyncError(error, { chunk: chunk + 1, chunks, committedChunks: chunk });
      }
    }
    return { known, codeById, skippedRemoved };
  }

  private async findStale(
    known: readonly CostDeliveryInput[],
    codeById: ReadonlyMap<string, string>,
    mentioned: ReadonlySet<string>,
    report: SyncReport,
  ): Promise<{ productId: string; deliveryRef: string }[]> {
    const missing: { productId: string; deliveryRef: string }[] = [];
    const readKeys = new Set(
      known.map((k) => refKey(productCodeKey(codeById.get(k.productId) ?? ''), k.deliveryRef)),
    );
    const productIds = [...new Set(known.map((k) => k.productId))];
    const stored = await this.priceReference.findStoredDeliveryRefs(productIds);
    for (const { productId, deliveryRef } of stored) {
      const productCode = codeById.get(productId);
      if (productCode === undefined) continue;
      const key = refKey(productCodeKey(productCode), deliveryRef);
      if (!readKeys.has(key) && !mentioned.has(key)) {
        report.staleRefs.push({ productCode, deliveryRef });
        missing.push({ productId, deliveryRef });
      }
    }
    report.staleRefs.sort(
      (a, b) =>
        a.productCode.localeCompare(b.productCode) || a.deliveryRef.localeCompare(b.deliveryRef),
    );
    return missing;
  }

  // ---- persisted run report -------------------------------------------------------------------

  /**
   * A failed run is recorded from its own transaction (the sync's chunk transactions are long
   * gone or rolled back). If even that fails, the ORIGINAL error still reaches the caller; the
   * recording failure is only logged, with an error code and no message.
   */
  private async recordFailedRun(
    report: SyncReport,
    startedAt: Date,
    trigger: SheetSyncTrigger,
    error: unknown,
  ): Promise<void> {
    try {
      await this.runs.insertAndPrune(
        await this.toRunRecord(report, startedAt, trigger, safeErrorCode(error)),
      );
    } catch (recordingError) {
      this.logger.error(
        `Could not record the failed sheet sync run: ${describeErrorSafely(recordingError)}`,
      );
    }
  }

  private async toRunRecord(
    report: SyncReport,
    startedAt: Date,
    trigger: SheetSyncTrigger,
    errorCode: string | null,
  ): Promise<SheetSyncRunRecord> {
    const rejectedRows = report.rejected.flatMap(toRejectedRows);
    const counts: SheetSyncRunCounts = {
      rowsRead: report.rowsRead,
      created: report.created,
      updated: report.updated,
      unchanged: report.unchanged,
      rejected: report.rejected.length,
      skippedRows: report.skippedBySupplierFilter.reduce((sum, s) => sum + s.count, 0),
      staleRefs: report.staleRefs.length,
      mismatches: report.mismatches.length,
      createdProducts: report.createdProducts.length,
      removalsRequested: report.removals.requested,
      removalsDismissed: report.removals.dismissed,
      reappearedAfterRemoval: report.reappearedAfterRemoval.length,
    };
    return {
      startedAt,
      finishedAt: this.clock.now(),
      status: errorCode === null ? 'OK' : 'FAILED',
      trigger,
      counts,
      rejectedRows: rejectedRows.slice(0, STORED_LIST_CAP),
      skippedSuppliers: report.skippedBySupplierFilter
        .slice(0, STORED_LIST_CAP)
        .map((s) => ({ ...s, supplier: capStoredSupplier(s.supplier) })),
      createdProducts: report.createdProducts.slice(0, STORED_CREATED_PRODUCTS_CAP),
      pendingRemovalRequests: await this.removals.countPending(),
      costMismatches: report.mismatches.slice(0, STORED_LIST_CAP),
      errorCode,
    };
  }
}

function toDelivery(row: ValidRow, productId: string): CostDeliveryInput {
  return {
    productId,
    deliveryRef: row.deliveryRef,
    supplier: row.supplier,
    purchaseMethod: row.purchaseMethod,
    category: row.category,
    deliveredQuantity: new Prisma.Decimal(row.deliveredQuantity),
    availableQuantity: new Prisma.Decimal(row.availableQuantity),
    // Null together ("cost pending", see cost-source-row.ts); the DB check keeps them together.
    costUsd: row.costUsd === null ? null : new Prisma.Decimal(row.costUsd),
    usdRateUsed: row.usdRateUsed === null ? null : new Prisma.Decimal(row.usdRateUsed),
    costUzs: row.costUzs === null ? null : new Prisma.Decimal(row.costUzs),
    deliveredAt: row.deliveredAt,
  };
}

/**
 * The identifying cells of a rejected row, only where they are safe to keep: a product code that
 * passes the product code rule, a delivery id of reasonable length. Anything else is dropped.
 */
function rejectedIdentity(
  rawCode: unknown,
  rawRef: string | null,
): { productCode?: string; deliveryRef?: string } {
  const code = productCodeSchema.safeParse(typeof rawCode === 'string' ? rawCode : '');
  return {
    ...(code.success ? { productCode: code.data } : {}),
    ...(rawRef !== null && rawRef.length <= MAX_STORED_DELIVERY_REF_LENGTH
      ? { deliveryRef: rawRef }
      : {}),
  };
}

/** One stored entry per issue: the sheet header (path), a short reason, and the safe identity. */
function toRejectedRows(row: RejectedRow): SheetSyncRejectedRow[] {
  return row.issues.map((issue) => ({
    header: issue.path,
    reason: issue.message.slice(0, MAX_STORED_REASON_LENGTH),
    ...(row.productCode === undefined ? {} : { productCode: row.productCode }),
    ...(row.deliveryRef === undefined ? {} : { deliveryRef: row.deliveryRef }),
  }));
}
