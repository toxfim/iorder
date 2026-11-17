import type { OrderStatus } from '@iorder/shared';
import type {
  AllocationAttention,
  AllocationMode,
  AllocationPreview,
  AllocationRequestRow,
  OrderItemAllocation,
} from '@iorder/shared/staff-orders';
import { ApiConflictError, ApiValidationError } from '@core/lib/api-errors';
import { fromMilli, toMilli } from '@core/lib/quantity';

// The in-memory twin of the api's holds (supply-allocation, order-allocation-preview). Same rules on
// bigint thousandths: FIFO by delivery date, short stock first, a FIFO plan must still be the FIFO, a
// manual one must fit. Dev and test only.

export interface FakeSupplyLine {
  id: string;
  productId: string;
  deliveryRef: string;
  deliveredAt: string;
  available: bigint;
  removed: boolean;
}

export interface FakeHold {
  orderItemId: string;
  supplyLineId: string;
  quantity: bigint;
}

export interface AllocatableOrder {
  id: string;
  status: OrderStatus;
  rowVersion: number;
  items: readonly {
    id: string;
    productId: string;
    productCode: string;
    name: string;
    quantity: string;
    /** False: a staff-added product outside the plan (no lines, no hold, never short). Absent: tracked. */
    stockTracked?: boolean;
  }[];
}

const tracked = (item: AllocatableOrder['items'][number]): boolean => item.stockTracked !== false;

const figure = (milli: bigint): string => {
  const whole = milli / 1000n;
  return `${whole}.${(milli % 1000n).toString().padStart(3, '0')}`;
};
const positive = (value: bigint): bigint => (value > 0n ? value : 0n);

