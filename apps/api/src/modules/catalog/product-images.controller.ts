import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  idempotencyKeySchema,
  productImageListQuerySchema,
  productImageMediaParamsSchema,
  productImageParamsSchema,
  productImageUploadFieldsSchema,
  productImageUploadParamsSchema,
  type ProductImageListQuery,
  type ProductImageListResponse,
  type ProductImageProduct,
  type ProductImageResponse,
  type ProductImageUploadFields,
  type ProductImageUploadResponse,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, Public, RequirePermission } from '../../common/auth/route-access.js';
import { InputValidationError } from '../../common/errors/domain-errors.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { PRODUCT_IMAGE_LIMITS } from './product-image.processing.js';
import type { ProductImageVariant } from './product-image.storage.js';
import { ProductImagesService } from './product-images.service.js';
import { toProductImageListItem, toProductImageResponse } from './dto/product-image.response.js';

/** The part of a multer file this route reads (@types/multer is not a dependency). */
interface UploadedImageFile {
  buffer: Buffer;
}

// Tight multipart limits: one file and the two text fields; anything bigger is refused while it
// is being read (multer answers 413 for the file size), before any image work starts.
const UPLOAD_INTERCEPTOR = FileInterceptor('file', {
  limits: {
    fileSize: PRODUCT_IMAGE_LIMITS.maxBytes,
    files: 1,
    fields: 4,
    fieldSize: 4096,
    parts: 6,
  },
});

/** The list cursor is the last product's lowercase code key, opaque to the client. */
function encodeCursor(afterKey: string): string {
  return Buffer.from(afterKey, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (key === '' || encodeCursor(key) !== cursor) {
    throw new InputValidationError([{ path: 'cursor', message: 'is not a valid cursor' }]);
  }
  return key;
}

// HTTP only: validation, actor, mapping. Rules live in ProductImagesService. The paths sit under
// staff/product-images so they can never collide with staff/products/:id.
@Controller('staff/product-images')
@RequirePermission('MANAGE_PRODUCT_IMAGES')
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  @Get('products')
  async list(
    @Query(new ZodValidationPipe(productImageListQuerySchema)) query: ProductImageListQuery,
  ): Promise<ProductImageListResponse> {
    const page = await this.images.listProducts({
      afterKey: decodeCursor(query.cursor),
      limit: query.limit,
      withoutImages: query.withoutImages === 'true',
    });
    return {
      items: page.items.map(toProductImageListItem),
      nextCursor: page.nextAfterKey === null ? null : encodeCursor(page.nextAfterKey),
    };
  }

  @Get('products/:productCode')
  async getProduct(
    @Param(new ZodValidationPipe(productImageUploadParamsSchema)) params: { productCode: string },
  ): Promise<ProductImageProduct> {
    return toProductImageListItem(await this.images.getProduct(params.productCode));
  }

  /** 201 for a new photo; 200 when the same Idempotency-Key was already answered (a retry). */
  @Post('products/:productCode/images')
  @UseInterceptors(UPLOAD_INTERCEPTOR)
  async upload(
    @CurrentActor() actor: Actor,
    @Param(new ZodValidationPipe(productImageUploadParamsSchema)) params: { productCode: string },
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() rawFields: unknown,
    @UploadedFile() file: UploadedImageFile | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProductImageUploadResponse> {
    const idempotencyKey = new ZodValidationPipe(idempotencyKeySchema).transform(rawKey);
    // multer gives the text fields as an object without a prototype; zod reads it as a plain one.
    const fields: ProductImageUploadFields = new ZodValidationPipe(
      productImageUploadFieldsSchema,
    ).transform({ ...(rawFields as Record<string, unknown> | undefined) });
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw new InputValidationError([{ path: 'file', message: 'the file part is required' }]);
    }
    const result = await this.images.upload(actor, {
      productCode: params.productCode,
      bytes: file.buffer,
      sourceUrl: fields.sourceUrl ?? null,
      isPrimary: fields.isPrimary === undefined ? undefined : fields.isPrimary === 'true',
      idempotencyKey,
    });
    response.status(result.created ? 201 : 200);
    const image = toProductImageResponse(result.image);
    return {
      imageId: image.imageId,
      productCode: result.image.productCode,
      url: image.url,
      thumbUrl: image.thumbUrl,
      isPrimary: image.isPrimary,
    };
  }

  @Put('images/:imageId/primary')
  @HttpCode(200)
  async setPrimary(
    @CurrentActor() actor: Actor,
    @Param(new ZodValidationPipe(productImageParamsSchema)) params: { imageId: string },
  ): Promise<ProductImageResponse> {
    return toProductImageResponse(await this.images.setPrimary(actor, params.imageId));
  }

  @Delete('images/:imageId')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(new ZodValidationPipe(productImageParamsSchema)) params: { imageId: string },
  ): Promise<void> {
    await this.images.remove(actor, params.imageId);
  }
}

/**
 * The photo files. Public on purpose: a product photo is not secret, and the id is a UUID v7
 * (a timestamp plus 74 random bits, so not guessable) that only staff responses (and later the
 * price list) hand out. Removed photos answer 404.
 */
@Controller('media/product-images')
export class ProductImageMediaController {
  constructor(private readonly images: ProductImagesService) {}

  @Get(':imageId/:variant')
  @Public()
  async get(
    @Param(new ZodValidationPipe(productImageMediaParamsSchema))
    params: { imageId: string; variant: ProductImageVariant },
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const bytes = await this.images.readVariant(params.imageId, params.variant);
    // Set only after the file was found, so a 404 is never cached or typed as an image.
    response.set({
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      // A stored variant never changes (a new photo gets a new id), so browsers may keep it.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'",
    });
    return new StreamableFile(bytes);
  }
}
