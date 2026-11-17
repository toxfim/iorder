import { z } from 'zod';
import { isoInstantSchema, productCodeSchema, uuidSchema } from './common.js';
import { route } from './routes.js';

// Product photos (owner 2026-10-29), docs/api/product-images-api.md. Staff (manager, admin) and an
// API token with the MANAGE_PRODUCT_IMAGES scope. Photos are not cost data.

export const PRODUCT_IMAGE_ROUTES = Object.freeze({
  listProducts: route('GET', '/staff/product-images/products'),
  /** One product with its live photos (the staff photo manager of a product). */
  getProduct: route('GET', '/staff/product-images/products/:productCode'),
  upload: route('POST', '/staff/product-images/products/:productCode/images'),
  setPrimary: route('PUT', '/staff/product-images/images/:imageId/primary'),
  remove: route('DELETE', '/staff/product-images/images/:imageId'),
  /** Public (UUID v7 id, not guessable): the photo files themselves, `variant` = large | thumb. */
  media: route('GET', '/media/product-images/:imageId/:variant'),
});

export const PRODUCT_IMAGE_LIST_MAX_LIMIT = 200;

/** Largest accepted upload in bytes (10 MB [P]); the api answers 413 above it. */
export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The upload formats the api accepts (it detects them from the bytes, not from this type). */
export const PRODUCT_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ProductImageVariant = 'large' | 'thumb';

// The web apps and the reverse proxy reach the api under /api/ (deploy/apache, the Vite dev proxy),
// so a photo URL relative to the web origin works from both staff and customer pages.
const PRODUCT_IMAGE_MEDIA_PREFIX = '/api/media/product-images';

/** The public URL of a stored photo variant, relative to the web origin. */
export function productImageMediaUrl(imageId: string, variant: ProductImageVariant): string {
  return `${PRODUCT_IMAGE_MEDIA_PREFIX}/${imageId}/${variant}`;
}

/**
 * The primary photo of a product on the list rows (staff stock, unpriced, both price lists):
 * `imageUrl` is the thumb, `imageLargeUrl` the large variant; both null without a primary photo.
 */
export const productPrimaryImageShape = {
  imageUrl: z.string().nullable(),
  imageLargeUrl: z.string().nullable(),
};

/** `?withoutImages=true` lists only the products that still have no photo. */
export const productImageListQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,400}$/, 'must be the nextCursor of the previous page')
    .optional(),
  limit: z.coerce.number().int().min(1).max(PRODUCT_IMAGE_LIST_MAX_LIMIT).default(100),
  withoutImages: z.enum(['true', 'false']).default('false'),
});
export type ProductImageListQuery = z.output<typeof productImageListQuerySchema>;

/** The text fields of the multipart upload (the file itself is the `file` part). */
export const productImageUploadFieldsSchema = z.strictObject({
  sourceUrl: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL')
    .optional(),
  isPrimary: z.enum(['true', 'false']).optional(),
});
export type ProductImageUploadFields = z.output<typeof productImageUploadFieldsSchema>;

// The Idempotency-Key header uses the same rule as an order submit (`idempotencyKeySchema`).

export const productImageUploadParamsSchema = z.strictObject({ productCode: productCodeSchema });
export const productImageParamsSchema = z.strictObject({ imageId: uuidSchema });
export const productImageMediaParamsSchema = z.strictObject({
  imageId: uuidSchema,
  variant: z.enum(['large', 'thumb']),
});

export const productImageResponseSchema = z.strictObject({
  imageId: uuidSchema,
  isPrimary: z.boolean(),
  /** Relative to the web origin, for example `/api/media/product-images/<id>/large`. */
  url: z.string(),
  thumbUrl: z.string(),
  sourceUrl: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  createdAt: isoInstantSchema,
});
export type ProductImageResponse = z.infer<typeof productImageResponseSchema>;

/** A product with its live photos, primary first. Also the answer of `getProduct`. */
export const productImageProductSchema = z.strictObject({
  productCode: z.string(),
  /** One name, as every product DTO names it (`commonProductName`). */
  name: z.string(),
  images: z.array(productImageResponseSchema),
});
export type ProductImageProduct = z.infer<typeof productImageProductSchema>;

export const productImageListResponseSchema = z.strictObject({
  items: z.array(productImageProductSchema),
  nextCursor: z.string().nullable(),
});
export type ProductImageListResponse = z.infer<typeof productImageListResponseSchema>;

export const productImageUploadResponseSchema = z.strictObject({
  imageId: uuidSchema,
  productCode: z.string(),
  url: z.string(),
  thumbUrl: z.string(),
  isPrimary: z.boolean(),
});
export type ProductImageUploadResponse = z.infer<typeof productImageUploadResponseSchema>;
