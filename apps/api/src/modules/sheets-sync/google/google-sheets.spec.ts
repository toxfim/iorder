import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnconfiguredDeliveryCostSource } from '../delivery-cost-source.js';
import { parseSheetDate, parseSheetNumber } from '../sheet-values.js';
import { createDeliveryCostSource } from './create-delivery-cost-source.js';
import {
  GoogleSheetsDeliveryCostSource,
  MAX_SHEET_DATA_ROWS,
} from './google-sheets-delivery-cost-source.js';
import {
  ASSERTION_LIFETIME_SECONDS,
  buildAssertion,
  GOOGLE_TOKEN_URL,
  GoogleTokenProvider,
  SHEETS_READONLY_SCOPE,
  TOKEN_EXPIRY_MARGIN_MS,
} from './google-token-provider.js';
import type { HttpFetch } from './http.js';
import { createFileKeyReader } from './service-account-key.js';
import {
  SHEET_READ_ERROR_KINDS,
  SheetReadError,
  type SheetReadErrorKind,
} from './sheet-read-error.js';

// A throw-away key pair generated at test time: no real credential is ever used here.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const EMAIL = 'reader@fake-project.iam.gserviceaccount.com';
const KEY = { clientEmail: EMAIL, privateKey };
const TOKEN = 'ya29.FAKE-ACCESS-TOKEN-0123456789';
const SECRET_CELL = 'SECRET-COST-CELL-98765';
const SHEET_ID = 'fake-sheet-id-0123456789';

interface Call {
  url: string;
  init: Parameters<HttpFetch>[1];
}
type Reply = { status: number; body: string } | Error;

function scriptedFetch(replies: (Reply | ((call: Call) => Reply))[]): {
  fetch: HttpFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFake: HttpFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    const reply = typeof next === 'function' ? next(call) : next;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ status: reply.status, text: () => Promise.resolve(reply.body) });
  };
  return { fetch: fetchFake, calls };
}

const tokenReply = (expiresIn = 3600): Reply => ({
  status: 200,
  body: JSON.stringify({ access_token: TOKEN, expires_in: expiresIn, token_type: 'Bearer' }),
});
const valuesReply = (values: unknown): Reply => ({
  status: 200,
  body: JSON.stringify({ range: 'x', majorDimension: 'ROWS', values }),
});

function makeSource(replies: (Reply | ((call: Call) => Reply))[], nowMs = () => 1_700_000_000_000) {
  const { fetch: fetchFake, calls } = scriptedFetch(replies);
  const tokens = new GoogleTokenProvider(() => Promise.resolve(KEY), fetchFake, nowMs);
  const source = new GoogleSheetsDeliveryCostSource(tokens, fetchFake, {
    spreadsheetId: SHEET_ID,
    tab: 'Поставка',
  });
  return { source, calls };
}

async function kindOf(promise: Promise<unknown>): Promise<SheetReadErrorKind> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SheetReadError) return error.kind;
    throw error;
  }
  throw new Error('expected a SheetReadError');
}

describe('service account assertion (JWT)', () => {
  it('carries the read-only scope and verifies with the public key', () => {
    const now = 1_700_000_000_000;
    const jwt = buildAssertion(KEY, now);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: EMAIL,
      scope: SHEETS_READONLY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + ASSERTION_LIFETIME_SECONDS,
    });
    expect(SHEETS_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('refuses an unusable private key with an AUTH error that does not quote the key', () => {
    const bad = { clientEmail: EMAIL, privateKey: 'not a key BAD-KEY-MATERIAL' };
    try {
      buildAssertion(bad, 0);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SheetReadError);
      expect((error as SheetReadError).kind).toBe('AUTH');
      expect(String((error as Error).stack)).not.toContain('BAD-KEY-MATERIAL');
    }
  });
});

