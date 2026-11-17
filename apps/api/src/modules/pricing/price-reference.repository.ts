import { Injectable } from '@nestjs/common';
import { lockByName } from '../../common/database/advisory-lock.js';
import type { Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  CostDeliveryData,
  CostDeliverySummaryView,
  CostDeliveryView,
  MegaReportLine,
} from './price-reference.types.js';

const SELECT_DELIVERY = {
  id: true,
  productId: true,
  deliveryRef: true,
  supplier: true,
  purchaseMethod: true,
  category: true,
  deliveredQuantity: true,
  availableQuantity: true,
  costUsd: true,
  usdRateUsed: true,
  costUzs: true,
  deliveredAt: true,
  syncedAt: true,
  removedAt: true,
} as const;

@Injectable()
export class PriceReferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  /** Serializes concurrent syncs and first-time rate writes without locking table rows. */
  lockNamed(tx: Tx, name: string): Promise<void> {
    return lockByName(tx, name);
  }

  /**
   * Newest delivery first. Ties on delivered_at are broken by delivery_ref descending: the
   * order is arbitrary but STABLE, so "latest" never flips between two reads.
   */
  findByProduct(productId: string): Promise<CostDeliveryView[]> {
    // Removed (manager-confirmed) lines are excluded from the default history; they stay in the table.
    return this.prisma.priceReference.findMany({
      where: { productId, removedAt: null },
      orderBy: [{ deliveredAt: 'desc' }, { deliveryRef: 'desc' }],
      select: SELECT_DELIVERY,
    });
  }

  findByProducts(tx: Tx, productIds: readonly string[]): Promise<CostDeliveryView[]> {
    return tx.priceReference.findMany({
      where: { productId: { in: [...productIds] } },
      select: SELECT_DELIVERY,
    });
  }

  /** One INSERT for all rows; returns the new ids so the audit rows can reference them. */
  async createMany(
    tx: Tx,
    rows: readonly (CostDeliveryData & {
      productId: string;
      deliveryRef: string;
      syncedAt: Date;
    })[],
  ): Promise<{ id: string; productId: string; deliveryRef: string }[]> {
    if (rows.length === 0) return [];
    return tx.priceReference.createManyAndReturn({
      data: [...rows],
      select: { id: true, productId: true, deliveryRef: true },
    });
  }

  /** Sum of the available quantity over ALL stored delivery lines of each product. */
  async sumAvailableByProduct(
    tx: Tx,
    productIds: readonly string[],
  ): Promise<{ productId: string; quantity: Prisma.Decimal }[]> {
    if (productIds.length === 0) return [];
    // Removed lines do not count. Every asked product gets an entry (0 when nothing is left), so a
    // product whose last line was removed gets its aggregate rewritten to 0, not left stale.
    const grouped = await tx.priceReference.groupBy({
      by: ['productId'],
      where: { productId: { in: [...productIds] }, removedAt: null },
      _sum: { availableQuantity: true },
    });
    const sums = new Map(grouped.map((g) => [g.productId, g._sum.availableQuantity]));
    return [...new Set(productIds)].map((productId) => ({
      productId,
      quantity: sums.get(productId) ?? new Prisma.Decimal(0),
    }));
  }

  /**
   * The newest `limit` deliveries of EACH product, in ONE statement (window function): no query
   * per product. Newest first (delivered_at, then delivery_ref descending, the same stable rule
   * as findByProduct), grouped by product.
   */
  findRecentByProducts(
    productIds: readonly string[],
    limit: number,
  ): Promise<CostDeliverySummaryView[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    const ids = [...productIds];
    return this.prisma.$queryRaw<CostDeliverySummaryView[]>`
      SELECT product_id AS "productId", delivered_at AS "deliveredAt", delivery_ref AS "deliveryRef",
             supplier, cost_usd AS "costUsd", usd_rate_used AS "usdRateUsed", cost_uzs AS "costUzs"
      FROM (
        SELECT *, row_number() OVER (
                 PARTITION BY product_id ORDER BY delivered_at DESC, delivery_ref DESC
               ) AS rn
        FROM price_reference
        WHERE product_id = ANY(${ids}::uuid[]) AND removed_at IS NULL
      ) ranked
      WHERE rn <= ${limit}
      ORDER BY product_id, rn`;
  }

  /**
   * Every live (not removed) delivery line with only what the mega report shows, oldest first
   * per product (delivered_at, then delivery_ref: the same stable tie rule as findByProduct).
   */
  findAllLiveForReport(): Promise<MegaReportLine[]> {
    return this.prisma.priceReference.findMany({
      where: { removedAt: null },
      orderBy: [{ productId: 'asc' }, { deliveredAt: 'asc' }, { deliveryRef: 'asc' }],
      select: {
        productId: true,
        deliveryRef: true,
        availableQuantity: true,
        costUsd: true,
        usdRateUsed: true,
        costUzs: true,
      },
    });
  }

  /** Number of live (not removed) delivery lines per product that has any. One statement. */
  /**
   * The distinct suppliers of each product's LIVE delivery lines, sorted, in one statement (the
   * staff supplier filter of Qoldiq and Narxlar, owner request 2026-11-13). `productIds` omitted:
   * every product. Products without a live line are absent.
   */
  async findSuppliersByProduct(productIds?: readonly string[]): Promise<Map<string, string[]>> {
    const grouped = await this.prisma.priceReference.groupBy({
      by: ['productId', 'supplier'],
      where: {
        removedAt: null,
        ...(productIds === undefined ? {} : { productId: { in: [...productIds] } }),
      },
      orderBy: [{ productId: 'asc' }, { supplier: 'asc' }],
    });
    const byProduct = new Map<string, string[]>();
    for (const row of grouped) {
      byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row.supplier]);
    }
    return byProduct;
  }

  async countDeliveriesByProduct(): Promise<{ productId: string; count: number }[]> {
    const grouped = await this.prisma.priceReference.groupBy({
      by: ['productId'],
      where: { removedAt: null },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ productId: g.productId, count: g._count._all }));
  }

  /**
   * The category of each product's newest live delivery line (same order as the cost history:
   * delivered_at desc, then delivery_ref desc), in ONE statement. Products without a live line
   * are absent here (the service maps them to null).
   */
  async findLatestCategories(
    tx: Tx,
    productIds: readonly string[],
  ): Promise<{ productId: string; category: string }[]> {
    if (productIds.length === 0) return [];
    const ids = [...productIds];
    return tx.$queryRaw<{ productId: string; category: string }[]>`
      SELECT DISTINCT ON (product_id) product_id AS "productId", category
      FROM price_reference
      WHERE product_id = ANY(${ids}::uuid[]) AND removed_at IS NULL
      ORDER BY product_id, delivered_at DESC, delivery_ref DESC`;
  }

  /** Keys only: no cost columns are selected. */
  findRefsByProducts(
    productIds: readonly string[],
  ): Promise<{ productId: string; deliveryRef: string }[]> {
    return this.prisma.priceReference.findMany({
      // Lines already confirmed as removed are not "stale": they are decided.
      where: { productId: { in: [...productIds] }, removedAt: null },
      select: { productId: true, deliveryRef: true },
    });
  }

  async update(tx: Tx, id: string, data: CostDeliveryData & { syncedAt: Date }): Promise<void> {
    await tx.priceReference.update({ where: { id }, data });
  }
}
