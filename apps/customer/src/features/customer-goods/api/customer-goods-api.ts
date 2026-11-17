import {
  CUSTOMER_GOODS_ROUTES,
  customerGoodsSummarySchema,
  customerGoodsListSchema,
  customerGoodsProductSchema,
  customerGoodsUnitSchema,
  type CustomerGoodsSummary,
  type CustomerGoodsList,
  type CustomerGoodsProduct,
  type CustomerGoodsUnit,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';
export interface GoodsQuery {
  search?: string;
  cursor?: string;
  limit?: number;
}
export interface CustomerGoodsApi {
  summary: () => Promise<CustomerGoodsSummary>;
  list: (query?: GoodsQuery) => Promise<CustomerGoodsList>;
  product: (productId: string, query?: GoodsQuery) => Promise<CustomerGoodsProduct>;
  unit: (productId: string, unitId: string) => Promise<CustomerGoodsUnit>;
  acknowledgeDiscovery: () => Promise<void>;
}
function queryParams(query: GoodsQuery = {}): Record<string, string | undefined> {
  return {
    search: query.search?.trim() || undefined,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : String(query.limit),
  };
}
export function createHttpCustomerGoodsApi(http: HttpClient): CustomerGoodsApi {
  return {
    summary: () => http.request(CUSTOMER_GOODS_ROUTES.summary, customerGoodsSummarySchema),
    list: (query) =>
      http.request(CUSTOMER_GOODS_ROUTES.list, customerGoodsListSchema, {
        query: queryParams(query),
      }),
    product: (productId, query) =>
      http.request(CUSTOMER_GOODS_ROUTES.product, customerGoodsProductSchema, {
        params: { productId },
        query: queryParams(query),
      }),
    unit: (productId, unitId) =>
      http.request(CUSTOMER_GOODS_ROUTES.unit, customerGoodsUnitSchema, {
        params: { productId, unitId },
      }),
    acknowledgeDiscovery: () => http.requestVoid(CUSTOMER_GOODS_ROUTES.acknowledgeDiscovery),
  };
}
