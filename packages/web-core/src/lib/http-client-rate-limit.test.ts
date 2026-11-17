import { describe, expect, it } from 'vitest';
import { ApiRateLimitedError } from './api-errors';
import { DEFAULT_RETRY_AFTER_SECONDS, createHttpClient } from './http-client';

const spec = { method: 'GET', path: '/x' } as const;
const schema = { safeParse: (data: unknown) => ({ success: true as const, data }) };

function clientAnswering(response: Response) {
  return createHttpClient({ baseUrl: '', fetchImpl: () => Promise.resolve(response) });
}

async function failureOf(response: Response): Promise<unknown> {
  return clientAnswering(response)
    .request(spec, schema)
    .catch((caught: unknown) => caught);
}

describe('429 handling', () => {
  it('reads whole seconds from Retry-After', async () => {
    const failure = await failureOf(
      new Response('{}', { status: 429, headers: { 'Retry-After': '42' } }),
    );
    expect(failure).toBeInstanceOf(ApiRateLimitedError);
    expect((failure as ApiRateLimitedError).retryAfterSeconds).toBe(42);
    expect((failure as ApiRateLimitedError).status).toBe(429);
  });

  it.each([null, 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '-5', '1.5'])(
    'uses the default for an unreadable Retry-After (%s)',
    async (header) => {
      const headers: Record<string, string> = header === null ? {} : { 'Retry-After': header };
      const failure = await failureOf(new Response('<html>', { status: 429, headers }));
      expect((failure as ApiRateLimitedError).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    },
  );

  it('keeps the countdown within sane bounds', async () => {
    const huge = await failureOf(
      new Response('{}', { status: 429, headers: { 'Retry-After': '999999' } }),
    );
    expect((huge as ApiRateLimitedError).retryAfterSeconds).toBe(3600);
    const zero = await failureOf(
      new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }),
    );
    expect((zero as ApiRateLimitedError).retryAfterSeconds).toBe(1);
  });
});
