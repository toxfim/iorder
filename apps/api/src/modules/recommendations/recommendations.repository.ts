import { Injectable } from '@nestjs/common';
import type { ProductSuccessionStatus } from '@iorder/shared/staff-cost';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import { Prisma } from '../../generated/prisma/client.js';

/** What ONE organization bought of a product, over its RECEIVED orders. */
export interface PurchaseStats {
  productId: string;
  /** The staff-only sheet category of the product; used only to find matching products, never sent. */
  category: string | null;
  /** When the last order holding the product was received. */
  lastReceivedAt: Date;
  /** The quantity of that last order's line. */
  lastQuantity: Prisma.Decimal;
  /** How many received orders held the product. */
  timesOrdered: number;
}

export interface SuccessionRow {
  id: string;
  olderProductId: string;
  newerProductId: string;
  status: ProductSuccessionStatus;
  proposedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

@Injectable()
export class RecommendationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  // ---- the customer's purchases (hard rule 6: the organization is part of the query) ----------

  /** One row per product the organization received, in one set-based query. */
  async purchaseStats(organizationId: string): Promise<PurchaseStats[]> {
    const rows = await this.prisma.$queryRaw<
      {
        product_id: string;
        category: string | null;
        last_received_at: Date;
        last_quantity: Prisma.Decimal;
        times_ordered: bigint;
      }[]
    >`
      WITH lines AS (
        SELECT i.product_id, i.quantity, o.id AS order_id,
          -- Orders received before the column existed carry no received_at: their last change is it.
          COALESCE(o.received_at, o.updated_at) AS received_at
        FROM order_items i
        JOIN orders o ON o.id = i.order_id
        WHERE o.organization_id = ${organizationId}::uuid AND o.status = 'RECEIVED'
      ),
      latest AS (
        SELECT DISTINCT ON (product_id) product_id, received_at, quantity
        FROM lines
        ORDER BY product_id, received_at DESC, order_id DESC
      )
      SELECT l.product_id, p.category, l.received_at AS last_received_at,
        l.quantity AS last_quantity,
        (SELECT count(DISTINCT order_id) FROM lines WHERE lines.product_id = l.product_id) AS times_ordered
      FROM latest l
      JOIN products p ON p.id = l.product_id`;
    return rows.map((row) => ({
      productId: row.product_id,
      category: row.category,
      lastReceivedAt: row.last_received_at,
      lastQuantity: row.last_quantity,
      timesOrdered: Number(row.times_ordered),
    }));
  }

  /** CONFIRMED pairs whose older product is one of the given ones. Nothing for an empty list. */
  async confirmedSuccessionsOf(olderProductIds: readonly string[]): Promise<SuccessionRow[]> {
    if (olderProductIds.length === 0) return [];
    return this.prisma.productSuccession.findMany({
      where: { status: 'CONFIRMED', olderProductId: { in: [...olderProductIds] } },
      orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
    });
  }

  // ---- the staff review list ---------------------------------------------------------------

  async listSuccessions(status: ProductSuccessionStatus): Promise<SuccessionRow[]> {
    return this.prisma.productSuccession.findMany({
      where: { status },
      orderBy: [{ proposedAt: 'desc' }, { id: 'desc' }],
    });
  }

  async countByStatus(): Promise<Record<ProductSuccessionStatus, number>> {
    const groups = await this.prisma.productSuccession.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts: Record<ProductSuccessionStatus, number> = {
      PROPOSED: 0,
      CONFIRMED: 0,
      REJECTED: 0,
    };
    for (const group of groups) counts[group.status] = group._count._all;
    return counts;
  }

  async findSuccession(id: string, db: DbClient = this.prisma): Promise<SuccessionRow | null> {
    return db.productSuccession.findUnique({ where: { id } });
  }

  /** Every pair in any status, as "older|newer" keys: the generator never proposes one twice. */
  async existingPairKeys(): Promise<Set<string>> {
    const rows = await this.prisma.productSuccession.findMany({
      select: { olderProductId: true, newerProductId: true },
    });
    return new Set(rows.map((row) => `${row.olderProductId}|${row.newerProductId}`));
  }

  /** Products that appear in a RECEIVED order of ANY organization (staff-side, for the generator). */
  async boughtProductIds(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ product_id: string }[]>`
      SELECT DISTINCT i.product_id FROM order_items i
      JOIN orders o ON o.id = i.order_id
      WHERE o.status = 'RECEIVED'`;
    return new Set(rows.map((row) => row.product_id));
  }

  /** Inserts the proposals; a pair that exists meanwhile is skipped (the unique index). */
  async insertProposals(
    tx: Tx,
    proposals: readonly { olderProductId: string; newerProductId: string }[],
    proposedAt: Date,
  ): Promise<number> {
    if (proposals.length === 0) return 0;
    const result = await tx.productSuccession.createMany({
      data: proposals.map((pair) => ({ ...pair, status: 'PROPOSED', proposedAt })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async decide(
    tx: Tx,
    id: string,
    decision: { status: 'CONFIRMED' | 'REJECTED'; decidedBy: string; decidedAt: Date },
  ): Promise<SuccessionRow> {
    return tx.productSuccession.update({ where: { id }, data: decision });
  }
}
