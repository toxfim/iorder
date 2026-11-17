import { Injectable } from '@nestjs/common';
import { lockByName } from '../../../common/database/advisory-lock.js';
import type { DbClient, Tx } from '../../../common/database/db-client.js';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { runInTransaction } from '../../../common/database/transaction.js';
import type { Prisma } from '../../../generated/prisma/client.js';

export interface SupplyGroupRow {
  deliveryRef: string;
  productCount: number;
  totalQuantity: Prisma.Decimal;
  deliveredAt: Date;
}

export interface SupplyPartyRow {
  deliveryRef: string;
  partyNumber: string;
}

const SELECT_PARTY = { deliveryRef: true, partyNumber: true } as const;

@Injectable()
export class SupplyPartyRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  lockNamed(tx: Tx, name: string): Promise<void> {
    return lockByName(tx, name);
  }

  /** Live lines grouped by supply, newest first. Selects quantities and dates, never cost. */
  async listSupplyGroups(search: string | undefined): Promise<SupplyGroupRow[]> {
    const groups = await this.prisma.priceReference.groupBy({
      by: ['deliveryRef'],
      where: {
        removedAt: null,
        ...(search ? { deliveryRef: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      _count: { _all: true },
      _sum: { deliveredQuantity: true },
      _max: { deliveredAt: true },
    });
    return groups.flatMap((group) => {
      const { _sum: sum, _max: max } = group;
      if (sum.deliveredQuantity === null || max.deliveredAt === null) return [];
      return [
        {
          deliveryRef: group.deliveryRef,
          productCount: group._count._all,
          totalQuantity: sum.deliveredQuantity,
          deliveredAt: max.deliveredAt,
        },
      ];
    });
  }

  findLineProducts(refs: readonly string[]): Promise<{ deliveryRef: string; productId: string }[]> {
    if (refs.length === 0) return Promise.resolve([]);
    return this.prisma.priceReference.findMany({
      where: { deliveryRef: { in: [...refs] }, removedAt: null },
      select: { deliveryRef: true, productId: true },
    });
  }

  /** The chosen supplies that still have a live line. */
  async findLiveRefs(tx: Tx, refs: readonly string[]): Promise<Set<string>> {
    const rows = await tx.priceReference.findMany({
      where: { deliveryRef: { in: [...refs] }, removedAt: null },
      distinct: ['deliveryRef'],
      select: { deliveryRef: true },
    });
    return new Set(rows.map((row) => row.deliveryRef));
  }

  findParties(refs: readonly string[], db: DbClient = this.prisma): Promise<SupplyPartyRow[]> {
    if (refs.length === 0) return Promise.resolve([]);
    return db.supplyParty.findMany({
      where: { deliveryRef: { in: [...refs] } },
      select: SELECT_PARTY,
    });
  }

  findMembers(tx: Tx, partyNumber: string): Promise<SupplyPartyRow[]> {
    return tx.supplyParty.findMany({
      where: { partyNumber },
      orderBy: { deliveryRef: 'asc' },
      select: SELECT_PARTY,
    });
  }

  async setParty(
    tx: Tx,
    deliveryRef: string,
    partyNumber: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    const values = { partyNumber, updatedBy: userId, updatedAt: now };
    await tx.supplyParty.upsert({
      where: { deliveryRef },
      create: { deliveryRef, ...values },
      update: values,
    });
  }

  async removeParties(tx: Tx, refs: readonly string[]): Promise<void> {
    await tx.supplyParty.deleteMany({ where: { deliveryRef: { in: [...refs] } } });
  }
}
