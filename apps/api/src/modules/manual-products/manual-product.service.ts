import { Injectable } from '@nestjs/common';
import { PRODUCT_NAME_LANG } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import type { Tx } from '../../common/database/db-client.js';
import { AuditService } from '../audit/index.js';
import {
  BrandService,
  CatalogService,
  ProductImagesService,
  type MergeMoves,
  type MergePair,
} from '../catalog/index.js';
import { CartService } from '../orders/index.js';
import {
  PriceReferenceService,
  PricingService,
  type ItemView,
  type VersionView,
} from '../pricing/index.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { ManualProductCheckView, MergePreviewView } from './dto/manual-products.response.js';

export interface CreateManualProductInput {
  baseVersionNumber: number | null;
  name: string;
  brandId: string | null;
  category: string | null;
  basePrice: Prisma.Decimal;
  deferredPrice: Prisma.Decimal | null;
}

export interface ManualProductCreated {
  productId: string;
  productCode: string;
  version: VersionView;
  skippedInactiveCount: number;
}

export interface MergeResult {
  sourceProductId: string;
  targetProductId: string;
  /** Null when the source had no price in the list: nothing to republish. */
  version: { version: VersionView; skippedInactiveCount: number } | null;
}

/**
 * Products staff add without a sheet «Товар_ID» [C, 2026-11-09] and their merge into the sheet
 * product for the same goods. Every write publishes the list as the next version in the SAME
 * transaction (through the pricing module's publish), so a product never exists without its price
 * and a merge never leaves the merged product priced. Permission: UPDATE_PRICE_LIST (manager,
 * admin), the same as the publish endpoint.
 */
