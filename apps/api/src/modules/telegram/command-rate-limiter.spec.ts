import { describe, expect, it } from 'vitest';
import { CommandRateLimiter, COMMAND_LIMIT, COMMAND_WINDOW_MS } from './command-rate-limiter.js';

describe('CommandRateLimiter', () => {
  it('allows the limit within a window and refuses the next command', () => {
    const limiter = new CommandRateLimiter(3, 10_000);
    expect([0, 1, 2].map((i) => limiter.tryAcquire('chat', i))).toEqual([true, true, true]);
    expect(limiter.tryAcquire('chat', 3)).toBe(false);
    expect(limiter.tryAcquire('chat', 9_999)).toBe(false);
  });

  it('lets commands through again once the oldest ones leave the window', () => {
    const limiter = new CommandRateLimiter(2, 1_000);
    limiter.tryAcquire('chat', 0);
    limiter.tryAcquire('chat', 500);
    expect(limiter.tryAcquire('chat', 999)).toBe(false);
    expect(limiter.tryAcquire('chat', 1_000)).toBe(true); // the command at 0 expired
    expect(limiter.tryAcquire('chat', 1_001)).toBe(false); // 500 and 1000 still count
    expect(limiter.tryAcquire('chat', 1_500)).toBe(true); // 500 expired
  });

  it('does not count refused commands against the chat', () => {
    const limiter = new CommandRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('chat', 0)).toBe(true);
    for (let at = 1; at < 1_000; at += 100) expect(limiter.tryAcquire('chat', at)).toBe(false);
    expect(limiter.tryAcquire('chat', 1_000)).toBe(true);
  });

  it('keeps chats independent', () => {
    const limiter = new CommandRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('a', 0)).toBe(true);
    expect(limiter.tryAcquire('b', 0)).toBe(true);
    expect(limiter.tryAcquire('a', 1)).toBe(false);
  });

  it('has a small default limit per chat', () => {
    expect(COMMAND_LIMIT).toBeGreaterThanOrEqual(3);
    expect(COMMAND_LIMIT).toBeLessThanOrEqual(10);
    expect(COMMAND_WINDOW_MS).toBeGreaterThanOrEqual(5_000);
  });
});
