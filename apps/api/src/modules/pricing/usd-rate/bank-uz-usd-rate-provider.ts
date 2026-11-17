import { z } from 'zod';
import type { FetchTextLike } from './usd-channel-rate-provider.js';
import { tashkentDay } from './usd-rate-resolve.js';
import { RateProviderError, UsdRateProvider, type UsdRateQuote } from './usd-rate-provider.js';

// cbu.uz timed out from the staging server, from the developer's computer and from the owner's phone
// on 2026-10-31. bank.uz republishes the Central Bank's rate on this page: the USD tab holds today's
// rate and its change, its chart the earlier days. VERIFIED on 2026-10-31: the chart's 20.10 value
// (12044.72) equals the cbu.uz response of 20.10, and 12066.22 (30.10) - 42.76 = 12023.46 (tab).
export const BANK_UZ_CURRENCY_URL = 'https://bank.uz/uz/currency';

const TIMEOUT_MS = 15_000;

/** A chart whose last day is older than this is a page that stopped updating (weekends are absent). */
const MAX_CHART_AGE_DAYS = 7;

const USD_TAB =
  /init_diag\('USD'\)[\s\S]*?<span class="medium-text">USD<\/span>[\s\S]*?<span class="medium-text">\s*(\d[\d ]*\.\d{2})<\/span>\s*<span class="medium-text[^"]*">\s*([+-]?\d[\d ]*\.\d{2})<\/span>/;
const USD_CHART = /if\s*\(cur==='USD'\)[\s\S]*?chart\.data\s*=\s*(\[[^\]]*\])/;

const chartSchema = z
  .array(
    z.object({
      name: z.string().regex(/^\d{2}\.\d{2}$/),
      value: z.string().regex(/^\d+\.\d{2}$/),
    }),
  )
  .min(1);

/** Two-decimal text as whole tiyin, so the page's own sum is checked without a float. */
function toTiyin(text: string): bigint {
  return BigInt(text.replace(/[ +.]/g, ''));
}

/** `DD.MM` of a chart, without a year: the latest such day not after `now`. */
function chartDayAgeDays(name: string, now: Date): number {
  const [day, month] = name.split('.').map(Number) as [number, number];
  const today = tashkentDay(now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const year = Number(today.slice(0, 4));
  const thisYear = Date.UTC(year, month - 1, day);
  const dayMs = thisYear > todayMs ? Date.UTC(year - 1, month - 1, day) : thisYear;
  return (todayMs - dayMs) / 86_400_000;
}

/** Null when the page is not the known shape or its numbers do not agree with each other. */
export function parseBankUzPage(html: string, now: Date): UsdRateQuote | null {
  const tab = USD_TAB.exec(html);
  const chartText = USD_CHART.exec(html)?.[1];
  if (!tab || !chartText) return null;

  let chartJson: unknown;
  try {
    chartJson = JSON.parse(chartText);
  } catch {
    return null;
  }
  const chart = chartSchema.safeParse(chartJson);
  const last = chart.success ? chart.data.at(-1) : undefined;
  if (!last || chartDayAgeDays(last.name, now) > MAX_CHART_AGE_DAYS) return null;

  const rate = (tab[1] as string).replace(/ /g, '');
  const change = (tab[2] as string).replace(/ /g, '');
  // The page does not print the tab's day. On a day without a new rate the tab equals the chart's
  // last value; otherwise it must be that value plus the printed change, and it is today's rate.
  if (rate === last.value) {
    const [day, month] = last.name.split('.') as [string, string];
    const today = tashkentDay(now);
    const thisYear = Number(today.slice(0, 4));
    const year = today.slice(5) < `${month}-${day}` ? thisYear - 1 : thisYear;
    return { rate, rateDate: `${String(year)}-${month}-${day}`, source: 'CBU' };
  }
  if (toTiyin(last.value) + toTiyin(change) !== toTiyin(rate)) return null;
  return { rate, rateDate: tashkentDay(now), source: 'CBU' };
}

/** Real implementation over the built-in fetch (injected, so tests never use the network). */
export class BankUzUsdRateProvider extends UsdRateProvider {
  constructor(
    private readonly fetchImpl: FetchTextLike,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async fetchUsdRate(): Promise<UsdRateQuote> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let html: string;
    try {
      const response = await this.fetchImpl(BANK_UZ_CURRENCY_URL, { signal });
      if (!response.ok) throw new RateProviderError('HTTP_STATUS');
      html = await response.text();
    } catch (error) {
      if (error instanceof RateProviderError) throw error;
      throw new RateProviderError(signal.aborted ? 'TIMEOUT' : 'UNREACHABLE');
    }
    const quote = parseBankUzPage(html, this.now());
    if (!quote) throw new RateProviderError('BAD_RESPONSE');
    return quote;
  }
}

/** The Central Bank's own endpoint first; the republished rate only when that one fails. */
export class FallbackUsdRateProvider extends UsdRateProvider {
  constructor(
    private readonly primary: UsdRateProvider,
    private readonly secondary: UsdRateProvider,
  ) {
    super();
  }

  async fetchUsdRate(): Promise<UsdRateQuote> {
    try {
      return await this.primary.fetchUsdRate();
    } catch (error) {
      if (!(error instanceof RateProviderError)) throw error;
      return this.secondary.fetchUsdRate();
    }
  }
}
