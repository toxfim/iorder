import { UsdChannelRateProvider, type ChannelRateQuote } from './usd-channel-rate-provider.js';
import { RateProviderError, type RateProviderErrorKind } from './usd-rate-provider.js';

/** In-memory provider for tests: returns settable posts or fails with a settable kind. */
export class FakeUsdChannelRateProvider extends UsdChannelRateProvider {
  calls = 0;
  private quotes: ChannelRateQuote[] = [];
  private failure: RateProviderErrorKind | null = null;

  fetchRecentQuotes(): Promise<ChannelRateQuote[]> {
    this.calls += 1;
    if (this.failure !== null) return Promise.reject(new RateProviderError(this.failure));
    return Promise.resolve(this.quotes);
  }

  returns(...quotes: ChannelRateQuote[]): void {
    this.quotes = quotes;
    this.failure = null;
  }

  failsWith(kind: RateProviderErrorKind): void {
    this.failure = kind;
  }
}
