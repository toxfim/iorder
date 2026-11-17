import { Injectable } from '@nestjs/common';
import { lockByName } from '../../../common/database/advisory-lock.js';
import type { Tx } from '../../../common/database/db-client.js';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { runInTransaction } from '../../../common/database/transaction.js';
import type { Prisma } from '../../../generated/prisma/client.js';

export interface RemovalRequestRow {
  id: string;
  productId: string;
  deliveryRef: string;
  status: 'PENDING' | 'CONFIRMED' | 'DISMISSED';
  detectedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

export interface RemovalLineRow {
  id: string;
  productId: string;
  deliveryRef: string;
  deliveredAt: Date;
  supplier: string;
  deliveredQuantity: Prisma.Decimal;
  availableQuantity: Prisma.Decimal;
  /** Null together while the line's cost is pending (see price-reference.types). */
  costUsd: Prisma.Decimal | null;
  usdRateUsed: Prisma.Decimal | null;
  costUzs: Prisma.Decimal | null;
}

const SELECT_REQUEST = {
  id: true,
  productId: true,
  deliveryRef: true,
  status: true,
  detectedAt: true,
  decidedBy: true,
  decidedAt: true,
} as const;

@Injectable()
export class SupplyRemovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  lockNamed(tx: Tx, name: string): Promise<void> {
    return lockByName(tx, name);
  }

  pendingCount(): Promise<number> {
    return this.prisma.supplyRemovalRequest.count({ where: { status: 'PENDING' } });
  }

  listPending(): Promise<RemovalRequestRow[]> {
    return this.prisma.supplyRemovalRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: [{ detectedAt: 'asc' }, { deliveryRef: 'asc' }],
      select: SELECT_REQUEST,
    });
  }

  /** The delivery lines the requests point at, in one query. */
  findLines(
    keys: readonly { productId: string; deliveryRef: string }[],
  ): Promise<RemovalLineRow[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.prisma.priceReference.findMany({
      where: { OR: keys.map((k) => ({ productId: k.productId, deliveryRef: k.deliveryRef })) },
      select: {
        id: true,
        productId: true,
        deliveryRef: true,
        deliveredAt: true,
        supplier: true,
        deliveredQuantity: true,
        availableQuantity: true,
        costUsd: true,
        usdRateUsed: true,
        costUzs: true,
      },
    });
  }

  /** PENDING requests among the given lines (the unique partial index allows at most one each). */
  findPendingFor(tx: Tx, productIds: readonly string[]): Promise<RemovalRequestRow[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    return tx.supplyRemovalRequest.findMany({
      where: { status: 'PENDING', productId: { in: [...productIds] } },
      select: SELECT_REQUEST,
    });
  }

  /** Row lock on one request, so two decisions cannot both win. */
  async lockById(tx: Tx, id: string): Promise<RemovalRequestRow | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM supply_removal_requests WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) return null;
    return tx.supplyRemovalRequest.findUnique({ where: { id }, select: SELECT_REQUEST });
  }

  async createMany(
    tx: Tx,
    rows: readonly { productId: string; deliveryRef: string; detectedAt: Date }[],
  ): Promise<{ id: string; productId: string; deliveryRef: string }[]> {
    if (rows.length === 0) return [];
    return tx.supplyRemovalRequest.createManyAndReturn({
      data: [...rows],
      select: { id: true, productId: true, deliveryRef: true },
    });
  }

  /**
   * Decides a request only while it is still PENDING; returns false when it no longer is (a
   * person decided first). Never overwrites a decision.
   */
  async decideIfPending(
    tx: Tx,
    id: string,
    decision: { status: 'CONFIRMED' | 'DISMISSED'; decidedBy: string | null; decidedAt: Date },
  ): Promise<boolean> {
    const { count } = await tx.supplyRemovalRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: decision,
    });
    return count === 1;
  }

  async decide(
    tx: Tx,
    id: string,
    decision: { status: 'CONFIRMED' | 'DISMISSED'; decidedBy: string | null; decidedAt: Date },
  ): Promise<void> {
    await tx.supplyRemovalRequest.update({ where: { id }, data: decision });
  }

  /** Soft-removes a line. Returns its id, or null when no such (not yet removed) line exists. */
  async markLineRemoved(
    tx: Tx,
    productId: string,
    deliveryRef: string,
    removedBy: string,
    removedAt: Date,
  ): Promise<string | null> {
    const line = await tx.priceReference.findFirst({
      where: { productId, deliveryRef, removedAt: null },
      select: { id: true },
    });
    if (!line) return null;
    await tx.priceReference.update({ where: { id: line.id }, data: { removedAt, removedBy } });
    return line.id;
  }
}
