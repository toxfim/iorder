import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../common/errors/domain-errors.js';
import {
  AnonymousFailureAggregator,
  SignInThrottle,
  throttleKeyForIp,
  UsedProofs,
} from './sign-in-guards.js';
import {
  GLOBAL_FAILURE_LIMIT,
  SIGN_IN_LIMIT_PER_IP,
  SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER,
  SIGN_IN_WINDOW_SECONDS,
} from './staff-auth.settings.js';

describe('SignInThrottle', () => {
  it('refuses the attempt after the per IP and identifier limit, with the wait', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
      throttle.check('1.1.1.1', 'login:alice', 0);
    }
    expect(() => throttle.check('1.1.1.1', 'login:alice', 1_000)).toThrow(RateLimitedError);
    try {
      throttle.check('1.1.1.1', 'login:alice', 1_000);
    } catch (error) {
      expect((error as RateLimitedError).retryAfterSeconds).toBe(SIGN_IN_WINDOW_SECONDS - 1);
    }
  });

  it('keeps another identifier or another address unaffected', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
      throttle.check('1.1.1.1', 'login:alice', 0);
    }
    expect(() => throttle.check('1.1.1.1', 'login:bob', 0)).not.toThrow();
    expect(() => throttle.check('2.2.2.2', 'login:alice', 0)).not.toThrow();
  });

  it('limits one address across many identifiers', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP; i += 1) throttle.check('3.3.3.3', `login:u${i}`, 0);
    expect(() => throttle.check('3.3.3.3', 'login:fresh', 0)).toThrow(RateLimitedError);
  });

  it('lets attempts through again after the window', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
      throttle.check('1.1.1.1', 'login:alice', 0);
    }
    expect(() =>
      throttle.check('1.1.1.1', 'login:alice', SIGN_IN_WINDOW_SECONDS * 1000),
    ).not.toThrow();
  });
});

describe('SignInThrottle counts failures only', () => {
  const attempt = (throttle: SignInThrottle, ip: string, id: string, ok: boolean, t: number) => {
    throttle.check(ip, id, t);
    if (ok) throttle.release(ip, id, t);
  };

  it('lets a known login sign in successfully far more than the failure budget', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER + 2; i += 1) {
      expect(() => attempt(throttle, '1.1.1.1', 'login:alice', true, i * 1_000)).not.toThrow();
    }
    expect(() => attempt(throttle, '1.1.1.1', 'login:alice', true, 20_000)).not.toThrow();
  });

  it('9 failures, a success, then a failure is allowed; the next attempt is refused', () => {
    const throttle = new SignInThrottle();
    const budget = SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER;
    for (let i = 0; i < budget - 1; i += 1) attempt(throttle, '1.1.1.1', 'login:alice', false, 0);
    attempt(throttle, '1.1.1.1', 'login:alice', true, 1_000);
    expect(() => attempt(throttle, '1.1.1.1', 'login:alice', false, 2_000)).not.toThrow();
    expect(() => throttle.check('1.1.1.1', 'login:alice', 3_000)).toThrow(RateLimitedError);
  });

  it('a success does not give back failures: only its own attempt is refunded', () => {
    const throttle = new SignInThrottle();
    const budget = SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER;
    for (let i = 0; i < budget; i += 1) attempt(throttle, '1.1.1.1', 'login:alice', false, 0);
    // The budget is spent, so even the right password is refused (uniform 429).
    expect(() => throttle.check('1.1.1.1', 'login:alice', 1_000)).toThrow(RateLimitedError);
  });

  it('an attacker with one valid account cannot widen the per IP failure gate', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP - 1; i += 1) {
      attempt(throttle, '9.9.9.9', `login:victim${i}`, false, 0);
      attempt(throttle, '9.9.9.9', 'login:mine', true, 0);
    }
    attempt(throttle, '9.9.9.9', 'login:victim-last', false, 0);
    expect(() => throttle.check('9.9.9.9', 'login:victim-next', 1_000)).toThrow(RateLimitedError);
  });

  it('keeps two logins from one address separate for the per-login budget', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
      attempt(throttle, '1.1.1.1', 'login:bob', false, 0);
      attempt(throttle, '1.1.1.1', 'login:alice', true, 0);
    }
    expect(() => throttle.check('1.1.1.1', 'login:bob', 1_000)).toThrow(RateLimitedError);
    expect(() => throttle.check('1.1.1.1', 'login:alice', 1_000)).not.toThrow();
  });

  it('a release after the window ended does not go below zero or free a newer window', () => {
    const throttle = new SignInThrottle();
    throttle.release('1.1.1.1', 'login:alice', 0);
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
      throttle.check('1.1.1.1', 'login:alice', 0);
    }
    expect(() => throttle.check('1.1.1.1', 'login:alice', 1_000)).toThrow(RateLimitedError);
  });
});

