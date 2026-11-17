import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { productCodeKey } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { Clock } from '../../common/clock/clock.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { ConflictError, NotFoundError } from '../../common/errors/domain-errors.js';
import { AuditService } from '../audit/index.js';
import {
  processProductImage,
  thumbToJpeg,
  type ProcessedProductImage,
} from './product-image.processing.js';
import { ProductImageStorage, type ProductImageVariant } from './product-image.storage.js';
import {
  ProductImagesRepository,
  type ProductImageRecord,
  type ProductWithImages,
} from './product-images.repository.js';

const IMAGE_ENTITY = 'PRODUCT_IMAGE';

export interface ExportThumbnail {
  buffer: Buffer;
  extension: 'jpeg';
}

export interface UploadProductImageInput {
  productCode: string;
  bytes: Buffer;
  sourceUrl: string | null;
  /** Undefined: primary only when the product has no primary photo yet. */
  isPrimary: boolean | undefined;
  idempotencyKey: string;
}

export interface UploadResult {
  /** False when the same Idempotency-Key was answered before: nothing new was stored. */
  created: boolean;
  image: ProductImageRecord;
}

export interface ProductImagePage {
  items: ProductWithImages[];
  /** The lowercase product code key of the last item when another page may follow. */
  nextAfterKey: string | null;
}

/**
 * Product photos (owner 2026-10-29). Rules: a photo is never silently replaced (a second primary
 * is refused; switching the primary is its own request), the same file is stored once per product,
 * and every change is in the audit log in the same transaction. Removing keeps the row and files.
 */
@Injectable()
export class ProductImagesService {
  private readonly logger = new Logger(ProductImagesService.name);

  constructor(
    private readonly repository: ProductImagesRepository,
    private readonly storage: ProductImageStorage,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async listProducts(input: {
    afterKey: string | null;
    limit: number;
    withoutImages: boolean;
  }): Promise<ProductImagePage> {
    const items = await this.repository.listProducts(input);
    const last = items.at(-1);
    return {
      items,
      nextAfterKey: items.length === input.limit && last ? productCodeKey(last.productCode) : null,
    };
  }

  /** One product with its live photos (also an inactive one, so its photos can be managed). */
  async getProduct(productCode: string): Promise<ProductWithImages> {
    const product = await this.repository.findProductWithImages(productCode);
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  /**
   * productId -> live primary photo id, for the staff list rows (one query per page, no N+1).
   * A product whose primary was removed has none here even when other photos remain: removal never
   * promotes another photo, so the lists show what the manager chose.
   */
  primaryImageIds(productIds: readonly string[]): Promise<Map<string, string>> {
    return this.repository.findPrimaryIds(productIds);
  }

  async upload(actor: Actor, input: UploadProductImageInput): Promise<UploadResult> {
    const replay = await this.replay(actor, input);
    if (replay) return replay;
    const product = await this.repository.findProductByCode(input.productCode);
    if (!product) throw new NotFoundError('Product not found');
    const processed = await processProductImage(input.bytes);
    try {
      return await this.store(actor, product.id, input, processed);
    } catch (error) {
      // Uploads of one product are serialised by the product lock, so a unique violation means a
      // concurrent upload of ANOTHER product with the same key. Deciding again on the committed
      // state gives the precise answer (a replay or IDEMPOTENCY_KEY_REUSED).
      if (!isUniqueViolation(error)) throw error;
    }
    try {
      return await this.store(actor, product.id, input, processed);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictError(
        'This Idempotency-Key was already used for another upload',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
  }

  async setPrimary(actor: Actor, imageId: string): Promise<ProductImageRecord> {
    const productId = await this.productOf(imageId);
    return this.repository.transaction(async (tx) => {
      await this.repository.lockProduct(tx, productId);
      // Read again under the lock: a concurrent removal may have committed meanwhile.
      const image = await this.liveImage(imageId, tx);
      if (image.isPrimary) return image;
      const current = await this.repository.findLivePrimary(tx, image.productId);
      // The old primary is cleared first: the one-primary index would refuse two at once.
      if (current) await this.repository.setPrimary(tx, current.id, false);
      await this.repository.setPrimary(tx, image.id, true);
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: IMAGE_ENTITY,
        entityId: image.id,
        action: 'PRODUCT_IMAGE_PRIMARY_SET',
        changes: {
          productCode: { from: image.productCode, to: image.productCode },
          isPrimary: { from: false, to: true },
          primaryImageId: { from: current?.id ?? null, to: image.id },
          ...viaApiToken(actor),
        },
      });
      return { ...image, isPrimary: true };
    });
  }

  /** Marks the photo removed. A removed primary is NOT replaced by another photo automatically. */
  async remove(actor: Actor, imageId: string): Promise<void> {
    const productId = await this.productOf(imageId);
    await this.repository.transaction(async (tx) => {
      await this.repository.lockProduct(tx, productId);
      // Read again under the lock: a concurrent removal may have committed meanwhile.
      const image = await this.liveImage(imageId, tx);
      const now = this.clock.now();
      await this.repository.markRemoved(tx, image.id, actor.userId, now);
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: IMAGE_ENTITY,
        entityId: image.id,
        action: 'PRODUCT_IMAGE_REMOVED',
        changes: {
          productCode: { from: image.productCode, to: image.productCode },
          removedAt: { from: null, to: now.toISOString() },
          isPrimary: { from: image.isPrimary, to: false },
          ...viaApiToken(actor),
        },
      });
    });
  }

