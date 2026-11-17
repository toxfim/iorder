import { route } from '@iorder/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiConflictError, NetworkError, PermissionDeniedError } from './api-errors';
import { createHttpClient, fileNameFromContentDisposition } from './http-client';

const EXCEL = route('GET', '/staff/price-list/current/excel');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function clientAnswering(response: () => Response) {
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  return { fetchImpl, client: createHttpClient({ baseUrl: 'https://api.test', fetchImpl }) };
}

describe('requestFile', () => {
  it('returns the body as a blob with the file name of Content-Disposition', async () => {
    const { client, fetchImpl } = clientAnswering(
      () =>
        new Response(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: {
            'Content-Type': XLSX,
            'Content-Disposition': 'attachment; filename="iorder-price-v12.xlsx"',
          },
        }),
    );
    const file = await client.requestFile(EXCEL);
    expect(file.fileName).toBe('iorder-price-v12.xlsx');
    expect(file.blob.size).toBe(4);
    expect(file.blob.type).toBe(XLSX);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.test/staff/price-list/current/excel');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Accept: '*/*' });
  });

  it('gives a null name when the server sends none', async () => {
    const { client } = clientAnswering(() => new Response('x', { status: 200 }));
    await expect(client.requestFile(EXCEL)).resolves.toMatchObject({ fileName: null });
  });

  it('maps error answers to the same typed errors as JSON requests', async () => {
    const denied = clientAnswering(
      () =>
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'no' } }), {
          status: 403,
        }),
    );
    await expect(denied.client.requestFile(EXCEL)).rejects.toBeInstanceOf(PermissionDeniedError);

    const conflict = clientAnswering(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'CONFLICT', message: 'x', reason: 'NO_PUBLISHED_VERSION' },
          }),
          { status: 409 },
        ),
    );
    const error = await conflict.client.requestFile(EXCEL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBe('NO_PUBLISHED_VERSION');
  });

  it('maps a rejected fetch to NetworkError', async () => {
    const client = createHttpClient({
      baseUrl: '',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(client.requestFile(EXCEL)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('fileNameFromContentDisposition', () => {
  it.each([
    ['attachment; filename="price.xlsx"', 'price.xlsx'],
    ['attachment; filename=price.xlsx', 'price.xlsx'],
    ['attachment; filename="a \\"b\\".xlsx"', 'a "b".xlsx'],
    // The RFC 5987 form wins and is percent-decoded (Cyrillic and spaces survive).
    [
      'attachment; filename="price.xlsx"; filename*=UTF-8\'\'%D0%9F%D1%80%D0%B0%D0%B9%D1%81%20v3.xlsx',
      'Прайс v3.xlsx',
    ],
    // Path parts never reach the saved name.
    ['attachment; filename="../../etc/passwd"', 'passwd'],
    ['attachment; filename=C:\\temp\\x.xlsx', 'x.xlsx'],
  ])('%s -> %s', (header, expected) => {
    expect(fileNameFromContentDisposition(header)).toBe(expected);
  });

  it.each([null, 'attachment', 'attachment; filename=""', 'attachment; filename=".."'])(
    '%s -> null',
    (header) => {
      expect(fileNameFromContentDisposition(header)).toBeNull();
    },
  );

  it('falls back to the plain name when the extended one cannot be decoded', () => {
    expect(
      fileNameFromContentDisposition('attachment; filename="ok.xlsx"; filename*=UTF-8\'\'%E0%A4%A'),
    ).toBe('ok.xlsx');
  });
});
