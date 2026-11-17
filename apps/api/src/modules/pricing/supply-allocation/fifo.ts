import { Prisma } from '../../../generated/prisma/client.js';

// PURE: no I/O, no clock. Quantities are fixed-point (hard rule 1).

const ZERO = new Prisma.Decimal(0);

/** How much one order line asks for. */
export interface DemandLine {
  orderItemId: string;
  productId: string;
  quantity: Prisma.Decimal;
}

/** A delivery line as a plan sees it: `heldQuantity` counts OTHER orders only. */
export interface SupplyLine {
  id: string;
  productId: string;
  deliveryRef: string;
  deliveredAt: Date;
  availableQuantity: Prisma.Decimal;
  heldQuantity: Prisma.Decimal;
  removed: boolean;
}

export interface PlannedHold {
  orderItemId: string;
  supplyLineId: string;
  quantity: Prisma.Decimal;
}

export interface FifoPlan {
  holds: PlannedHold[];
  /** Only the lines that cannot be covered. */
  short: Map<string, Prisma.Decimal>;
}

/** Room left on a line; an overdrawn or removed line simply has none. */
export function freeOf(line: SupplyLine): Prisma.Decimal {
  if (line.removed) return ZERO;
  const free = line.availableQuantity.minus(line.heldQuantity);
  return free.gt(0) ? free : ZERO;
}

/**
 * What one order line can take of a line's free room. Order lines are whole pieces, so a whole line
 * takes whole pieces from each delivery: half a piece here and half there is not a piece. A legacy
 * fractional order line (written before the whole-number rule) takes the room as it is.
 */
export function roomFor(free: Prisma.Decimal, wanted: Prisma.Decimal): Prisma.Decimal {
  return wanted.isInteger() ? free.floor() : free;
}

// Code units, not localeCompare: the order must not depend on the server's ICU data.
function compareRefs(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Oldest delivery first; the ref breaks a tie so the plan is stable between two reads. */
export function compareFifo(a: SupplyLine, b: SupplyLine): number {
  return (
    a.deliveredAt.getTime() - b.deliveredAt.getTime() || compareRefs(a.deliveryRef, b.deliveryRef)
  );
}

export function planFifo(demand: readonly DemandLine[], lines: readonly SupplyLine[]): FifoPlan {
  const free = new Map(lines.map((line) => [line.id, freeOf(line)]));
  const ordered = [...lines].sort(compareFifo);
  const holds: PlannedHold[] = [];
  const short = new Map<string, Prisma.Decimal>();
  // Whole lines first: a legacy line taking a fraction first could leave them no whole piece.
  const wholeFirst = [...demand].sort(
    (a, b) => Number(b.quantity.isInteger()) - Number(a.quantity.isInteger()),
  );
  for (const item of wholeFirst) {
    let left = item.quantity;
    for (const line of ordered) {
      if (line.productId !== item.productId || !left.gt(0)) continue;
      const lineFree = free.get(line.id) ?? ZERO;
      const room = roomFor(lineFree, item.quantity);
      if (!room.gt(0)) continue;
      const taken = room.lt(left) ? room : left;
      holds.push({ orderItemId: item.orderItemId, supplyLineId: line.id, quantity: taken });
      free.set(line.id, lineFree.minus(taken));
      left = left.minus(taken);
    }
    if (left.gt(0)) short.set(item.orderItemId, left);
  }
  return { holds, short };
}

const keyOf = (hold: PlannedHold): string => `${hold.orderItemId}|${hold.supplyLineId}`;

/** Same rows in any order (quantities compared as numbers: "2" equals "2.000"). */
export function samePlan(a: readonly PlannedHold[], b: readonly PlannedHold[]): boolean {
  if (a.length !== b.length) return false;
  const quantities = new Map(a.map((hold) => [keyOf(hold), hold.quantity]));
  return b.every((hold) => quantities.get(keyOf(hold))?.equals(hold.quantity) === true);
}

export interface PlanIssue {
  path: string;
  message: string;
}

/**
 * Mistakes of the request itself, whatever the stock is: a line of another product, a repeated row,
 * a fraction for a whole order line, or quantities that do not add up to the order line.
 */
export function shapeIssues(
  demand: readonly DemandLine[],
  lines: readonly SupplyLine[],
  requested: readonly PlannedHold[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const items = new Map(demand.map((item) => [item.orderItemId, item]));
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const seen = new Set<string>();
  const totals = new Map<string, Prisma.Decimal>();
  requested.forEach((hold, index) => {
    const item = items.get(hold.orderItemId);
    if (item === undefined) {
      issues.push({
        path: `allocations.${index}.orderItemId`,
        message: 'Not a line of this order',
      });
      return;
    }
    if (lineById.get(hold.supplyLineId)?.productId !== item.productId) {
      issues.push({
        path: `allocations.${index}.supplyLineId`,
        message: 'Not a delivery line of this product',
      });
      return;
    }
    if (item.quantity.isInteger() && !hold.quantity.isInteger()) {
      issues.push({ path: `allocations.${index}.quantity`, message: 'Whole pieces only' });
    }
    if (seen.has(keyOf(hold))) {
      issues.push({ path: `allocations.${index}`, message: 'This row appears twice' });
    }
    seen.add(keyOf(hold));
    totals.set(hold.orderItemId, (totals.get(hold.orderItemId) ?? ZERO).plus(hold.quantity));
  });
  for (const item of demand) {
    if (!(totals.get(item.orderItemId) ?? ZERO).equals(item.quantity)) {
      issues.push({
        path: 'allocations',
        message: `The rows of order line ${item.orderItemId} must add up to its quantity`,
      });
    }
  }
  return issues;
}

/** True when some row asks more than its line has room for, or names a removed line. */
export function exceedsLines(
  lines: readonly SupplyLine[],
  requested: readonly PlannedHold[],
): boolean {
  const asked = new Map<string, Prisma.Decimal>();
  for (const hold of requested) {
    asked.set(hold.supplyLineId, (asked.get(hold.supplyLineId) ?? ZERO).plus(hold.quantity));
  }
  return lines.some((line) => asked.get(line.id)?.gt(freeOf(line)) ?? false);
}

export type PlanMode = 'FIFO' | 'MANUAL';

export type PlanVerdict =
  | { outcome: 'ACCEPTED'; holds: readonly PlannedHold[] }
  | { outcome: 'STOCK_INSUFFICIENT' }
  | { outcome: 'ALLOCATION_CHANGED' }
  | { outcome: 'INVALID'; issues: PlanIssue[] };

/**
 * The server's answer to a plan, on the lines read under the sync lock. Short stock comes first, so
 * a product with no stock at all says so whatever was sent. A FIFO plan must still BE the fresh FIFO
 * (a sync may have added an older line); a manual plan only has to fit.
 */
export function judgePlan(
  demand: readonly DemandLine[],
  lines: readonly SupplyLine[],
  mode: PlanMode,
  requested: readonly PlannedHold[],
): PlanVerdict {
  const fresh = planFifo(demand, lines);
  if (fresh.short.size > 0) return { outcome: 'STOCK_INSUFFICIENT' };
  if (mode === 'FIFO') {
    return samePlan(fresh.holds, requested)
      ? { outcome: 'ACCEPTED', holds: fresh.holds }
      : { outcome: 'ALLOCATION_CHANGED' };
  }
  const issues = shapeIssues(demand, lines, requested);
  if (issues.length > 0) return { outcome: 'INVALID', issues };
  return exceedsLines(lines, requested)
    ? { outcome: 'ALLOCATION_CHANGED' }
    : { outcome: 'ACCEPTED', holds: requested };
}
