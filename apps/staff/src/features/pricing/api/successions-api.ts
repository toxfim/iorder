// Staff-only entry: the "newer model" pairs a manager or admin confirms for the customer home.
import {
  PRODUCT_SUCCESSION_ROUTES,
  findProductSuccessionsResponseSchema,
  productSuccessionListResponseSchema,
  productSuccessionSchema,
  type FindProductSuccessionsResponse,
  type ProductSuccession,
  type ProductSuccessionDecision,
  type ProductSuccessionListResponse,
  type ProductSuccessionStatus,
} from '@iorder/shared/staff-cost';
import type { HttpClient } from '@core/lib/http-client';

/**
 * The "Yangi modellar" page's calls [C, 2026-11-09]. Reading is for the price management roles;
 * finding proposals and deciding for manager and admin (the server refuses everyone else).
 */
export interface SuccessionsApi {
  /** The pairs in one status, newest proposal first, with the counts of every status. */
  list: (status: ProductSuccessionStatus) => Promise<ProductSuccessionListResponse>;
  /** Runs the generator; answers how many NEW pairs it proposed. Existing rows are never touched. */
  findProposals: () => Promise<FindProductSuccessionsResponse>;
  /** Confirms or rejects one pair; a decided pair may be decided the other way, never un-decided. */
  decide: (id: string, decision: ProductSuccessionDecision) => Promise<ProductSuccession>;
}

export function createHttpSuccessionsApi(http: HttpClient): SuccessionsApi {
  return {
    list: (status) =>
      http.request(
        PRODUCT_SUCCESSION_ROUTES.listProductSuccessions,
        productSuccessionListResponseSchema,
        {
          query: { status },
        },
      ),
    findProposals: () =>
      http.request(
        PRODUCT_SUCCESSION_ROUTES.findProductSuccessions,
        findProductSuccessionsResponseSchema,
      ),
    decide: (id, decision) =>
      http.request(PRODUCT_SUCCESSION_ROUTES.decideProductSuccession, productSuccessionSchema, {
        params: { id },
        body: { decision },
      }),
  };
}
