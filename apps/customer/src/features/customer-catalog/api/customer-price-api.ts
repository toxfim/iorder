import {
  PRICING_ROUTES,
  customerPriceListResponseSchema,
  type CustomerPriceListResponse,
  type Locale,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/**
 * The published price list as a customer sees it: name, unit, price and the category label for
 * browsing (the one sheet-derived field allowed, owner decision 2026-10-23). No cost or stock.
 */
export interface CustomerPriceApi {
  /** Answers 404 (ApiNotFoundError) until the first price list is published. */
  getCurrent: (lang: Locale) => Promise<CustomerPriceListResponse>;
}

export function createHttpCustomerPriceApi(http: HttpClient): CustomerPriceApi {
  return {
    getCurrent: (lang) =>
      http.request(PRICING_ROUTES.currentPriceList, customerPriceListResponseSchema, {
        query: { lang },
      }),
  };
}
