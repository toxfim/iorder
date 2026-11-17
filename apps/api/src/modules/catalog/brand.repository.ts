import { Injectable } from '@nestjs/common';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { BrandView, ProductView } from './product.view.js';

const BRAND_FIELDS = { id: true, name: true } as const;

@Injectable()
export class BrandRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  /** Sorted by the case-insensitive key, so the order is the same on every machine. */
  listBrands(db?: DbClient): Promise<BrandView[]> {
    return (db ?? this.prisma).brand.findMany({
      select: BRAND_FIELDS,
      orderBy: { nameKey: 'asc' },
    });
  }

  findBrandById(id: string, db?: DbClient): Promise<BrandView | null> {
    return (db ?? this.prisma).brand.findUnique({ where: { id }, select: BRAND_FIELDS });
  }

  /** Every brand keyed by its case-insensitive name key (the generated `name_key` column). */
  async listBrandsByNameKey(db?: DbClient): Promise<Map<string, BrandView>> {
    const rows = await (db ?? this.prisma).brand.findMany({
      select: { ...BRAND_FIELDS, nameKey: true },
    });
    return new Map(rows.map(({ nameKey, ...brand }) => [nameKey, brand]));
  }

  /** Case-insensitive: compares the generated key, like the unique index does. */
  async existsByName(name: string): Promise<boolean> {
    const row = await this.prisma.brand.findUnique({
      where: { nameKey: name.trim().toLowerCase() },
      select: { id: true },
    });
    return row !== null;
  }

  createBrand(
    tx: Tx,
    data: { name: string; createdByUserId: string; now: Date },
  ): Promise<BrandView> {
    return tx.brand.create({
      data: { name: data.name, createdByUserId: data.createdByUserId, createdAt: data.now },
      select: BRAND_FIELDS,
    });
  }

  /** The staff-chosen brand id per product (null when none is chosen). */
  async findBrandIds(
    productIds: readonly string[],
    db?: DbClient,
  ): Promise<Map<string, string | null>> {
    if (productIds.length === 0) return new Map();
    const rows = await (db ?? this.prisma).product.findMany({
      where: { id: { in: [...productIds] } },
      select: { id: true, brandId: true },
    });
    return new Map(rows.map((row) => [row.id, row.brandId]));
  }

  /** Active products without a staff-chosen brand (the finder decides about them). */
  listActiveWithoutChosenBrand(): Promise<ProductView[]> {
    return this.prisma.product.findMany({
      where: { isActive: true, brandId: null },
      include: { translations: { orderBy: { lang: 'asc' } } },
      orderBy: { productCode: 'asc' },
    });
  }

  /** Row lock so the "before" brand written to the audit log is the one really replaced. */
  async lockProduct(tx: Tx, productId: string): Promise<string | null | undefined> {
    const rows = await tx.$queryRaw<{ brand_id: string | null }[]>`
      SELECT brand_id FROM products WHERE id = ${productId}::uuid FOR NO KEY UPDATE`;
    return rows[0] === undefined ? undefined : rows[0].brand_id;
  }

  async setProductBrand(tx: Tx, productId: string, brandId: string, now: Date): Promise<void> {
    await tx.product.update({ where: { id: productId }, data: { brandId, updatedAt: now } });
  }
}
