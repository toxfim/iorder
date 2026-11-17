import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../common/errors/domain-errors.js';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter.js';

/** A person edits their own profile by hand; ten tries a minute is far more than they need. */
export const OWN_CONTACT_LIMIT_PER_ACTOR = 10;
export const OWN_CONTACT_WINDOW_SECONDS = 60;

/**
 * Per-actor cap on a person's writes to their own account (`PUT /me/contact`, the staff
 * `PUT /staff/me/profile`, the customer login). Process local like the other throttles; answers 429.
 */
@Injectable()
export class OwnContactThrottle {
  private readonly limiter = new FixedWindowRateLimiter(
    OWN_CONTACT_LIMIT_PER_ACTOR,
    OWN_CONTACT_WINDOW_SECONDS * 1000,
  );

  check(actorUserId: string, nowMs: number): void {
    const decision = this.limiter.hit(actorUserId, nowMs);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }
}
