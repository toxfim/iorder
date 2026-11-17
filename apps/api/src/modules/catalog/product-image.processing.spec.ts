import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { InputValidationError } from '../../common/errors/domain-errors.js';
import {
  ConcurrencyGate,
  PRODUCT_IMAGE_LIMITS,
  processProductImage,
} from './product-image.processing.js';

function picture(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff',
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c33' } })
    .toFormat(format)
    .toBuffer();
}

async function rejection(bytes: Buffer): Promise<string> {
  const error = await processProductImage(bytes).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(InputValidationError);
  return (error as InputValidationError).issues.map((issue) => issue.message).join('; ');
}

describe('processProductImage', () => {
  it('accepts JPEG, PNG and WebP and detects the type from the bytes', async () => {
    for (const [format, contentType] of [
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const) {
      const result = await processProductImage(await picture(400, 300, format));
      expect(result.originalContentType).toBe(contentType);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await sharp(result.large).metadata()).format).toBe('webp');
      expect((await sharp(result.thumb).metadata()).format).toBe('webp');
    }
  });

  it('shrinks to the large and thumb sizes but never enlarges', async () => {
    const big = await processProductImage(await picture(3000, 1500, 'jpeg'));
    expect([big.width, big.height]).toEqual([PRODUCT_IMAGE_LIMITS.largeMaxSide, 600]);
    const thumb = await sharp(big.thumb).metadata();
    expect([thumb.width, thumb.height]).toEqual([PRODUCT_IMAGE_LIMITS.thumbMaxSide, 128]);

    const small = await processProductImage(await picture(300, 200, 'png'));
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it('applies the EXIF orientation and strips metadata', async () => {
    const rotated = await sharp({
      create: { width: 400, height: 250, channels: 3, background: '#3c3' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await processProductImage(rotated);
    expect([result.width, result.height]).toEqual([250, 400]);
    const meta = await sharp(result.large).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('refuses other formats, garbage, empty and truncated files', async () => {
    expect(await rejection(await picture(400, 300, 'gif'))).toMatch(/JPEG, PNG or WebP/);
    expect(await rejection(await picture(400, 300, 'tiff'))).toMatch(/JPEG, PNG or WebP/);
    expect(await rejection(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatch(
      /not a readable image|JPEG, PNG or WebP/,
    );
    expect(await rejection(Buffer.from('not an image at all'))).toMatch(/not a readable image/);
    expect(await rejection(Buffer.alloc(0))).toMatch(/empty/);
    const jpeg = await picture(800, 600, 'jpeg');
    expect(await rejection(jpeg.subarray(0, Math.floor(jpeg.length / 2)))).toMatch(
      /not a readable image/,
    );
  });

  it('refuses a too small side, too many pixels and a too large file', async () => {
    expect(await rejection(await picture(199, 800, 'png'))).toMatch(/at least 200 px/);
    // A tiny PNG that claims huge dimensions must be refused without decoding it.
    expect(await rejection(await picture(8000, 6000, 'png'))).toMatch(/too large|not a readable/);
    expect(await rejection(Buffer.alloc(PRODUCT_IMAGE_LIMITS.maxBytes + 1))).toMatch(/too large/);
  });

  it('refuses an animated image', async () => {
    const frame = { width: 300, height: 300, channels: 4, background: '#00f' } as const;
    const animated = await sharp(
      [
        await sharp({ create: frame }).png().toBuffer(),
        await sharp({ create: { ...frame, background: '#0f0' } })
          .png()
          .toBuffer(),
      ],
      { join: { animated: true } },
    )
      .webp()
      .toBuffer();
    expect(await rejection(animated)).toMatch(/animated/);
  });
});

describe('ConcurrencyGate', () => {
  it('runs at most `limit` tasks at once, the rest in arrival order, also after a failure', async () => {
    const gate = new ConcurrencyGate(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number, fail = false) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        order.push(id);
        if (fail) throw new Error(`task ${id}`);
        return id;
      });
    const results = await Promise.allSettled([task(1), task(2, true), task(3), task(4), task(5)]);
    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(order.slice(2).sort()).toEqual([3, 4, 5]);
    // Free again afterwards.
    expect(await task(6)).toBe(6);
  });
});
