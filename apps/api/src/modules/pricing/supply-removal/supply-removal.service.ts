import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../common/auth/actor.js';
import { can } from '../../../common/auth/can.js';
import { Clock } from '../../../common/clock/clock.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors/domain-errors.js';
import { AuditService, type SystemAuditEntry } from '../../audit/index.js';
import { CatalogService } from '../../catalog/index.js';
import { PriceReferenceRepository } from '../price-reference.repository.js';
import { PriceReferenceService } from '../price-reference.service.js';
import {
  SupplyRemovalRepository,
  type RemovalLineRow,
  type RemovalRequestRow,
} from './supply-removal.repository.js';

export interface PendingRemoval {
  request: RemovalRequestRow;
  productCode: string;
  line: RemovalLineRow;
}

export interface DetectionResult {
  requested: number;
  dismissed: number;
}

const ENTITY = 'SUPPLY_REMOVAL_REQUEST';
const LOCK = 'supply_removal';

/**
 * A delivery line that vanished from the sheet is NEVER deleted by the sync [C]. The sync opens a
 * PENDING request; a manager (or admin) CONFIRMS it (the line is soft-removed) or DISMISSES it.
 *
 * While a request is PENDING the line keeps counting for stock and for cost history. This is the
 * conservative default (nothing changes without a person's decision); whether a missing line
 * should stop counting earlier is an OPEN product detail.
 */
@Injectable()
export class SupplyRemovalService {
  constructor(
    private readonly repository: SupplyRemovalRepository,
    private readonly lines: PriceReferenceRepository,
    private readonly lineService: PriceReferenceService,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---- the sync (system action) ------------------------------------------------------------

  /**
   * Called by the sheet sync after a read. \`missing\`: stored lines of products that WERE read but
   * are absent from the sheet. \`present\`: lines that ARE in the sheet. Idempotent: a PENDING
   * request is opened at most once per line (also guaranteed by a partial unique index), and a
   * PENDING request whose line reappeared is dismissed automatically. Changes nothing else.
   */
  async syncDetected(input: {
    missing: readonly { productId: string; deliveryRef: string }[];
    present: readonly { productId: string; deliveryRef: string }[];
  }): Promise<DetectionResult> {
    const result: DetectionResult = { requested: 0, dismissed: 0 };
    if (input.missing.length === 0 && input.present.length === 0) return result;

    return this.repository.transaction(async (tx) => {
      await this.repository.lockNamed(tx, LOCK);
      const now = this.clock.now();
      const key = (p: { productId: string; deliveryRef: string }): string =>
        JSON.stringify([p.productId, p.deliveryRef]);
      const pending = await this.repository.findPendingFor(tx, [
        ...new Set([...input.missing, ...input.present].map((p) => p.productId)),
      ]);
      const pendingByKey = new Map(pending.map((r) => [key(r), r]));
      const audits: SystemAuditEntry[] = [];

      const toOpen = input.missing.filter((m) => !pendingByKey.has(key(m)));
      const created = await this.repository.createMany(
        tx,
        toOpen.map((m) => ({
          productId: m.productId,
          deliveryRef: m.deliveryRef,
          detectedAt: now,
        })),
      );
      for (const c of created) {
        audits.push({
          systemSource: 'SHEET_SYNC',
          entityType: ENTITY,
          entityId: c.id,
          action: 'SHEET_SYNC_REMOVAL_REQUESTED',
          changes: {
            productId: { from: null, to: c.productId },
            deliveryRef: { from: null, to: c.deliveryRef },
            status: { from: null, to: 'PENDING' },
          },
        });
      }
      result.requested = created.length;

      for (const p of input.present) {
        const open = pendingByKey.get(key(p));
        if (!open) continue;
        pendingByKey.delete(key(p));
        // Conditional: a person's decision made since we read the row always wins.
        const changed = await this.repository.decideIfPending(tx, open.id, {
          status: 'DISMISSED',
          decidedBy: null,
          decidedAt: now,
        });
        if (!changed) continue;
        audits.push({
          systemSource: 'SHEET_SYNC',
          entityType: ENTITY,
          entityId: open.id,
          action: 'SHEET_SYNC_REMOVAL_DISMISSED',
          changes: { status: { from: 'PENDING', to: 'DISMISSED' } },
        });
        result.dismissed += 1;
      }
      await this.audit.recordSystemMany(tx, audits);
      return result;
    });
  }

  /** Number of PENDING requests (for the persisted sync report; the caller authorizes). */
  countPending(): Promise<number> {
    return this.repository.pendingCount();
  }

  // ---- staff ---------------------------------------------------------------------------------

  /** Pending requests with the delivery line staff need to decide. Manager, accountant, admin. */
  async listPending(actor: Actor): Promise<{ total: number; items: PendingRemoval[] }> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    const requests = await this.repository.listPending();
    const [lines, products] = await Promise.all([
      this.repository.findLines(requests),
      this.catalog.findProductsByIds(requests.map((r) => r.productId)),
    ]);
    const lineByKey = new Map(lines.map((l) => [JSON.stringify([l.productId, l.deliveryRef]), l]));
    const codeById = new Map(products.map((p) => [p.id, p.productCode]));
    const items: PendingRemoval[] = [];
    for (const request of requests) {
      const line = lineByKey.get(JSON.stringify([request.productId, request.deliveryRef]));
      const productCode = codeById.get(request.productId);
      // A line is never deleted, so this cannot happen; never show a half-empty request.
      if (!line || productCode === undefined) continue;
      items.push({ request, productCode, line });
    }
    return { total: requests.length, items };
  }

