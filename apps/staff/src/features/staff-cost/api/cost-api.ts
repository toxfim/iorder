import {
  COST_ROUTES,
  priceListCostsResponseSchema,
  productCostReferenceResponseSchema,
  usdRateResponseSchema,
  type PriceListCostsResponse,
  type ProductCostReferenceResponse,
  type UpdateUsdRateRequest,
  type UsdRateResponse,
} from '@iorder/shared/staff-cost';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Staff-only cost reference and the USD rate (hard rule 7). Viewing is for manager, accountant and
 * admin; changing the rate is for manager and admin. The server decides; the web only hides.
 */
export interface CostApi {
  /** Cost and stock of every product in the CURRENT published list (404 before the first publish). */
  getPriceListCosts: () => Promise<PriceListCostsResponse>;
  /** Every delivery of one product, newest first. */
  getProductCostReference: (productId: string) => Promise<ProductCostReferenceResponse>;
  getUsdRate: () => Promise<UsdRateResponse>;
  /** Manager and admin. The manual rate stays in force until the bank is followed again. */
  setUsdRate: (request: UpdateUsdRateRequest) => Promise<UsdRateResponse>;
  /** Manager and admin. Back to the Central Bank, refreshing once right away. */
  followCentralBank: () => Promise<UsdRateResponse>;
}

export function createHttpCostApi(http: HttpClient): CostApi {
  return {
    getPriceListCosts: () =>
      http.request(COST_ROUTES.currentPriceListCosts, priceListCostsResponseSchema),
    getProductCostReference: (productId) =>
      http.request(COST_ROUTES.productCostReference, productCostReferenceResponseSchema, {
        params: { id: productId },
      }),
    getUsdRate: () => http.request(COST_ROUTES.getUsdRate, usdRateResponseSchema),
    setUsdRate: (request) =>
      http.request(COST_ROUTES.setUsdRate, usdRateResponseSchema, { body: request }),
    followCentralBank: () => http.request(COST_ROUTES.followCentralBank, usdRateResponseSchema),
  };
}
