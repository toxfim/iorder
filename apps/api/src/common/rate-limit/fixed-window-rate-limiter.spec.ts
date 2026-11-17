import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './fixed-window-rate-limiter.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit, then refuses with the seconds left', () => {
    const limiter = new FixedWindowRateLimiter(3, 10_000);
    for (let i = 0; i < 3; i += 1) expect(limiter.hit('a', 1_000 + i).allowed).toBe(true);
    expect(limiter.hit('a', 4_000)).toEqual({ allowed: false, retryAfterSeconds: 7 });
  });

  it('starts a fresh window after the old one ends', () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000);
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 9_999).allowed).toBe(false);
    expect(limiter.hit('a', 10_000).allowed).toBe(true);
  });

  it('does not extend the window by refused hits', () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000);
    limiter.hit('a', 0);
    for (let t = 1_000; t < 10_000; t += 1_000) limiter.hit('a', t);
    expect(limiter.hit('a', 10_000).allowed).toBe(true);
  });

  it('keeps keys apart and can forget one', () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000);
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('b', 0).allowed).toBe(true);
    expect(limiter.hit('a', 1).allowed).toBe(false);
    limiter.reset('a');
    expect(limiter.hit('a', 2).allowed).toBe(true);
  });

  it('treats a clock that moved backwards as a new window instead of locking forever', () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000);
    limiter.hit('a', 50_000);
    expect(limiter.hit('a', 1_000).allowed).toBe(true);
  });

  it('never tracks more than the cap, dropping the least recently used key first', () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000, 3);
    for (const key of ['a', 'b', 'c']) limiter.hit(key, 0);
    limiter.hit('d', 2);
    // 'a' was evicted, so it starts fresh; 'c' is still tracked and still refused.
    expect(limiter.hit('c', 3).allowed).toBe(false);
    expect(limiter.hit('a', 4).allowed).toBe(true);
  });

  it('sweeps expired windows once per window, not on every hit', () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000, 1_000);
    for (let i = 0; i < 500; i += 1) limiter.hit(`k${i}`, 0);
    limiter.hit('late', 10_001);
    const windows = (limiter as unknown as { windows: Map<string, unknown> }).windows;
    expect([...windows.keys()]).toEqual(['late']);
  });

  it('rejects nonsense configuration', () => {
    expect(() => new FixedWindowRateLimiter(0, 1000)).toThrow();
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow();
  });
});
