import { Injectable } from '@nestjs/common';
import { commonProductName, productCodeKey } from '@iorder/shared';
import {
  PRICE_IMPORT_MAX_BYTES,
  type PriceImportPreviewRow,
  type PriceImportTemplateKind,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../../common/auth/actor.js';
import { businessDayOf } from '../../../common/clock/business-time.js';
import { Clock } from '../../../common/clock/clock.js';
import type { DbClient, Tx } from '../../../common/database/db-client.js';
import { UnprocessableError } from '../../../common/errors/domain-errors.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { BrandService, CatalogService, type ProductView } from '../../catalog/index.js';
import { PricingService, type ItemView, type VersionView } from '../../pricing/index.js';
import {
  judgeRows,
  summarize,
  type ImportContext,
  type ImportProductFact,
  type ImportRowInput,
  type JudgedRow,
} from './price-import-rows.js';
import {
  buildTemplateWorkbook,
  readImportWorkbook,
  type TemplateRow,
} from './price-import-workbook.js';

export interface ImportTemplate {
  /**
   * `iorder-import-template-YYYY-MM-DD.xlsx` (`-empty-` before the date for the header-only
   * file), the date being today in Asia/Tashkent.
   */
  fileName: string;
  data: Uint8Array;
}

export interface ImportPreview {
  baseVersionNumber: number | null;
  rows: PriceImportPreviewRow[];
  summary: ReturnType<typeof summarize>;
}

/** One confirmed row (the request after validation). */
export interface ConfirmRow {
  productCode: string | null;
  name: string;
  brandName: string | null;
  category: string | null;
  basePrice: string;
  deferredPrice: string | null;
  rrp: string | null;
  /** Omitted (undefined) = keep the product's current wholesale prices. */
  wholesalePrice?: string | null | undefined;
  wholesaleDeferredPrice?: string | null | undefined;
  /** Omitted (undefined) = keep the product's current Alif factoring prices. */
  alifPrice?: string | null | undefined;
  alifDeferredPrice?: string | null | undefined;
}

export interface ImportConfirmation {
  version: VersionView;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
}

/**
 * The Excel price list import [C, 2026-11-09]: template -> preview -> confirm. The preview writes
 * nothing. The confirm re-runs the same row rules against locked data, creates the code-less rows
 * as generated-code products (with the row's brand and category), renames generated-code products
 * whose name differs, and publishes the current list + every row's prices (sale, deferred, RRP) as
 * the next version, all in ONE transaction. A sheet product is never renamed and never created by
 * an import (its name cell is ignored; an unknown code is a row error), and no existing product's
 * brand or category changes. Permission: UPDATE_PRICE_LIST, like the publish.
 */
@Injectable()
export class PriceImportService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly brands: BrandService,
    private readonly pricing: PricingService,
    private readonly clock: Clock,
  ) {}

  /**
   * The template [C, design 2026-11-09]: `filled` with the generated-code products of the
   * published list, by name; `empty` with the header row only (the same layout).
   */
  async template(actor: Actor, kind: PriceImportTemplateKind): Promise<ImportTemplate> {
    this.pricing.assertMayManagePriceList(actor);
    const rows = kind === 'empty' ? [] : await this.templateRows();
    const suffix = kind === 'empty' ? '-empty' : '';
    return {
      fileName: `iorder-import-template${suffix}-${businessDayOf(this.clock.now()).date}.xlsx`,
      data: await buildTemplateWorkbook(rows),
    };
  }

  private async templateRows(): Promise<TemplateRow[]> {
    const published = await this.pricing.currentPublishedItems();
    const rows: TemplateRow[] = [];
    if (published !== null) {
      const generated = (await this.catalog.findActiveGeneratedProducts()).filter((p) =>
        published.items.some((item) => item.productId === p.id),
      );
      const brandOf = await this.brands.resolveBrands(generated);
      const priceOf = new Map(published.items.map((item) => [item.productId, item]));
      for (const product of generated) {
        const item = priceOf.get(product.id);
        if (item === undefined) continue;
        rows.push({
          productCode: product.productCode,
          name: commonProductName(product.translations, product.productCode),
          brandName: brandOf.get(product.id)?.name ?? null,
          category: product.category,
          basePrice: item.basePrice.toFixed(2),
          deferredPrice: item.deferredPrice?.toFixed(2) ?? null,
          rrp: item.rrp?.toFixed(2) ?? null,
          wholesalePrice: item.wholesalePrice?.toFixed(2) ?? null,
          wholesaleDeferredPrice: item.wholesaleDeferredPrice?.toFixed(2) ?? null,
          alifPrice: item.alifPrice?.toFixed(2) ?? null,
          alifDeferredPrice: item.alifDeferredPrice?.toFixed(2) ?? null,
        });
      }
      rows.sort((a, b) => compareText(a.name, b.name) || compareText(a.productCode, b.productCode));
    }
    return rows;
  }

  /** Reads and judges an uploaded file. Nothing is written. */
  async preview(actor: Actor, file: Buffer): Promise<ImportPreview> {
    this.pricing.assertMayManagePriceList(actor);
    if (file.byteLength > PRICE_IMPORT_MAX_BYTES) {
      throw new UnprocessableError('PRICE_IMPORT_FILE_INVALID', 'The file is too large', {
        reason: 'FILE_TOO_LARGE',
      });
    }
    const rows = await readImportWorkbook(file);
    const published = await this.pricing.currentPublishedItems();
    const judged = judgeRows(rows, await this.contextFor(rows, published?.items ?? []));
    const previews = judged.map((row) => row.preview);
    return {
      baseVersionNumber: published?.version.number ?? null,
      rows: previews,
      summary: summarize(previews),
    };
  }

  /** The confirm: one transaction, nothing written when any row fails the checks. */
  async confirm(
    actor: Actor,
    input: { baseVersionNumber: number | null; rows: readonly ConfirmRow[] },
  ): Promise<ImportConfirmation> {
    this.pricing.assertMayManagePriceList(actor);
    return this.pricing.inPublishTransaction(async (tx) => {
      // The publish lock first (the order every publish takes), then the list and the products are
      // read under it.
      await this.pricing.lockPublished(tx);
      const items = (await this.pricing.currentPublishedItems(tx))?.items ?? [];
      const rows: ImportRowInput[] = input.rows.map((row, index) => ({
        rowNumber: index + 2,
        productCode: row.productCode,
        name: row.name,
        brandName: row.brandName,
        category: row.category,
        basePrice: row.basePrice,
        deferredPrice: row.deferredPrice,
        rrp: row.rrp,
        // The client sends the wholesale fields only for a file that had the wholesale columns.
        wholesaleGiven: row.wholesalePrice !== undefined,
        wholesalePrice: row.wholesalePrice ?? null,
        wholesaleDeferredPrice: row.wholesaleDeferredPrice ?? null,
        // The same for the Alif factoring columns [C, owner 2026-11-12].
        alifGiven: row.alifPrice !== undefined,
        alifPrice: row.alifPrice ?? null,
        alifDeferredPrice: row.alifDeferredPrice ?? null,
        issues: [
          ...(typeof row.wholesaleDeferredPrice === 'string' &&
          (row.wholesalePrice ?? null) === null
            ? (['WHOLESALE_PRICE_MISSING'] as const)
            : []),
          ...(typeof row.alifDeferredPrice === 'string' && (row.alifPrice ?? null) === null
            ? (['ALIF_PRICE_MISSING'] as const)
            : []),
        ],
      }));
      const judged = judgeRows(rows, await this.contextFor(rows, items, tx));
      const invalid = judged.filter((row) => row.preview.status === 'ERROR');
      if (invalid.length > 0) {
        throw new UnprocessableError('IMPORT_ROWS_INVALID', 'Some rows cannot be imported', {
          rows: invalid.map((row) => ({
            index: row.preview.rowNumber - 2,
            issues: row.preview.issues,
          })),
        });
      }
      const upserts: {
        productId: string;
        basePrice: Prisma.Decimal;
        deferredPrice: Prisma.Decimal | null;
        rrp: Prisma.Decimal | null;
        wholesalePrice?: Prisma.Decimal | null;
        wholesaleDeferredPrice?: Prisma.Decimal | null;
        alifPrice?: Prisma.Decimal | null;
        alifDeferredPrice?: Prisma.Decimal | null;
      }[] = [];
      let createdCount = 0;
      let updatedCount = 0;
      let unchangedCount = 0;
      for (const row of judged) {
        const productId = await this.productFor(tx, actor, row);
        if (row.preview.status === 'NEW') createdCount += 1;
        else if (row.preview.status === 'UNCHANGED') unchangedCount += 1;
        else updatedCount += 1;
        upserts.push({
          productId,
          basePrice: new Prisma.Decimal(row.preview.basePrice ?? '0'),
          deferredPrice: optionalDecimal(row.preview.deferredPrice),
          // An empty RRP cell means "no RRP", exactly like an empty deferred price cell.
          rrp: optionalDecimal(row.preview.rrp),
          // Without the wholesale columns the product keeps its wholesale prices [P].
          ...(row.preview.wholesaleGiven
            ? {
                wholesalePrice: optionalDecimal(row.preview.wholesalePrice),
                wholesaleDeferredPrice: optionalDecimal(row.preview.wholesaleDeferredPrice),
              }
            : {}),
          // Without the Alif columns the product keeps its Alif prices (same rule) [P].
          ...(row.preview.alifGiven
            ? {
                alifPrice: optionalDecimal(row.preview.alifPrice),
                alifDeferredPrice: optionalDecimal(row.preview.alifDeferredPrice),
              }
            : {}),
        });
      }
      const { version } = await this.pricing.publishChangesIn(tx, actor, {
        baseVersionNumber: input.baseVersionNumber,
        upserts,
        removedProductIds: [],
      });
      return { version, createdCount, updatedCount, unchangedCount };
    });
  }

  /**
   * The product a confirmed row prices: created for a code-less row; renamed when it is a
   * generated-code product and the file's name differs (a sheet product keeps its name). The
   * rename (lock + read + audit) runs only for a differing name, not for every generated row.
   */
  private async productFor(tx: Tx, actor: Actor, row: JudgedRow): Promise<string> {
    const { preview } = row;
    if (preview.productId === null) {
      // The row's category label, stored like the one the staff form takes (free text, null = none).
      const created = await this.catalog.createManualProduct(tx, actor, {
        name: preview.name,
        brandId: row.brandId,
        category: preview.category,
      });
      return created.id;
    }
    if (preview.codeGenerated === true && preview.name.trim() !== row.currentName?.trim()) {
      await this.catalog.updateProductIn(tx, actor, preview.productId, { name: preview.name });
    }
    return preview.productId;
  }

  /** The lookups the rows are judged against, read in one go (a fixed number of queries). */
  private async contextFor(
    rows: readonly ImportRowInput[],
    items: readonly ItemView[],
    db?: DbClient,
  ): Promise<ImportContext> {
    const codes = rows.flatMap((row) => (row.productCode === null ? [] : [row.productCode]));
    const [products, brands, activeNameKeys] = await Promise.all([
      this.catalog.findProductsByProductCodes(codes, db),
      this.catalog.findBrandsByNameKeys(db),
      this.catalog.findActiveProductNameKeys(db),
    ]);
    return {
      productsByCodeKey: new Map(products.map((p) => [productCodeKey(p.productCode), factOf(p)])),
      brandIdsByNameKey: new Map([...brands].map(([key, brand]) => [key, brand.id])),
      publishedPrices: new Map(
        items.map((item) => [
          item.productId,
          {
            basePrice: item.basePrice,
            deferredPrice: item.deferredPrice,
            rrp: item.rrp,
            wholesalePrice: item.wholesalePrice,
            wholesaleDeferredPrice: item.wholesaleDeferredPrice,
            alifPrice: item.alifPrice,
            alifDeferredPrice: item.alifDeferredPrice,
          },
        ]),
      ),
      activeNameKeys,
    };
  }
}

function factOf(product: ProductView): ImportProductFact {
  return {
    id: product.id,
    name: commonProductName(product.translations, product.productCode),
    codeGenerated: product.codeGenerated,
    isActive: product.isActive,
    mergedIntoProductId: product.mergedIntoProductId,
  };
}

const optionalDecimal = (value: string | null): Prisma.Decimal | null =>
  value === null ? null : new Prisma.Decimal(value);

// Plain code-point order: the same on every machine, unlike locale-dependent collation.
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
