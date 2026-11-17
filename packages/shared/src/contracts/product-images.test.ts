import { describe, expect, it } from 'vitest';
import {
  PRODUCT_IMAGE_CONTENT_TYPES,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_ROUTES,
  productImageMediaUrl,
  productImageProductSchema,
} from './product-images.js';
import { buildPath } from './routes.js';

const imageId = '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b';

describe('product image contracts', () => {
  it('builds the media URL relative to the web origin', () => {
    expect(productImageMediaUrl(imageId, 'thumb')).toBe(
      `/api/media/product-images/${imageId}/thumb`,
    );
    expect(productImageMediaUrl(imageId, 'large')).toBe(
      `/api/media/product-images/${imageId}/large`,
    );
  });

  it('names the one-product route and the upload limits', () => {
    expect(buildPath(PRODUCT_IMAGE_ROUTES.getProduct, { productCode: 'A 1' })).toBe(
      '/staff/product-images/products/A%201',
    );
    expect(PRODUCT_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(PRODUCT_IMAGE_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('a product with photos is strict', () => {
    const product = {
      productCode: 'A-1',
      name: 'Tovar',
      images: [
        {
          imageId,
          isPrimary: true,
          url: productImageMediaUrl(imageId, 'large'),
          thumbUrl: productImageMediaUrl(imageId, 'thumb'),
          sourceUrl: null,
          width: 1200,
          height: 900,
          createdAt: '2026-10-29T08:00:00.000Z',
        },
      ],
    };
    expect(productImageProductSchema.safeParse(product).success).toBe(true);
    expect(productImageProductSchema.safeParse({ ...product, sha256: 'x' }).success).toBe(false);
  });
});
