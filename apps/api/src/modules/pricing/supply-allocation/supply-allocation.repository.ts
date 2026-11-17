import { Injectable } from '@nestjs/common';
import { lockByName } from '../../../common/database/advisory-lock.js';
import type { DbClient, Tx } from '../../../common/database/db-client.js';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';

export interface SupplyLineRow {
  id: string;
  productId: string;
  deliveryRef: string;
  deliveredAt: Date;
  availableQuantity: Prisma.Decimal;
  heldQuantity: Prisma.Decimal;
  removedAt: Date | null;
}

export interface ActiveHoldRow {
  orderItemId: string;
  supplyLineId: string;
  quantity: Prisma.Decimal;
}

export interface StandingAllocationRow {
  orderItemId: string;
  quantity: Prisma.Decimal;
  deliveryRef: string;
  deliveredAt: Date;
}

const ACTIVE = { holdEndedAt: null, voidedAt: null } as const;

/** Keys and quantities only: no cost column and no supplier is ever selected here (hard rule 7). */
@Injectable()
export class SupplyAllocationRepository {
  constructor(private readonly prisma: PrismaService) {}

  get db(): DbClient {
    return this.prisma;
  }

  lockNamed(tx: Tx, name: string): Promise<void> {
    return lockByName(tx, name);
  }

  /**
   * Every delivery line of the products (also removed ones: a hold may sit on one), with the holds
   * of the OTHER orders, in one statement.
   */
  findLines(
    db: DbClient,
    productIds: readonly string[],
    excludingOrderId: string,
  ): Promise<SupplyLineRow[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    const ids = [...productIds];
    return db.$queryRaw<SupplyLineRow[]>`
      SELECT pr.id, pr.product_id AS "productId", pr.delivery_ref AS "deliveryRef",
             pr.delivered_at AS "deliveredAt", pr.available_quantity AS "availableQuantity",
             pr.removed_at AS "removedAt", COALESCE(h.held, 0) AS "heldQuantity"
      FROM price_reference pr
      LEFT JOIN (
        SELECT price_reference_id, SUM(quantity) AS held
        FROM order_allocations
        WHERE hold_ended_at IS NULL AND voided_at IS NULL AND order_id <> ${excludingOrderId}::uuid
        GROUP BY price_reference_id
      ) h ON h.price_reference_id = pr.id
      WHERE pr.product_id = ANY(${ids}::uuid[])`;
  }

  async findActiveHolds(db: DbClient, orderId: string): Promise<ActiveHoldRow[]> {
    const rows = await db.orderAllocation.findMany({
      where: { orderId, ...ACTIVE },
      select: { orderItemId: true, priceReferenceId: true, quantity: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      orderItemId: row.orderItemId,
      supplyLineId: row.priceReferenceId,
      quantity: row.quantity,
    }));
  }

  /**
   * The plan of an order that stands, also after its hold ended: the record of where the goods left
   * from. Replaced plans (voided) do not count. Selects the delivery's ref and date, nothing else of
   * the cost table.
   */
  async findStandingRows(db: DbClient, orderId: string): Promise<StandingAllocationRow[]> {
    const rows = await db.orderAllocation.findMany({
      where: { orderId, voidedAt: null },
      select: {
        orderItemId: true,
        quantity: true,
        priceReference: { select: { deliveryRef: true, deliveredAt: true } },
      },
    });
    return rows.map((row) => ({
      orderItemId: row.orderItemId,
      quantity: row.quantity,
      deliveryRef: row.priceReference.deliveryRef,
      deliveredAt: row.priceReference.deliveredAt,
    }));
  }

  async hasAnyAllocation(db: DbClient, orderId: string): Promise<boolean> {
    return (await db.orderAllocation.count({ where: { orderId } })) > 0;
  }

  async insertHolds(
    tx: Tx,
    rows: readonly {
      orderId: string;
      orderItemId: string;
      productId: string;
      priceReferenceId: string;
      quantity: Prisma.Decimal;
      createdBy: string;
      createdAt: Date;
    }[],
  ): Promise<void> {
    if (rows.length > 0) await tx.orderAllocation.createMany({ data: [...rows] });
  }

  async endHolds(tx: Tx, orderId: string, now: Date): Promise<number> {
    const { count } = await tx.orderAllocation.updateMany({
      where: { orderId, ...ACTIVE },
      data: { holdEndedAt: now },
    });
    return count;
  }

  async voidHolds(tx: Tx, orderId: string, by: string, now: Date): Promise<number> {
    const { count } = await tx.orderAllocation.updateMany({
      where: { orderId, ...ACTIVE },
      data: { voidedAt: now, voidedBy: by },
    });
    return count;
  }

  /** Active holds per product; a product without any has no entry. */
  async heldByProduct(productIds?: readonly string[]): Promise<Map<string, Prisma.Decimal>> {
    const grouped = await this.prisma.orderAllocation.groupBy({
      by: ['productId'],
      where: {
        ...ACTIVE,
        ...(productIds === undefined ? {} : { productId: { in: [...productIds] } }),
      },
      _sum: { quantity: true },
    });
    return new Map(grouped.map((g) => [g.productId, g._sum.quantity ?? new Prisma.Decimal(0)]));
  }

  /**
   * What can still be promised, per product: each live line's room after its own holds, never below
   * zero, added up. The same room as `freeOf` in the planner, so a hold above one line (or on a
   * removed line) does not eat the room of another. A product with no live line has no entry.
   */
  async availableByProduct(productIds?: readonly string[]): Promise<Map<string, Prisma.Decimal>> {
    const onlyProducts =
      productIds === undefined
        ? Prisma.empty
        : Prisma.sql`AND pr.product_id = ANY(${[...productIds]}::uuid[])`;
    const rows = await this.prisma.$queryRaw<{ productId: string; available: Prisma.Decimal }[]>`
      SELECT pr.product_id AS "productId",
             SUM(GREATEST(pr.available_quantity - COALESCE(h.held, 0), 0)) AS "available"
      FROM price_reference pr
      LEFT JOIN (
        SELECT price_reference_id, SUM(quantity) AS held
        FROM order_allocations
        WHERE hold_ended_at IS NULL AND voided_at IS NULL
        GROUP BY price_reference_id
      ) h ON h.price_reference_id = pr.id
      WHERE pr.removed_at IS NULL ${onlyProducts}
      GROUP BY pr.product_id`;
    return new Map(rows.map((row) => [row.productId, new Prisma.Decimal(row.available)]));
  }

  /** The newest time a sync wrote a delivery line. Unchanged lines are not rewritten. */
  async lastSheetChange(db: DbClient): Promise<Date | null> {
    const { _max } = await db.priceReference.aggregate({ _max: { syncedAt: true } });
    return _max.syncedAt;
  }
}
