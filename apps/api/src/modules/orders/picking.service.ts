import { Injectable } from '@nestjs/common';
import { uuidSchema, type OrderStatus } from '@iorder/shared';
import {
  allowsCodeSlot,
  checkUnitCode,
  recordUnitCodeRequestSchema,
  requiredCodeSlots,
  type PickingSlot,
  type TrackingType,
  type UnitCodeKind,
  type UnitCodeRule,
} from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { parseInput } from './orders.schemas.js';
import { CatalogService } from '../catalog/index.js';
import { resourceContextOf } from './order-actor.js';
import {
  OrderItemAllocationsService,
  type ItemAllocations,
  type OrderItemAllocationView,
} from './order-item-allocations.service.js';
import type { OrderItemRecord, OrderRecord } from './orders.repository.js';
import { OrdersRepository } from './orders.repository.js';
import {
  OrderUnitsRepository,
  type OrderClosedVoidReason,
  type OrderUnitRecord,
  type UnitCodeRecord,
} from './order-units.repository.js';

export interface PickingLineView {
  item: OrderItemRecord;
  trackingType: TrackingType;
  markingRequired: boolean;
  allocations: readonly OrderItemAllocationView[];
  units: { unit: OrderUnitRecord; missing: PickingSlot[] }[];
  incompleteUnits: number;
}

export interface PickingView {
  order: OrderRecord;
  editable: boolean;
  complete: boolean;
  lines: PickingLineView[];
}

/** What the release transaction records about the codes (payload of its STATUS_CHANGED event). */
export interface ReleasedCodesSummary {
  units: number;
  codes: number;
}

const NO_RULE: UnitCodeRule = { trackingType: 'NONE', markingRequired: false };

const SCANNABLE_STATUSES: readonly OrderStatus[] = ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED'];

/**
 * Picking ([C] 2026-10-25, the reference-distributor model; opened at approval [C] 2026-10-30): every piece
 * of an order gets an order_units row when the manager approves it; until the release the warehouse
 * scans the codes the product's rule asks for (IMEI1 + optional IMEI2, or SN; plus the marking
 * code when required); the release is refused until every required code is there. The rule is
 * the product's CURRENT one, recomputed on every read and at release, never a stored flag.
 */
