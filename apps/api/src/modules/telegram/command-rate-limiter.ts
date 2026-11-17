/** At most this many commands per chat inside one window. */
export const COMMAND_LIMIT = 5;
export const COMMAND_WINDOW_MS = 10_000;
/** Safety cap on remembered chats; the oldest idle ones are dropped first. */
const MAX_TRACKED_CHATS = 10_000;

/**
 * Small in-memory sliding-window limiter, one window per chat. In-memory is enough: it only
 * stops a chat from flooding the bot with commands, and a restart or a second process merely
 * resets the window. The caller passes the time so tests need no real waiting.
 */
export class CommandRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number = COMMAND_LIMIT,
    private readonly windowMs: number = COMMAND_WINDOW_MS,
  ) {}

  /** True and counted when the chat may run a command now; false when it is over the limit. */
  tryAcquire(chatKey: string, nowMs: number): boolean {
    const recent = (this.hits.get(chatKey) ?? []).filter((at) => nowMs - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(chatKey, recent);
      return false;
    }
    recent.push(nowMs);
    // Re-insert so the least recently used chat is first in iteration order.
    this.hits.delete(chatKey);
    this.hits.set(chatKey, recent);
    this.evictIfNeeded(nowMs);
    return true;
  }

  private evictIfNeeded(nowMs: number): void {
    if (this.hits.size <= MAX_TRACKED_CHATS) return;
    for (const [key, times] of this.hits) {
      if (this.hits.size <= MAX_TRACKED_CHATS) return;
      const last = times[times.length - 1] ?? 0;
      if (nowMs - last >= this.windowMs) this.hits.delete(key);
    }
    // Still too many (all busy): drop the oldest entries.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_TRACKED_CHATS) return;
      this.hits.delete(key);
    }
  }
}
