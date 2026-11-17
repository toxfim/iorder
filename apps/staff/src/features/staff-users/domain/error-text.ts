import {
  ApiConflictError,
  ApiNotFoundError,
  ApiRateLimitedError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';

export interface ErrorText {
  /** Message key under `staffUsers.errors`. */
  readonly key:
    | 'forbidden'
    | 'notFound'
    | 'conflict'
    | 'lastAdmin'
    | 'telegramIdRequired'
    | 'rateLimited'
    | 'invalid'
    | 'generic';
  readonly params?: Readonly<Record<string, number>>;
}

/**
 * One text per kind of failure, never the server's wording. A 403 is the same text whatever its
 * cause (the api answers every refusal alike, so the page must not guess which one it was). A 409
 * has its own text only for the reasons these screens can cause; any other is the generic one.
 */
export function errorTextFor(error: unknown): ErrorText {
  if (error instanceof PermissionDeniedError) return { key: 'forbidden' };
  if (error instanceof ApiNotFoundError) return { key: 'notFound' };
  if (error instanceof ApiConflictError) {
    if (error.reason === 'LAST_ADMIN') return { key: 'lastAdmin' };
    if (error.reason === 'TELEGRAM_ID_REQUIRED') return { key: 'telegramIdRequired' };
    return { key: 'conflict' };
  }
  if (error instanceof ApiRateLimitedError) {
    return { key: 'rateLimited', params: { seconds: error.retryAfterSeconds } };
  }
  if (error instanceof ApiValidationError) return { key: 'invalid' };
  return { key: 'generic' };
}
