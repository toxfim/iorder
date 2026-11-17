import {
  MANUAL_PRODUCT_ROUTES,
  byOrderProductsResponseSchema,
  type ByOrderProductsResponse,
} from '@iorder/shared/staff-cost';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Staff-only: the products brought by order (staff-added, no sheet «Товар_ID») with what open
 * orders wait for. For the roles of the stock page; the server enforces it.
 */
export interface ByOrderApi {
  /** Products needed now first, then the rest by name (the server's order). */
  list: () => Promise<ByOrderProductsResponse>;
}

export function createHttpByOrderApi(http: HttpClient): ByOrderApi {
  return {
    list: () => http.request(MANUAL_PRODUCT_ROUTES.byOrderProducts, byOrderProductsResponseSchema),
  };
}