@Injectable()
export class PickingService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly units: OrderUnitsRepository,
    private readonly catalog: CatalogService,
    private readonly clock: Clock,
    private readonly allocations: OrderItemAllocationsService,
  ) {}

  // ------------------------------------------------------------- HTTP use cases

  async getPicking(actor: Actor, orderId: string): Promise<PickingView> {
    const order = await this.loadVisible(actor, orderId);
    return this.buildView(actor, order);
  }

  /**
   * One scan into one (kind, slot) of a unit. A rescan of a filled slot voids the old value and
   * records the new one. Validation and uniqueness are checked on every scan, so the warehouse
   * hears about a duplicate at the shelf, not at the release button. One order event per scan.
   */
  async recordCode(
    actor: Actor,
    orderId: string,
    unitId: string,
    rawCommand: unknown,
  ): Promise<PickingView> {
    const command = parseInput(recordUnitCodeRequestSchema, rawCommand);
    try {
      const order = await this.orders.transaction(async (tx) => {
        const { order: locked, unit, rule } = await this.loadForScan(tx, actor, orderId, unitId);
        if (!allowsCodeSlot(rule, command.kind, command.slot)) {
          throw new ConflictError('The product does not take this code', 'UNIT_CODE_NOT_REQUIRED', {
            kind: command.kind,
            slot: command.slot,
          });
        }
        const check = checkUnitCode(command.kind, command.value);
        if (!check.ok) {
          throw new InputValidationError([{ path: 'value', message: check.error }]);
        }
        const current = await this.units.findLiveCode(tx, unit.id, command.kind, command.slot);
        if (current?.codeValue === check.value) return locked;

        const holder = await this.units.findLiveHolder(tx, command.kind, check.key, unit.productId);
        if (holder !== null) throw duplicate(command.kind, holder.orderNumber);

        const now = this.clock.now();
        if (current !== null)
          await this.units.voidCode(tx, current.id, actor.userId, 'REPLACED', now);
        await this.units.insertCode(tx, {
          unitId: unit.id,
          orderId: locked.id,
          productId: unit.productId,
          kind: command.kind,
          slot: command.slot,
          codeValue: check.value,
          codeKey: check.key,
          recordedBy: actor.userId,
          recordedAt: now,
        });
        await this.orders.insertEvents(tx, [
          {
            orderId: locked.id,
            eventType: 'UNIT_CODE_RECORDED',
            fromStatus: null,
            toStatus: null,
            actorUserId: actor.userId,
            actorRole: 'WAREHOUSE_MANAGER',
            comment: null,
            payload: {
              before: codePayload(locked, unit, command.kind, command.slot, current),
              after: {
                ...codePayload(locked, unit, command.kind, command.slot, null),
                value: check.value,
              },
            },
            createdAt: now,
          },
        ]);
        return locked;
      });
      return this.buildView(actor, order);
    } catch (error) {
      // Two scans of the same code raced past the holder check: the partial unique index decided.
      if (isUniqueViolation(error)) throw duplicate(command.kind, null);
      throw error;
    }
  }

  /** Removes a scanned code (voided, never deleted), with one order event. */
  async clearCode(
    actor: Actor,
    orderId: string,
    unitId: string,
    kind: UnitCodeKind,
    slot: number,
  ): Promise<PickingView> {
    const order = await this.orders.transaction(async (tx) => {
      const { order: locked, unit } = await this.loadForScan(tx, actor, orderId, unitId);
      const current = await this.units.findLiveCode(tx, unit.id, kind, slot);
      if (current === null) return locked;
      const now = this.clock.now();
      await this.units.voidCode(tx, current.id, actor.userId, 'CLEARED', now);
      await this.orders.insertEvents(tx, [
        {
          orderId: locked.id,
          eventType: 'UNIT_CODE_CLEARED',
          fromStatus: null,
          toStatus: null,
          actorUserId: actor.userId,
          actorRole: 'WAREHOUSE_MANAGER',
          comment: null,
          payload: {
            before: codePayload(locked, unit, kind, slot, current),
            after: codePayload(locked, unit, kind, slot, null),
          },
          createdAt: now,
        },
      ]);
      return locked;
    });
    return this.buildView(actor, order);
  }

  // ---------------------------------------------- inside the status transition (hard rule 2)

  /** The manager approved the order: one unit row per piece of every line. Idempotent. */
  async createUnits(tx: Tx, order: OrderRecord, now: Date): Promise<void> {
    await this.units.insertUnits(
      tx,
      order.id,
      order.items.flatMap((item) => {
        const pieces = item.quantity.toNumber();
        // Lines written before whole quantities were enforced cannot be split into pieces.
        return Number.isInteger(pieces) && pieces > 0
          ? [{ orderItemId: item.id, productId: item.productId, pieces }]
          : [];
      }),
      now,
    );
  }

  /**
   * Release gate, called inside the release transaction after the order row is locked: the
   * products' current rules (share-locked, so a rule cannot change before the commit) against the
   * live codes. Throws UNIT_CODES_INCOMPLETE naming every line that still misses codes.
   */
  async assertCodesComplete(tx: Tx, order: OrderRecord): Promise<ReleasedCodesSummary> {
    const rules = await this.rulesOf(order, tx);
    const units = await this.units.findUnits(order.id, tx);
    const lines = this.buildLines(order, units, rules, new Map());
    const incomplete = lines.filter((line) => line.incompleteUnits > 0);
    if (incomplete.length > 0) {
      throw new ConflictError('Unit codes are missing', 'UNIT_CODES_INCOMPLETE', {
        items: incomplete.map((line) => ({
          itemId: line.item.id,
          productCode: line.item.productCodeSnapshot,
          incompleteUnits: line.incompleteUnits,
        })),
      });
    }
    return {
      units: units.length,
      codes: units.reduce((sum, unit) => sum + unit.codes.length, 0),
    };
  }

  /**
   * A rejected or cancelled order frees its scanned codes for other orders. Returns how many were
   * voided. The caller holds the order row lock that scans also take, so no scan can slip past.
   */
  voidCodesOfClosedOrder(
    tx: Tx,
    orderId: string,
    actorUserId: string,
    reason: OrderClosedVoidReason,
    now: Date,
  ): Promise<number> {
    return this.units.voidLiveCodesOfOrder(tx, orderId, actorUserId, reason, now);
  }

  // ----------------------------------------------------------------- helpers

  private async loadVisible(actor: Actor, orderId: string, db?: DbClient): Promise<OrderRecord> {
    const notFound = new NotFoundError('Order not found');
    if (!uuidSchema.safeParse(orderId).success) throw notFound;
    const order = await this.orders.findById(orderId, db);
    if (!order || !can(actor, 'VIEW_ORDER', resourceContextOf(order))) throw notFound;
    if (!can(actor, 'VIEW_UNIT_CODES')) throw new ForbiddenError('Access denied');
    return order;
  }

  private async loadForScan(
    tx: Tx,
    actor: Actor,
    orderId: string,
    unitId: string,
  ): Promise<{
    order: OrderRecord;
    unit: { id: string; productId: string; orderItemId: string; unitNo: number };
    rule: UnitCodeRule;
  }> {
    if (!uuidSchema.safeParse(orderId).success) throw new NotFoundError('Order not found');
    await this.orders.lockOrder(tx, orderId);
    const order = await this.loadVisible(actor, orderId, tx);
    if (!SCANNABLE_STATUSES.includes(order.status)) {
      throw new ConflictError(
        'Codes are scanned only between the approval and the release',
        'UNIT_CODES_NOT_EDITABLE',
        { currentStatus: order.status },
      );
    }
    if (!can(actor, 'RECORD_UNIT_CODES', resourceContextOf(order))) {
      throw new ForbiddenError('Access denied');
    }
    const unit = uuidSchema.safeParse(unitId).success
      ? await this.units.findUnit(tx, order.id, unitId)
      : null;
    if (unit === null) throw new NotFoundError('Unit not found');
    const rule = (await this.rulesOf(order, tx)).get(unit.productId) ?? NO_RULE;
    return { order, unit, rule };
  }

  private async buildView(actor: Actor, order: OrderRecord): Promise<PickingView> {
    const [rules, units, allocations] = await Promise.all([
      this.rulesOf(order),
      this.units.findUnits(order.id),
      this.allocations.ofOrder(order.id),
    ]);
    const lines = this.buildLines(order, units, rules, allocations);
    return {
      order,
      editable:
        SCANNABLE_STATUSES.includes(order.status) &&
        can(actor, 'RECORD_UNIT_CODES', resourceContextOf(order)),
      complete: lines.every((line) => line.incompleteUnits === 0),
      lines,
    };
  }

  private buildLines(
    order: OrderRecord,
    units: readonly OrderUnitRecord[],
    rules: ReadonlyMap<string, UnitCodeRule>,
    allocations: ItemAllocations,
  ): PickingLineView[] {
    return order.items.map((item) => {
      const rule = rules.get(item.productId) ?? NO_RULE;
      const required = requiredCodeSlots(rule);
      const lineUnits = units
        .filter((unit) => unit.orderItemId === item.id)
        .map((unit) => ({
          unit,
          missing: required.filter(
            (slot) =>
              !unit.codes.some((code) => code.kind === slot.kind && code.slot === slot.slot),
          ),
        }));
      return {
        item,
        trackingType: rule.trackingType,
        markingRequired: rule.markingRequired,
        allocations: allocations.get(item.id) ?? [],
        units: lineUnits,
        incompleteUnits: lineUnits.filter((entry) => entry.missing.length > 0).length,
      };
    });
  }

  /** The products' current rules; inside a transaction they are share-locked until it ends. */
  private async rulesOf(order: OrderRecord, tx?: Tx): Promise<Map<string, UnitCodeRule>> {
    const ids = [...new Set(order.items.map((item) => item.productId))];
    const products =
      tx === undefined
        ? await this.catalog.findProductsByIds(ids)
        : await this.catalog.findProductsLockedForShare(tx, ids);
    return new Map(
      products.map((p) => [
        p.id,
        { trackingType: p.trackingType, markingRequired: p.markingRequired },
      ]),
    );
  }
}

function duplicate(kind: UnitCodeKind, orderNumber: string | null): ConflictError {
  return new ConflictError('This code is already recorded on another unit', 'UNIT_CODE_DUPLICATE', {
    kind,
    orderNumber,
  });
}

function codePayload(
  order: OrderRecord,
  unit: { id: string; orderItemId: string; unitNo: number },
  kind: UnitCodeKind,
  slot: number,
  code: UnitCodeRecord | null,
): {
  unitId: string;
  productCode: string;
  unitNo: number;
  kind: UnitCodeKind;
  slot: number;
  value: string | null;
} {
  const item = order.items.find((line) => line.id === unit.orderItemId);
  return {
    unitId: unit.id,
    productCode: item?.productCodeSnapshot ?? '',
    unitNo: unit.unitNo,
    kind,
    slot,
    value: code?.codeValue ?? null,
  };
}
