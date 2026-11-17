import type { OrderStatus } from '@iorder/shared';
import {
  UNIT_CODE_ERRORS,
  allowsCodeSlot,
  checkUnitCode,
  requiredCodeSlots,
  type PickingLine,
  type PickingResponse,
  type UnitCodeError,
  type UnitCodeKind,
} from '@iorder/shared/staff-orders';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { describeOrderError } from './order-errors';

// Pure picking logic of the warehouse scanner screen ([C] 2026-10-25): which slots a unit shows,
// where the focus goes after a scan, the progress, and the words for a refused scan. The server
// stays the authority; the shared validator only gives instant feedback.

/** One code place of one unit: IMEI 1, IMEI 2 (optional), SN or the marking code. */
export interface SlotRef {
  readonly unitId: string;
  readonly kind: UnitCodeKind;
  readonly slot: number;
}

export interface SlotView extends SlotRef {
  readonly key: string;
  readonly unitNo: number;
  readonly required: boolean;
  readonly value: string | null;
}

export interface UnitView {
  readonly unitId: string;
  readonly unitNo: number;
  readonly complete: boolean;
  readonly slots: readonly SlotView[];
}

export interface LineView {
  readonly line: PickingLine;
  /** Quantity goods (no code rule): only the count is shown, nothing to scan. */
  readonly scanless: boolean;
  readonly units: readonly UnitView[];
}

// The order the slots of one unit are shown and filled in: IMEI1, IMEI2, SN, marking.
const SLOT_ORDER: readonly { kind: UnitCodeKind; slot: number }[] = [
  { kind: 'IMEI', slot: 1 },
  { kind: 'IMEI', slot: 2 },
  { kind: 'SERIAL', slot: 1 },
  { kind: 'MARKING', slot: 1 },
];

export const slotKey = (ref: SlotRef): string => `${ref.unitId}:${ref.kind}:${ref.slot}`;

export function lineViews(picking: PickingResponse): LineView[] {
  return picking.lines.map((line) => {
    const rule = { trackingType: line.trackingType, markingRequired: line.markingRequired };
    const required = requiredCodeSlots(rule);
    const allowed = SLOT_ORDER.filter((s) => allowsCodeSlot(rule, s.kind, s.slot));
    return {
      line,
      scanless: allowed.length === 0,
      units: line.units.map((unit) => ({
        unitId: unit.unitId,
        unitNo: unit.unitNo,
        complete: unit.missing.length === 0,
        slots: allowed.map((s) => {
          const code = unit.codes.find((c) => c.kind === s.kind && c.slot === s.slot);
          return {
            unitId: unit.unitId,
            unitNo: unit.unitNo,
            kind: s.kind,
            slot: s.slot,
            key: slotKey({ unitId: unit.unitId, kind: s.kind, slot: s.slot }),
            required: required.some((r) => r.kind === s.kind && r.slot === s.slot),
            value: code?.value ?? null,
          };
        }),
      })),
    };
  });
}

/** Units that need at least one code, and how many of them have every required code. */
export function pickingProgress(picking: PickingResponse): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const view of lineViews(picking)) {
    for (const unit of view.units) {
      if (!unit.slots.some((s) => s.required)) continue;
      total += 1;
      if (unit.complete) done += 1;
    }
  }
  return { done, total };
}

/**
 * The next required slot to scan after `from` (in screen order, wrapping round), skipping filled
 * ones and the ones in `busy` (a scan on its way to the server). The optional IMEI2 is never an
 * auto-advance target: a dual-SIM phone gets it by tapping the field. Null: nothing left.
 */
export function nextSlot(
  picking: PickingResponse,
  from: string | null,
  busy: ReadonlySet<string> = new Set(),
): SlotView | null {
  const slots = lineViews(picking).flatMap((view) => view.units.flatMap((unit) => unit.slots));
  const start = from === null ? -1 : slots.findIndex((s) => s.key === from);
  for (let step = 1; step <= slots.length; step += 1) {
    const candidate = slots[(start + step + slots.length) % slots.length];
    if (candidate && candidate.required && candidate.value === null && !busy.has(candidate.key)) {
      return candidate;
    }
  }
  return null;
}

