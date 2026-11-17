import { describe, expect, it } from 'vitest';
import { fallbackPriceFileName } from './price-file-name';

describe('fallbackPriceFileName', () => {
  it('uses the Tashkent calendar date', () => {
    expect(fallbackPriceFileName(new Date('2026-10-28T08:00:00Z'))).toBe(
      'iorder-price-2026-10-28.xlsx',
    );
    // 20:30 UTC is already the next day in Tashkent (UTC+5).
    expect(fallbackPriceFileName(new Date('2026-03-04T20:30:00Z'))).toBe(
      'iorder-price-2026-03-05.xlsx',
    );
  });
});
