import { createHash } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo, type Sharp } from 'sharp';
import { PRODUCT_IMAGE_MAX_BYTES } from '@iorder/shared';
import { InputValidationError } from '../../common/errors/domain-errors.js';

/**
 * Upload limits and stored sizes of product photos. [P] (owner 2026-10-29 asked for size and
 * dimension checks; the numbers are proposals.)
 */
export const PRODUCT_IMAGE_LIMITS = {
  /** Largest accepted upload. Also the multipart file size limit of the upload route. */
  maxBytes: PRODUCT_IMAGE_MAX_BYTES,
  /** A shorter side below this is too small to show a product. */
  minSide: 200,
  /**
   * Decoding stops above this many pixels (a "decompression bomb" guard). Decoded pixels live in
   * native memory outside the Node heap cap, so this also bounds the api's memory per upload.
   */
  maxPixels: 24_000_000,
  /** Photos processed at the same time in one api process; more requests wait their turn. */
  maxConcurrent: 2,
  /** The shown photo: longest side at most this, never enlarged. */
  largeMaxSide: 1200,
  /** The list thumbnail (40 px rows at up to 3x screens, and small previews). */
  thumbMaxSide: 256,
} as const;

const FORMATS = {
  jpeg: { contentType: 'image/jpeg', extension: 'jpg' },
  png: { contentType: 'image/png', extension: 'png' },
  webp: { contentType: 'image/webp', extension: 'webp' },
} as const;
type AcceptedFormat = keyof typeof FORMATS;

export type OriginalContentType = (typeof FORMATS)[AcceptedFormat]['contentType'];

export interface ProcessedProductImage {
  /** Detected from the bytes, never taken from the client. */
  originalContentType: OriginalContentType;
  originalExtension: string;
  sha256: string;
  byteSize: number;
  /** Of the large variant (after auto-rotation). */
  width: number;
  height: number;
  large: Buffer;
  thumb: Buffer;
}

function invalid(message: string): InputValidationError {
  return new InputValidationError([{ path: 'file', message }]);
}

function isAccepted(format: string | undefined): format is AcceptedFormat {
  return format !== undefined && Object.hasOwn(FORMATS, format);
}

/**
 * Checks an uploaded photo and makes the two stored WebP variants. Re-encoding is the point: the
 * served files are always pixels we produced (no EXIF, GPS or embedded payload of the upload), in
 * one known format. The original bytes are kept by the caller but never served.
 */
export function processProductImage(bytes: Buffer): Promise<ProcessedProductImage> {
  return processingGate.run(() => processNow(bytes));
}

/**
 * At most `limit` tasks run at once; the rest wait in arrival order. In-process only: the api is
 * one process (deploy/compose.app.yml), and the point is to bound its native memory.
 */
export class ConcurrencyGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      // The slot passes straight to the next waiter (running stays the same), or is freed.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

const processingGate = new ConcurrencyGate(PRODUCT_IMAGE_LIMITS.maxConcurrent);

async function processNow(bytes: Buffer): Promise<ProcessedProductImage> {
  if (bytes.length === 0) throw invalid('the file is empty');
  if (bytes.length > PRODUCT_IMAGE_LIMITS.maxBytes) throw invalid('the file is too large');

  const options = { limitInputPixels: PRODUCT_IMAGE_LIMITS.maxPixels, failOn: 'error' } as const;
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, options).metadata();
  } catch {
    throw invalid('the file is not a readable image');
  }
  if (!isAccepted(metadata.format)) throw invalid('only JPEG, PNG or WebP images are accepted');
  if ((metadata.pages ?? 1) > 1) throw invalid('animated images are not accepted');
  const { width, height } = metadata;
  if (width === undefined || height === undefined) throw invalid('the image has no size');
  if (width * height > PRODUCT_IMAGE_LIMITS.maxPixels) throw invalid('the image is too large');
  if (Math.min(width, height) < PRODUCT_IMAGE_LIMITS.minSide) {
    throw invalid(`the shorter side must be at least ${PRODUCT_IMAGE_LIMITS.minSide} px`);
  }

  try {
    // The big original is decoded once; the thumb is made from the (small) large variant, which
    // is already rotated and stripped.
    const large = await variant(
      sharp(bytes, options).rotate(),
      PRODUCT_IMAGE_LIMITS.largeMaxSide,
      82,
    );
    const thumb = await variant(sharp(large.data), PRODUCT_IMAGE_LIMITS.thumbMaxSide, 75);
    const format = FORMATS[metadata.format];
    return {
      originalContentType: format.contentType,
      originalExtension: format.extension,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      width: large.info.width,
      height: large.info.height,
      large: large.data,
      thumb: thumb.data,
    };
  } catch {
    // The header was fine but the pixel data is broken (a truncated file, for example).
    throw invalid('the file is not a readable image');
  }
}

/**
 * A stored WebP thumb as JPEG on a white background, for consumers that cannot read WebP (ExcelJS
 * embeds only PNG, JPEG and GIF). Goes through the same gate as uploads: it decodes pixels too.
 */
export function thumbToJpeg(webp: Buffer): Promise<Buffer> {
  return processingGate.run(() =>
    sharp(webp, { limitInputPixels: PRODUCT_IMAGE_LIMITS.maxPixels })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

// rotate() with no angle (on the original) applies the EXIF orientation, so a phone photo is not
// shown sideways.
function variant(
  image: Sharp,
  maxSide: number,
  quality: number,
): Promise<{ data: Buffer; info: OutputInfo }> {
  return image
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
}
