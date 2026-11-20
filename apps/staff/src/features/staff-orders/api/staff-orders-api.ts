import {
  STAFF_ORDER_ROUTES,
  STAFF_PICKING_ROUTES,
  pickingResponseSchema,
  staffOrderCountsResponseSchema,
  staffOrderListResponseSchema,
  staffOrderSchema,
  allocationPreviewSchema,
  newOrderCatalogResponseSchema,
  newOrderCustomersResponseSchema,
  type AllocationPreview,
  type CreateStaffOrderRequest,
  type NewOrderCatalogResponse,
  type NewOrderCustomerQuery,
  type NewOrderCustomersResponse,
  type SetOrderAllocationsRequest,
  type ApproveOrderRequest,
  type EditOrderItemsRequest,
  type OrderDecisionWithCommentRequest,
  type OrderDecisionWithReasonRequest,
  type PickingResponse,
  type RecordUnitCodeRequest,
  type ReleaseOrderRequest,
  type SetPaymentMethodRequest,
  type SetPaymentPlanRequest,
  type StaffOrder,
  type StaffOrderCountsQuery,
  type StaffOrderCountsResponse,
  type StaffOrderListQuery,
  type StaffOrderListResponse,
  type UnitCodeKind,
} from '@iorder/shared/staff-orders';
import type { HttpClient } from '@core/lib/http-client';
import { tolerantTimelineResponseSchema, type TimelineResponse } from '../domain/timeline-model';

/**
 * The staff order endpoints, one method per route of `STAFF_ORDER_ROUTES`. Payload types are the
 * shared contract's. Every decision carries `expectedRowVersion` (the version the person saw): a
 * stale one answers 409 with the reason ORDER_CHANGED, and the screen then re-reads the order.
 * Every cancel and reject carries a reason; skipping accounting is an option of `approve` only.
 * What each role may see (FULL or FULFILMENT, phones, delivery contact) and do is decided by the
 * server; the web only hides what a role cannot use.
 */
