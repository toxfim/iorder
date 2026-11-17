import { describe, expect, it } from 'vitest';
import { BUSINESS_TIME_ZONE } from './index.js';

describe('shared constants', () => {
  it('uses Asia/Tashkent for business time rules', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Tashkent');
  });
});
