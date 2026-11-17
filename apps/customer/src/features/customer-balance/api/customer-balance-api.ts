import {
  CUSTOMER_BALANCE_ROUTES,
  customerBalanceResponseSchema,
  type CustomerBalanceResponse,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/**
 * What the person's own organization has to pay ([C] 2026-10-26): its received orders minus the
 * payments the manager recorded, computed by the server. The customer sees only the amount, never
 * the payments themselves; an overpayment reads as zero.
 */
export interface CustomerBalanceApi {
  getBalance: () => Promise<CustomerBalanceResponse>;
}

export function createHttpCustomerBalanceApi(http: HttpClient): CustomerBalanceApi {
  return {
    getBalance: () =>
      http.request(CUSTOMER_BALANCE_ROUTES.getBalance, customerBalanceResponseSchema),
  };
}