export interface StaffOrdersApi {
  /** One page, newest first. Pass `nextCursor` of the previous page as `cursor`. */
  listOrders: (query?: StaffOrderListQuery) => Promise<StaffOrderListResponse>;
  /** Matching orders per status over the list's filters (the stage tabs, the count and sum). */
  countOrders: (query?: StaffOrderCountsQuery) => Promise<StaffOrderCountsResponse>;
  /**
   * The manager's new order [C, owner 2026-11-20], step 1: ACTIVE organizations by name, member name
   * or phone, type and label, with their current members; `recent` = the «Oxirgi mijozlar» chips.
   */
  listNewOrderCustomers: (query?: NewOrderCustomerQuery) => Promise<NewOrderCustomersResponse>;
  /** Step 2: what the organization may order, at its price tier, with the free stock as a hint. */
  getNewOrderCatalog: (organizationId: string) => Promise<NewOrderCatalogResponse>;
  /**
   * Step 4: creates the SUBMITTED order. `idempotencyKey` is new per attempt of one order: a retry
   * with the same key returns the same order.
   */
  createOrder: (request: CreateStaffOrderRequest, idempotencyKey: string) => Promise<StaffOrder>;
  /** 404 for an order the role may not see. */
  getOrder: (orderId: string) => Promise<StaffOrder>;
  getTimeline: (orderId: string) => Promise<TimelineResponse>;
  /** Manager only. SUBMITTED to MANAGER_APPROVED, or on to ACCOUNTING_CLEARED with the skip. */
  approve: (orderId: string, request: ApproveOrderRequest) => Promise<StaffOrder>;
  /** Manager only: the FIFO proposal, what is short, the holds now. */
  getAllocationPreview: (orderId: string) => Promise<AllocationPreview>;
  /** Manager only, once approved and until the release: moves the holds. */
  setAllocations: (
    orderId: string,
    request: SetOrderAllocationsRequest,
  ) => Promise<AllocationPreview>;
  /** Manager only (SUBMITTED to REJECTED). */
  reject: (orderId: string, request: OrderDecisionWithReasonRequest) => Promise<StaffOrder>;
  /** Manager and admin, until the goods are released. */
  cancel: (orderId: string, request: OrderDecisionWithReasonRequest) => Promise<StaffOrder>;
  /** Accountant only (MANAGER_APPROVED to ACCOUNTING_CLEARED). */
  accountingApprove: (
    orderId: string,
    request: OrderDecisionWithCommentRequest,
  ) => Promise<StaffOrder>;
  /** Accountant only (MANAGER_APPROVED to REJECTED). */
  accountingReject: (
    orderId: string,
    request: OrderDecisionWithReasonRequest,
  ) => Promise<StaffOrder>;
  /** Warehouse manager only, with the driver. */
  release: (orderId: string, request: ReleaseOrderRequest) => Promise<StaffOrder>;
  /** The assigned driver only. */
  deliver: (orderId: string, request: OrderDecisionWithCommentRequest) => Promise<StaffOrder>;
  /** Warehouse only: the goods of an order rejected or cancelled after approval are back. */
  markGoodsReturned: (
    orderId: string,
    request: OrderDecisionWithCommentRequest,
  ) => Promise<StaffOrder>;
  /** Manager only, while SUBMITTED. One call is one history event and one customer message. */
  editItems: (orderId: string, request: EditOrderItemsRequest) => Promise<StaffOrder>;
  /**
   * Manager only, once approved and while not rejected or cancelled. No row version: like the
   * payment status it never moves the workflow.
   */
  setPaymentMethod: (orderId: string, request: SetPaymentMethodRequest) => Promise<StaffOrder>;
  /** Manager only, while SUBMITTED. One call is one history event and one customer message. */
  setPaymentPlan: (orderId: string, request: SetPaymentPlanRequest) => Promise<StaffOrder>;
  /**
   * The per-unit codes of an order ([C] 2026-10-25). Manager, accountant, admin and the warehouse
   * read it; only the warehouse may scan, while the order is ACCOUNTING_CLEARED (`editable`). The
   * driver gets 403.
   */
  getPicking: (orderId: string) => Promise<PickingResponse>;
  /**
   * One scan into one (kind, slot) of a unit; a filled slot is replaced. 422 with a
   * UNIT_CODE_ERRORS message for a malformed code, 409 UNIT_CODE_DUPLICATE when another live unit
   * holds it. Answers the whole picking view.
   */
  recordUnitCode: (
    orderId: string,
    unitId: string,
    request: RecordUnitCodeRequest,
  ) => Promise<PickingResponse>;
  /** Removes a scanned code (kept in history on the server). Answers the whole picking view. */
  clearUnitCode: (
    orderId: string,
    unitId: string,
    kind: UnitCodeKind,
    slot: number,
  ) => Promise<PickingResponse>;
}

