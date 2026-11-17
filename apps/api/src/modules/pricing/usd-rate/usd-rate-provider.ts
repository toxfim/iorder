/** What a provider reports: the rate and the day it is valid for (not the day it was fetched). */
export interface UsdRateQuote {
  /** UZS per 1 USD as a decimal string with at most 4 fraction digits (fits Decimal(18,4)). */
  rate: string;
  /** The calendar date the rate is published for, ISO `YYYY-MM-DD`. */
  rateDate: string;
  source: 'CBU';
}

/**
 * Where the default USD rate comes from. READ-ONLY, one method. A real implementation talks to
 * the Central Bank of Uzbekistan; tests use a fake and never touch the network.
 */
export abstract class UsdRateProvider {
  abstract fetchUsdRate(): Promise<UsdRateQuote>;
}

export type RateProviderErrorKind =
  | 'UNREACHABLE' // network error
  | 'TIMEOUT'
  | 'HTTP_STATUS' // the bank answered with an error status
  | 'BAD_RESPONSE' // not JSON, or not the expected shape
  | 'IMPLAUSIBLE_RATE' // well-formed, but outside the plausibility band (never stored)
  | 'FAR_FROM_BANK'; // a channel rate too far from the Central Bank's (never stored)

/**
 * Plausibility band for a bank rate, UZS per 1 USD. A quote outside it is never stored (a typo or
 * a unit change at the bank would silently misprice everything). Decision applied without the
 * owner (see the work log); widen here if the real rate ever leaves the band.
 */
export const USD_RATE_PLAUSIBLE_MIN = 5_000;
export const USD_RATE_PLAUSIBLE_MAX = 30_000;

/**
 * [P, not owner-confirmed] A channel post further than this from the bank's rate is not applied: the
 * band above would let a typo like 19960 for 11960 through and it would price every order. The posts
 * of 26-28.10.2026 were about 1% from the bank. The fallback rule then applies and staff are warned.
 */
export const CHANNEL_MAX_BANK_DIFFERENCE = 0.05;

/**
 * A provider failure with a SAFE message: the kind only. The response body is never included
 * (and never logged): it is outside data and could be anything.
 */
export class RateProviderError extends Error {
  constructor(readonly kind: RateProviderErrorKind) {
    super(`USD rate provider failed: ${kind}`);
    this.name = 'RateProviderError';
  }
}
