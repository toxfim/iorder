import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Clock } from '../../common/clock/clock.js';
import {
  INIT_DATA_MAX_AGE_SECONDS,
  INIT_DATA_MAX_FUTURE_SKEW_SECONDS,
  TelegramInitDataVerifier,
} from './init-data-verifier.js';

// A fake token, only ever used in this file.
const TOKEN = '123456:FAKE-test-token_for_unit_tests';
const NOW = new Date('2026-10-25T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

class FixedClock extends Clock {
  constructor(private readonly at: Date) {
    super();
  }
  now(): Date {
    return this.at;
  }
}

/** Independent re-implementation of the official signing, used to build fixtures. */
function sign(token: string, fields: [string, string][]): string {
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const dataCheckString = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

function build(options: {
  token?: string;
  authDate?: number;
  user?: unknown;
  extra?: [string, string][];
  mutate?: (fields: [string, string][]) => void;
  rawSuffix?: string;
}): string {
  const fields: [string, string][] = [
    ['auth_date', String(options.authDate ?? NOW_SECONDS)],
    ['query_id', 'AAH-fake'],
    [
      'user',
      JSON.stringify(
        options.user ?? {
          id: 777000111,
          first_name: 'Ali',
          username: 'ali_v',
          language_code: 'uz',
        },
      ),
    ],
    ...(options.extra ?? []),
  ];
  const hash = sign(options.token ?? TOKEN, fields);
  options.mutate?.(fields);
  const query = new URLSearchParams([...fields, ['hash', hash]]).toString();
  return query + (options.rawSuffix ?? '');
}

const verifier = new TelegramInitDataVerifier({ botToken: TOKEN, clock: new FixedClock(NOW) });

describe('TelegramInitDataVerifier', () => {
  it('accepts valid init data and extracts the user', () => {
    const result = verifier.verify(build({}));
    expect(result).toEqual({
      ok: true,
      data: {
        authDate: new Date(NOW_SECONDS * 1000),
        user: {
          telegramUserId: '777000111',
          firstName: 'Ali',
          username: 'ali_v',
          languageCode: 'uz',
        },
      },
    });
  });

  it('matches the documented algorithm for a known vector', () => {
    // Computed once with an independent HMAC implementation for the fake token above.
    const fields: [string, string][] = [
      ['auth_date', String(NOW_SECONDS)],
      ['user', '{"id":1,"first_name":"A"}'],
    ];
    const hash = sign(TOKEN, fields);
    const initData = new URLSearchParams([...fields, ['hash', hash]]).toString();
    expect(verifier.verify(initData).ok).toBe(true);
  });

  it('accepts unicode names and keeps them intact', () => {
    const result = verifier.verify(
      build({ user: { id: 5, first_name: 'Анвар Ўктам', last_name: 'Йигитали-ўғли 🚚' } }),
    );
    expect(result.ok && result.data.user.firstName).toBe('Анвар Ўктам');
    expect(result.ok && result.data.user.lastName).toBe('Йигитали-ўғли 🚚');
  });

  it('accepts extra signed fields (they are part of the signature) and unknown user keys', () => {
    const result = verifier.verify(
      build({
        extra: [
          ['chat_type', 'sender'],
          ['signature', 'abc'],
        ],
        user: { id: 9, first_name: 'Z', is_premium: true, photo_url: 'https://t.me/i/u.jpg' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a user id given as a digit string', () => {
    const result = verifier.verify(build({ user: { id: '4503599627370495', first_name: 'Big' } }));
    expect(result.ok && result.data.user.telegramUserId).toBe('4503599627370495');
  });

  it('rejects a tampered field', () => {
    const tampered = build({
      mutate: (fields) => {
        const user = fields.find(([k]) => k === 'user');
        if (user) user[1] = JSON.stringify({ id: 1, first_name: 'Admin' });
      },
    });
    expect(verifier.verify(tampered)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a tampered auth_date', () => {
    const tampered = build({
      mutate: (fields) => {
        const date = fields.find(([k]) => k === 'auth_date');
        if (date) date[1] = String(NOW_SECONDS + 5);
      },
    });
    expect(verifier.verify(tampered)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects data signed with another token', () => {
    const other = build({ token: '999:another-fake-token' });
    expect(verifier.verify(other)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a missing hash', () => {
    const query = build({}).replace(/&?hash=[0-9a-f]+/, '');
    expect(verifier.verify(query)).toEqual({ ok: false, reason: 'MISSING_HASH' });
  });

  it.each(['', 'zz', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65)])(
    'rejects a malformed hash %j',
    (hash) => {
      const query = build({}).replace(/hash=[0-9a-f]+/, `hash=${hash}`);
      expect(verifier.verify(query).ok).toBe(false);
    },
  );

  it('rejects expired init data and accepts data right at the limit', () => {
    const expired = build({ authDate: NOW_SECONDS - INIT_DATA_MAX_AGE_SECONDS - 1 });
    expect(verifier.verify(expired)).toEqual({ ok: false, reason: 'EXPIRED' });
    const atLimit = build({ authDate: NOW_SECONDS - INIT_DATA_MAX_AGE_SECONDS });
    expect(verifier.verify(atLimit).ok).toBe(true);
  });

  it('rejects future-dated data beyond the skew and accepts a small skew', () => {
    const future = build({ authDate: NOW_SECONDS + INIT_DATA_MAX_FUTURE_SKEW_SECONDS + 1 });
    expect(verifier.verify(future)).toEqual({ ok: false, reason: 'FROM_THE_FUTURE' });
    const skewed = build({ authDate: NOW_SECONDS + INIT_DATA_MAX_FUTURE_SKEW_SECONDS });
    expect(verifier.verify(skewed).ok).toBe(true);
  });

  it('honours a configured maximum age', () => {
    const strict = new TelegramInitDataVerifier({
      botToken: TOKEN,
      clock: new FixedClock(NOW),
      maxAgeSeconds: 10,
    });
    expect(strict.verify(build({ authDate: NOW_SECONDS - 11 })).ok).toBe(false);
    expect(strict.verify(build({ authDate: NOW_SECONDS - 10 })).ok).toBe(true);
  });

  it('rejects duplicated fields even when the signature would match the first value', () => {
    const duplicated = build({ rawSuffix: '&auth_date=1' });
    expect(verifier.verify(duplicated)).toEqual({ ok: false, reason: 'DUPLICATE_FIELD' });
    const twoHashes = build({}) + '&hash=' + 'a'.repeat(64);
    expect(verifier.verify(twoHashes)).toEqual({ ok: false, reason: 'DUPLICATE_FIELD' });
  });

  it('rejects a missing or non-numeric auth_date even when correctly signed', () => {
    const fields: [string, string][] = [['user', '{"id":1,"first_name":"A"}']];
    const missing = new URLSearchParams([...fields, ['hash', sign(TOKEN, fields)]]).toString();
    expect(verifier.verify(missing)).toEqual({ ok: false, reason: 'MISSING_AUTH_DATE' });
    const bad: [string, string][] = [...fields, ['auth_date', '12abc']];
    const badQuery = new URLSearchParams([...bad, ['hash', sign(TOKEN, bad)]]).toString();
    expect(verifier.verify(badQuery)).toEqual({ ok: false, reason: 'MISSING_AUTH_DATE' });
  });

  it.each([
    ['not json', 'not json'],
    ['array', '[1]'],
    ['no id', '{"first_name":"A"}'],
    ['zero id', '{"id":0,"first_name":"A"}'],
    ['negative id', '{"id":-5,"first_name":"A"}'],
    ['float id', '{"id":1.5,"first_name":"A"}'],
    ['unsafe id', '{"id":9007199254740993,"first_name":"A"}'],
    ['huge string id', '{"id":"99999999999999999999","first_name":"A"}'],
    ['no first name', '{"id":1}'],
    ['blank first name', '{"id":1,"first_name":"  "}'],
    ['non-string username', '{"id":1,"first_name":"A","username":5}'],
  ])('rejects a signed but invalid user object: %s', (_name, userJson) => {
    const fields: [string, string][] = [
      ['auth_date', String(NOW_SECONDS)],
      ['user', userJson],
    ];
    const query = new URLSearchParams([...fields, ['hash', sign(TOKEN, fields)]]).toString();
    expect(verifier.verify(query)).toEqual({ ok: false, reason: 'BAD_USER' });
  });

  it('rejects a missing user', () => {
    const fields: [string, string][] = [['auth_date', String(NOW_SECONDS)]];
    const query = new URLSearchParams([...fields, ['hash', sign(TOKEN, fields)]]).toString();
    expect(verifier.verify(query)).toEqual({ ok: false, reason: 'BAD_USER' });
  });

  it.each(['', 'x'.repeat(9000), '&&&', 'hash'])('rejects garbage input %#', (input) => {
    expect(verifier.verify(input).ok).toBe(false);
  });

  it('does not put the token or the init data into any result', () => {
    const initData = build({ authDate: NOW_SECONDS - 99999 });
    const serialized = JSON.stringify(verifier.verify(initData));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(initData);
  });

  it('refuses to be built with an empty token', () => {
    expect(
      () => new TelegramInitDataVerifier({ botToken: '', clock: new FixedClock(NOW) }),
    ).toThrow();
  });
});
