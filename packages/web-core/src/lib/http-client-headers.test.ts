import { PRICING_ROUTES, staffVersionResponseSchema } from '@iorder/shared';
import { describe, expect, it, vi } from 'vitest';
import { PermissionDeniedError, UnauthenticatedError } from './api-errors';
import { createHttpClient } from './http-client';

const VERSION = {
  id: '11111111-1111-4111-8111-111111111111',
  number: 3,
  status: 'DRAFT',
  note: null,
  source: 'MANUAL',
  createdAt: '2026-10-19T08:30:00.000Z',
  publishedAt: null,
  publishedBy: null,
  publishedByUserId: null,
};

const respond = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const errorBody = (code: string) => ({ error: { code, message: 'x' } });

async function failureOf(status: number, body?: unknown): Promise<unknown> {
  const client = createHttpClient({
    baseUrl: 'https://api.test',
    fetchImpl: () => Promise.resolve(respond(status, body)),
  });
  return client
    .request(PRICING_ROUTES.getVersion, staffVersionResponseSchema, { params: { id: 'x' } })
    .catch((e: unknown) => e);
}

describe('createHttpClient headers', () => {
  it('sends default headers (read per call) and per-request headers, the latter winning', async () => {
    let token = 'one';
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200, VERSION)));
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      defaultHeaders: () => ({ Authorization: `tma ${token}`, 'X-Test': 'default' }),
    });
    await client.request(PRICING_ROUTES.getVersion, staffVersionResponseSchema, {
      params: { id: VERSION.id },
      headers: { 'X-Test': 'call' },
    });
    token = 'two';
    await client.request(PRICING_ROUTES.getVersion, staffVersionResponseSchema, {
      params: { id: VERSION.id },
    });
    const sent = fetchImpl.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1]);
    expect(sent[0]?.headers).toMatchObject({ Authorization: 'tma one', 'X-Test': 'call' });
    expect(sent[1]?.headers).toMatchObject({ Authorization: 'tma two', 'X-Test': 'default' });
  });
});

describe('createHttpClient 401 and 403', () => {
  it('tells 401 (not authenticated) from 403, both being permission errors', async () => {
    const e401 = await failureOf(401, errorBody('UNAUTHENTICATED'));
    expect(e401).toBeInstanceOf(UnauthenticatedError);
    expect(e401).toBeInstanceOf(PermissionDeniedError);

    const e403 = await failureOf(403, errorBody('FORBIDDEN'));
    expect(e403).toBeInstanceOf(PermissionDeniedError);
    expect(e403).not.toBeInstanceOf(UnauthenticatedError);
  });

  it('keeps the distinction when the body is not the standard error body', async () => {
    expect(await failureOf(401)).toBeInstanceOf(UnauthenticatedError);
    expect(await failureOf(403)).not.toBeInstanceOf(UnauthenticatedError);
  });

  it('sends a form as multipart: the body is the FormData and no Content-Type is forced', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200, VERSION)));
    const client = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'p.png');
    await client.request(PRICING_ROUTES.getVersion, staffVersionResponseSchema, {
      params: { id: VERSION.id },
      form,
      headers: { 'Idempotency-Key': 'key-00000001' },
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe(form);
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'key-00000001' });
    expect(Object.keys(init.headers ?? {})).not.toContain('Content-Type');
  });
});
