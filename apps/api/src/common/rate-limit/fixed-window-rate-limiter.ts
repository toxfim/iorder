export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the window ends; only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

interface Window {
  startedAtMs: number;
  count: number;
}

/** Safety cap on remembered keys: an attacker choosing endless keys cannot grow memory without bound. */
const MAX_TRACKED_KEYS = 20_000;

/**
 * Small in-process fixed-window limiter: at most `limit` hits per key inside one window. Process
 * local on purpose (no dependency, no shared store): a restart or a second process resets it, so
 * it slows guessing down but is not the only defence (the per-login lockout lives in the
 * database). The caller passes the time so tests need no real waiting.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweepMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = MAX_TRACKED_KEYS,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error('windowMs must be a positive integer');
    }
  }

  /** Counts one hit for `key`. A refused hit is not counted, so the window still ends on time. */
  hit(key: string, nowMs: number): RateLimitDecision {
    const current = this.windows.get(key);
    const window =
      current && nowMs >= current.startedAtMs && nowMs - current.startedAtMs < this.windowMs
        ? current
        : { startedAtMs: nowMs, count: 0 };
    if (window.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.startedAtMs + this.windowMs - nowMs) / 1000),
        ),
      };
    }
    window.count += 1;
    // Re-insert so the least recently used key is first in iteration order.
    this.windows.delete(key);
    this.windows.set(key, window);
    this.trim(nowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Gives back one hit of the key's CURRENT window (never below zero, nothing when the window has
   * ended). For callers that reserve a slot before the work and learn afterwards that it should
   * not have counted.
   */
  refund(key: string, nowMs: number): void {
    const window = this.windows.get(key);
    if (!window || nowMs < window.startedAtMs || nowMs - window.startedAtMs >= this.windowMs)
      return;
    window.count = Math.max(0, window.count - 1);
  }

  /** Forgets a key. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Expired windows are swept once per window length (amortised, not a scan on every hit), and
   * the map never holds more than `maxKeys`: beyond that the least recently used keys go first.
   * Iteration order is insertion order and hits re-insert, so the first keys are the oldest.
   */
  private trim(nowMs: number): void {
    if (nowMs < this.lastSweepMs || nowMs - this.lastSweepMs >= this.windowMs) {
      this.lastSweepMs = nowMs;
      for (const [key, window] of this.windows) {
        if (nowMs < window.startedAtMs || nowMs - window.startedAtMs >= this.windowMs) {
          this.windows.delete(key);
        }
      }
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size <= this.maxKeys) return;
      this.windows.delete(key);
    }
  }
}
