import { createHmac, timingSafeEqual } from 'node:crypto';
import { telegramUserIdSchema } from '@iorder/shared';
import { z } from 'zod';
import type { Clock } from '../../common/clock/clock.js';

/**
 * Official Telegram Mini App check (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * secret = HMAC_SHA256(key "WebAppData", data bot token); expected hash =
 * HMAC_SHA256(key secret, data-check-string), where the data-check-string is every received
 * field except `hash` as `key=value`, sorted by key, joined with "\n".
 */
const SECRET_KEY_CONSTANT = 'WebAppData';

/**
 * Default limit: init data older than this is rejected (ADR-001 §3.6: stale data is rejected by
 * timestamp). 24 hours because an open Mini App session reuses the same signed init data; the
 * running app takes the value from TELEGRAM_INIT_DATA_MAX_AGE_SECONDS.
 */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Small tolerance for a device clock running ahead of ours. */
export const INIT_DATA_MAX_FUTURE_SKEW_SECONDS = 60;
/** Real init data is well under 2 KB; anything near this size is not from Telegram. */
const MAX_INIT_DATA_LENGTH = 8192;

export type InitDataFailureReason =
  | 'MALFORMED'
  | 'MISSING_HASH'
  | 'DUPLICATE_FIELD'
  | 'BAD_SIGNATURE'
  | 'MISSING_AUTH_DATE'
  | 'EXPIRED'
  | 'FROM_THE_FUTURE'
  | 'BAD_USER';

export interface TelegramInitDataUser {
  /** Decimal string: Telegram ids are 64-bit in the database and never travel as JS numbers. */
  telegramUserId: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface VerifiedInitData {
  user: TelegramInitDataUser;
  authDate: Date;
}

export type InitDataResult =
  { ok: true; data: VerifiedInitData } | { ok: false; reason: InitDataFailureReason };

const failure = (reason: InitDataFailureReason): InitDataResult => ({ ok: false, reason });

// Telegram adds user fields over time (is_premium, photo_url, ...). Unknown keys are dropped
// (plain z.object), known ones are checked strictly. The id is a safe integer or a digit string.
const userSchema = z
  .object({
    id: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]),
    first_name: z.string().trim().min(1).max(256),
    last_name: z.string().max(256).optional(),
    username: z.string().max(64).optional(),
    language_code: z.string().max(35).optional(),
  })
  .transform((raw, ctx) => {
    const id = telegramUserIdSchema.safeParse(String(raw.id));
    if (!id.success) {
      ctx.addIssue({ code: 'custom', message: 'invalid telegram id' });
      return z.NEVER;
    }
    const user: TelegramInitDataUser = {
      telegramUserId: id.data,
      firstName: raw.first_name,
      ...(raw.last_name === undefined ? {} : { lastName: raw.last_name }),
      ...(raw.username === undefined ? {} : { username: raw.username }),
      ...(raw.language_code === undefined ? {} : { languageCode: raw.language_code }),
    };
    return user;
  });

export interface InitDataVerifierOptions {
  /** A secret. Held in memory only; never logged, never part of an error. */
  botToken: string;
  clock: Clock;
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

/**
 * Pure apart from reading the Clock. Returns a result instead of throwing, and the failure
 * reason is for tests and metrics only: callers must answer every failure the same way.
 * The init data and the token are never logged or included in any value this class returns.
 */
export class TelegramInitDataVerifier {
  private readonly secret: Buffer;
  private readonly clock: Clock;
  private readonly maxAgeSeconds: number;
  private readonly maxFutureSkewSeconds: number;

  constructor(options: InitDataVerifierOptions) {
    if (options.botToken.length === 0) throw new Error('Bot token must not be empty');
    this.secret = createHmac('sha256', SECRET_KEY_CONSTANT).update(options.botToken).digest();
    this.clock = options.clock;
    this.maxAgeSeconds = options.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS;
    this.maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? INIT_DATA_MAX_FUTURE_SKEW_SECONDS;
  }

  verify(initData: string): InitDataResult {
    if (initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH)
      return failure('MALFORMED');

    const fields = new Map<string, string>();
    for (const [key, value] of new URLSearchParams(initData)) {
      if (fields.has(key)) return failure('DUPLICATE_FIELD');
      fields.set(key, value);
    }

    const hash = fields.get('hash');
    if (hash === undefined) return failure('MISSING_HASH');
    fields.delete('hash');

    if (!this.signatureMatches(fields, hash)) return failure('BAD_SIGNATURE');

    // Only a signed payload is interpreted from here on.
    const authDate = parseAuthDate(fields.get('auth_date'));
    if (authDate === null) return failure('MISSING_AUTH_DATE');
    const ageSeconds = (this.clock.now().getTime() - authDate.getTime()) / 1000;
    if (ageSeconds > this.maxAgeSeconds) return failure('EXPIRED');
    if (ageSeconds < -this.maxFutureSkewSeconds) return failure('FROM_THE_FUTURE');

    const user = parseUser(fields.get('user'));
    if (user === null) return failure('BAD_USER');
    return { ok: true, data: { user, authDate } };
  }

  private signatureMatches(fields: ReadonlyMap<string, string>, hash: string): boolean {
    // Exactly 64 hex characters, so the buffers below always have the same length.
    if (!/^[0-9a-f]{64}$/i.test(hash)) return false;
    const dataCheckString = [...fields.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const expected = createHmac('sha256', this.secret).update(dataCheckString).digest();
    return timingSafeEqual(expected, Buffer.from(hash, 'hex'));
  }
}

function parseAuthDate(raw: string | undefined): Date | null {
  if (raw === undefined || !/^\d{1,12}$/.test(raw)) return null;
  return new Date(Number(raw) * 1000);
}

function parseUser(raw: string | undefined): TelegramInitDataUser | null {
  if (raw === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = userSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
