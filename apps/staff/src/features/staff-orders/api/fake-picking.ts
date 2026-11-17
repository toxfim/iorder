import type { OrderStatus } from '@iorder/shared';
import {
  allowsCodeSlot,
  checkUnitCode,
  passesLuhn,
  recordUnitCodeRequestSchema,
  requiredCodeSlots,
  type PickingResponse,
  type RecordUnitCodeRequest,
  type UnitCodeKind,
  type UnitCodeRule,
  type OrderItemAllocation,
} from '@iorder/shared/staff-orders';
import { ApiConflictError, ApiNotFoundError, ApiValidationError } from '@core/lib/api-errors';

// The picking half of the fake staff orders backend (dev and tests only, never in a production
// bundle): one unit per piece once an order is ACCOUNTING_CLEARED, the codes the product's CURRENT
// rule asks for, the same validator as the api, uniqueness over every live unit (IMEI and marking
// in any order, a serial within the same product) and the release gate. Kept apart from
// fake-staff-orders-backend.ts so that file stays about the order lifecycle.

export const NO_CODE_RULE: UnitCodeRule = { trackingType: 'NONE', markingRequired: false };

/** What the picking needs to know about an order of the orders fake. */
export interface PickingOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly rowVersion: number;
  readonly items: readonly {
    readonly id: string;
    readonly productId: string;
    readonly productCode: string;
    readonly name: string;
    readonly unit: string;
    readonly quantity: string;
    /** False: a staff-added product outside the plan (there is no supply to pick from). Absent: tracked. */
    readonly stockTracked?: boolean;
  }[];
}

interface CodeRecord {
  kind: UnitCodeKind;
  slot: number;
  value: string;
  key: string;
  recordedAt: string;
}

interface UnitRecord {
  unitId: string;
  orderId: string;
  orderNumber: string;
  itemId: string;
  productId: string;
  unitNo: number;
  codes: CodeRecord[];
}

export interface FakePickingOptions {
  /** The orders fake's holds; a test of the scanner alone has none. */
  allocationsOf?: (
    orderId: string,
    item: { id: string; productId: string },
  ) => OrderItemAllocation[];
  /** The product's CURRENT code rule, read on every call (the catalog fake may change it). */
  readonly rule: (productCode: string) => UnitCodeRule;
  readonly now: () => Date;
  readonly nextId: (kind: string) => string;
}

export interface IncompleteLine {
  itemId: string;
  productCode: string;
  incompleteUnits: number;
}

export interface FakePicking {
  /** The order reached ACCOUNTING_CLEARED: one unit row per piece of every line (idempotent). */
  createUnits: (order: PickingOrder) => void;
  /** Seeds an already released demo order with valid codes, so read-only views show some. */
  fillDemoCodes: (order: PickingOrder) => void;
  view: (order: PickingOrder, editable: boolean) => PickingResponse;
  /** Validation (422) and conflicts (409) as the api raises them; the caller checked access. */
  record: (order: PickingOrder, unitId: string, request: unknown) => void;
  clear: (order: PickingOrder, unitId: string, kind: UnitCodeKind, slot: number) => void;
  /** Lines that still miss a required code (empty: the order may be released). */
  incomplete: (order: PickingOrder) => IncompleteLine[];
  /** A cancelled order frees its codes for other orders. */
  voidCodes: (orderId: string) => void;
}

function wholePieces(quantity: string): number {
  const pieces = Number(quantity);
  return Number.isInteger(pieces) && pieces > 0 ? pieces : 0;
}

/** A valid-looking IMEI (14 digits + the Luhn check digit) for the demo data. */
export function demoImei(seed: number): string {
  const body = `35${String(seed).padStart(12, '0')}`;
  for (let digit = 0; digit <= 9; digit += 1) {
    if (passesLuhn(`${body}${digit}`)) return `${body}${digit}`;
  }
  return `${body}0`;
}