describe('GoogleTokenProvider', () => {
  let now: number;
  beforeEach(() => {
    now = 1_700_000_000_000;
  });

  it('posts the jwt-bearer grant to the token endpoint and returns the token', async () => {
    const { fetch: fetchFake, calls } = scriptedFetch([tokenReply()]);
    const provider = new GoogleTokenProvider(
      () => Promise.resolve(KEY),
      fetchFake,
      () => now,
    );
    expect(await provider.getAccessToken()).toBe(TOKEN);
    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(calls[0]?.init.method).toBe('POST');
    const form = new URLSearchParams(calls[0]?.init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('reuses the token until the expiry margin, then exchanges again', async () => {
    const { fetch: fetchFake, calls } = scriptedFetch([tokenReply(3600), tokenReply(3600)]);
    const provider = new GoogleTokenProvider(
      () => Promise.resolve(KEY),
      fetchFake,
      () => now,
    );
    await provider.getAccessToken();
    now += 3600_000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    await provider.getAccessToken();
    expect(calls).toHaveLength(1);
    now += 2;
    await provider.getAccessToken();
    expect(calls).toHaveLength(2);
  });

  it('shares one exchange between concurrent callers', async () => {
    const { fetch: fetchFake, calls } = scriptedFetch([tokenReply()]);
    const provider = new GoogleTokenProvider(
      () => Promise.resolve(KEY),
      fetchFake,
      () => now,
    );
    await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [{ status: 400, body: '{"error":"invalid_grant"}' }, 'AUTH'],
    [{ status: 401, body: '{}' }, 'AUTH'],
    [{ status: 429, body: '{}' }, 'QUOTA'],
    [{ status: 503, body: '{}' }, 'NETWORK'],
    [new Error('socket hang up'), 'NETWORK'],
    [{ status: 200, body: 'not json' }, 'MALFORMED'],
    [
      { status: 200, body: '{"access_token":"","expires_in":3600,"token_type":"Bearer"}' },
      'MALFORMED',
    ],
  ] as [Reply, SheetReadErrorKind][])('maps %j to %s', async (reply, kind) => {
    const { fetch: fetchFake } = scriptedFetch([reply]);
    const provider = new GoogleTokenProvider(
      () => Promise.resolve(KEY),
      fetchFake,
      () => now,
    );
    expect(await kindOf(provider.getAccessToken())).toBe(kind);
  });

  it('does not cache a failure: the next call tries again', async () => {
    const { fetch: fetchFake } = scriptedFetch([{ status: 503, body: '' }, tokenReply()]);
    const provider = new GoogleTokenProvider(
      () => Promise.resolve(KEY),
      fetchFake,
      () => now,
    );
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(SheetReadError);
    expect(await provider.getAccessToken()).toBe(TOKEN);
  });
});

describe('GoogleSheetsDeliveryCostSource', () => {
  it('requests the encoded range with FORMATTED_VALUE and the bearer token (GET only)', async () => {
    const { source, calls } = makeSource([tokenReply(), valuesReply([['Дата'], ['x']])]);
    await source.readDeliveryTable();
    const request = calls[1];
    expect(request?.init.method).toBe('GET');
    expect(request?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const url = new URL(request?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("'Поставка'!A:CZ")}`,
    );
    expect(request?.url).toContain('%D0%9F%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D0%BA%D0%B0');
    expect(url.searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE');
    // Nothing but reads: no request in the whole flow is anything other than the token POST and a GET.
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET']);
  });

  it('doubles a quote inside the tab name', () => {
    const { fetch: fetchFake } = scriptedFetch([]);
    const tokens = new GoogleTokenProvider(() => Promise.resolve(KEY), fetchFake, Date.now);
    const source = new GoogleSheetsDeliveryCostSource(tokens, fetchFake, {
      spreadsheetId: SHEET_ID,
      tab: "O'Brien tab",
    });
    expect(decodeURIComponent(source.buildUrl())).toContain("'O''Brien tab'!A:CZ");
  });

  it('returns headers and rows; short rows are padded, trailing blank rows dropped', async () => {
    const { source } = makeSource([
      tokenReply(),
      valuesReply([
        ['Дата', 'Поставщик', 'Факт кол-во'],
        ['21/10/2026 14:30:05', 'ACME'],
        ['22/10/2026 09:00:00', 'ACME', '12,650'],
        [],
        ['', ' ', ''],
      ]),
    ]);
    const table = await source.readDeliveryTable();
    expect(table.headers).toEqual(['Дата', 'Поставщик', 'Факт кол-во']);
    expect(table.rows).toEqual([
      ['21/10/2026 14:30:05', 'ACME', ''],
      ['22/10/2026 09:00:00', 'ACME', '12,650'],
    ]);
  });

  it('delivers FORMATTED_VALUE strings the existing strict parsers accept', async () => {
    const { source } = makeSource([
      tokenReply(),
      valuesReply([
        ['Дата', 'Цена закупа сумм'],
        ['21/10/2026 14:30:05', '1,690,000.50'],
      ]),
    ]);
    const [row] = (await source.readDeliveryTable()).rows;
    expect(parseSheetDate(row?.[0])?.toISOString()).toBe('2026-10-21T09:30:05.000Z');
    expect(parseSheetNumber(row?.[1])).toBe('1690000.50');
  });

  it('accepts exactly the maximum number of data rows and refuses one more', async () => {
    const header = ['A'];
    const rows = (count: number): string[][] => Array.from({ length: count }, () => ['v']);
    const ok = makeSource([tokenReply(), valuesReply([header, ...rows(MAX_SHEET_DATA_ROWS)])]);
    expect((await ok.source.readDeliveryTable()).rows).toHaveLength(MAX_SHEET_DATA_ROWS);
    const tooMany = makeSource([
      tokenReply(),
      valuesReply([header, ...rows(MAX_SHEET_DATA_ROWS + 1)]),
    ]);
    expect(await kindOf(tooMany.source.readDeliveryTable())).toBe('MALFORMED');
  });

  it('reuses the token across reads', async () => {
    const { source, calls } = makeSource([
      tokenReply(),
      valuesReply([['A'], ['1']]),
      valuesReply([['A'], ['2']]),
    ]);
    await source.readDeliveryTable();
    await source.readDeliveryTable();
    expect(calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it('on a 401 drops the cached token, takes a fresh one and retries once', async () => {
    const { source, calls } = makeSource([
      tokenReply(),
      { status: 401, body: '{}' },
      tokenReply(),
      valuesReply([['Дата'], ['x']]),
    ]);
    await source.readDeliveryTable();
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
  });

  it('gives up with AUTH when the retry is refused as well (no third attempt)', async () => {
    const { source, calls } = makeSource([
      tokenReply(),
      { status: 401, body: '{}' },
      tokenReply(),
      { status: 401, body: '{}' },
    ]);
    expect(await kindOf(source.readDeliveryTable())).toBe('AUTH');
    expect(calls).toHaveLength(4);
  });

  const quotaBody = JSON.stringify({
    error: { status: 'RESOURCE_EXHAUSTED', errors: [{ reason: 'rateLimitExceeded' }] },
  });
  it.each([
    [{ status: 403, body: '{"error":{"status":"PERMISSION_DENIED"}}' }, 'NOT_FOUND'],
    [{ status: 403, body: quotaBody }, 'QUOTA'],
    [{ status: 429, body: '{}' }, 'QUOTA'],
    [{ status: 404, body: '{}' }, 'NOT_FOUND'],
    [{ status: 400, body: '{"error":{"message":"Unable to parse range"}}' }, 'NOT_FOUND'],
    [{ status: 500, body: '' }, 'NETWORK'],
    [{ status: 503, body: '' }, 'NETWORK'],
    [new Error('ECONNRESET'), 'NETWORK'],
    [{ status: 200, body: '<html>' }, 'MALFORMED'],
    [{ status: 200, body: '{"range":"x"}' }, 'MALFORMED'],
    [valuesReply([]), 'MALFORMED'],
    [valuesReply([[], ['x']]), 'MALFORMED'],
    [valuesReply([['A'], [12.5]]), 'MALFORMED'],
    [{ status: 302, body: '' }, 'MALFORMED'],
  ] as [Reply, SheetReadErrorKind][])('maps the Google answer %j to %s', async (reply, kind) => {
    const { source } = makeSource([tokenReply(), reply]);
    expect(await kindOf(source.readDeliveryTable())).toBe(kind);
  });

  it('covers every error kind', () => {
    expect(SHEET_READ_ERROR_KINDS).toEqual(['AUTH', 'NOT_FOUND', 'QUOTA', 'NETWORK', 'MALFORMED']);
  });
});

describe('no secret leaks into errors or logs', () => {
  const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  afterAll(() => {
    spies.forEach((spy) => spy.mockRestore());
  });

  it('keeps tokens, keys, response bodies and cell contents out of every failure', async () => {
    const hostile = (status: number): Reply => ({
      status,
      body: JSON.stringify({
        error: { message: `${SECRET_CELL} ${TOKEN} ${privateKey}`, status: 'X' },
      }),
    });
    const secrets = [SECRET_CELL, TOKEN, privateKey, 'PRIVATE KEY'];
    for (const status of [400, 401, 403, 404, 429, 500, 200]) {
      const { source } = makeSource([tokenReply(), hostile(status)]);
      try {
        await source.readDeliveryTable();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SheetReadError);
        const e = error as SheetReadError;
        expect(e.cause).toBeUndefined();
        expect(e.details).toBeUndefined();
        const everything = `${e.message} ${e.stack ?? ''} ${e.code} ${JSON.stringify(e)}`;
        for (const secret of secrets) expect(everything).not.toContain(secret);
      }
    }
    // A token exchange that fails with the same hostile body.
    const { fetch: fetchFake } = scriptedFetch([hostile(401)]);
    const provider = new GoogleTokenProvider(() => Promise.resolve(KEY), fetchFake, Date.now);
    const error: unknown = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SheetReadError);
    const text = `${(error as Error).message} ${(error as Error).stack}`;
    for (const secret of secrets) expect(text).not.toContain(secret);
    // The client does not log at all.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('createFileKeyReader', () => {
  let dir: string;
  const dirReady = mkdtemp(join(tmpdir(), 'iorder-key-')).then((d) => {
    dir = d;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads client_email and private_key lazily from the JSON file', async () => {
    await dirReady;
    const path = join(dir, 'key.json');
    await writeFile(
      path,
      JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: privateKey }),
    );
    expect(await createFileKeyReader(path)()).toEqual(KEY);
  });

  it.each([
    ['a missing file', null],
    ['invalid JSON', 'SECRET-FILE-CONTENT {'],
    ['a key without private_key', JSON.stringify({ client_email: EMAIL })],
    ['a private_key that is not a key', JSON.stringify({ client_email: EMAIL, private_key: 'x' })],
  ])('turns %s into an AUTH error without the file content', async (_name, content) => {
    await dirReady;
    const path = join(dir, `bad-${String(Math.random()).slice(2)}.json`);
    if (content !== null) await writeFile(path, content);
    try {
      await createFileKeyReader(path)();
      expect.unreachable();
    } catch (error) {
      expect((error as SheetReadError).kind).toBe('AUTH');
      expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain('SECRET-FILE');
    }
  });

  it('does not touch the file until the first read', () => {
    expect(() => createFileKeyReader('/does/not/exist.json')).not.toThrow();
  });
});

describe('createDeliveryCostSource', () => {
  const full = {
    GOOGLE_SERVICE_ACCOUNT_FILE: 'key.json',
    GOOGLE_SHEET_ID: SHEET_ID,
    GOOGLE_SHEET_SUPPLIES_TAB: 'Поставка',
  };

  it('uses the real source only when all three settings exist', () => {
    expect(createDeliveryCostSource(full)).toBeInstanceOf(GoogleSheetsDeliveryCostSource);
    for (const missing of Object.keys(full)) {
      const partial = { ...full, [missing]: undefined };
      expect(createDeliveryCostSource(partial)).toBeInstanceOf(UnconfiguredDeliveryCostSource);
    }
  });

  it('makes no request while being built', () => {
    const never = vi.fn<HttpFetch>();
    createDeliveryCostSource(full, never);
    expect(never).not.toHaveBeenCalled();
  });
});
