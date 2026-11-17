import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import type { Tx } from '../../common/database/db-client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AuditService,
  diffFields,
  type AuditValue,
  type SystemAuditEntry,
} from '../audit/index.js';
import { CatalogService, type ProductView } from '../catalog/index.js';
import { PriceReferenceRepository } from './price-reference.repository.js';
import { PricingService } from './pricing.service.js';
import { RECENT_DELIVERIES_LIMIT } from '@iorder/shared/staff-cost';
import type {
  AfterDeliveriesWritten,
  CostDeliveryData,
  CostDeliveryInput,
  CostDeliverySummaryView,
  CostDeliveryView,
  UpsertDeliveriesResult,
} from './price-reference.types.js';

/** Audit action names for changes made by the sheet sync (a system action: actor is null). */
export const SHEET_SYNC_CREATED = 'SHEET_SYNC_CREATED';
export const SHEET_SYNC_UPDATED = 'SHEET_SYNC_UPDATED';

/** Largest batch one upsertDeliveries call (one transaction) accepts. */
export const MAX_DELIVERIES_PER_UPSERT = 500;
/** Product ids per IN (...) list when reading stored delivery refs. */
const REF_LOOKUP_CHUNK = 1000;

/** Fixed fraction digits per column; they mirror the Decimal(p, s) scales of the table. */
const SCALE = { quantity: 3, usd: 4, rate: 4, uzs: 2 } as const;

function emptyUpsertResult(): UpsertDeliveriesResult {
  return { created: 0, updated: 0, unchanged: 0, skippedRemoved: [] };
}

function snapshot(data: CostDeliveryData): Record<string, AuditValue> {
  return {
    supplier: data.supplier,
    purchaseMethod: data.purchaseMethod,
    category: data.category,
    deliveredQuantity: data.deliveredQuantity.toFixed(SCALE.quantity),
    availableQuantity: data.availableQuantity.toFixed(SCALE.quantity),
    // Null while the line's cost is pending: the audit "from" of the later fill-in is null.
    costUsd: data.costUsd?.toFixed(SCALE.usd) ?? null,
    usdRateUsed: data.usdRateUsed?.toFixed(SCALE.rate) ?? null,
    costUzs: data.costUzs?.toFixed(SCALE.uzs) ?? null,
    deliveredAt: data.deliveredAt.toISOString(),
  };
}

/**
 * Staff-only cost reference and the USD rate. NOTHING here is reachable from a customer
 * route; the customer price list never calls this service (hard rule 7).
 *
 * Changes to stored cost rows and to the rate go through the full history: an audit row with
 * before/after, written in the same transaction as the change.
 */
@Injectable()
export class PriceReferenceService {
  constructor(
    private readonly repository: PriceReferenceRepository,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly pricing: PricingService,
  ) {}

  // -------------------------------------------------------------------------------------
  // Cost reference (read)
  // -------------------------------------------------------------------------------------

