import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison always runs
 * over equal-length buffers: neither the content nor the length of the secret leaks through the
 * time the comparison takes.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export type WebhookCheck = 'OK' | 'NOT_FOUND' | 'UNAUTHORIZED';

export interface WebhookCheckInput {
  mode: 'off' | 'polling' | 'webhook';
  /** TELEGRAM_WEBHOOK_SECRET; undefined when not configured. */
  expectedSecret: string | undefined;
  /** The `:secret` segment of the URL. */
  pathSecret: string;
  /** The `X-Telegram-Bot-Api-Secret-Token` header, as Telegram sends it with `secret_token`. */
  headerSecret: string | string[] | undefined;
}

/**
 * Decides whether a webhook request may be processed. The route exists only in `webhook` mode
 * (everything else is a plain 404, as if the route were not there) and needs BOTH the secret in
 * the URL and Telegram's secret-token header. Both comparisons always run, so a wrong URL and a
 * wrong header take the same time.
 */
export function checkWebhookRequest(input: WebhookCheckInput): WebhookCheck {
  if (input.mode !== 'webhook' || input.expectedSecret === undefined) return 'NOT_FOUND';
  const pathOk = secretsEqual(input.pathSecret, input.expectedSecret);
  const header = typeof input.headerSecret === 'string' ? input.headerSecret : undefined;
  const headerOk = header !== undefined && secretsEqual(header, input.expectedSecret);
  if (!pathOk) return 'NOT_FOUND';
  return headerOk ? 'OK' : 'UNAUTHORIZED';
}
