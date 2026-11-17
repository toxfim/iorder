import { describe, expect, it } from 'vitest';
import { PendingNoticeLimiter } from './pending-notice-limiter.js';

const HOUR = 60 * 60 * 1000;

describe('PendingNoticeLimiter', () => {
  it('lets one person trigger only a few pending notices per hour, then allows again', () => {
    const limiter = new PendingNoticeLimiter(2, 100);
    expect(limiter.allow(1n, 0)).toBe(true);
    expect(limiter.allow(1n, 1_000)).toBe(true);
    expect(limiter.allow(1n, 2_000)).toBe(false);
    expect(limiter.allow(1n, HOUR)).toBe(true);
  });

  it('keeps the budgets of different people apart, and groups added by nobody share one budget', () => {
    const limiter = new PendingNoticeLimiter(1, 100);
    expect(limiter.allow(1n, 0)).toBe(true);
    expect(limiter.allow(2n, 0)).toBe(true);
    expect(limiter.allow(null, 0)).toBe(true);
    expect(limiter.allow(null, 0)).toBe(false);
    expect(limiter.allow(1n, 0)).toBe(false);
  });

  it('caps the total per hour, without letting a refused adder eat into the total', () => {
    const limiter = new PendingNoticeLimiter(1, 2);
    expect(limiter.allow(1n, 0)).toBe(true);
    // Refused by the adder budget: the global budget is untouched.
    expect(limiter.allow(1n, 0)).toBe(false);
    expect(limiter.allow(2n, 0)).toBe(true);
    // The total is spent now, even for a fresh adder.
    expect(limiter.allow(3n, 0)).toBe(false);
  });
});
