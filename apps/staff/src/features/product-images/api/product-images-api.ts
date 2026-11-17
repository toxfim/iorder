import {
  PRODUCT_IMAGE_ROUTES,
  productImageProductSchema,
  productImageResponseSchema,
  productImageUploadResponseSchema,
  type ProductImageProduct,
  type ProductImageResponse,
  type ProductImageUploadResponse,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Deadline of one upload [P]: a 10 MB photo over a slow phone connection, plus the server's
 * queue of at most two photos processed at once, takes longer than the default 30 s.
 */
export const PHOTO_UPLOAD_TIMEOUT_MS = 120_000;

/** Product photos (manager, admin): docs/api/product-images-api.md. */
export interface ProductImagesApi {
  /** One product with its live photos, primary first. */
  getProduct: (productCode: string) => Promise<ProductImageProduct>;
  /**
   * One photo. `idempotencyKey` is new per upload attempt; the server decides the primary (the
   * first photo of a product becomes primary, a later one never replaces it).
   */
  upload: (
    productCode: string,
    file: File,
    idempotencyKey: string,
  ) => Promise<ProductImageUploadResponse>;
  setPrimary: (imageId: string) => Promise<ProductImageResponse>;
  remove: (imageId: string) => Promise<void>;
}

export function createHttpProductImagesApi(http: HttpClient): ProductImagesApi {
  return {
    getProduct: (productCode) =>
      http.request(PRODUCT_IMAGE_ROUTES.getProduct, productImageProductSchema, {
        params: { productCode },
      }),
    upload: (productCode, file, idempotencyKey) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return http.request(PRODUCT_IMAGE_ROUTES.upload, productImageUploadResponseSchema, {
        params: { productCode },
        form,
        headers: { 'Idempotency-Key': idempotencyKey },
        timeoutMs: PHOTO_UPLOAD_TIMEOUT_MS,
      });
    },
    setPrimary: (imageId) =>
      http.request(PRODUCT_IMAGE_ROUTES.setPrimary, productImageResponseSchema, {
        params: { imageId },
      }),
    remove: (imageId) => http.requestVoid(PRODUCT_IMAGE_ROUTES.remove, { params: { imageId } }),
  };
}
