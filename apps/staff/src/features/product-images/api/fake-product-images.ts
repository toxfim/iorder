import {
  PRODUCT_IMAGE_CONTENT_TYPES,
  PRODUCT_IMAGE_MAX_BYTES,
  productCodeKey,
  type ProductImageProduct,
  type ProductImageResponse,
  type ProductImageUploadResponse,
  type StaffRole,
} from '@iorder/shared';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiResponseError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';
import type { PrimaryImageUrls } from '@/features/pricing/api/fake-price-backend';
import type { ProductImagesApi } from './product-images-api';

// Dev and test only (loaded behind the fake gate, see app/create-services.ts); bundle-check fails
// a production build that contains this marker.
export const FAKE_PRODUCT_IMAGES_MARKER = 'iorder-fake-product-images';

// Two 32 px demo pictures (a neutral circle and a neutral bar), so the lists show a photo without
// any network. Inline PNGs: nothing is fetched.
const DEMO_PICTURES = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAT0lEQVR42mN48ugeTRHDqAWjFoCRm5sfLkQFC/CYTowdDBSaTtAOBspNx28HA1VMx2PHqAWjFoxaMJA5mR5lET1KU3rUB6N18qgFoxZQjADh/tL/fDCS2AAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAM0lEQVR42mN48+oZTRHDqAWD2gIbBw/i0agFoxaMWjBqwagFoxaMWjBqwcBZMNqyo48FAOqOSUGjE9OyAAAAAElFTkSuQmCC',
] as const;

/** Demo products that start with photos (codes of the fake price list). */
const SEEDED: readonly { productCode: string; pictures: readonly number[] }[] = [
  { productCode: '10482', pictures: [0, 1] },
  { productCode: '10483', pictures: [1] },
];

const MANAGERS: readonly StaffRole[] = ['MANAGER', 'ADMIN'];
const ACCEPTED: ReadonlySet<string> = new Set(PRODUCT_IMAGE_CONTENT_TYPES);

interface ImageRecord {
  readonly imageId: string;
  readonly productCode: string;
  isPrimary: boolean;
  removed: boolean;
  readonly src: string;
  /** Stands in for the server's SHA-256 of the bytes: same name, type and size. */
  readonly identity: string;
  readonly createdAt: string;
}

export interface FakeProductImagesOptions {
  /** The catalog of the price fake, read at call time. */
  readonly products: () => readonly { productCode: string; name: string }[];
  readonly roles: () => readonly StaffRole[];
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  readonly now?: () => Date;
}

export interface FakeProductImages {
  readonly productImagesApi: ProductImagesApi;
  /** The primary photo of a product code, as the staff list rows carry it. */
  readonly primaryImage: (productCode: string) => PrimaryImageUrls;
  /** Live photos of a product code (the merge preview counts them). */
  readonly imageCount: (productCode: string) => number;
}

// Valid v4-shaped ids (variant a), apart from the price fake's ids.
const imageId = (counter: number): string =>
  `00000000-0000-4000-a000-${counter.toString(16).padStart(12, '0')}`;

/**
 * In-memory stand-in for the product photo endpoints, following the api's rules: manager and
 * admin only, the first photo becomes primary, a second primary is refused (PRIMARY_IMAGE_EXISTS),
 * the same file twice is refused (PRODUCT_IMAGE_DUPLICATE), an Idempotency-Key replays its first
 * answer and is refused for another file, removal never promotes another photo.
 */
