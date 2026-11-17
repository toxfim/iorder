import {
  CUSTOMER_HOME_ROUTES,
  customerHomeRecommendationsResponseSchema,
  type CustomerHomeRecommendationsResponse,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/**
 * The home recommendations of the person's own organization [C, 2026-11-09]: products to reorder,
 * products that match what was bought and the staff-confirmed newer model, each as a customer
 * price list card. Empty blocks for a first visit and for a staff viewer.
 */
export interface CustomerHomeApi {
  getRecommendations: () => Promise<CustomerHomeRecommendationsResponse>;
}

export function createHttpCustomerHomeApi(http: HttpClient): CustomerHomeApi {
  return {
    getRecommendations: () =>
      http.request(
        CUSTOMER_HOME_ROUTES.getRecommendations,
        customerHomeRecommendationsResponseSchema,
      ),
  };
}
