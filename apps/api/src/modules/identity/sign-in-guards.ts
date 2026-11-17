import { Injectable } from '@nestjs/common';
import { isIPv4, isIPv6 } from 'node:net';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter.js';
import { RateLimitedError } from '../../common/errors/domain-errors.js';
import {
  FAILURE_BUCKET_SECONDS,
  GLOBAL_FAILURE_LIMIT,
  GLOBAL_FAILURE_WINDOW_SECONDS,
  SIGN_IN_LIMIT_PER_IP,
  SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER,
  SIGN_IN_WINDOW_SECONDS,
} from './staff-auth.settings.js';

/**
 * The key an address is throttled under. IPv4 stays as is; IPv6 collapses to its /64 prefix because
 * one subscriber normally owns a whole /64 and could otherwise use 2^64 addresses to dodge the
 * per-address limits. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) counts as the IPv4 address.
 */
export function throttleKeyForIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const address = mapped?.[1] ?? ip;
  if (isIPv4(address) || !isIPv6(address)) return address;
  const [head = '', tail] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tailGroups];
  const prefix = groups.slice(0, 4).map((group) => group.toLowerCase().padStart(4, '0'));
  return `${prefix.join(':')}::/64`;
}

/**
 * The in-process throttles in front of both public sign-in endpoints. Every FAILED attempt counts,
 * whether or not the identifier exists, so the 429 reveals nothing about accounts; a successful
 * sign-in does not use up the budget (see `release`). `ip` is the socket
 * address (`request.ip`); X-Forwarded-For is never trusted here. Behind a reverse proxy the
 * deployment must set TRUST_PROXY correctly, otherwise every client shares one address.
 */
@Injectable()
export class SignInThrottle {
  private readonly perIp = new FixedWindowRateLimiter(
    SIGN_IN_LIMIT_PER_IP,
    SIGN_IN_WINDOW_SECONDS * 1000,
  );
  private readonly perIpAndIdentifier = new FixedWindowRateLimiter(
    SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER,
    SIGN_IN_WINDOW_SECONDS * 1000,
  );
  private failuresInWindow = 0;
  private failureWindowStartMs = Number.NEGATIVE_INFINITY;

  /**
   * Cheapest possible refusal, called first: once the whole service has seen too many failed
   * sign-ins inside one minute (a spray from many addresses), every sign-in answers 429 before any
   * database or scrypt work. Real users wait out that minute too, which is the price. [P]
   */
  assertCapacity(nowMs: number): void {
    this.rollWindow(nowMs);
    if (this.failuresInWindow < GLOBAL_FAILURE_LIMIT) return;
    const left = this.failureWindowStartMs + GLOBAL_FAILURE_WINDOW_SECONDS * 1000 - nowMs;
    throw new RateLimitedError(Math.max(1, Math.ceil(left / 1000)));
  }

  /** Counts one failed sign-in (any cause) toward the global limit. */
  noteFailure(nowMs: number): void {
    this.rollWindow(nowMs);
    this.failuresInWindow += 1;
  }

  /** Throws RateLimitedError when either limit is spent. */
  check(rawIp: string, identifier: string, nowMs: number): void {
    const ip = throttleKeyForIp(rawIp);
    const wide = this.perIp.hit(`ip:${ip}`, nowMs);
    if (!wide.allowed) throw new RateLimitedError(wide.retryAfterSeconds);
    const narrow = this.perIpAndIdentifier.hit(`${ip}|${identifier}`, nowMs);
    if (!narrow.allowed) throw new RateLimitedError(narrow.retryAfterSeconds);
  }

  /**
   * A sign-in that succeeded gives its own slot back: only FAILED attempts spend the per IP and
   * per IP + identifier budgets. The slot is taken in `check` before the password work (so a burst
   * of parallel guesses cannot all slip past a not-yet-counted budget) and returned here. It
   * refunds exactly the one slot of this attempt, never earlier failures, so a valid account
   * cannot be used to wipe the failure count of other logins from the same address.
   */
  release(rawIp: string, identifier: string, nowMs: number): void {
    const ip = throttleKeyForIp(rawIp);
    this.perIp.refund(`ip:${ip}`, nowMs);
    this.perIpAndIdentifier.refund(`${ip}|${identifier}`, nowMs);
  }

  private rollWindow(nowMs: number): void {
    const windowMs = GLOBAL_FAILURE_WINDOW_SECONDS * 1000;
    if (nowMs >= this.failureWindowStartMs && nowMs - this.failureWindowStartMs < windowMs) return;
    this.failureWindowStartMs = nowMs;
    this.failuresInWindow = 0;
  }
}

/** What the caller should do with one failed attempt that matches no known account. */
export type AnonymousFailureDecision =
  | { write: false }
  | {
      write: true;
      /** Attempts of the previous bucket for this reason that were not written as rows (0 = none). */
      previousBucketAttempts: number;
      previousBucketStart: string | null;
    };

/**
 * Failures that match no account (unknown login, bad widget proof, replay...) cost an attacker
 * nothing and the audit log is append-only, so one row per attempt would let anyone grow it
 * without bound. Instead: at most one row per (reason, minute); the attempts after the first are
 * counted in memory and reported by the NEXT row of that reason (`previousBucketAttempts`). This
 * needs no update of history and no extra table; the cost is that the count of a bucket nobody
 * follows up on (quiet afterwards, or a restart) is never written. Failures of a KNOWN account do
 * not use this: they keep a full row each.
 */
@Injectable()
export class AnonymousFailureAggregator {
  private readonly buckets = new Map<string, { bucket: number; suppressed: number }>();

  decide(reason: string, nowMs: number): AnonymousFailureDecision {
    const bucket = Math.floor(nowMs / (FAILURE_BUCKET_SECONDS * 1000));
    const current = this.buckets.get(reason);
    if (current?.bucket === bucket) {
      current.suppressed += 1;
      return { write: false };
    }
    this.buckets.set(reason, { bucket, suppressed: 0 });
    if (!current || current.suppressed === 0) {
      return { write: true, previousBucketAttempts: 0, previousBucketStart: null };
    }
    return {
      write: true,
      // The first attempt of that bucket was written as its own row, hence the +1.
      previousBucketAttempts: current.suppressed + 1,
      previousBucketStart: new Date(current.bucket * FAILURE_BUCKET_SECONDS * 1000).toISOString(),
    };
  }
}

const MAX_REMEMBERED_PROOFS = 5_000;

/**
 * Remembers Login Widget proofs already used, until they would expire anyway, so one captured
 * payload cannot mint a second session. Process local like the throttle (a second process or a
 * restart forgets), which still shrinks the replay window to a single process lifetime. GO-LIVE
 * GATE: run a single api instance, or move this memory to a database table first.
 */
@Injectable()
export class UsedProofs {
  private readonly seen = new Map<string, number>();

  /** True when the proof is new (and now remembered); false when it was already used. */
  claim(hash: string, nowMs: number, ttlMs: number): boolean {
    for (const [key, until] of this.seen) {
      if (until > nowMs) break;
      this.seen.delete(key);
    }
    if (this.seen.has(hash)) return false;
    this.seen.set(hash, nowMs + ttlMs);
    if (this.seen.size > MAX_REMEMBERED_PROOFS) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
