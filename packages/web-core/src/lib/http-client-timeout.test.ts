import { PRICING_ROUTES, staffVersionListResponseSchema } from '@iorder/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, RequestTimeoutError } from './api-errors';
import { REQUEST_TIMEOUT_MS, createHttpClient } from './http-client';

afterEach(() => {
  vi.useRealTimers();
});

/** A fetch that never answers, like a hung connection; it only ends when its signal aborts. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    });
}

describe('createHttpClient timeout', () => {
  it('uses a 30 second default deadline', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('aborts a hung request after the deadline and reports a timeout (a NetworkError)', async () => {
    vi.useFakeTimers();
    const client = createHttpClient({ baseUrl: '', fetchImpl: hangingFetch() });
    const outcome = client
      .request(PRICING_ROUTES.listVersions, staffVersionListResponseSchema)
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('passes an abort signal to fetch and honours a custom deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      signal = init?.signal ?? undefined;
      return hangingFetch()(input, init);
    };
    const client = createHttpClient({ baseUrl: '', fetchImpl, timeoutMs: 50 });
    const outcome = client
      .requestVoid(PRICING_ROUTES.discardDraft, { params: { id: 'x' } })
      .catch((e: unknown) => e);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(signal?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it('also covers a body that never finishes arriving', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = (_input, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      } as Response);
    const client = createHttpClient({ baseUrl: '', fetchImpl });
    const outcome = client
      .request(PRICING_ROUTES.listVersions, staffVersionListResponseSchema)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it('clears the timer after a normal answer', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('{"items":[]}', { status: 200 }));
    const client = createHttpClient({ baseUrl: '', fetchImpl });
    await client.request(PRICING_ROUTES.listVersions, staffVersionListResponseSchema);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a user-caused abort that is not our deadline stays a plain NetworkError', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new DOMException('Aborted', 'AbortError'));
    const client = createHttpClient({ baseUrl: '', fetchImpl });
    const error = await client
      .request(PRICING_ROUTES.listVersions, staffVersionListResponseSchema)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
  });

  it('lets one call set its own deadline (a large upload)', async () => {
    vi.useFakeTimers();
    const client = createHttpClient({ baseUrl: '', fetchImpl: hangingFetch() });
    const outcome = client
      .request(PRICING_ROUTES.listVersions, staffVersionListResponseSchema, {
        timeoutMs: 120_000,
      })
      .catch((e: unknown) => e);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000 - REQUEST_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it('refuses a JSON body and a form in one call at compile time', () => {
    const client = createHttpClient({ baseUrl: '', fetchImpl: hangingFetch() });
    const call = () =>
      // @ts-expect-error a request has a JSON body or a multipart form, never both
      client.requestVoid(PRICING_ROUTES.listVersions, { body: {}, form: new FormData() });
    expect(typeof call).toBe('function');
  });
});