  /**
   * CONFIRM: the line is soft-removed (stays in the table and the audit log, but no longer counts
   * for stock or cost queries) and the product's stock aggregate is recomputed in the SAME
   * transaction. 409 REMOVAL_REQUEST_NOT_PENDING when it was already decided.
   */
  async confirm(actor: Actor, id: string): Promise<RemovalRequestRow> {
    this.assertMayDecide(actor);
    return this.repository.transaction(async (tx) => {
      // Sync lock first (same order everywhere): the stock recompute below must not interleave
      // with a sheet sync chunk, or it could overwrite fresher totals with stale ones.
      await this.repository.lockNamed(tx, 'price_reference_sync');
      await this.repository.lockNamed(tx, LOCK);
      const request = await this.requirePending(tx, id);
      const now = this.clock.now();
      const lineId = await this.repository.markLineRemoved(
        tx,
        request.productId,
        request.deliveryRef,
        actor.userId,
        now,
      );
      await this.repository.decide(tx, id, {
        status: 'CONFIRMED',
        decidedBy: actor.userId,
        decidedAt: now,
      });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY,
        entityId: id,
        action: 'SUPPLY_REMOVAL_CONFIRMED',
        changes: {
          status: { from: 'PENDING', to: 'CONFIRMED' },
          decidedBy: { from: null, to: actor.userId },
        },
      });
      if (lineId !== null) {
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: 'PRICE_REFERENCE',
          entityId: lineId,
          action: 'SUPPLY_LINE_REMOVED',
          changes: {
            removedAt: { from: null, to: now.toISOString() },
            removedBy: { from: null, to: actor.userId },
          },
        });
      }
      // Stock without the removed line, in the same transaction (through the catalog service).
      const totals = await this.lines.sumAvailableByProduct(tx, [request.productId]);
      await this.catalog.replaceStock(tx, totals, { actorUserId: actor.userId });
      // The category follows the newest LIVE line: it moves back when the newest one was removed
      // and is cleared when no line is left (same transaction, audited under the actor).
      await this.catalog.setCategories(
        tx,
        await this.lineService.latestCategories(tx, [request.productId]),
        { actorUserId: actor.userId },
      );
      return { ...request, status: 'CONFIRMED' as const, decidedBy: actor.userId, decidedAt: now };
    });
  }

  /** DISMISS: the line stays exactly as it is. 409 when already decided. */
  async dismiss(actor: Actor, id: string): Promise<RemovalRequestRow> {
    this.assertMayDecide(actor);
    return this.repository.transaction(async (tx) => {
      // The sheet sync takes this lock before it auto-dismisses; waiting here keeps one writer.
      await this.repository.lockNamed(tx, LOCK);
      const request = await this.requirePending(tx, id);
      const now = this.clock.now();
      await this.repository.decide(tx, id, {
        status: 'DISMISSED',
        decidedBy: actor.userId,
        decidedAt: now,
      });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY,
        entityId: id,
        action: 'SUPPLY_REMOVAL_DISMISSED',
        changes: {
          status: { from: 'PENDING', to: 'DISMISSED' },
          decidedBy: { from: null, to: actor.userId },
        },
      });
      return { ...request, status: 'DISMISSED' as const, decidedBy: actor.userId, decidedAt: now };
    });
  }

  private async requirePending(
    tx: Parameters<SupplyRemovalRepository['lockById']>[0],
    id: string,
  ): Promise<RemovalRequestRow> {
    const request = await this.repository.lockById(tx, id);
    if (!request) throw new NotFoundError('Removal request not found');
    if (request.status !== 'PENDING') {
      throw new ConflictError(
        'This removal request has already been decided',
        'REMOVAL_REQUEST_NOT_PENDING',
      );
    }
    return request;
  }

  private assertMayDecide(actor: Actor): void {
    if (!can(actor, 'DECIDE_SUPPLY_REMOVAL')) throw new ForbiddenError('Access denied');
  }
}
