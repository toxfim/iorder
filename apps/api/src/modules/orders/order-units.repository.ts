import { Injectable } from '@nestjs/common';
import type { UnitCodeKind } from '@iorder/shared/staff-orders';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';

export interface UnitCodeRecord {
  id: string;
  unitId: string;
  kind: UnitCodeKind;
  slot: number;
  codeValue: string;
  recordedAt: Date;
}

export interface OrderUnitRecord {
  id: string;
  orderItemId: string;
  productId: string;
  unitNo: number;
  /** Live (not voided) codes only. */
  codes: UnitCodeRecord[];
}

export type OrderClosedVoidReason = 'ORDER_CANCELLED' | 'ORDER_REJECTED';
export type CodeVoidReason = 'REPLACED' | 'CLEARED' | OrderClosedVoidReason;

/** Data access for order_units and unit_codes. Never leaves the orders module. */
@Injectable()
export class OrderUnitsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One row per piece of every line, unit numbers 1..quantity. Idempotent per (item, unitNo). */
  async insertUnits(
    tx: Tx,
    orderId: string,
    lines: readonly { orderItemId: string; productId: string; pieces: number }[],
    now: Date,
  ): Promise<void> {
    const data = lines.flatMap((line) =>
      Array.from({ length: line.pieces }, (_, index) => ({
        orderId,
        orderItemId: line.orderItemId,
        productId: line.productId,
        unitNo: index + 1,
        createdAt: now,
      })),
    );
    if (data.length > 0) await tx.orderUnit.createMany({ data, skipDuplicates: true });
  }

  async findUnits(orderId: string, db: DbClient = this.prisma): Promise<OrderUnitRecord[]> {
    const rows = await db.orderUnit.findMany({
      where: { orderId },
      orderBy: [{ orderItemId: 'asc' }, { unitNo: 'asc' }],
      select: {
        id: true,
        orderItemId: true,
        productId: true,
        unitNo: true,
        codes: {
          where: { voidedAt: null },
          orderBy: [{ kind: 'asc' }, { slot: 'asc' }],
          select: {
            id: true,
            unitId: true,
            kind: true,
            slot: true,
            codeValue: true,
            recordedAt: true,
          },
        },
      },
    });
    return rows;
  }

  async findUnit(
    tx: Tx,
    orderId: string,
    unitId: string,
  ): Promise<{ id: string; productId: string; orderItemId: string; unitNo: number } | null> {
    return tx.orderUnit.findFirst({
      where: { id: unitId, orderId },
      select: { id: true, productId: true, orderItemId: true, unitNo: true },
    });
  }

  async findLiveCode(
    tx: Tx,
    unitId: string,
    kind: UnitCodeKind,
    slot: number,
  ): Promise<UnitCodeRecord | null> {
    return tx.unitCode.findFirst({
      where: { unitId, kind, slot, voidedAt: null },
      select: { id: true, unitId: true, kind: true, slot: true, codeValue: true, recordedAt: true },
    });
  }

  /**
   * The live code that already holds this key, in the scope the unique indexes use: IMEI and
   * marking across everything, a serial within the product. Returns its unit and order number.
   */
  async findLiveHolder(
    tx: Tx,
    kind: UnitCodeKind,
    codeKey: string,
    productId: string,
  ): Promise<{ unitId: string; slot: number; orderNumber: string } | null> {
    const row = await tx.unitCode.findFirst({
      where: {
        kind,
        codeKey,
        voidedAt: null,
        ...(kind === 'SERIAL' ? { productId } : {}),
      },
      select: { unitId: true, slot: true, order: { select: { orderNumber: true } } },
    });
    return row === null
      ? null
      : { unitId: row.unitId, slot: row.slot, orderNumber: row.order.orderNumber };
  }

  async insertCode(
    tx: Tx,
    data: {
      unitId: string;
      orderId: string;
      productId: string;
      kind: UnitCodeKind;
      slot: number;
      codeValue: string;
      codeKey: string;
      recordedBy: string;
      recordedAt: Date;
    },
  ): Promise<void> {
    await tx.unitCode.create({ data, select: { id: true } });
  }

  async voidCode(
    tx: Tx,
    codeId: string,
    voidedBy: string,
    reason: CodeVoidReason,
    now: Date,
  ): Promise<void> {
    await tx.unitCode.update({
      where: { id: codeId },
      data: { voidedAt: now, voidedBy, voidReason: reason },
      select: { id: true },
    });
  }

  /** Voids every live code of an order (a closed order frees its codes); returns how many. */
  async voidLiveCodesOfOrder(
    tx: Tx,
    orderId: string,
    voidedBy: string,
    reason: OrderClosedVoidReason,
    now: Date,
  ): Promise<number> {
    const result = await tx.unitCode.updateMany({
      where: { orderId, voidedAt: null },
      data: { voidedAt: now, voidedBy, voidReason: reason },
    });
    return result.count;
  }
}
