import {
  IDEMPOTENCY_KEY_HEADER,
  ORDER_ROUTES,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerTimelineResponseSchema,
  type ChangeOwnPaymentPlanRequest,
  type CustomerOrder,
  type CustomerOrderListResponse,
  type CustomerReceiveOrderRequest,
  type SubmitOrderRequest,
  type CustomerTimelineResponse,
  type OrderStatus,
  type CustomerOrderGroup,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

export interface OrderListQuery {
  readonly status?: OrderStatus;
  readonly group?: CustomerOrderGroup;
  readonly search?: string;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: string;
  readonly limit?: number;
}

/** Orders of the person's own organization. A foreign or unknown order is a 404. */
export interface CustomerOrdersApi {
  /** The same key twice returns the same order, so a retry after a network error is safe. */
  submit: (idempotencyKey: string, request: SubmitOrderRequest) => Promise<CustomerOrder>;
  list: (query?: OrderListQuery) => Promise<CustomerOrderListResponse>;
  get: (orderId: string) => Promise<CustomerOrder>;
  timeline: (orderId: string) => Promise<CustomerTimelineResponse>;
  /** Only while SUBMITTED, and a reason is mandatory. */
  receive: (orderId: string, request?: CustomerReceiveOrderRequest) => Promise<CustomerOrder>;
  /** Only inside the time the order answer names; the server decides. */
  changePaymentPlan: (
    orderId: string,
    request: ChangeOwnPaymentPlanRequest,
  ) => Promise<CustomerOrder>;
}

export function createHttpCustomerOrdersApi(http: HttpClient): CustomerOrdersApi {
  return {
    submit: (idempotencyKey, request) =>
      http.request(ORDER_ROUTES.submitOrder, customerOrderSchema, {
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        body: request,
      }),
    list: (query = {}) =>
      http.request(ORDER_ROUTES.listOrders, customerOrderListResponseSchema, {
        query: {
          status: query.status,
          group: query.group,
          search: query.search,
          cursor: query.cursor,
          limit: query.limit === undefined ? undefined : String(query.limit),
        },
      }),
    get: (orderId) =>
      http.request(ORDER_ROUTES.getOrder, customerOrderSchema, { params: { id: orderId } }),
    timeline: (orderId) =>
      http.request(ORDER_ROUTES.getOrderTimeline, customerTimelineResponseSchema, {
        params: { id: orderId },
      }),
    receive: (orderId, request = {}) =>
      http.request(ORDER_ROUTES.receiveOrder, customerOrderSchema, {
        params: { id: orderId },
        body: request,
      }),
    changePaymentPlan: (orderId, request) =>
      http.request(ORDER_ROUTES.changeOrderPaymentPlan, customerOrderSchema, {
        params: { id: orderId },
        body: request,
      }),
  };
}
