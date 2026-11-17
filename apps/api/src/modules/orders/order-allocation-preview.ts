import type {
  AllocationAttention,
  AllocationPreview,
  AllocationRequestRow,
} from '@iorder/shared/staff-orders';
import { Prisma } from '../../generated/prisma/client.js';
import {
  compareFifo,
  freeOf,
  planFifo,
  roomFor,
  type DemandLine,
  type PlannedHold,
  type SupplyLine,
  type SupplyState,
} from '../pricing/index.js';
import { formatQuantity } from './order-lines.js';
import type { OrderItemRecord, OrderRecord } from './orders.repository.js';

// PURE: turns the state of the delivery lines into the manager's view. Fields are allow-listed; the
// lines carry no cost and no supplier, so none can appear in a preview or in a 409's details.

const ZERO = new Prisma.Decimal(0);

export interface EarlierDemand {
  orders: number;
  quantity: Prisma.Decimal;
}

/**
 * What the plan must cover. A staff-added product without a sheet code [C, 2026-11-09] has no
 * delivery lines and is outside the plan: it asks for nothing, so it never holds and is never short.
 */
export function demandOf(items: readonly OrderItemRecord[]): DemandLine[] {
  return items
    .filter((item) => item.stockTracked)
    .map((item) => ({
      orderItemId: item.id,
      productId: item.productId,
      quantity: item.quantity,
    }));
}

/** The products of an order whose stock the plan reads; the untracked ones have no lines to read. */
export function trackedProductIds(items: readonly OrderItemRecord[]): string[] {
  return items.filter((item) => item.stockTracked).map((item) => item.productId);
}

export function holdsOf(rows: readonly AllocationRequestRow[]): PlannedHold[] {
  return rows.map((row) => ({
    orderItemId: row.orderItemId,
    supplyLineId: row.supplyLineId,
    quantity: new Prisma.Decimal(row.quantity),
  }));
}

/** A hold needs a look when its line left the sheet or the sheet shows less than all its holds. */
function attentionOf(
  line: SupplyLine | undefined,
  ownOnLine: Prisma.Decimal,
): AllocationAttention | null {
  if (line === undefined || line.removed) return 'LINE_REMOVED';
  return line.heldQuantity.plus(ownOnLine).gt(line.availableQuantity) ? 'LINE_SHORT' : null;
}

export function buildAllocationPreview(
  order: Pick<OrderRecord, 'id' | 'status' | 'rowVersion' | 'items'>,
  state: SupplyState,
  earlier: ReadonlyMap<string, EarlierDemand>,
): AllocationPreview {
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  const refOf = (id: string): string => lineById.get(id)?.deliveryRef ?? '';
  const row = (hold: { supplyLineId: string; quantity: Prisma.Decimal }) => ({
    supplyLineId: hold.supplyLineId,
    deliveryRef: refOf(hold.supplyLineId),
    quantity: formatQuantity(hold.quantity),
  });
  const ownByLine = new Map<string, Prisma.Decimal>();
  for (const hold of state.own) {
    ownByLine.set(
      hold.supplyLineId,
      (ownByLine.get(hold.supplyLineId) ?? ZERO).plus(hold.quantity),
    );
  }
  const plan = planFifo(demandOf(order.items), state.lines);
  const ordered = [...state.lines].sort(compareFifo);

  const items = order.items.map((item) => {
    const head = {
      orderItemId: item.id,
      productId: item.productId,
      productCode: item.productCodeSnapshot,
      name: item.nameSnapshot,
      quantity: formatQuantity(item.quantity),
    };
    // Outside the plan: nothing to show but the line itself (the UI says "stock not tracked").
    if (!item.stockTracked) {
      return {
        ...head,
        stockTracked: false,
        lines: [],
        fifo: [],
        shortQuantity: formatQuantity(ZERO),
        earlierDemand: { orders: 0, quantity: formatQuantity(ZERO) },
        current: [],
      };
    }
    const own = state.own.filter((hold) => hold.orderItemId === item.id);
    const demand = earlier.get(item.productId);
    return {
      ...head,
      stockTracked: true,
      lines: ordered
        .filter((line) => line.productId === item.productId && !line.removed)
        .map((line) => ({
          supplyLineId: line.id,
          deliveryRef: line.deliveryRef,
          deliveredAt: line.deliveredAt.toISOString(),
          availableQuantity: formatQuantity(line.availableQuantity),
          heldQuantity: formatQuantity(line.heldQuantity),
          // The same room the plan uses, so a hand-made plan is checked against what FIFO could take.
          freeQuantity: formatQuantity(roomFor(freeOf(line), item.quantity)),
        })),
      fifo: plan.holds.filter((hold) => hold.orderItemId === item.id).map(row),
      shortQuantity: formatQuantity(plan.short.get(item.id) ?? ZERO),
      earlierDemand: {
        orders: demand?.orders ?? 0,
        quantity: formatQuantity(demand?.quantity ?? ZERO),
      },
      current: own.map((hold) => ({
        ...row(hold),
        attention: attentionOf(
          lineById.get(hold.supplyLineId),
          ownByLine.get(hold.supplyLineId) ?? ZERO,
        ),
      })),
    };
  });

  return {
    orderId: order.id,
    status: order.status,
    rowVersion: order.rowVersion,
    items,
    feasible: plan.short.size === 0,
    attention: items.some((item) => item.current.some((hold) => hold.attention !== null)),
    notAllocated: order.status !== 'SUBMITTED' && !state.everAllocated,
    lastSheetChangeAt: state.lastSheetChangeAt?.toISOString() ?? null,
  };
}
