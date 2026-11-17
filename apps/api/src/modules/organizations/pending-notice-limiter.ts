import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter.js';

/**
 * Anyone on Telegram can add the bot to a group, and every new group creates an INACTIVE
 * organization plus one ORGANIZATION_PENDING notice to every manager and admin. The organization
 * row is cheap and idempotent; the notices are the amplifier (one private message per staff
 * member per group). Beyond these caps a new group is still registered and still listed as
 * pending in the staff app, but no notice is sent. In-process like the other throttles. [P]
 */
export const PENDING_NOTICES_PER_ADDER_PER_HOUR = 5;
export const PENDING_NOTICES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export class PendingNoticeLimiter {
  private readonly perAdder: FixedWindowRateLimiter;
  private readonly global: FixedWindowRateLimiter;

  constructor(
    perAdderPerHour: number = PENDING_NOTICES_PER_ADDER_PER_HOUR,
    perHour: number = PENDING_NOTICES_PER_HOUR,
  ) {
    this.perAdder = new FixedWindowRateLimiter(perAdderPerHour, HOUR_MS);
    this.global = new FixedWindowRateLimiter(perHour, HOUR_MS);
  }

  /**
   * True when a notice for a group added by this person may be sent now. The global budget is
   * only spent when the adder's own budget allowed the notice, so one spammer cannot use up the
   * global budget for everybody else. A group added by nobody in particular (no `from`) shares
   * one anonymous adder budget.
   */
  allow(addedByTelegramUserId: bigint | null, nowMs: number): boolean {
    const adder = addedByTelegramUserId === null ? 'anonymous' : addedByTelegramUserId.toString();
    if (!this.perAdder.hit(`adder:${adder}`, nowMs).allowed) return false;
    return this.global.hit('all', nowMs).allowed;
  }
}
