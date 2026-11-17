import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { ProcessedProductImage } from './product-image.processing.js';

export const PRODUCT_IMAGE_VARIANTS = ['large', 'thumb'] as const;
export type ProductImageVariant = (typeof PRODUCT_IMAGE_VARIANTS)[number];

// MEDIA_DIR unset (development and tests only; production requires it): <repo>/.media. Resolved
// from this file so the api finds the same folder whatever directory it was started from (src and
// dist sit at the same depth).
const DEFAULT_MEDIA_DIR = fileURLToPath(new URL('../../../../../.media', import.meta.url));

/**
 * The photo files on disk: `<MEDIA_DIR>/product-images/<imageId>-large.webp`, `-thumb.webp` and
 * `-original.<ext>`. File names come only from the server-made image id, never from the upload.
 */
@Injectable()
export class ProductImageStorage {
  readonly directory: string;

  constructor(@Inject(APP_ENV) env: Pick<Env, 'MEDIA_DIR'>) {
    this.directory = join(resolve(env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR), 'product-images');
  }

  pathOf(imageId: string, variant: ProductImageVariant): string {
    return join(this.directory, `${imageId}-${variant}.webp`);
  }

  /**
   * Writes the three files. Each is written under a temporary name and renamed, so a reader never
   * sees half a file. Returns the written paths, so a failed database write can remove them.
   */
  async save(imageId: string, image: ProcessedProductImage, original: Buffer): Promise<string[]> {
    await mkdir(this.directory, { recursive: true });
    const files: [string, Buffer][] = [
      [this.pathOf(imageId, 'large'), image.large],
      [this.pathOf(imageId, 'thumb'), image.thumb],
      [join(this.directory, `${imageId}-original.${image.originalExtension}`), original],
    ];
    const written: string[] = [];
    try {
      for (const [path, data] of files) {
        const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(temporary, data, { flag: 'wx' });
        try {
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
        written.push(path);
      }
    } catch (error) {
      await this.discard(written);
      throw error;
    }
    return written;
  }

  /** Removes files of an upload whose database record was never written. Best effort. */
  async discard(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
  }
}