export function createFakeProductImages(options: FakeProductImagesOptions): FakeProductImages {
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? (() => 'ready');
  const now = options.now ?? (() => new Date());
  const images: ImageRecord[] = [];
  const keys = new Map<string, { identity: string; productKey: string; imageId: string }>();
  let counter = 0;

  for (const { productCode, pictures } of SEEDED) {
    pictures.forEach((picture, index) => {
      images.push({
        imageId: imageId(++counter),
        productCode,
        isPrimary: index === 0,
        removed: false,
        src: DEMO_PICTURES[picture] ?? DEMO_PICTURES[0],
        identity: `seed-${counter}`,
        createdAt: '2026-10-20T05:00:00.000Z',
      });
    });
  }

  async function before(): Promise<void> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (!options.roles().some((role) => MANAGERS.includes(role))) {
      throw new PermissionDeniedError();
    }
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_PRODUCT_IMAGES_MARKER}: simulated failure`);
  }

  function requireProduct(productCode: string): { productCode: string; name: string } {
    const key = productCodeKey(productCode);
    const product = options.products().find((p) => productCodeKey(p.productCode) === key);
    if (!product) throw new ApiNotFoundError('Product not found', 'NOT_FOUND');
    return product;
  }

  const live = (productCode: string): ImageRecord[] =>
    images
      .filter((i) => !i.removed && productCodeKey(i.productCode) === productCodeKey(productCode))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  function toResponse(image: ImageRecord): ProductImageResponse {
    return {
      imageId: image.imageId,
      isPrimary: image.isPrimary,
      url: image.src,
      thumbUrl: image.src,
      sourceUrl: null,
      width: 1200,
      height: 900,
      createdAt: image.createdAt,
    };
  }

  function toUpload(image: ImageRecord): ProductImageUploadResponse {
    return {
      imageId: image.imageId,
      productCode: image.productCode,
      url: image.src,
      thumbUrl: image.src,
      isPrimary: image.isPrimary,
    };
  }

  function liveImage(id: string): ImageRecord {
    const image = images.find((i) => i.imageId === id && !i.removed);
    if (!image) throw new ApiNotFoundError('Image not found', 'NOT_FOUND');
    return image;
  }

  // A real browser shows the chosen file itself; tests (jsdom) have no object URLs.
  function sourceOf(file: File): string {
    return typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(file)
      : DEMO_PICTURES[images.length % DEMO_PICTURES.length]!;
  }

  const productImagesApi: ProductImagesApi = {
    async getProduct(productCode) {
      await before();
      const product = requireProduct(productCode);
      const result: ProductImageProduct = {
        productCode: product.productCode,
        name: product.name,
        images: live(product.productCode).map(toResponse),
      };
      return result;
    },

    async upload(productCode, file, idempotencyKey) {
      await before();
      const product = requireProduct(productCode);
      const productKey = productCodeKey(product.productCode);
      const identity = `${file.name}:${file.type}:${file.size}`;
      const earlier = keys.get(idempotencyKey);
      if (earlier) {
        if (earlier.identity !== identity || earlier.productKey !== productKey) {
          throw new ApiConflictError(
            'This Idempotency-Key was already used for another upload',
            'CONFLICT',
            undefined,
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        const replay = images.find((i) => i.imageId === earlier.imageId);
        if (replay) return toUpload(replay);
      }
      if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
        throw new ApiResponseError('File too large', 413, 'PAYLOAD_TOO_LARGE');
      }
      if (!ACCEPTED.has(file.type)) {
        throw new ApiValidationError('Request validation failed', 'VALIDATION_FAILED', [
          { path: 'file', message: 'must be a JPEG, PNG or WebP picture' },
        ]);
      }
      const current = live(product.productCode);
      const duplicate = current.find((i) => i.identity === identity);
      if (duplicate) {
        throw new ApiConflictError(
          'This photo is already on the product',
          'CONFLICT',
          { imageId: duplicate.imageId },
          'PRODUCT_IMAGE_DUPLICATE',
        );
      }
      const created: ImageRecord = {
        imageId: imageId(++counter),
        productCode: product.productCode,
        isPrimary: !current.some((i) => i.isPrimary),
        removed: false,
        src: sourceOf(file),
        identity,
        createdAt: now().toISOString(),
      };
      images.push(created);
      keys.set(idempotencyKey, { identity, productKey, imageId: created.imageId });
      return toUpload(created);
    },

    async setPrimary(id) {
      await before();
      const image = liveImage(id);
      for (const other of live(image.productCode)) other.isPrimary = false;
      image.isPrimary = true;
      return toResponse(image);
    },

    async remove(id) {
      await before();
      const image = liveImage(id);
      image.removed = true;
      image.isPrimary = false;
    },
  };

  function primaryImage(productCode: string): PrimaryImageUrls {
    const primary = live(productCode).find((i) => i.isPrimary);
    return primary
      ? { imageUrl: primary.src, imageLargeUrl: primary.src }
      : { imageUrl: null, imageLargeUrl: null };
  }

  return { productImagesApi, primaryImage, imageCount: (code) => live(code).length };
}