  /** For other modules (the merge preview; the caller authorizes): live photos of a product. */
  countLiveImages(productId: string): Promise<number> {
    return this.repository.countLive(productId);
  }

  /**
   * A merge [C, 2026-11-09]: the source's live photos move to the target inside the caller's
   * transaction (the source row must already point at the target, the history guard checks it).
   * The target's existing primary wins; a photo whose file the target already has is marked removed
   * on the source instead (the same file is stored once per product). Each move is audited.
   * Returns how many photos moved. The caller has authorized the actor.
   */
  async moveImagesIn(
    tx: Tx,
    actor: Actor,
    sourceProductId: string,
    targetProductId: string,
    now: Date,
  ): Promise<number> {
    const [sourceImages, targetImages] = await Promise.all([
      this.repository.findLive(tx, sourceProductId),
      this.repository.findLive(tx, targetProductId),
    ]);
    const targetHasPrimary = targetImages.some((image) => image.isPrimary);
    const targetShas = new Set(targetImages.map((image) => image.sha256));
    let moved = 0;
    let primaryGiven = false;
    for (const image of sourceImages) {
      if (targetShas.has(image.sha256)) {
        await this.repository.markRemoved(tx, image.id, actor.userId, now);
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: IMAGE_ENTITY,
          entityId: image.id,
          action: 'PRODUCT_IMAGE_REMOVED',
          changes: {
            productCode: { from: image.productCode, to: image.productCode },
            removedAt: { from: null, to: now.toISOString() },
            isPrimary: { from: image.isPrimary, to: false },
            duplicateOfProductId: { from: null, to: targetProductId },
          },
        });
        continue;
      }
      // The source's primary stays primary only when the target had none (one primary per product).
      const isPrimary = image.isPrimary && !targetHasPrimary && !primaryGiven;
      if (isPrimary) primaryGiven = true;
      await this.repository.moveToProduct(tx, image.id, targetProductId, isPrimary);
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: IMAGE_ENTITY,
        entityId: image.id,
        action: 'PRODUCT_IMAGE_MOVED',
        changes: {
          productId: { from: sourceProductId, to: targetProductId },
          isPrimary: { from: image.isPrimary, to: isPrimary },
        },
      });
      moved += 1;
    }
    return moved;
  }

  /**
   * The primary photo's thumb of each product as JPEG, for the price list Excel file. Products
   * without a live primary photo are absent. A missing or unreadable file is logged and skipped:
   * a broken photo must never stop the price list from being built.
   */
  async primaryThumbnailsForExport(
    productIds: readonly string[],
  ): Promise<Map<string, ExportThumbnail>> {
    const primaryIds = await this.repository.findPrimaryIds(productIds);
    const result = new Map<string, ExportThumbnail>();
    for (const [productId, imageId] of primaryIds) {
      try {
        const webp = await readFile(this.storage.pathOf(imageId, 'thumb'));
        result.set(productId, { buffer: await thumbToJpeg(webp), extension: 'jpeg' });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`Product photo ${imageId} skipped in export: ${reason}`);
      }
    }
    return result;
  }

  /** The bytes of a stored variant of a live photo; a removed or unknown photo is not found. */
  async readVariant(imageId: string, variant: ProductImageVariant): Promise<Buffer> {
    const image = await this.repository.findById(imageId);
    if (!image || image.removedAt !== null) throw new NotFoundError('Image not found');
    try {
      return await readFile(this.storage.pathOf(image.id, variant));
    } catch {
      // The record exists but the file does not (a media folder restored without it, say).
      throw new NotFoundError('Image not found');
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The first answer to this Idempotency-Key of this person, when the request is the same one
   * (same product, same file). The same key with other content is a client bug: 409.
   */
  private async replay(
    actor: Actor,
    input: UploadProductImageInput,
    db?: DbClient,
  ): Promise<UploadResult | null> {
    const earlier = await this.repository.findByIdempotencyKey(
      actor.userId,
      input.idempotencyKey,
      db,
    );
    if (!earlier) return null;
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const sameProduct = productCodeKey(earlier.productCode) === productCodeKey(input.productCode);
    if (!sameProduct || earlier.sha256 !== sha256) {
      throw new ConflictError(
        'This Idempotency-Key was already used for another upload',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    return { created: false, image: earlier };
  }

  private async store(
    actor: Actor,
    productId: string,
    input: UploadProductImageInput,
    processed: ProcessedProductImage,
  ): Promise<UploadResult> {
    let written: string[] = [];
    // Set when the transaction body finished: an error after that may come from COMMIT itself,
    // and then the row may exist, so its files must stay.
    let bodyDone = false;
    try {
      const result = await this.repository.transaction(async (tx): Promise<UploadResult> => {
        await this.repository.lockProduct(tx, productId);
        // A concurrent request with the same key waited on the lock: answer it as a replay.
        const replay = await this.replay(actor, input, tx);
        if (replay) return replay;
        const duplicate = await this.repository.findLiveBySha(tx, productId, processed.sha256);
        if (duplicate) {
          throw new ConflictError(
            'This photo is already on the product',
            'PRODUCT_IMAGE_DUPLICATE',
            {
              imageId: duplicate.id,
            },
          );
        }
        const primary = await this.repository.findLivePrimary(tx, productId);
        if (input.isPrimary === true && primary) {
          throw new ConflictError(
            'The product already has a primary photo',
            'PRIMARY_IMAGE_EXISTS',
            {
              imageId: primary.id,
            },
          );
        }
        const created = await this.repository.insert(tx, {
          productId,
          isPrimary: input.isPrimary ?? primary === null,
          sha256: processed.sha256,
          originalContentType: processed.originalContentType,
          width: processed.width,
          height: processed.height,
          byteSize: processed.byteSize,
          sourceUrl: input.sourceUrl,
          idempotencyKey: input.idempotencyKey,
          uploadedBy: actor.userId,
          now: this.clock.now(),
        });
        // Written inside the transaction, so a failed write rolls the row back.
        written = await this.storage.save(created.id, processed, input.bytes);
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: IMAGE_ENTITY,
          entityId: created.id,
          action: 'PRODUCT_IMAGE_UPLOADED',
          changes: {
            productCode: { from: null, to: created.productCode },
            isPrimary: { from: null, to: created.isPrimary },
            sha256: { from: null, to: created.sha256 },
            size: { from: null, to: `${created.width}x${created.height}` },
            sourceUrl: { from: null, to: created.sourceUrl },
            ...viaApiToken(actor),
          },
        });
        bodyDone = true;
        return { created: true, image: created };
      });
      return result;
    } catch (error) {
      if (!bodyDone) {
        // The body threw, so the transaction surely rolled back: no row points at the files.
        await this.storage.discard(written);
      } else if (written.length > 0) {
        // The commit outcome is unknown. Kept files are at worst orphans a later cleanup can
        // remove (files without a product_images row); deleting them could break a committed row.
        this.logger.warn('Upload failed after its transaction body; files kept');
      }
      throw error;
    }
  }

  /** The product of a photo, for taking the product lock; unknown photos are not found. */
  private async productOf(imageId: string): Promise<string> {
    const image = await this.repository.findById(imageId);
    if (!image) throw new NotFoundError('Image not found');
    return image.productId;
  }

  private async liveImage(
    imageId: string,
    tx: Parameters<ProductImagesRepository['findById']>[1],
  ): Promise<ProductImageRecord> {
    const image = await this.repository.findById(imageId, tx);
    if (!image || image.removedAt !== null) throw new NotFoundError('Image not found');
    return image;
  }
}

/** Marks in the history that a program (an API token), not the person by hand, made the change. */
function viaApiToken(actor: Actor): { viaApiToken?: { from: null; to: true } } {
  return actor.scopes === undefined ? {} : { viaApiToken: { from: null, to: true } };
}
