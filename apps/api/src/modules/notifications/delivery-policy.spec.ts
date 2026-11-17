import { describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SECONDS,
  DEFAULT_RATE_LIMIT_WAIT_SECONDS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  rateLimitWaitSeconds,
  RETRY_DELAYS_SECONDS,
  retryDelaySeconds,
} from './delivery-policy.js';

describe('retry schedule', () => {
  it('waits longer after each failed attempt (exponential, capped)', () => {
    const delays = Array.from({ length: MAX_DELIVERY_ATTEMPTS - 1 }, (_, i) =>
      retryDelaySeconds(i + 1),
    );
    expect(delays).toEqual([...RETRY_DELAYS_SECONDS]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    }
    expect(Math.max(...RETRY_DELAYS_SECONDS)).toBeLessThanOrEqual(2 * 3600);
  });

  it('has one delay for every attempt that may be followed by another', () => {
    expect(RETRY_DELAYS_SECONDS).toHaveLength(MAX_DELIVERY_ATTEMPTS - 1);
  });

  it('gives up after the last allowed attempt', () => {
    expect(retryDelaySeconds(MAX_DELIVERY_ATTEMPTS)).toBeNull();
    expect(retryDelaySeconds(MAX_DELIVERY_ATTEMPTS + 3)).toBeNull();
  });

  it('treats a nonsense attempt count like the first attempt', () => {
    expect(retryDelaySeconds(0)).toBe(RETRY_DELAYS_SECONDS[0]);
    expect(retryDelaySeconds(-5)).toBe(RETRY_DELAYS_SECONDS[0]);
  });

  it('keeps the lease longer than the whole retry-free work of a batch', () => {
    // 20 rows x 30 s client timeout is the worst case of one batch.
    expect(CLAIM_LEASE_SECONDS).toBeGreaterThanOrEqual(20 * 30);
  });
});

describe('rate limit wait', () => {
  it('honours retry_after, rounded up', () => {
    expect(rateLimitWaitSeconds(7)).toBe(7);
    expect(rateLimitWaitSeconds(7.2)).toBe(8);
  });

  it('clamps to sane bounds and has a default for a missing value', () => {
    expect(rateLimitWaitSeconds(0)).toBe(1);
    expect(rateLimitWaitSeconds(-3)).toBe(1);
    expect(rateLimitWaitSeconds(10 ** 9)).toBe(MAX_RATE_LIMIT_WAIT_SECONDS);
    expect(rateLimitWaitSeconds(undefined)).toBe(DEFAULT_RATE_LIMIT_WAIT_SECONDS);
    expect(rateLimitWaitSeconds(Number.NaN)).toBe(DEFAULT_RATE_LIMIT_WAIT_SECONDS);
  });
});
