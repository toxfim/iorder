import {
  RateProviderError,
  UsdRateProvider,
  type RateProviderErrorKind,
  type UsdRateQuote,
} from './usd-rate-provider.js';

/** In-memory provider for tests: returns a settable quote or fails with a settable kind. */
export class FakeUsdRateProvider extends UsdRateProvider {
  calls = 0;

  constructor(
    private quote: UsdRateQuote | null = {
      rate: '12044.72',
      rateDate: '2026-10-20',
      source: 'CBU',
    },
    private failure: RateProviderErrorKind | null = null,
  ) {
    super();
  }

  fetchUsdRate(): Promise<UsdRateQuote> {
    this.calls += 1;
    if (this.failure !== null || this.quote === null) {
      return Promise.reject(new RateProviderError(this.failure ?? 'BAD_RESPONSE'));
    }
    return Promise.resolve(this.quote);
  }

  returns(rate: string, rateDate: string): void {
    this.quote = { rate, rateDate, source: 'CBU' };
    this.failure = null;
  }

  failsWith(kind: RateProviderErrorKind): void {
    this.failure = kind;
  }
}