export function createFakePicking(options: FakePickingOptions): FakePicking {
  const units = new Map<string, UnitRecord[]>();
  let demoCounter = 0;

  const unitsOf = (orderId: string): UnitRecord[] => units.get(orderId) ?? [];
  const ruleOf = (order: PickingOrder, itemId: string): UnitCodeRule => {
    const item = order.items.find((i) => i.id === itemId);
    return item ? options.rule(item.productCode) : NO_CODE_RULE;
  };

  function missingOf(unit: UnitRecord, rule: UnitCodeRule): { kind: UnitCodeKind; slot: number }[] {
    return requiredCodeSlots(rule).filter(
      (slot) => !unit.codes.some((c) => c.kind === slot.kind && c.slot === slot.slot),
    );
  }

  function lines(order: PickingOrder) {
    return order.items.map((item) => {
      const rule = options.rule(item.productCode);
      const mine = unitsOf(order.id).filter((u) => u.itemId === item.id);
      const viewUnits = mine.map((unit) => ({
        unitId: unit.unitId,
        unitNo: unit.unitNo,
        codes: unit.codes.map(({ kind, slot, value, recordedAt }) => ({
          kind,
          slot,
          value,
          recordedAt,
        })),
        missing: missingOf(unit, rule),
      }));
      return {
        itemId: item.id,
        productId: item.productId,
        productCode: item.productCode,
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        allocations: options.allocationsOf?.(order.id, item) ?? [],
        stockTracked: item.stockTracked !== false,
        trackingType: rule.trackingType,
        markingRequired: rule.markingRequired,
        units: viewUnits,
        incompleteUnits: viewUnits.filter((u) => u.missing.length > 0).length,
      };
    });
  }

  function requireUnit(order: PickingOrder, unitId: string): UnitRecord {
    const unit = unitsOf(order.id).find((u) => u.unitId === unitId);
    if (!unit) throw new ApiNotFoundError('Unit not found', 'NOT_FOUND');
    return unit;
  }

  function holderOf(kind: UnitCodeKind, key: string, productId: string): UnitRecord | null {
    for (const list of units.values()) {
      for (const unit of list) {
        if (kind === 'SERIAL' && unit.productId !== productId) continue;
        if (unit.codes.some((c) => c.kind === kind && c.key === key)) return unit;
      }
    }
    return null;
  }

  function setCode(unit: UnitRecord, kind: UnitCodeKind, slot: number, value: string): void {
    const check = checkUnitCode(kind, value);
    if (!check.ok) return;
    unit.codes = unit.codes.filter((c) => !(c.kind === kind && c.slot === slot));
    unit.codes.push({
      kind,
      slot,
      value: check.value,
      key: check.key,
      recordedAt: options.now().toISOString(),
    });
  }

  return {
    createUnits(order) {
      if (units.has(order.id)) return;
      units.set(
        order.id,
        order.items.flatMap((item) =>
          Array.from({ length: wholePieces(item.quantity) }, (_, index) => ({
            unitId: options.nextId('unit'),
            orderId: order.id,
            orderNumber: order.orderNumber,
            itemId: item.id,
            productId: item.productId,
            unitNo: index + 1,
            codes: [],
          })),
        ),
      );
    },

    fillDemoCodes(order) {
      for (const unit of unitsOf(order.id)) {
        for (const { kind, slot } of requiredCodeSlots(ruleOf(order, unit.itemId))) {
          demoCounter += 1;
          const value =
            kind === 'IMEI'
              ? demoImei(demoCounter)
              : kind === 'SERIAL'
                ? `SN${String(demoCounter).padStart(8, '0')}`
                : `0104600000000${String(demoCounter).padStart(3, '0')}21DEMO${demoCounter}\u001d93Ab1z`;
          setCode(unit, kind, slot, value);
        }
      }
    },

    view(order, editable) {
      const viewLines = lines(order);
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        rowVersion: order.rowVersion,
        editable,
        complete: viewLines.every((line) => line.incompleteUnits === 0),
        lines: viewLines,
      };
    },

    record(order, unitId, request) {
      const parsed = recordUnitCodeRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ApiValidationError(
          'Request validation failed',
          'VALIDATION_FAILED',
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        );
      }
      const command: RecordUnitCodeRequest = parsed.data;
      const unit = requireUnit(order, unitId);
      const rule = ruleOf(order, unit.itemId);
      if (!allowsCodeSlot(rule, command.kind, command.slot)) {
        throw new ApiConflictError(
          'The product does not take this code',
          'CONFLICT',
          { kind: command.kind, slot: command.slot },
          'UNIT_CODE_NOT_REQUIRED',
        );
      }
      const check = checkUnitCode(command.kind, command.value);
      if (!check.ok) {
        throw new ApiValidationError('Request validation failed', 'VALIDATION_FAILED', [
          { path: 'value', message: check.error },
        ]);
      }
      const current = unit.codes.find((c) => c.kind === command.kind && c.slot === command.slot);
      if (current?.value === check.value) return;
      const holder = holderOf(command.kind, check.key, unit.productId);
      if (holder !== null) {
        throw new ApiConflictError(
          'This code is already recorded on another unit',
          'CONFLICT',
          { kind: command.kind, orderNumber: holder.orderNumber },
          'UNIT_CODE_DUPLICATE',
        );
      }
      setCode(unit, command.kind, command.slot, check.value);
    },

    clear(order, unitId, kind, slot) {
      const unit = requireUnit(order, unitId);
      unit.codes = unit.codes.filter((c) => !(c.kind === kind && c.slot === slot));
    },

    incomplete(order) {
      return lines(order)
        .filter((line) => line.incompleteUnits > 0)
        .map((line) => ({
          itemId: line.itemId,
          productCode: line.productCode,
          incompleteUnits: line.incompleteUnits,
        }));
    },

    voidCodes(orderId) {
      for (const unit of unitsOf(orderId)) unit.codes = [];
    },
  };
}
