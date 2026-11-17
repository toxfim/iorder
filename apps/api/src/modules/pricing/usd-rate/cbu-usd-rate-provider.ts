import { z } from 'zod';
import { RateProviderError, UsdRateProvider, type UsdRateQuote } from './usd-rate-provider.js';

// The Central Bank of Uzbekistan publishes archive rates as JSON. VERIFIED on 2026-10-20 with one
// read-only request to https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/ (HTTP 200,
// application/json): an ARRAY with one object per currency, every value a STRING:
//
//   [{"id":1,"Code":"840","Ccy":"USD","CcyNm_RU":"Доллар США","CcyNm_UZ":"AQSH dollari",
//     "CcyNm_UZC":"АҚШ доллари","CcyNm_EN":"US Dollar","Nominal":"1","Rate":"12044.72",
//     "Diff":"-11.18","Date":"20.10.2026"}]
//
// `Rate` is UZS per `Nominal` units of the currency; `Date` is DD.MM.YYYY. Only the fields below
// are read; everything else is ignored.
export const CBU_USD_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/';

/** One attempt, no retries: a scheduler decides when to try again. */
export const CBU_TIMEOUT_MS = 10_000;

const entrySchema = z.object({
  Code: z.literal('840'),
  Ccy: z.literal('USD'),
  // Rate is per `Nominal` units. USD is quoted per 1; anything else is not understood, not guessed.
  Nominal: z.literal('1'),
  // At most 4 fraction digits (our Decimal(18,4)) and a sane integer part; nothing else.
  Rate: z.string().regex(/^[1-9]\d{0,13}(\.\d{1,4})?$/),
  Date: z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/),
});

const responseSchema = z.array(z.unknown()).min(1);

/** `DD.MM.YYYY` -> `YYYY-MM-DD` for a real calendar date, else null. */
export function toIsoDate(ddmmyyyy: string): string | null {
  const [day, month, year] = ddmmyyyy.split('.').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return real && year >= 2000
    ? `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    : null;
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Real implementation over the built-in fetch (injected, so tests never use the network). */
export class CbuUsdRateProvider extends UsdRateProvider {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly options: { url?: string; timeoutMs?: number } = {},
  ) {
    super();
  }

  async fetchUsdRate(): Promise<UsdRateQuote> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? CBU_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchImpl(this.options.url ?? CBU_USD_URL, {
        signal,
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      // Only the KIND of failure survives; the underlying error text is dropped on purpose.
      const timedOut = signal.aborted || (error instanceof Error && error.name === 'TimeoutError');
      throw new RateProviderError(timedOut ? 'TIMEOUT' : 'UNREACHABLE');
    }
    if (!response.ok) throw new RateProviderError('HTTP_STATUS');

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RateProviderError('BAD_RESPONSE');
    }

    const list = responseSchema.safeParse(body);
    if (!list.success) throw new RateProviderError('BAD_RESPONSE');
    // The endpoint is per currency, but pick USD explicitly rather than trust the position.
    for (const candidate of list.data) {
      const entry = entrySchema.safeParse(candidate);
      if (!entry.success) continue;
      const rateDate = toIsoDate(entry.data.Date);
      if (rateDate === null) throw new RateProviderError('BAD_RESPONSE');
      return { rate: entry.data.Rate, rateDate, source: 'CBU' };
    }
    throw new RateProviderError('BAD_RESPONSE');
  }
}