describe('UsedProofs', () => {
  it('accepts a proof once and refuses it again while remembered', () => {
    const proofs = new UsedProofs();
    expect(proofs.claim('h1', 0, 1_000)).toBe(true);
    expect(proofs.claim('h1', 500, 1_000)).toBe(false);
    expect(proofs.claim('h2', 500, 1_000)).toBe(true);
  });

  it('forgets a proof after its time to live', () => {
    const proofs = new UsedProofs();
    proofs.claim('h1', 0, 1_000);
    expect(proofs.claim('h1', 1_000, 1_000)).toBe(true);
  });
});

describe('throttleKeyForIp', () => {
  it('leaves IPv4 alone and maps an IPv4-mapped IPv6 address to it', () => {
    expect(throttleKeyForIp('203.0.113.7')).toBe('203.0.113.7');
    expect(throttleKeyForIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses every address of one IPv6 /64 to one key and keeps other /64s apart', () => {
    const a = throttleKeyForIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(throttleKeyForIp('2001:DB8:1:2::1')).toBe(a);
    expect(throttleKeyForIp('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(throttleKeyForIp('2001:db8:1:3::1')).not.toBe(a);
    expect(throttleKeyForIp('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('really limits a client that rotates addresses inside its /64', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
      throttle.check(`2001:db8:1:2::${i + 1}`, 'login:alice', 0);
    }
    expect(() => throttle.check('2001:db8:1:2::ffff', 'login:alice', 0)).toThrow(RateLimitedError);
  });
});

describe('SignInThrottle global failure gate', () => {
  it('answers 429 once the service saw too many failures in a minute, and reopens after it', () => {
    const throttle = new SignInThrottle();
    for (let i = 0; i < GLOBAL_FAILURE_LIMIT; i += 1) {
      expect(() => throttle.assertCapacity(1_000)).not.toThrow();
      throttle.noteFailure(1_000);
    }
    expect(() => throttle.assertCapacity(30_000)).toThrow(RateLimitedError);
    expect(() => throttle.assertCapacity(61_001)).not.toThrow();
  });
});

describe('AnonymousFailureAggregator', () => {
  it('writes the first failure of a reason in a minute and counts the rest in memory', () => {
    const aggregator = new AnonymousFailureAggregator();
    expect(aggregator.decide('PASSWORD:UNKNOWN_LOGIN', 0)).toMatchObject({ write: true });
    for (let i = 1; i <= 50; i += 1) {
      expect(aggregator.decide('PASSWORD:UNKNOWN_LOGIN', i * 1000)).toEqual({ write: false });
    }
    // Another reason has its own bucket.
    expect(aggregator.decide('PASSWORD:BAD_PROOF', 10_000)).toMatchObject({ write: true });
  });

  it('reports the previous minute total with the next written row', () => {
    const aggregator = new AnonymousFailureAggregator();
    aggregator.decide('r', 0);
    aggregator.decide('r', 1_000);
    aggregator.decide('r', 2_000);
    expect(aggregator.decide('r', 60_000)).toEqual({
      write: true,
      previousBucketAttempts: 3,
      previousBucketStart: '1970-01-01T00:00:00.000Z',
    });
    expect(aggregator.decide('r', 120_000)).toEqual({
      write: true,
      previousBucketAttempts: 0,
      previousBucketStart: null,
    });
  });
});
