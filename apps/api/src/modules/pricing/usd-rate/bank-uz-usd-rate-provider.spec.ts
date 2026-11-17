import { describe, expect, it } from 'vitest';
import {
  BankUzUsdRateProvider,
  FallbackUsdRateProvider,
  parseBankUzPage,
} from './bank-uz-usd-rate-provider.js';
import { RateProviderError, UsdRateProvider, type UsdRateQuote } from './usd-rate-provider.js';

// The shape of the real page, kept from the read-only request of 2026-10-31.
const page = (rate: string, change: string, chart: string): string =>
  `<a onclick="init_diag('USD')" class="nav-link 769 active"><div class="tabs-a"><div><button>
   <span class="medium-text">USD</span></button></div>
   <span class="medium-text">  ${rate}</span>
   <span class="medium-text red-date">${change}</span></div></a>
   <script>if(cur==='USD'){ var chart = am4core.create(div, am4charts.XYChart);
   chart.data = ${chart};</script>`;
const CHART = '[{"name":"29.10","value":"12004.02"},{"name":"30.10","value":"12066.22"}]';
const NOW = new Date('2026-10-31T14:00:00Z');

describe('parseBankUzPage', () => {
  it('reads the tab as the rate of today when the change leads from the chart to it', () => {
    expect(parseBankUzPage(page('12 023.46', '-42.76', CHART), NOW)).toEqual({
      rate: '12023.46',
      rateDate: '2026-10-31',
      source: 'CBU',
    });
  });

  it('dates the rate by the chart when the tab is the chart`s last value', () => {
    expect(parseBankUzPage(page('12 066.22', '62.20', CHART), NOW)?.rateDate).toBe('2026-10-30');
  });

  it('dates a chart day of December as last year in January', () => {
    const chart = '[{"name":"31.12","value":"12066.22"}]';
    const quote = parseBankUzPage(
      page('12 066.22', '1.00', chart),
      new Date('2027-01-02T09:00:00Z'),
    );
    expect(quote?.rateDate).toBe('2026-12-31');
  });

  it.each([
    ['numbers that do not add up', page('12 023.46', '-40.00', CHART)],
    ['no USD tab', CHART],
    ['a broken chart', page('12 023.46', '-42.76', '[{"name":"x"}]')],
    ['an unknown page', '<html></html>'],
    ['a chart that stopped', page('12 023.46', '-42.76', '[{"name":"01.10","value":"12066.22"}]')],
  ])('refuses %s', (_name, html) => {
    expect(parseBankUzPage(html, NOW)).toBeNull();
  });
});

describe('BankUzUsdRateProvider', () => {
  it('reports a bad page and a failed status by kind', async () => {
    const provider = (ok: boolean, body: string): BankUzUsdRateProvider =>
      new BankUzUsdRateProvider(
        () => Promise.resolve({ ok, status: ok ? 200 : 503, text: () => Promise.resolve(body) }),
        () => NOW,
      );
    await expect(provider(true, 'x').fetchUsdRate()).rejects.toMatchObject({
      kind: 'BAD_RESPONSE',
    });
    await expect(provider(false, '').fetchUsdRate()).rejects.toMatchObject({ kind: 'HTTP_STATUS' });
  });
});

describe('FallbackUsdRateProvider', () => {
  const quote: UsdRateQuote = { rate: '12023.46', rateDate: '2026-10-31', source: 'CBU' };
  class Fixed extends UsdRateProvider {
    calls = 0;
    constructor(private readonly result: UsdRateQuote | Error) {
      super();
    }
    fetchUsdRate(): Promise<UsdRateQuote> {
      this.calls += 1;
      return this.result instanceof Error
        ? Promise.reject(this.result)
        : Promise.resolve(this.result);
    }
  }

  it('does not ask the second source when the bank answers', async () => {
    const second = new Fixed(quote);
    await new FallbackUsdRateProvider(new Fixed(quote), second).fetchUsdRate();
    expect(second.calls).toBe(0);
  });

  it('uses the second source when the bank fails', async () => {
    const first = new Fixed(new RateProviderError('TIMEOUT'));
    await expect(new FallbackUsdRateProvider(first, new Fixed(quote)).fetchUsdRate()).resolves.toBe(
      quote,
    );
  });

  it('fails when both fail, and passes on an unexpected error', async () => {
    const both = new FallbackUsdRateProvider(
      new Fixed(new RateProviderError('TIMEOUT')),
      new Fixed(new RateProviderError('BAD_RESPONSE')),
    );
    await expect(both.fetchUsdRate()).rejects.toMatchObject({ kind: 'BAD_RESPONSE' });
    const bug = new Error('bug');
    await expect(
      new FallbackUsdRateProvider(new Fixed(bug), new Fixed(quote)).fetchUsdRate(),
    ).rejects.toBe(bug);
  });
});