/** A refused scan, as the warehouse sees it in the on-screen list (toasts are missed). */
export interface ScanRefusal {
  /** vue-i18n key. */
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** The view is out of date (status moved, rule changed, unit gone): re-read it. */
  readonly reload: boolean;
}

const KNOWN_CODE_ERRORS: ReadonlySet<string> = new Set(UNIT_CODE_ERRORS);

export const codeErrorRefusal = (error: UnitCodeError): ScanRefusal => ({
  key: `orders.picking.codeErrors.${error}`,
  reload: false,
});

/**
 * The shared validator (the api runs the same one) plus a check against the codes already on
 * this order, so a double scan is refused at once. Returns the normalised value or the refusal.
 */
export function precheckScan(
  picking: PickingResponse,
  target: SlotRef,
  raw: string,
): { ok: true; value: string } | { ok: false; refusal: ScanRefusal } {
  const check = checkUnitCode(target.kind, raw);
  if (!check.ok) return { ok: false, refusal: codeErrorRefusal(check.error) };
  for (const line of picking.lines) {
    for (const unit of line.units) {
      for (const code of unit.codes) {
        if (code.kind !== target.kind) continue;
        if (unit.unitId === target.unitId && code.slot === target.slot) continue;
        const other = checkUnitCode(code.kind, code.value);
        if (other.ok && other.key === check.key) {
          return {
            ok: false,
            refusal: {
              key: 'orders.picking.errors.duplicateHere',
              params: { unit: unit.unitNo, product: line.name },
              reload: false,
            },
          };
        }
      }
    }
  }
  return { ok: true, value: check.value };
}

function orderNumberOf(details: unknown): string | null {
  if (typeof details !== 'object' || details === null || !('orderNumber' in details)) return null;
  const value: unknown = details.orderNumber;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Maps a failed scan or clear to words; never the server's English text. */
export function describeScanError(error: unknown): ScanRefusal {
  if (error instanceof ApiValidationError) {
    const message = error.issues[0]?.message ?? '';
    return KNOWN_CODE_ERRORS.has(message)
      ? codeErrorRefusal(message as UnitCodeError)
      : { key: 'orders.picking.codeErrors.invalid', reload: false };
  }
  if (error instanceof ApiConflictError) {
    switch (error.reason) {
      case 'UNIT_CODE_DUPLICATE': {
        const orderNumber = orderNumberOf(error.details);
        return orderNumber
          ? { key: 'orders.picking.errors.duplicateIn', params: { orderNumber }, reload: false }
          : { key: 'orders.picking.errors.duplicate', reload: false };
      }
      case 'UNIT_CODE_NOT_REQUIRED':
        return { key: 'orders.picking.errors.notRequired', reload: true };
      case 'UNIT_CODES_NOT_EDITABLE':
        return { key: 'orders.picking.errors.notEditable', reload: true };
      default:
        break;
    }
  }
  if (error instanceof ApiNotFoundError) return { key: 'orders.picking.errors.gone', reload: true };
  if (error instanceof PermissionDeniedError) return { key: 'apiErrors.denied', reload: false };
  const described = describeOrderError(error);
  return { key: described.key, reload: described.reload, params: described.params ?? {} };
}

/** A GS1 group separator is invisible: show it as a symbol so the person sees it was read. */
export const displayCode = (value: string): string => value.split('\u001d').join('␝');

/** Where an order has units: from the manager's approval on (a closed order frees its codes). */
const PICKING_STATUSES: readonly OrderStatus[] = [
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
];

export const showsPicking = (status: OrderStatus): boolean => PICKING_STATUSES.includes(status);