  /** All deliveries of a product, newest first; `latest` is the manager's reference line. */
  async getCostReference(
    actor: Actor,
    productId: string,
  ): Promise<{ product: ProductView; deliveries: CostDeliveryView[] }> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    const product = await this.catalog.requireProduct(productId);
    return { product, deliveries: await this.repository.findByProduct(productId) };
  }

  /**
   * Cost reference and stock of every product of the CURRENT published list, for the staff price
   * list. A fixed number of queries whatever the list size: the current list (2), the recent
   * deliveries of all its products (1, window function), their stock (1) and suppliers (1). Staff-only; the
   * customer price list never calls this.
   */
  async getCurrentListCosts(actor: Actor): Promise<{
    versionNumber: number;
    items: {
      productId: string;
      recent: CostDeliverySummaryView[];
      stockQuantity: Prisma.Decimal | null;
      suppliers: string[];
    }[];
  }> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    const current = await this.pricing.getCurrentListProductIds();
    const [rows, stock, suppliers] = await Promise.all([
      this.repository.findRecentByProducts(current.productIds, RECENT_DELIVERIES_LIMIT),
      this.catalog.getStockQuantities(current.productIds),
      this.repository.findSuppliersByProduct(current.productIds),
    ]);
    const byProduct = new Map<string, CostDeliverySummaryView[]>();
    for (const row of rows) {
      byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row]);
    }
    return {
      versionNumber: current.versionNumber,
      items: current.productIds.map((productId) => ({
        productId,
        recent: byProduct.get(productId) ?? [],
        stockQuantity: stock.get(productId) ?? null,
        suppliers: suppliers.get(productId) ?? [],
      })),
    };
  }

  // -------------------------------------------------------------------------------------
  // Sheet sync (system action)
  // -------------------------------------------------------------------------------------

  /**
   * Creates or updates delivery rows in ONE transaction (at most MAX_DELIVERIES_PER_UPSERT
   * rows: the caller commits big syncs in chunks, see SheetsSyncService). A system action:
   * audit rows carry a null actor (never a fake user) and SHEET_SYNC_* action names.
   *
   * Idempotent: a row whose values already match is not written and not audited. The same
   * delivery twice in one call collapses to the last occurrence. New rows go in with one
   * INSERT, their audit rows with one INSERT; changed rows are updated one by one (usually few).
   * The advisory lock is taken per call, so two syncs may interleave chunks but each chunk reads
   * the current rows under the lock: every change is audited once with its true "before".
   */
  async upsertDeliveries(
    rows: readonly CostDeliveryInput[],
    afterWritten?: AfterDeliveriesWritten,
  ): Promise<UpsertDeliveriesResult> {
    if (rows.length > MAX_DELIVERIES_PER_UPSERT) {
      throw new Error(`upsertDeliveries takes at most ${MAX_DELIVERIES_PER_UPSERT} rows per call`);
    }
    if (rows.length === 0) return emptyUpsertResult();
    return this.upsertDeliveriesResolved(() => Promise.resolve(rows), afterWritten);
  }

  /**
   * Like upsertDeliveries, but the rows are produced INSIDE the write transaction, after the sync
   * lock is taken: the sheet sync creates the products it has not met yet there, so a product and
   * its first delivery lines are committed (or rolled back) together.
   */
  async upsertDeliveriesResolved(
    resolveRows: (tx: Tx) => Promise<readonly CostDeliveryInput[]>,
    afterWritten?: AfterDeliveriesWritten,
  ): Promise<UpsertDeliveriesResult> {
    const result = emptyUpsertResult();
    const keyOf = (productId: string, deliveryRef: string): string =>
      JSON.stringify([productId, deliveryRef]);

    return this.repository.transaction(async (tx) => {
      await this.repository.lockNamed(tx, 'price_reference_sync');
      const rows = await resolveRows(tx);
      if (rows.length > MAX_DELIVERIES_PER_UPSERT) {
        throw new Error(
          `upsertDeliveries takes at most ${MAX_DELIVERIES_PER_UPSERT} rows per call`,
        );
      }
      if (rows.length === 0) return result;
      const latestByKey = new Map(rows.map((r) => [keyOf(r.productId, r.deliveryRef), r]));
      const syncedAt = this.clock.now();
      const existing = await this.repository.findByProducts(tx, [
        ...new Set([...latestByKey.values()].map((r) => r.productId)),
      ]);
      const byKey = new Map(existing.map((e) => [keyOf(e.productId, e.deliveryRef), e]));

      const toCreate: CostDeliveryInput[] = [];
      const audits: SystemAuditEntry[] = [];
      for (const [key, row] of latestByKey) {
        const current = byKey.get(key);
        if (!current) {
          toCreate.push(row);
          continue;
        }
        if (current.removedAt !== null) {
          // A manager confirmed this line's removal; a reappearing line is reported, not revived.
          result.skippedRemoved.push({ productId: row.productId, deliveryRef: row.deliveryRef });
          continue;
        }
        const changes = diffFields(snapshot(current), snapshot(row));
        if (Object.keys(changes).length === 0) {
          result.unchanged += 1;
          continue;
        }
        await this.repository.update(tx, current.id, { ...row, syncedAt });
        audits.push({
          systemSource: 'SHEET_SYNC',
          entityType: 'PRICE_REFERENCE',
          entityId: current.id,
          action: SHEET_SYNC_UPDATED,
          changes,
        });
        result.updated += 1;
      }

      const created = await this.repository.createMany(
        tx,
        toCreate.map((row) => ({ ...row, syncedAt })),
      );
      const idByKey = new Map(created.map((c) => [keyOf(c.productId, c.deliveryRef), c.id]));
      for (const row of toCreate) {
        audits.push({
          systemSource: 'SHEET_SYNC',
          entityType: 'PRICE_REFERENCE',
          entityId: idByKey.get(keyOf(row.productId, row.deliveryRef)) ?? '',
          action: SHEET_SYNC_CREATED,
          changes: {
            productId: { from: null, to: row.productId },
            deliveryRef: { from: null, to: row.deliveryRef },
            ...diffFields({}, snapshot(row)),
          },
        });
      }
      result.created += toCreate.length;

      await this.audit.recordSystemMany(tx, audits);
      // Same transaction: e.g. the stock aggregate of the touched products is rewritten atomically
      // with the lines it is summed from.
      await afterWritten?.(tx, [...new Set([...latestByKey.values()].map((r) => r.productId))]);
      return result;
    });
  }

  /**
   * For other modules (the merge preview): the USD cost of each product's latest live delivery
   * line (null while that line's cost is pending), as `latestDelivery.costUsd` shows it. Cost is
   * staff-only (hard rule 7): an actor without VIEW_COST_REFERENCE gets an empty map, never an
   * error, so the caller's DTO simply carries null.
   */
  async latestCostUsd(
    actor: Actor,
    productIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal | null>> {
    if (!can(actor, 'VIEW_COST_REFERENCE') || productIds.length === 0) return new Map();
    const rows = await this.repository.findRecentByProducts(productIds, 1);
    return new Map(rows.map((row) => [row.productId, row.costUsd]));
  }

  /**
   * The category each of these products must have: that of its newest live delivery line, or null
   * when it has no live line left (every line removed). One entry per product id. The sheet sync
   * and a confirmed line removal copy it onto the product inside their transaction.
   */
  async latestCategories(
    tx: Tx,
    productIds: readonly string[],
  ): Promise<{ productId: string; category: string | null }[]> {
    const found = new Map(
      (await this.repository.findLatestCategories(tx, productIds)).map((r) => [
        r.productId,
        r.category,
      ]),
    );
    return [...new Set(productIds)].map((productId) => ({
      productId,
      category: found.get(productId) ?? null,
    }));
  }

  /** Total available quantity of each product over ALL its stored delivery lines. */
  availableTotals(
    tx: Tx,
    productIds: readonly string[],
  ): Promise<{ productId: string; quantity: Prisma.Decimal }[]> {
    return this.repository.sumAvailableByProduct(tx, productIds);
  }

  /**
   * Which deliveries are stored for these products (refs only, never cost values). Used by the
   * sync to report deliveries that disappeared from the source. Read-only.
   */
  async findStoredDeliveryRefs(
    productIds: readonly string[],
  ): Promise<{ productId: string; deliveryRef: string }[]> {
    const found: { productId: string; deliveryRef: string }[] = [];
    const ids = [...new Set(productIds)];
    for (let i = 0; i < ids.length; i += REF_LOOKUP_CHUNK) {
      found.push(...(await this.repository.findRefsByProducts(ids.slice(i, i + REF_LOOKUP_CHUNK))));
    }
    return found;
  }
}