@Injectable()
export class ManualProductService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly brands: BrandService,
    private readonly images: ProductImagesService,
    private readonly pricing: PricingService,
    private readonly costs: PriceReferenceService,
    private readonly carts: CartService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What the form shows while the name is typed [P, design 2026-11-09]: the alike active products
   * (exact first, then spacing/punctuation, then containment; at most five), whether each is in the
   * published list, and the brand the finder reads in the name. Read-only: nothing is written.
   */
  async check(actor: Actor, name: string): Promise<ManualProductCheckView> {
    this.pricing.assertMayManagePriceList(actor);
    const [similar, priced, brandFound] = await Promise.all([
      this.catalog.findSimilarProducts(name),
      this.pricing.getPricedProductSets(),
      this.brands.findBrandInName(name),
    ]);
    return { similar, pricedProductIds: priced.published, brandFound };
  }

  async create(actor: Actor, input: CreateManualProductInput): Promise<ManualProductCreated> {
    this.pricing.assertMayManagePriceList(actor);
    return this.pricing.inPublishTransaction(async (tx) => {
      // The publish lock first, as every publish does; the product row comes after it.
      await this.pricing.lockPublished(tx);
      const product = await this.catalog.createManualProduct(tx, actor, {
        name: input.name,
        brandId: input.brandId,
        category: input.category,
      });
      const published = await this.pricing.publishChangesIn(tx, actor, {
        baseVersionNumber: input.baseVersionNumber,
        upserts: [
          {
            productId: product.id,
            basePrice: input.basePrice,
            deferredPrice: input.deferredPrice,
            // The form has no RRP field [P]: it is set afterwards in the price dialog or by a file.
            rrp: null,
          },
        ],
        removedProductIds: [],
      });
      return {
        productId: product.id,
        productCode: product.productCode,
        version: published.version,
        skippedInactiveCount: published.skippedInactiveCount,
      };
    });
  }

  /**
   * Merges the generated-code product `sourceId` into the sheet product `targetId`: the price moves
   * (the source's prices, its RRP included, win when both are priced), then brand, name, photos and open cart lines,
   * and the source becomes inactive with `mergedIntoProductId`. Old orders keep their snapshots.
   */
  async merge(
    actor: Actor,
    sourceId: string,
    targetId: string,
    baseVersionNumber: number | null,
  ): Promise<MergeResult> {
    this.pricing.assertMayManagePriceList(actor);
    return this.pricing.inPublishTransaction(async (tx) => {
      await this.pricing.lockPublished(tx);
      const pair = await this.catalog.lockMergePair(tx, sourceId, targetId);
      const version = await this.movePrice(tx, actor, pair, baseVersionNumber);
      const moves = await this.catalog.applyMerge(tx, actor, pair);
      const movedCartLineCount = await this.carts.moveCartLinesIn(tx, sourceId, targetId);
      await this.recordMerge(tx, actor, pair, moves, version !== null, movedCartLineCount);
      return { sourceProductId: sourceId, targetProductId: targetId, version };
    });
  }

  /**
   * What `merge` would do, for the dialog [P, design 2026-11-09]: the pair is checked with the
   * merge's own rules (the same 404/409 reasons, without the locks), then both sides' published
   * prices and brands, what moves from the source (photos, open cart lines), what the target has
   * (stock aggregate, latest cost in USD: only for an actor who may view cost) and the version the
   * merge would publish. Read-only.
   */
  async mergePreview(actor: Actor, sourceId: string, targetId: string): Promise<MergePreviewView> {
    this.pricing.assertMayManagePriceList(actor);
    const { source, target } = await this.catalog.findMergePair(sourceId, targetId);
    const [published, brands, imageCount, cartLineCount, stock, costs] = await Promise.all([
      this.pricing.currentPublishedItems(),
      this.brands.resolveBrands([source, target]),
      this.images.countLiveImages(source.id),
      this.carts.countCartLines(source.id),
      this.catalog.getStockQuantities([target.id]),
      this.costs.latestCostUsd(actor, [target.id]),
    ]);
    const items = published?.items ?? [];
    const sourcePrices = pricesOf(items, source.id);
    return {
      source: {
        product: source,
        brandName: brands.get(source.id)?.name ?? null,
        prices: sourcePrices,
        imageCount,
        cartLineCount,
      },
      target: {
        product: target,
        brandName: brands.get(target.id)?.name ?? null,
        prices: pricesOf(items, target.id),
        stockQuantity: stock.get(target.id) ?? null,
        costUsd: costs.get(target.id) ?? null,
      },
      // The merge republishes only when the source is priced (see movePrice).
      nextVersionNumber:
        published !== null && sourcePrices !== null ? published.version.number + 1 : null,
    };
  }

  /** The list without the source, the target at the source's prices; null when the source is unpriced. */
  private async movePrice(
    tx: Tx,
    actor: Actor,
    pair: MergePair,
    baseVersionNumber: number | null,
  ): Promise<MergeResult['version']> {
    const published = await this.pricing.currentPublishedItems(tx);
    const sourceItem = published?.items.find((item) => item.productId === pair.source.id);
    if (sourceItem === undefined) return null;
    return this.pricing.publishChangesIn(tx, actor, {
      baseVersionNumber,
      upserts: [
        {
          productId: pair.target.id,
          basePrice: sourceItem.basePrice,
          deferredPrice: sourceItem.deferredPrice,
          rrp: sourceItem.rrp,
          // A tier's pair moves with the product only when the source HAS that tier's price [P,
          // review 2026-11-12]; otherwise the fields are omitted, which keeps the target's own
          // (an Alif-priced sheet product must not lose its price and vanish for Alif customers).
          ...(sourceItem.wholesalePrice !== null
            ? {
                wholesalePrice: sourceItem.wholesalePrice,
                wholesaleDeferredPrice: sourceItem.wholesaleDeferredPrice,
              }
            : {}),
          ...(sourceItem.alifPrice !== null
            ? { alifPrice: sourceItem.alifPrice, alifDeferredPrice: sourceItem.alifDeferredPrice }
            : {}),
        },
      ],
      removedProductIds: [pair.source.id],
    });
  }

  private async recordMerge(
    tx: Tx,
    actor: Actor,
    pair: MergePair,
    moves: MergeMoves,
    movedPriceItem: boolean,
    movedCartLineCount: number,
  ): Promise<void> {
    const { source, target } = pair;
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: 'PRODUCT',
      entityId: source.id,
      action: 'PRODUCT_MERGED',
      changes: {
        isActive: { from: source.isActive, to: false },
        mergedIntoProductId: { from: null, to: target.id },
        movedPriceItem: { from: null, to: movedPriceItem },
        movedBrand: { from: null, to: moves.movedBrand },
        movedName: { from: null, to: moves.movedName },
        movedImageCount: { from: null, to: moves.movedImageCount },
        movedCartLineCount: { from: null, to: movedCartLineCount },
      },
    });
    const received = {
      mergedFromProductId: { from: null, to: source.id },
      ...(moves.movedBrand ? { brandId: { from: null, to: source.brandId } } : {}),
      ...(moves.movedName
        ? {
            name: {
              from: null,
              to: source.translations.find((t) => t.lang === PRODUCT_NAME_LANG)?.name ?? null,
            },
          }
        : {}),
    };
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: 'PRODUCT',
      entityId: target.id,
      action: 'PRODUCT_MERGE_RECEIVED',
      changes: received,
    });
  }
}

/** The published prices of a product; null when it is not in the list. */
function pricesOf(
  items: readonly ItemView[],
  productId: string,
): { basePrice: Prisma.Decimal; deferredPrice: Prisma.Decimal | null } | null {
  const item = items.find((candidate) => candidate.productId === productId);
  return item === undefined
    ? null
    : { basePrice: item.basePrice, deferredPrice: item.deferredPrice };
}
