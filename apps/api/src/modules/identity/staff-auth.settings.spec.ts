import { describe, expect, it } from 'vitest';
import {
  failureRoundIsOver,
  isSessionLive,
  lockSecondsAfterFailures,
  PASSWORD_LOCK_MAX_SECONDS,
  resolveStaffAuthSettings,
  sessionExpiry,
  STAFF_SESSION_ABSOLUTE_SECONDS,
  STAFF_SESSION_IDLE_SECONDS,
  TELEGRAM_LOGIN_MAX_AGE_SECONDS,
} from './staff-auth.settings.js';

describe('failureRoundIsOver', () => {
  const now = at('2026-10-21T12:00:00Z');
  it('keeps counting while failures are recent and no lock was served', () => {
    expect(failureRoundIsOver({ lastFailedAt: null, lockedUntil: null }, now)).toBe(false);
    expect(
      failureRoundIsOver({ lastFailedAt: at('2026-10-21T11:31:00Z'), lockedUntil: null }, now),
    ).toBe(false);
    // Still locked: the round is not over.
    expect(
      failureRoundIsOver(
        { lastFailedAt: at('2026-10-21T11:59:00Z'), lockedUntil: at('2026-10-21T12:01:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('starts again after 30 quiet minutes, and once a lock has been served', () => {
    expect(
      failureRoundIsOver({ lastFailedAt: at('2026-10-21T11:29:59Z'), lockedUntil: null }, now),
    ).toBe(true);
    expect(
      failureRoundIsOver(
        { lastFailedAt: at('2026-10-21T11:59:00Z'), lockedUntil: at('2026-10-21T12:00:00Z') },
        now,
      ),
    ).toBe(true);
  });
});

const at = (iso: string): Date => new Date(iso);

describe('staff auth settings', () => {
  // [C] 2026-11-09: a person who opens the site at least once in two weeks is not asked to sign in
  // again. The idle limit is the two weeks; the absolute limit [P] only bounds a stolen token.
  it('defaults to 14 d idle, 90 d absolute and a 5 minute widget proof', () => {
    expect(STAFF_SESSION_IDLE_SECONDS).toBe(14 * 24 * 3600);
    expect(STAFF_SESSION_ABSOLUTE_SECONDS).toBe(90 * 24 * 3600);
    expect(TELEGRAM_LOGIN_MAX_AGE_SECONDS).toBe(300);
    expect(resolveStaffAuthSettings({})).toEqual({
      idleSeconds: 1_209_600,
      absoluteSeconds: 7_776_000,
      loginMaxAgeSeconds: 300,
    });
  });

  it('leaves room for many two-week rounds before the absolute limit', () => {
    const { idleSeconds, absoluteSeconds } = resolveStaffAuthSettings({});
    expect(absoluteSeconds).toBeGreaterThanOrEqual(6 * idleSeconds);
  });

  it('takes the environment values, and never lets idle exceed absolute', () => {
    expect(
      resolveStaffAuthSettings({
        STAFF_SESSION_IDLE_SECONDS: 600,
        STAFF_SESSION_ABSOLUTE_SECONDS: 3600,
        TELEGRAM_LOGIN_MAX_AGE_SECONDS: 60,
      }),
    ).toEqual({ idleSeconds: 600, absoluteSeconds: 3600, loginMaxAgeSeconds: 60 });
    expect(
      resolveStaffAuthSettings({
        STAFF_SESSION_IDLE_SECONDS: 90_000,
        STAFF_SESSION_ABSOLUTE_SECONDS: 3600,
      }).idleSeconds,
    ).toBe(3600);
  });
});

describe('session expiry maths (fake clock)', () => {
  const session = {
    createdAt: at('2026-10-22T00:00:00Z'),
    lastSeenAt: at('2026-10-22T10:00:00Z'),
    expiresAt: at('2026-10-29T00:00:00Z'),
    revokedAt: null,
  };
  const idle = 12 * 3600;

  it('is live inside both limits', () => {
    expect(isSessionLive(session, at('2026-10-22T21:59:59Z'), idle)).toBe(true);
  });

  it('dies exactly at the idle limit', () => {
    expect(isSessionLive(session, at('2026-10-22T22:00:00Z'), idle)).toBe(false);
  });

  it('dies at the absolute limit even when it was just used', () => {
    const busy = { ...session, lastSeenAt: at('2026-10-28T23:59:00Z') };
    expect(isSessionLive(busy, at('2026-10-28T23:59:59Z'), idle)).toBe(true);
    expect(isSessionLive(busy, at('2026-10-29T00:00:00Z'), idle)).toBe(false);
  });

  it('is dead once revoked', () => {
    expect(
      isSessionLive(
        { ...session, revokedAt: at('2026-10-22T10:01:00Z') },
        at('2026-10-22T10:02:00Z'),
        idle,
      ),
    ).toBe(false);
  });

  it('reports the idle end capped by the absolute end', () => {
    expect(sessionExpiry(session, idle)).toEqual({
      expiresAt: session.expiresAt,
      idleExpiresAt: at('2026-10-22T22:00:00Z'),
    });
    expect(
      sessionExpiry({ ...session, lastSeenAt: at('2026-10-28T20:00:00Z') }, idle).idleExpiresAt,
    ).toEqual(session.expiresAt);
  });
});

describe('password lock backoff', () => {
  it('does not lock before the fifth consecutive failure', () => {
    for (const failures of [0, 1, 4]) expect(lockSecondsAfterFailures(failures)).toBe(0);
  });

  it('locks for a minute at five, then doubles up to the cap', () => {
    expect([5, 6, 7, 8, 9].map(lockSecondsAfterFailures)).toEqual([60, 120, 240, 480, 900]);
    expect(lockSecondsAfterFailures(1_000_000)).toBe(PASSWORD_LOCK_MAX_SECONDS);
  });
});
