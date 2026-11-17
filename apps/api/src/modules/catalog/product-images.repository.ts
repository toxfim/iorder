import { Injectable } from '@nestjs/common';
import { productCodeKey } from '@iorder/shared';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { Language } from '../../generated/prisma/client.js';

/** One stored photo as the service uses it. */
export interface ProductImageRecord {
  id: string;
  productId: string;
  productCode: string;
  isPrimary: boolean;
  sha256: string;
  width: number;
  height: number;
  sourceUrl: string | null;
  idempotencyKey: string | null;
  uploadedBy: string;
  createdAt: Date;
  removedAt: Date | null;
}

export interface ProductWithImages {
  productCode: string;
  names: { lang: Language; name: string }[];
  images: ProductImageRecord[];
}

const IMAGE_COLUMNS = {
  id: true,
  productId: true,
  isPrimary: true,
  sha256: true,
  width: true,
  height: true,
  sourceUrl: true,
  idempotencyKey: true,
  uploadedBy: true,
  createdAt: true,
  removedAt: true,
  product: { select: { productCode: true } },
} as const;

type ImageRow = Omit<ProductImageRecord, 'productCode'> & { product: { productCode: string } };

function toRecord({ product, ...row }: ImageRow): ProductImageRecord {
  return { ...row, productCode: product.productCode };
}

@Injectable()
export class ProductImagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  /** Case-insensitive, by the generated lowercase key. */
  findProductByCode(code: string): Promise<{ id: string; productCode: string } | null> {
    return this.prisma.product.findUnique({
      where: { productCodeKey: productCodeKey(code) },
      select: { id: true, productCode: true },
    });
  }

  /**
   * Serialises photo changes of one product (who is primary). FOR NO KEY UPDATE does not block
   * rows that only reference the product (their foreign key takes FOR KEY SHARE).
   */
  async lockProduct(tx: Tx, productId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR NO KEY UPDATE`;
  }

  async findById(id: string, db?: DbClient): Promise<ProductImageRecord | null> {
    const row = await (db ?? this.prisma).productImage.findUnique({
      where: { id },
      select: IMAGE_COLUMNS,
    });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(
    uploadedBy: string,
    idempotencyKey: string,
    db?: DbClient,
  ): Promise<ProductImageRecord | null> {
    const row = await (db ?? this.prisma).productImage.findUnique({
      where: { uploadedBy_idempotencyKey: { uploadedBy, idempotencyKey } },
      select: IMAGE_COLUMNS,
    });
    return row ? toRecord(row) : null;
  }

  async findLiveBySha(
    tx: Tx,
    productId: string,
    sha256: string,
  ): Promise<ProductImageRecord | null> {
    const row = await tx.productImage.findFirst({
      where: { productId, sha256, removedAt: null },
      select: IMAGE_COLUMNS,
    });
    return row ? toRecord(row) : null;
  }

  async findLivePrimary(tx: Tx, productId: string): Promise<ProductImageRecord | null> {
    const row = await tx.productImage.findFirst({
      where: { productId, isPrimary: true, removedAt: null },
      select: IMAGE_COLUMNS,
    });
    return row ? toRecord(row) : null;
  }

  async insert(
    tx: Tx,
    data: {
      productId: string;
      isPrimary: boolean;
      sha256: string;
      originalContentType: string;
      width: number;
      height: number;
      byteSize: number;
      sourceUrl: string | null;
      idempotencyKey: string;
      uploadedBy: string;
      now: Date;
    },
  ): Promise<ProductImageRecord> {
    const { now, ...fields } = data;
    const row = await tx.productImage.create({
      data: { ...fields, createdAt: now },
      select: IMAGE_COLUMNS,
    });
    return toRecord(row);
  }

  async setPrimary(tx: Tx, id: string, isPrimary: boolean): Promise<void> {
    await tx.productImage.update({ where: { id }, data: { isPrimary } });
  }

  /** How many live (not removed) photos a product has. */
  countLive(productId: string, db?: DbClient): Promise<number> {
    return (db ?? this.prisma).productImage.count({ where: { productId, removedAt: null } });
  }

  /** The live photos of a product, primary first. */
  async findLive(tx: Tx, productId: string): Promise<ProductImageRecord[]> {
    const rows = await tx.productImage.findMany({
      where: { productId, removedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: IMAGE_COLUMNS,
    });
    return rows.map(toRecord);
  }

  /**
   * Moves one live photo to another product (a merge). The history guard allows exactly this move:
   * onto the product its owner was merged into, with `is_primary` set here as the caller decided.
   */
  async moveToProduct(tx: Tx, id: string, productId: string, isPrimary: boolean): Promise<void> {
    await tx.productImage.update({ where: { id }, data: { productId, isPrimary } });
  }

  async markRemoved(tx: Tx, id: string, removedBy: string, now: Date): Promise<void> {
    await tx.productImage.update({
      where: { id },
      data: { removedAt: now, removedBy, isPrimary: false },
    });
  }

  /** The live primary photo id of each given product that has one (one query for any count). */
  async findPrimaryIds(productIds: readonly string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.prisma.productImage.findMany({
      where: { productId: { in: [...productIds] }, isPrimary: true, removedAt: null },
      select: { id: true, productId: true },
    });
    return new Map(rows.map((row) => [row.productId, row.id]));
  }

  /** One product (active or not, case-insensitive code) with its live photos, primary first. */
  async findProductWithImages(code: string): Promise<ProductWithImages | null> {
    const row = await this.prisma.product.findUnique({
      where: { productCodeKey: productCodeKey(code) },
      select: {
        productCode: true,
        translations: { select: { lang: true, name: true } },
        images: {
          where: { removedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: IMAGE_COLUMNS,
        },
      },
    });
    if (!row) return null;
    return {
      productCode: row.productCode,
      names: row.translations,
      images: row.images.map(toRecord),
    };
  }

  /**
   * One page of ACTIVE products in product-code order, after `afterKey` (the lowercase key of the
   * last product of the previous page), with their live photos.
   */
  async listProducts(input: {
    afterKey: string | null;
    limit: number;
    withoutImages: boolean;
  }): Promise<ProductWithImages[]> {
    const rows = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(input.afterKey === null ? {} : { productCodeKey: { gt: input.afterKey } }),
        ...(input.withoutImages ? { images: { none: { removedAt: null } } } : {}),
      },
      orderBy: { productCodeKey: 'asc' },
      take: input.limit,
      select: {
        productCode: true,
        translations: { select: { lang: true, name: true } },
        images: {
          where: { removedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: IMAGE_COLUMNS,
        },
      },
    });
    return rows.map((row) => ({
      productCode: row.productCode,
      names: row.translations,
      images: row.images.map(toRecord),
    }));
  }
}
