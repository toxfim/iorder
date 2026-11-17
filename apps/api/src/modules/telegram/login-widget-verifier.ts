import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../common/clock/clock.js';

/**
 * Telegram Login Widget check (https://core.telegram.org/widgets/login#checking-authorization):
 * secret = SHA256(bot token); expected hash = HMAC_SHA256(secret, data-check-string), where the
 * data-check-string is every received field except `hash` as `key=value`, sorted by key, joined
 * with "\n". Note this differs from the Mini App check (HMAC with the key "WebAppData").
 */

/** The widget's login proof is short-lived: it only has to survive one redirect or callback. */
export const LOGIN_WIDGET_MAX_AGE_SECONDS = 300;
/** Small tolerance for a device clock running ahead of ours. */
export const LOGIN_WIDGET_MAX_FUTURE_SKEW_SECONDS = 60;

/** The only fields the widget signs. Anything else is refused, not ignored. */
const ALLOWED_FIELDS = new Set([
  'id',
  'first_name',
  'last_name',
  'username',
  'photo_url',
  'auth_date',
  'hash',
]);

export type LoginWidgetFailureReason =
  'UNKNOWN_FIELD' | 'BAD_FIELD' | 'BAD_SIGNATURE' | 'EXPIRED' | 'FROM_THE_FUTURE';

export interface VerifiedLoginWidget {
  /** Decimal string, like every Telegram id outside the database. */
  telegramUserId: string;
  authDate: Date;
  /** The proof itself (lowercase hex), for single-use bookkeeping. */
  hash: string;
}

export type LoginWidgetResult =
  { ok: true; data: VerifiedLoginWidget } | { ok: false; reason: LoginWidgetFailureReason };

const failure = (reason: LoginWidgetFailureReason): LoginWidgetResult => ({ ok: false, reason });

export interface LoginWidgetVerifierOptions {
  /** A secret. Held (as its SHA-256) in memory only; never logged, never part of a result. */
  botToken: string;
  clock: Clock;
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

/**
 * Pure apart from reading the Clock. Returns a result instead of throwing; the failure reason is
 * for audit and tests only, and callers must answer every failure the same way.
 */
export class TelegramLoginWidgetVerifier {
  private readonly secret: Buffer;
  private readonly clock: Clock;
  private readonly maxAgeSeconds: number;
  private readonly maxFutureSkewSeconds: number;

  constructor(options: LoginWidgetVerifierOptions) {
    if (options.botToken.length === 0) throw new Error('Bot token must not be empty');
    this.secret = createHash('sha256').update(options.botToken).digest();
    this.clock = options.clock;
    this.maxAgeSeconds = options.maxAgeSeconds ?? LOGIN_WIDGET_MAX_AGE_SECONDS;
    this.maxFutureSkewSeconds =
      options.maxFutureSkewSeconds ?? LOGIN_WIDGET_MAX_FUTURE_SKEW_SECONDS;
  }

  verify(payload: Readonly<Record<string, unknown>>): LoginWidgetResult {
    const fields = new Map<string, string>();
    for (const [key, value] of Object.entries(payload)) {
      if (!ALLOWED_FIELDS.has(key)) return failure('UNKNOWN_FIELD');
      if (value === undefined) continue;
      // Only strings and safe integers can have been signed by Telegram.
      if (typeof value === 'number' && Number.isSafeInteger(value)) fields.set(key, String(value));
      else if (typeof value === 'string') fields.set(key, value);
      else return failure('BAD_FIELD');
    }

    const hash = fields.get('hash');
    const id = fields.get('id');
    const authDateRaw = fields.get('auth_date');
    if (hash === undefined || id === undefined || authDateRaw === undefined) {
      return failure('BAD_FIELD');
    }
    if (!/^[0-9a-f]{64}$/i.test(hash)) return failure('BAD_FIELD');
    fields.delete('hash');

    if (!this.signatureMatches(fields, hash)) return failure('BAD_SIGNATURE');

    // Only a signed payload is interpreted from here on.
    if (!/^[1-9]\d{0,15}$/.test(id) || !/^\d{1,12}$/.test(authDateRaw)) return failure('BAD_FIELD');
    const authDate = new Date(Number(authDateRaw) * 1000);
    const ageSeconds = (this.clock.now().getTime() - authDate.getTime()) / 1000;
    if (ageSeconds > this.maxAgeSeconds) return failure('EXPIRED');
    if (ageSeconds < -this.maxFutureSkewSeconds) return failure('FROM_THE_FUTURE');
    return { ok: true, data: { telegramUserId: id, authDate, hash: hash.toLowerCase() } };
  }

  private signatureMatches(fields: ReadonlyMap<string, string>, hash: string): boolean {
    const dataCheckString = [...fields.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const expected = createHmac('sha256', this.secret).update(dataCheckString).digest();
    return timingSafeEqual(expected, Buffer.from(hash, 'hex'));
  }
}
