import { Injectable } from '@nestjs/common';
import type { DbClient, Tx } from '../../../common/database/db-client.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { PlannedHold, SupplyLine } from './fifo.js';
import { SupplyAllocationRepository, type ActiveHoldRow } from './supply-allocation.repository.js';

/** The lock of every delivery line writer: the sheet sync and a confirmed removal take it too. */
const SUPPLY_LOCK = 'price_reference_sync';

export interface SupplyState {
  /** Every line of the products; holds of OTHER orders only. */
  lines: SupplyLine[];
  /** This order's own active holds. */
  own: ActiveHoldRow[];
  /** This order has allocation rows of any kind (an older approved order has none). */
  everAllocated: boolean;
  lastSheetChangeAt: Date | null;
}

export interface OrderLineSupply {
  orderItemId: string;
  deliveryRef: string;
  quantity: Prisma.Decimal;
}

/**
 * Stock holds of approved orders ([C] owner 2026-10-30). Lives in pricing beside the delivery lines,
 * because orders already depends on pricing. It knows order ids only as keys: who may do what and
 * every order event stay in the orders module. The caller authorizes.
 *
 * Available = per live line, the sheet's quantity minus that line's active holds, computed on read. A sync rewrites lines and
 * stock_cache as before and never touches a hold, so the sheet stays the only source of real stock.
 */
@Injectable()
export class SupplyAllocationService {
  constructor(private readonly repository: SupplyAllocationRepository) {}

  /**
   * Taken BEFORE the order row, by everyone who takes both: nothing that holds this lock waits for
   * a transaction that waits for it, because a sync never locks an order.
   */
  lockSupply(tx: Tx): Promise<void> {
    return this.repository.lockNamed(tx, SUPPLY_LOCK);
  }

  async readState(
    db: DbClient,
    productIds: readonly string[],
    orderId: string,
  ): Promise<SupplyState> {
    const [rows, own, everAllocated, lastSheetChangeAt] = await Promise.all([
      this.repository.findLines(db, productIds, orderId),
      this.repository.findActiveHolds(db, orderId),
      this.repository.hasAnyAllocation(db, orderId),
      this.repository.lastSheetChange(db),
    ]);
    return {
      lines: rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        deliveryRef: row.deliveryRef,
        deliveredAt: row.deliveredAt,
        availableQuantity: row.availableQuantity,
        heldQuantity: row.heldQuantity,
        removed: row.removedAt !== null,
      })),
      own,
      everAllocated,
      lastSheetChangeAt,
    };
  }

  /** `productOf` names the product of each order line, as the order knows it. */
  async createHolds(
    tx: Tx,
    input: {
      orderId: string;
      holds: readonly PlannedHold[];
      productOf: (orderItemId: string) => string;
      createdBy: string;
      now: Date;
    },
  ): Promise<void> {
    await this.repository.insertHolds(
      tx,
      input.holds.map((hold) => ({
        orderId: input.orderId,
        orderItemId: hold.orderItemId,
        productId: input.productOf(hold.orderItemId),
        priceReferenceId: hold.supplyLineId,
        quantity: hold.quantity,
        createdBy: input.createdBy,
        createdAt: input.now,
      })),
    );
  }

  /** The order was released, rejected or cancelled. Returns how many holds ended. */
  endHolds(tx: Tx, orderId: string, now: Date): Promise<number> {
    return this.repository.endHolds(tx, orderId, now);
  }

  /** The manager replaced the plan. */
  voidHolds(tx: Tx, orderId: string, by: string, now: Date): Promise<number> {
    return this.repository.voidHolds(tx, orderId, by, now);
  }

  /**
   * Pieces per order line and supply, oldest delivery first. One supply can hold two lines of the
   * same product; a reader asks "how many from this supply", so they add up.
   */
  async standingSupplies(db: DbClient, orderId: string): Promise<OrderLineSupply[]> {
    const rows = await this.repository.findStandingRows(db, orderId);
    const merged = new Map<string, OrderLineSupply & { deliveredAt: Date }>();
    for (const row of rows) {
      const key = `${row.orderItemId}:${row.deliveryRef}`;
      const seen = merged.get(key);
      if (seen === undefined) merged.set(key, { ...row });
      else seen.quantity = seen.quantity.plus(row.quantity);
    }
    return [...merged.values()]
      .sort(
        (a, b) =>
          a.deliveredAt.getTime() - b.deliveredAt.getTime() ||
          a.deliveryRef.localeCompare(b.deliveryRef),
      )
      .map(({ orderItemId, deliveryRef, quantity }) => ({ orderItemId, deliveryRef, quantity }));
  }

  /** Active holds per product; without `productIds`, of every product. */
  heldByProduct(productIds?: readonly string[]): Promise<Map<string, Prisma.Decimal>> {
    return this.repository.heldByProduct(productIds);
  }

  /** See the repository: per live line, the planner's room. A product with no live line has none. */
  availableByProduct(productIds?: readonly string[]): Promise<Map<string, Prisma.Decimal>> {
    return this.repository.availableByProduct(productIds);
  }

  /**
   * What can still be promised for the products of `stock`. The sheet may already show this order's
   * shipment, so a line can be held above its quantity: that line has no room, not a debt. A product
   * without an aggregate has no entry, as in the input.
   */
  async availableFrom(
    stock: ReadonlyMap<string, Prisma.Decimal>,
  ): Promise<Map<string, Prisma.Decimal>> {
    const available = await this.availableByProduct([...stock.keys()]);
    return new Map(
      [...stock.keys()].map((productId) => [
        productId,
        available.get(productId) ?? new Prisma.Decimal(0),
      ]),
    );
  }
}
