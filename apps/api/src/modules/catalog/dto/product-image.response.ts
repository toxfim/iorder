import {
  commonProductName,
  productImageMediaUrl,
  type ProductImageProduct,
  type ProductImageResponse,
} from '@iorder/shared';
import type { ProductImageRecord, ProductWithImages } from '../product-images.repository.js';

/** Allow-listed fields only (never the uploader, the hash or the idempotency key). */
export function toProductImageResponse(image: ProductImageRecord): ProductImageResponse {
  return {
    imageId: image.id,
    isPrimary: image.isPrimary,
    url: productImageMediaUrl(image.id, 'large'),
    thumbUrl: productImageMediaUrl(image.id, 'thumb'),
    sourceUrl: image.sourceUrl,
    width: image.width,
    height: image.height,
    createdAt: image.createdAt.toISOString(),
  };
}

export function toProductImageListItem(product: ProductWithImages): ProductImageProduct {
  return {
    productCode: product.productCode,
    name: commonProductName(product.names, product.productCode),
    images: product.images.map(toProductImageResponse),
  };
}