export function createHttpStaffOrdersApi(http: HttpClient): StaffOrdersApi {
  const post = (
    spec: (typeof STAFF_ORDER_ROUTES)[keyof typeof STAFF_ORDER_ROUTES],
    orderId: string,
    body: unknown,
  ): Promise<StaffOrder> => http.request(spec, staffOrderSchema, { params: { id: orderId }, body });

  return {
    listOrders: (query = {}) =>
      http.request(STAFF_ORDER_ROUTES.listOrders, staffOrderListResponseSchema, {
        query: {
          status: query.status,
          statuses: query.statuses?.join(','),
          ...filterQuery(query),
          limit: query.limit === undefined ? undefined : String(query.limit),
          cursor: query.cursor,
        },
      }),
    countOrders: (query = {}) =>
      http.request(STAFF_ORDER_ROUTES.countOrders, staffOrderCountsResponseSchema, {
        query: {
          ...filterQuery(query),
          statuses: query.statuses?.join(','),
          groupBy: query.groupBy,
        },
      }),
    listNewOrderCustomers: (query = {}) =>
      http.request(STAFF_ORDER_ROUTES.listNewOrderCustomers, newOrderCustomersResponseSchema, {
        query: { search: query.search, type: query.type, label: query.label },
      }),
    getNewOrderCatalog: (organizationId) =>
      http.request(STAFF_ORDER_ROUTES.getNewOrderCatalog, newOrderCatalogResponseSchema, {
        query: { organizationId },
      }),
    createOrder: (request, idempotencyKey) =>
      http.request(STAFF_ORDER_ROUTES.createOrder, staffOrderSchema, {
        body: request,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    getOrder: (orderId) =>
      http.request(STAFF_ORDER_ROUTES.getOrder, staffOrderSchema, { params: { id: orderId } }),
    getTimeline: (orderId) =>
      http.request(STAFF_ORDER_ROUTES.getOrderTimeline, tolerantTimelineResponseSchema, {
        params: { id: orderId },
      }),
    approve: (orderId, request) => post(STAFF_ORDER_ROUTES.approveOrder, orderId, request),
    getAllocationPreview: (orderId) =>
      http.request(STAFF_ORDER_ROUTES.getAllocationPreview, allocationPreviewSchema, {
        params: { id: orderId },
      }),
    setAllocations: (orderId, request) =>
      http.request(STAFF_ORDER_ROUTES.setOrderAllocations, allocationPreviewSchema, {
        params: { id: orderId },
        body: request,
      }),
    reject: (orderId, request) => post(STAFF_ORDER_ROUTES.rejectOrder, orderId, request),
    cancel: (orderId, request) => post(STAFF_ORDER_ROUTES.cancelOrder, orderId, request),
    accountingApprove: (orderId, request) =>
      post(STAFF_ORDER_ROUTES.accountingApproveOrder, orderId, request),
    accountingReject: (orderId, request) =>
      post(STAFF_ORDER_ROUTES.accountingRejectOrder, orderId, request),
    release: (orderId, request) => post(STAFF_ORDER_ROUTES.releaseOrder, orderId, request),
    deliver: (orderId, request) => post(STAFF_ORDER_ROUTES.deliverOrder, orderId, request),
    markGoodsReturned: (orderId, request) =>
      post(STAFF_ORDER_ROUTES.markGoodsReturned, orderId, request),
    editItems: (orderId, request) => post(STAFF_ORDER_ROUTES.editOrderItems, orderId, request),
    setPaymentMethod: (orderId, request) =>
      post(STAFF_ORDER_ROUTES.setPaymentMethod, orderId, request),
    setPaymentPlan: (orderId, request) => post(STAFF_ORDER_ROUTES.setPaymentPlan, orderId, request),
    getPicking: (orderId) =>
      http.request(STAFF_PICKING_ROUTES.getPicking, pickingResponseSchema, {
        params: { id: orderId },
      }),
    recordUnitCode: (orderId, unitId, request) =>
      http.request(STAFF_PICKING_ROUTES.recordUnitCode, pickingResponseSchema, {
        params: { id: orderId, unitId },
        body: request,
      }),
    clearUnitCode: (orderId, unitId, kind, slot) =>
      http.request(STAFF_PICKING_ROUTES.clearUnitCode, pickingResponseSchema, {
        params: { id: orderId, unitId, kind, slot: String(slot) },
      }),
  };
}

/** The filters the list and its counts share, as query values. */
function filterQuery(
  query: Omit<StaffOrderCountsQuery, 'statuses' | 'groupBy'>,
): Record<string, string | undefined> {
  return {
    paymentStatus: query.paymentStatus,
    paymentPlan: query.paymentPlan,
    organizationId: query.organizationId,
    placedByUserId: query.placedByUserId,
    period: query.period,
    search: query.search,
    goodsReturn: query.goodsReturn,
  };
}