export function createFakeAllocation(lineSeed: (productId: string) => readonly FakeSupplyLine[]) {
  const linesByProduct = new Map<string, FakeSupplyLine[]>();
  const standing = new Map<string, readonly FakeHold[]>();
  const holds = new Map<string, FakeHold[]>();

  function linesOf(productId: string): FakeSupplyLine[] {
    let lines = linesByProduct.get(productId);
    if (lines === undefined) {
      lines = [...lineSeed(productId)].sort(
        (a, b) =>
          Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt) ||
          (a.deliveryRef < b.deliveryRef ? -1 : 1),
      );
      linesByProduct.set(productId, lines);
    }
    return lines;
  }

  function heldByOthers(lineId: string, orderId: string): bigint {
    let sum = 0n;
    for (const [owner, rows] of holds) {
      if (owner === orderId) continue;
      for (const row of rows) if (row.supplyLineId === lineId) sum += row.quantity;
    }
    return sum;
  }

  const freeOf = (line: FakeSupplyLine, orderId: string): bigint =>
    line.removed ? 0n : positive(line.available - heldByOthers(line.id, orderId));

  function fifoOf(order: AllocatableOrder): { holds: FakeHold[]; short: Map<string, bigint> } {
    const room = new Map<string, bigint>();
    const planned: FakeHold[] = [];
    const short = new Map<string, bigint>();
    for (const item of order.items) {
      if (!tracked(item)) continue;
      let left = toMilli(item.quantity);
      for (const line of linesOf(item.productId)) {
        if (left <= 0n) break;
        const free = room.get(line.id) ?? freeOf(line, order.id);
        if (free <= 0n) continue;
        const taken = free < left ? free : left;
        planned.push({ orderItemId: item.id, supplyLineId: line.id, quantity: taken });
        room.set(line.id, free - taken);
        left -= taken;
      }
      if (left > 0n) short.set(item.id, left);
    }
    return { holds: planned, short };
  }

  function preview(order: AllocatableOrder): AllocationPreview {
    const plan = fifoOf(order);
    const own = holds.get(order.id) ?? [];
    const refOf = (lineId: string, productId: string): string =>
      linesOf(productId).find((line) => line.id === lineId)?.deliveryRef ?? '';
    const items = order.items.map((item) => ({
      orderItemId: item.id,
      productId: item.productId,
      productCode: item.productCode,
      name: item.name,
      quantity: figure(toMilli(item.quantity)),
      stockTracked: tracked(item),
      // An untracked product has no supply lines at all, so every list below stays empty for it.
      lines: linesOf(item.productId)
        .filter((line) => tracked(item) && !line.removed)
        .map((line) => ({
          supplyLineId: line.id,
          deliveryRef: line.deliveryRef,
          deliveredAt: line.deliveredAt,
          availableQuantity: figure(line.available),
          heldQuantity: figure(heldByOthers(line.id, order.id)),
          freeQuantity: figure(freeOf(line, order.id)),
        })),
      fifo: plan.holds
        .filter((hold) => hold.orderItemId === item.id)
        .map((hold) => ({
          supplyLineId: hold.supplyLineId,
          deliveryRef: refOf(hold.supplyLineId, item.productId),
          quantity: figure(hold.quantity),
        })),
      shortQuantity: figure(plan.short.get(item.id) ?? 0n),
      earlierDemand: { orders: 0, quantity: '0.000' },
      current: own
        .filter((hold) => hold.orderItemId === item.id)
        .map((hold) => {
          const line = linesOf(item.productId).find((l) => l.id === hold.supplyLineId);
          let attention: AllocationAttention | null = null;
          if (line === undefined || line.removed) attention = 'LINE_REMOVED';
          else if (heldByOthers(line.id, order.id) + hold.quantity > line.available) {
            attention = 'LINE_SHORT';
          }
          return {
            supplyLineId: hold.supplyLineId,
            deliveryRef: refOf(hold.supplyLineId, item.productId),
            quantity: figure(hold.quantity),
            attention,
          };
        }),
    }));
    return {
      orderId: order.id,
      status: order.status,
      rowVersion: order.rowVersion,
      items,
      feasible: plan.short.size === 0,
      attention: items.some((item) => item.current.some((hold) => hold.attention !== null)),
      notAllocated: order.status !== 'SUBMITTED' && !holds.has(order.id),
      lastSheetChangeAt: null,
    };
  }

  const refuse = (
    reason: 'ALLOCATION_CHANGED' | 'STOCK_INSUFFICIENT',
    order: AllocatableOrder,
  ): ApiConflictError =>
    new ApiConflictError(reason, 'CONFLICT', { preview: preview(order) }, reason);

  /** Throws what the api answers; returns the holds to store. */
  function judge(
    order: AllocatableOrder,
    mode: AllocationMode,
    requested: readonly AllocationRequestRow[],
  ): FakeHold[] {
    const fresh = fifoOf(order);
    if (fresh.short.size > 0) throw refuse('STOCK_INSUFFICIENT', order);
    const rows: FakeHold[] = requested.map((row) => ({
      orderItemId: row.orderItemId,
      supplyLineId: row.supplyLineId,
      quantity: toMilli(row.quantity),
    }));
    const key = (hold: FakeHold): string =>
      `${hold.orderItemId}|${hold.supplyLineId}|${fromMilli(hold.quantity)}`;
    if (mode === 'FIFO') {
      const wanted = new Set(fresh.holds.map(key));
      if (rows.length !== wanted.size || !rows.every((row) => wanted.has(key(row)))) {
        throw refuse('ALLOCATION_CHANGED', order);
      }
      return rows;
    }
    for (const item of order.items) {
      const sum = rows
        .filter((row) => row.orderItemId === item.id)
        .reduce((total, row) => total + row.quantity, 0n);
      // An untracked line takes no rows; a tracked one must be covered exactly.
      if (sum !== (tracked(item) ? toMilli(item.quantity) : 0n)) {
        throw new ApiValidationError('Request validation failed', 'VALIDATION_FAILED', [
          { path: 'allocations', message: 'The rows must add up to the quantity' },
        ]);
      }
    }
    for (const row of rows) {
      const item = order.items.find((candidate) => candidate.id === row.orderItemId);
      const line = item && linesOf(item.productId).find((l) => l.id === row.supplyLineId);
      if (!line || row.quantity > freeOf(line, order.id)) throw refuse('ALLOCATION_CHANGED', order);
    }
    return rows;
  }

  return {
    preview,
    judge,
    /** Replaces the order's holds; the caller judged them first. */
    store(orderId: string, rows: readonly FakeHold[]): void {
      holds.set(orderId, [...rows]);
      standing.set(orderId, [...rows]);
    },
    /**
     * A demo order approved before the fake started: 3 of 4 from the older delivery, the last piece
     * from the newer, so the split shows on the screens.
     */
    seed(order: AllocatableOrder): void {
      const rows: FakeHold[] = [];
      for (const item of order.items) {
        if (!tracked(item)) continue;
        const [first, second] = linesOf(item.productId);
        if (!first) continue;
        const wanted = toMilli(item.quantity);
        const split = second !== undefined && wanted >= 2000n;
        rows.push({
          orderItemId: item.id,
          supplyLineId: first.id,
          quantity: split ? wanted - 1000n : wanted,
        });
        if (split) rows.push({ orderItemId: item.id, supplyLineId: second.id, quantity: 1000n });
      }
      holds.set(order.id, rows);
      standing.set(order.id, rows);
    },
    /** As the api's OrderItemAllocationsService: the plan that stands, even after the hold ended. */
    allocationsOf(orderId: string, item: { id: string; productId: string }): OrderItemAllocation[] {
      const lines = linesOf(item.productId);
      return (standing.get(orderId) ?? [])
        .filter((row) => row.orderItemId === item.id)
        .flatMap((row) => {
          const index = lines.findIndex((line) => line.id === row.supplyLineId);
          const line = lines[index];
          if (!line) return [];
          return [
            {
              supplyRef: line.deliveryRef,
              // The older delivery of the demo has a party, the newer one has none yet.
              partyNumber: index === 0 ? `PRT-${line.deliveryRef.slice(3, 7)}` : null,
              quantity: figure(row.quantity),
            },
          ];
        });
    },
    /** The order was released, rejected or cancelled. */
    end(orderId: string): void {
      if (holds.has(orderId)) holds.set(orderId, []);
    },
    /** For tests: the sheet now says this. */
    setAvailable(productId: string, deliveryRef: string, available: string): void {
      const line = linesOf(productId).find((l) => l.deliveryRef === deliveryRef);
      if (line) line.available = toMilli(available);
    },
  };
}

export type FakeAllocation = ReturnType<typeof createFakeAllocation>;

/** For tests: what the dialog sends for the proposal it shows. */
export async function fifoPlanOf(
  api: { getAllocationPreview: (orderId: string) => Promise<AllocationPreview> },
  orderId: string,
): Promise<{ allocationMode: 'FIFO'; allocations: AllocationRequestRow[] }> {
  const preview = await api.getAllocationPreview(orderId);
  return {
    allocationMode: 'FIFO',
    allocations: preview.items.flatMap((item) =>
      item.fifo.map((row) => ({
        orderItemId: item.orderItemId,
        supplyLineId: row.supplyLineId,
        quantity: row.quantity,
      })),
    ),
  };
}
