import { PRICING_ROUTES, staffVersionResponseSchema } from '@iorder/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiResponseError,
  ApiValidationError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
} from './api-errors';
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

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function clientWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {})),
  );
  return { fetchImpl, client: createHttpClient({ baseUrl: 'https://api.test/', fetchImpl }) };
}

function errorBody(code: string, message: string, details?: unknown, reason?: string) {
  return {
    error: {
      code,
      message,
      ...(reason === undefined ? {} : { reason }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

describe('createHttpClient requests', () => {
  it('builds the URL from the shared route table and sends JSON', async () => {
    const { client, fetchImpl } = clientWith(() => respond(200, VERSION));
    await client.request(PRICING_ROUTES.updateDraft, staffVersionResponseSchema, {
      params: { id: VERSION.id },
      body: { note: 'x' },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.test/staff/price-list/drafts/${VERSION.id}`);
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"note":"x"}');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('sends no body and no content type for a GET', async () => {
    const { client, fetchImpl } = clientWith(() => respond(200, VERSION));
    await client.request(PRICING_ROUTES.getVersion, staffVersionResponseSchema, {
      params: { id: VERSION.id },
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty('Content-Type');
  });

  it('works with an empty base URL (same origin)', async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      void input;
      return Promise.resolve(respond(200, VERSION));
    });
    const client = createHttpClient({ baseUrl: '', fetchImpl });
    await client.request(PRICING_ROUTES.listVersions, staffVersionResponseSchema);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/staff/price-list/versions');
  });

  it('encodes path parameters', async () => {
    const { client, fetchImpl } = clientWith(() => respond(204));
    await client.requestVoid(PRICING_ROUTES.removeDraftItem, {
      params: { id: 'a/b', productId: 'c d' },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.test/staff/price-list/drafts/a%2Fb/items/c%20d',
    );
  });

  it('appends a query string, skipping undefined values and encoding the rest', async () => {
    const { client, fetchImpl } = clientWith(() => respond(200, VERSION));
    await client.request(PRICING_ROUTES.listVersions, staffVersionResponseSchema, {
      query: { search: 'a&b c', category: undefined, inStock: 'true' },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.test/staff/price-list/versions?search=a%26b+c&inStock=true',
    );
  });

  it('adds no question mark when every query value is undefined', async () => {
    const { client, fetchImpl } = clientWith(() => respond(200, VERSION));
    await client.request(PRICING_ROUTES.listVersions, staffVersionResponseSchema, {
      query: { category: undefined },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.test/staff/price-list/versions');
  });

  it('accepts 204 for void routes', async () => {
    const { client } = clientWith(() => respond(204));
    await expect(
      client.requestVoid(PRICING_ROUTES.discardDraft, { params: { id: 'x' } }),
    ).resolves.toBeUndefined();
  });
});

describe('createHttpClient response parsing', () => {
  it('returns the parsed data', async () => {
    const { client } = clientWith(() => respond(200, VERSION));
    const result = await client.request(PRICING_ROUTES.createDraft, staffVersionResponseSchema, {
      body: {},
    });
    expect(result.number).toBe(3);
  });

  it('turns a body that violates the contract into InvalidResponseError (never a crash)', async () => {
    const { client } = clientWith(() => respond(200, { ...VERSION, status: 'WAITING' }));
    await expect(
      client.request(PRICING_ROUTES.createDraft, staffVersionResponseSchema, { body: {} }),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('rejects extra keys (strict schemas catch a leaked field)', async () => {
    const { client } = clientWith(() => respond(200, { ...VERSION, costPrice: '1.00' }));
    await expect(
      client.request(PRICING_ROUTES.createDraft, staffVersionResponseSchema, { body: {} }),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('rejects a non-JSON 200 (for example a proxy login page)', async () => {
    const { client } = clientWith(() => new Response('<html>', { status: 200 }));
    await expect(
      client.request(PRICING_ROUTES.listVersions, staffVersionResponseSchema),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('createHttpClient error mapping', () => {
  async function failure(status: number, body?: unknown): Promise<unknown> {
    const { client } = clientWith(() => respond(status, body));
    return client
      .request(PRICING_ROUTES.listVersions, staffVersionResponseSchema)
      .catch((e: unknown) => e);
  }

  it('maps 401 and 403 to PermissionDeniedError', async () => {
    expect(
      await failure(401, errorBody('UNAUTHENTICATED', 'Authentication required')),
    ).toBeInstanceOf(PermissionDeniedError);
    expect(await failure(403, errorBody('FORBIDDEN', 'Access denied'))).toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('maps 404 and 409 keeping code and details', async () => {
    const notFound = await failure(404, errorBody('NOT_FOUND', 'Gone', { productIds: ['p'] }));
    expect(notFound).toBeInstanceOf(ApiNotFoundError);
    expect(notFound).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      details: { productIds: ['p'] },
    });

    const conflict = await failure(409, errorBody('CONFLICT', 'Inactive', { productIds: ['p1'] }));
    expect(conflict).toBeInstanceOf(ApiConflictError);
    expect(conflict).toMatchObject({ status: 409, details: { productIds: ['p1'] } });
  });

  it('reads the machine-readable 409 reason', async () => {
    const error = await failure(
      409,
      errorBody('CONFLICT', 'A draft is open', undefined, 'DRAFT_ALREADY_OPEN'),
    );
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBe('DRAFT_ALREADY_OPEN');
  });

  it('keeps a 409 with a reason this client does not know as a generic conflict', async () => {
    const error = await failure(409, {
      error: { code: 'CONFLICT', message: 'new thing', reason: 'SOMETHING_FROM_A_NEWER_SERVER' },
    });
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBeUndefined();
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('maps 422 to ApiValidationError with parsed issues and drops malformed ones', async () => {
    const error = await failure(
      422,
      errorBody('VALIDATION_FAILED', 'Request validation failed', [
        { path: 'items.2.basePrice', message: 'Price must be positive' },
        { nope: true },
      ]),
    );
    expect(error).toBeInstanceOf(ApiValidationError);
    expect((error as ApiValidationError).issues).toEqual([
      { path: 'items.2.basePrice', message: 'Price must be positive' },
    ]);
  });

  it('keeps the raw details of a 422 that is not about fields (a whole-file reason)', async () => {
    const error = await failure(
      422,
      errorBody('VALIDATION_FAILED', 'Not an .xlsx file', { reason: 'FILE_NOT_XLSX' }),
    );
    expect(error).toBeInstanceOf(ApiValidationError);
    expect((error as ApiValidationError).issues).toEqual([]);
    expect((error as ApiValidationError).details).toEqual({ reason: 'FILE_NOT_XLSX' });
  });

  it('keeps unknown statuses as ApiResponseError and survives a foreign error body', async () => {
    const internal = await failure(500, errorBody('INTERNAL_ERROR', 'Internal server error'));
    expect(internal).toBeInstanceOf(ApiResponseError);
    expect(internal).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });

    const { client } = clientWith(() => new Response('Bad gateway', { status: 502 }));
    const foreign = await client
      .request(PRICING_ROUTES.listVersions, staffVersionResponseSchema)
      .catch((e: unknown) => e);
    expect(foreign).toMatchObject({ status: 502, code: 'UNKNOWN' });
  });

  it('maps a rejected fetch to NetworkError', async () => {
    const client = createHttpClient({
      baseUrl: '',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(
      client.request(PRICING_ROUTES.listVersions, staffVersionResponseSchema),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
