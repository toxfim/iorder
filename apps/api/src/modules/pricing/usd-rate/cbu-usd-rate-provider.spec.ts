import { describe, expect, it } from 'vitest';
import { CbuUsdRateProvider, type FetchLike } from './cbu-usd-rate-provider.js';
import { RateProviderError } from './usd-rate-provider.js';

// A real response of the Central Bank archive API, recorded 2026-10-20 (public data, no secrets).
const REAL_RESPONSE = [
  {
    id: 1,
    Code: '840',
    Ccy: 'USD',
    CcyNm_RU: 'Доллар США',
    CcyNm_UZ: 'AQSH dollari',
    CcyNm_UZC: 'АҚШ доллари',
    CcyNm_EN: 'US Dollar',
    Nominal: '1',
    Rate: '12044.72',
    Diff: '-11.18',
    Date: '20.10.2026',
  },
];

const ok =
  (body: unknown): FetchLike =>
  () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

const failure = async (provider: CbuUsdRateProvider): Promise<RateProviderError> => {
  const error = await provider.fetchUsdRate().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RateProviderError);
  return error as RateProviderError;
};

describe('CbuUsdRateProvider', () => {
  it('reads the real response shape into a quote (the rate stays an exact string)', async () => {
    const quote = await new CbuUsdRateProvider(ok(REAL_RESPONSE)).fetchUsdRate();
    expect(quote).toEqual({ rate: '12044.72', rateDate: '2026-10-20', source: 'CBU' });
  });

  it('asks the configured URL with a timeout signal and a JSON accept header', async () => {
    let seen: { url: string; hasSignal: boolean; accept: string | undefined } | null = null;
    const fetchImpl: FetchLike = (url, init) => {
      seen = { url, hasSignal: init.signal instanceof AbortSignal, accept: init.headers.accept };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(REAL_RESPONSE) });
    };
    await new CbuUsdRateProvider(fetchImpl, { url: 'https://example.test/usd' }).fetchUsdRate();
    expect(seen).toEqual({
      url: 'https://example.test/usd',
      hasSignal: true,
      accept: 'application/json',
    });
  });

  it('ignores extra fields and other currencies in the array, and picks USD', async () => {
    const quote = await new CbuUsdRateProvider(
      ok([
        { Ccy: 'EUR', Code: '978', Nominal: '1', Rate: '14000.00', Date: '20.10.2026' },
        ...REAL_RESPONSE,
      ]),
    ).fetchUsdRate();
    expect(quote.rate).toBe('12044.72');
  });

  it.each([
    ['not an array', { Rate: '1' }],
    ['an empty array', []],
    [
      'no USD entry',
      [{ Ccy: 'EUR', Code: '978', Nominal: '1', Rate: '14000', Date: '20.10.2026' }],
    ],
    ['a numeric rate (not the documented string)', [{ ...REAL_RESPONSE[0], Rate: 12044.72 }]],
    ['a zero rate', [{ ...REAL_RESPONSE[0], Rate: '0' }]],
    ['a negative rate', [{ ...REAL_RESPONSE[0], Rate: '-5' }]],
    ['too many fraction digits (never rounded)', [{ ...REAL_RESPONSE[0], Rate: '12044.72345' }]],
    ['a thousands separator', [{ ...REAL_RESPONSE[0], Rate: '12,044.72' }]],
    ['a nominal other than 1', [{ ...REAL_RESPONSE[0], Nominal: '100' }]],
    ['an ISO date instead of DD.MM.YYYY', [{ ...REAL_RESPONSE[0], Date: '2026-10-20' }]],
    ['an impossible date', [{ ...REAL_RESPONSE[0], Date: '31.02.2026' }]],
    ['a date before 2000', [{ ...REAL_RESPONSE[0], Date: '20.10.1899' }]],
    ['a missing date', [{ ...REAL_RESPONSE[0], Date: undefined }]],
  ])('rejects %s as BAD_RESPONSE', async (_name, body) => {
    expect((await failure(new CbuUsdRateProvider(ok(body)))).kind).toBe('BAD_RESPONSE');
  });

  it('answers BAD_RESPONSE when the body is not JSON', async () => {
    const notJson: FetchLike = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('x')) });
    expect((await failure(new CbuUsdRateProvider(notJson))).kind).toBe('BAD_RESPONSE');
  });

  it('answers HTTP_STATUS for an error status and never reads the body', async () => {
    let bodyRead = false;
    const down: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => {
          bodyRead = true;
          return Promise.resolve({});
        },
      });
    expect((await failure(new CbuUsdRateProvider(down))).kind).toBe('HTTP_STATUS');
    expect(bodyRead).toBe(false);
  });

  it('answers UNREACHABLE for a network error, without leaking its text', async () => {
    const offline: FetchLike = () => Promise.reject(new Error('getaddrinfo ENOTFOUND secret-host'));
    const error = await failure(new CbuUsdRateProvider(offline));
    expect(error.kind).toBe('UNREACHABLE');
    expect(error.message).not.toContain('secret-host');
    expect(JSON.stringify(error)).not.toContain('secret-host');
  });

  it('answers TIMEOUT when the request does not finish in time (no network used)', async () => {
    const hangs: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'TimeoutError')),
        );
      });
    const error = await failure(new CbuUsdRateProvider(hangs, { timeoutMs: 30 }));
    expect(error.kind).toBe('TIMEOUT');
  });
});
