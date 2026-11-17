import { createHash, createHmac } from 'node:crypto';
import { FAKE_BOT_TOKEN } from './init-data.js';

/**
 * Builds a correctly signed Telegram Login Widget payload, independently of the production
 * verifier (so a shared bug cannot hide itself): secret = SHA256(token), hash = HMAC-SHA256 of
 * the sorted data-check-string.
 */
export function signedLoginWidget(options: {
  telegramUserId: string | bigint;
  now: Date;
  /** Seconds before `now` that the proof was issued. */
  ageSeconds?: number;
  token?: string;
  extra?: Record<string, string | number>;
}): Record<string, string | number> {
  const authDate = Math.floor(options.now.getTime() / 1000) - (options.ageSeconds ?? 0);
  const fields: Record<string, string | number> = {
    id: Number(options.telegramUserId),
    first_name: 'Tester',
    username: 'tester',
    auth_date: authDate,
    ...options.extra,
  };
  const secret = createHash('sha256')
    .update(options.token ?? FAKE_BOT_TOKEN)
    .digest();
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}
