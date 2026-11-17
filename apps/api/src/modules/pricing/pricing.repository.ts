import type { UsdRateSource } from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ItemPrices, ItemView, VersionSummaryView, VersionView } from './pricing.types.js';
import type { PriceAtVersion } from './price-history.js';
import type { VersionStatus } from './version-status.js';

@Injectable()
export class PricingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs `work` in one database transaction; the caller passes `tx` on to every write. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  createVersion(tx: Tx, note: string | null): Promise<VersionView> {
    return tx.priceListVersion.create({ data: { note, source: 'MANUAL' } });
  }

  /**
   * Row lock on the version. Edits and publish both take it first, so they are serialized
   * and the "before" values in audit rows are the ones really replaced.
   */
  async lockStatus(tx: Tx, id: string): Promise<VersionStatus | null> {
    const rows = await tx.$queryRaw<{ status: VersionStatus }[]>`
      SELECT status::text AS status FROM price_list_versions WHERE id = ${id}::uuid FOR UPDATE`;
    return rows[0]?.status ?? null;
  }

  findVersion(id: string, tx?: DbClient): Promise<VersionView | null> {
    return (tx ?? this.prisma).priceListVersion.findUnique({ where: { id } });
  }

  findPublished(tx?: DbClient): Promise<VersionView | null> {
    return (tx ?? this.prisma).priceListVersion.findFirst({ where: { status: 'PUBLISHED' } });
  }

  findOpenDraft(tx?: DbClient): Promise<VersionView | null> {
    return (tx ?? this.prisma).priceListVersion.findFirst({ where: { status: 'DRAFT' } });
  }

  /** The rate snapshot is written in the publish transaction, while the version is still a DRAFT. */
  async insertRateSnapshot(
    tx: Tx,
    versionId: string,
    snapshot: { rate: Prisma.Decimal; source: UsdRateSource; rateDate: string | null },
  ): Promise<void> {
    await tx.priceListVersionRate.create({
      data: {
        versionId,
        usdRate: snapshot.rate,
        source: snapshot.source,
        rateDate: snapshot.rateDate === null ? null : new Date(`${snapshot.rateDate}T00:00:00Z`),
      },
    });
  }

  /** Snapshots of the given versions in ONE query; versions without one are absent. */
  async findRateSnapshots(
    versionIds: readonly string[],
  ): Promise<
    Map<string, { rate: Prisma.Decimal; source: UsdRateSource; rateDate: string | null }>
  > {
    if (versionIds.length === 0) return new Map();
    const rows = await this.prisma.priceListVersionRate.findMany({
      where: { versionId: { in: [...versionIds] } },
    });
    return new Map(
      rows.map((r) => [
        r.versionId,
        {
          rate: r.usdRate,
          source: r.source as UsdRateSource,
          rateDate: r.rateDate ? r.rateDate.toISOString().slice(0, 10) : null,
        },
      ]),
    );
  }

  countDrafts(tx: Tx): Promise<number> {
    return tx.priceListVersion.count({ where: { status: 'DRAFT' } });
  }

  async listVersions(): Promise<VersionSummaryView[]> {
    const rows = await this.prisma.priceListVersion.findMany({
      orderBy: { number: 'desc' },
      include: { _count: { select: { items: true } } },
    });
    return rows.map(({ _count, ...version }) => ({ ...version, itemCount: _count.items }));
  }

  async listNonDraftVersions(): Promise<VersionView[]> {
    return this.prisma.priceListVersion.findMany({
      where: { status: { in: ['PUBLISHED', 'ARCHIVED'] } },
    });
  }

  listItems(versionId: string, tx?: DbClient): Promise<ItemView[]> {
    return (tx ?? this.prisma).priceListItem.findMany({
      where: { versionId },
      select: {
        productId: true,
        basePrice: true,
        deferredPrice: true,
        rrp: true,
        wholesalePrice: true,
        wholesaleDeferredPrice: true,
        alifPrice: true,
        alifDeferredPrice: true,
        currency: true,
      },
    });
  }

  /**
   * Product ids priced in the PUBLISHED version and in the open DRAFT, in ONE statement. Both sets
   * are empty when the version does not exist.
   */
  async findPricedProductIds(): Promise<{ published: string[]; draft: string[] }> {
    const rows = await this.prisma.$queryRaw<{ productId: string; status: string }[]>`
      SELECT i.product_id AS "productId", v.status::text AS status
      FROM price_list_items i JOIN price_list_versions v ON v.id = i.version_id
      WHERE v.status::text IN ('PUBLISHED', 'DRAFT')`;
    return {
      published: rows.filter((r) => r.status === 'PUBLISHED').map((r) => r.productId),
      draft: rows.filter((r) => r.status === 'DRAFT').map((r) => r.productId),
    };
  }

  async findItemPricesByVersion(productId: string): Promise<Map<string, PriceAtVersion>> {
    const rows = await this.prisma.priceListItem.findMany({
      where: { productId, version: { status: { in: ['PUBLISHED', 'ARCHIVED'] } } },
      select: {
        versionId: true,
        basePrice: true,
        deferredPrice: true,
        rrp: true,
        currency: true,
      },
    });
    return new Map(
      rows.map((r) => [
        r.versionId,
        {
          basePrice: r.basePrice,
          deferredPrice: r.deferredPrice,
          rrp: r.rrp,
          currency: r.currency,
        },
      ]),
    );
  }

  async createItems(
    tx: Tx,
    versionId: string,
    items: readonly ({ productId: string; currency: string } & ItemPrices)[],
  ): Promise<void> {
    if (items.length === 0) return;
    await tx.priceListItem.createMany({
      data: items.map((item) => ({ versionId, ...item })),
    });
  }

  /** One statement for all rows; prices travel as decimal text, never as floats. */
  async updateItemPrices(
    tx: Tx,
    versionId: string,
    items: readonly ({ productId: string; currency: string } & ItemPrices)[],
  ): Promise<void> {
    if (items.length === 0) return;
    const productIds = items.map((i) => i.productId);
    const prices = items.map((i) => i.basePrice.toFixed(2));
    const deferredPrices = items.map((i) => i.deferredPrice?.toFixed(2) ?? null);
    const rrps = items.map((i) => i.rrp?.toFixed(2) ?? null);
    const wholesalePrices = items.map((i) => i.wholesalePrice?.toFixed(2) ?? null);
    const wholesaleDeferred = items.map((i) => i.wholesaleDeferredPrice?.toFixed(2) ?? null);
    const alifPrices = items.map((i) => i.alifPrice?.toFixed(2) ?? null);
    const alifDeferred = items.map((i) => i.alifDeferredPrice?.toFixed(2) ?? null);
    const currencies = items.map((i) => i.currency);
    await tx.$executeRaw`
      UPDATE price_list_items AS i
      SET base_price = v.price, deferred_price = v.deferred_price, rrp = v.rrp,
          wholesale_price = v.wholesale_price,
          wholesale_deferred_price = v.wholesale_deferred_price,
          alif_price = v.alif_price, alif_deferred_price = v.alif_deferred_price,
          currency = v.currency
      FROM unnest(
        ${productIds}::uuid[], ${prices}::numeric[], ${deferredPrices}::numeric[],
        ${rrps}::numeric[], ${wholesalePrices}::numeric[], ${wholesaleDeferred}::numeric[],
        ${alifPrices}::numeric[], ${alifDeferred}::numeric[], ${currencies}::text[]
      ) AS v(product_id, price, deferred_price, rrp, wholesale_price, wholesale_deferred_price,
             alif_price, alif_deferred_price, currency)
      WHERE i.version_id = ${versionId}::uuid AND i.product_id = v.product_id`;
  }

  async deleteItem(tx: Tx, versionId: string, productId: string): Promise<boolean> {
    const result = await tx.priceListItem.deleteMany({ where: { versionId, productId } });
    return result.count > 0;
  }

  async updateNote(tx: Tx, id: string, note: string | null): Promise<void> {
    await tx.priceListVersion.update({ where: { id }, data: { note } });
  }

  async deleteDraft(tx: Tx, id: string): Promise<void> {
    await tx.priceListVersion.delete({ where: { id } });
  }

  async archive(tx: Tx, id: string): Promise<void> {
    await tx.priceListVersion.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  async publish(tx: Tx, id: string, publishedAt: Date, publishedBy: string): Promise<void> {
    await tx.priceListVersion.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt, publishedBy },
    });
  }
}
