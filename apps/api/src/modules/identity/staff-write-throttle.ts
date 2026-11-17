import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../common/errors/domain-errors.js';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter.js';
import { STAFF_WRITE_LIMIT_PER_ACTOR, STAFF_WRITE_WINDOW_SECONDS } from './staff-auth.settings.js';

/**
 * Per-actor cap on creating staff accounts and linking Telegram ids, so a stolen manager session
 * cannot mint accounts or take over peers at machine speed. Process local like the sign-in
 * throttle. Answers the usual 429 with Retry-After.
 */
@Injectable()
export class StaffWriteThrottle {
  private readonly limiter = new FixedWindowRateLimiter(
    STAFF_WRITE_LIMIT_PER_ACTOR,
    STAFF_WRITE_WINDOW_SECONDS * 1000,
  );

  check(actorUserId: string, nowMs: number): void {
    const decision = this.limiter.hit(actorUserId, nowMs);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }
}
