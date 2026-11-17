import { describe, expect, it } from 'vitest';
import { Clock } from '../../common/clock/clock.js';
import { signedLoginWidget } from '../../../test/support/login-widget.js';
import { FAKE_BOT_TOKEN } from '../../../test/support/init-data.js';
import { telegramWidgetSignInRequestSchema } from '@iorder/shared/staff-auth';
import { TelegramLoginWidgetVerifier } from './login-widget-verifier.js';

const NOW = new Date('2026-10-22T08:00:00Z');

class FixedClock extends Clock {
  now(): Date {
    return NOW;
  }
}

const verifier = new TelegramLoginWidgetVerifier({
  botToken: FAKE_BOT_TOKEN,
  clock: new FixedClock(),
});
const signed = (ageSeconds = 0, extra?: Record<string, string | number>) =>
  signedLoginWidget({
    telegramUserId: 424_242n,
    now: NOW,
    ageSeconds,
    ...(extra ? { extra } : {}),
  });

describe('TelegramLoginWidgetVerifier', () => {
  it('accepts a correctly signed, fresh payload and returns the id as a string', () => {
    const payload = signed();
    const result = verifier.verify(payload);
    expect(result).toEqual({
      ok: true,
      data: {
        telegramUserId: '424242',
        authDate: NOW,
        hash: payload['hash'],
      },
    });
  });

  it('accepts the optional signed fields (last_name, photo_url)', () => {
    const payload = signed(0, { last_name: 'Last', photo_url: 'https://t.me/i/userpic/1.jpg' });
    expect(verifier.verify(payload).ok).toBe(true);
  });

  it('rejects a wrong bot token', () => {
    const payload = signedLoginWidget({
      telegramUserId: 1n,
      now: NOW,
      token: '1:other-fake-token',
    });
    expect(verifier.verify(payload)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a tampered field', () => {
    expect(verifier.verify({ ...signed(), id: 999_999 })).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a stale payload and one from the future', () => {
    expect(verifier.verify(signed(301))).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verifier.verify(signed(299)).ok).toBe(true);
    expect(verifier.verify(signed(-3600))).toEqual({ ok: false, reason: 'FROM_THE_FUTURE' });
  });

  it('rejects a field that is not part of the widget payload, even when it is signed', () => {
    const payload = signed(0, { is_admin: 1 });
    expect(verifier.verify(payload)).toEqual({ ok: false, reason: 'UNKNOWN_FIELD' });
  });

  it('rejects a missing or malformed hash and non-scalar values', () => {
    const { hash: _hash, ...withoutHash } = signed();
    void _hash;
    expect(verifier.verify(withoutHash)).toEqual({ ok: false, reason: 'BAD_FIELD' });
    expect(verifier.verify({ ...signed(), hash: 'abc' })).toEqual({
      ok: false,
      reason: 'BAD_FIELD',
    });
    expect(verifier.verify({ ...signed(), username: { a: 1 } })).toEqual({
      ok: false,
      reason: 'BAD_FIELD',
    });
  });

  it('refuses an empty bot token at construction', () => {
    expect(
      () => new TelegramLoginWidgetVerifier({ botToken: '', clock: new FixedClock() }),
    ).toThrow();
  });
});

describe('telegramWidgetSignInRequestSchema', () => {
  it('rejects unknown fields (strict)', () => {
    expect(telegramWidgetSignInRequestSchema.safeParse(signed()).success).toBe(true);
    expect(telegramWidgetSignInRequestSchema.safeParse({ ...signed(), extra: 'x' }).success).toBe(
      false,
    );
  });
});
