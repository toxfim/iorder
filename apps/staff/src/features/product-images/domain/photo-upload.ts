import { PRODUCT_IMAGE_CONTENT_TYPES, PRODUCT_IMAGE_MAX_BYTES } from '@iorder/shared';
import { ApiConflictError, ApiResponseError, ApiValidationError } from '@core/lib/api-errors';
import { describePricingError, type DescribedError } from '@core/lib/price-errors';

/** Why a chosen file is refused before it is sent (the server checks the bytes again). */
export type PhotoFileProblem = 'type' | 'size';

const ACCEPTED: ReadonlySet<string> = new Set(PRODUCT_IMAGE_CONTENT_TYPES);

/** The `accept` attribute of the file input. */
export const PHOTO_ACCEPT = PRODUCT_IMAGE_CONTENT_TYPES.join(',');

/**
 * A quick check of the browser's file type and size, so a wrong file is refused without an
 * upload. Only a convenience: the api detects the format from the bytes and limits the size.
 */
export function checkPhotoFile(file: {
  readonly type: string;
  readonly size: number;
}): PhotoFileProblem | null {
  if (!ACCEPTED.has(file.type)) return 'type';
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return 'size';
  return null;
}

/** 10 MB, as the hint shows it. */
export const PHOTO_MAX_MB = Math.round(PRODUCT_IMAGE_MAX_BYTES / (1024 * 1024));

/**
 * A new Idempotency-Key for one upload attempt: 32 hex characters (the api allows 8-128 of
 * `A-Z a-z 0-9 _ . : -`). getRandomValues works outside secure contexts too, unlike randomUUID.
 */
export function newUploadKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `img-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The message of a failed photo call. The photo-specific answers (file too large, not a usable
 * picture, a reused upload key) get their own `photos.errors` text; everything else goes through
 * the shared pricing error mapping (`apiErrors`), which knows PRODUCT_IMAGE_DUPLICATE and
 * PRIMARY_IMAGE_EXISTS.
 */
export function describePhotoError(error: unknown): DescribedError {
  if (error instanceof ApiResponseError && error.status === 413) {
    return { key: 'photos.errors.tooLarge', params: { mb: PHOTO_MAX_MB } };
  }
  if (error instanceof ApiValidationError) return { key: 'photos.errors.invalid' };
  // The shared text of this reason speaks of orders; a photo upload says it its own way.
  if (error instanceof ApiConflictError && error.reason === 'IDEMPOTENCY_KEY_REUSED') {
    return { key: 'photos.errors.retry' };
  }
  return describePricingError('updateProduct', error);
}
