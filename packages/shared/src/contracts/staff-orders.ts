import { z } from 'zod';
import { usdRateStringSchema } from './cost.js';
import { ORDER_STATUSES } from '../order-status.js';
import { STAFF_ROLES } from '../roles.js';
import { isoInstantSchema } from './common.js';
import {
  amountSchema,
  currencySchema,
  idSchema,
  optionalCommentSchema,
  requiredTextSchema,
  rowVersionSchema,
} from './order-parts.js';
import {
  customerOrderItemSchema,
  customerOrderListQuerySchema,
  orderActorRoleSchema,
  orderItemsChangeSchema,
  orderStatusSchema,
  paymentChangeSchema,
  paymentPlanChangeSchema,
  paymentPlanSchema,
  paymentStatusSchema,
  quantityStringSchema,
  wholeQuantityStringSchema,
} from './orders.js';
import { route } from './routes.js';
import {
  MAX_IMEI_SLOTS,
  MARKING_MAX_LENGTH,
  trackingTypeSchema,
  unitCodeKindSchema,
} from './unit-codes.js';

// STAFF-ONLY order contracts (hard rule 7 and the lifecycle's customer view). Deliberately NOT
// re-exported from the package barrel (`@iorder/shared`): they carry accounting vocabulary
// (including the skip marker), the price list version id, notification and delivery-contact shapes
// and the staff route paths. The staff app (apps/staff) may import the entry
// `@iorder/shared/staff-orders`; an ESLint rule and the bundle check keep customer code away from it.
// Staff DTOs come in two shapes per role: FULL (manager, accountant, admin) and FULFILMENT
// (warehouse, driver).

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/**
 * How the accounting step was (or will be) passed. The manager chooses the skip when approving,
 * on any day (lifecycle section 3.1, [C] 2026-10-20); nothing here depends on the calendar.
 */
export const ACCOUNTING_MODES = ['PENDING', 'APPROVED', 'SKIPPED_BY_MANAGER'] as const;
export type AccountingMode = (typeof ACCOUNTING_MODES)[number];

/**
 * How the customer pays for this order ("Naqd" / "Official"), chosen by the manager per order when
 * approving and changeable by the manager later ([C] 2026-10-24). A staff fact separate from the
 * payment STATUS: it never blocks or moves the workflow. Visible to manager and accountant only.
 */
export const PAYMENT_METHODS = ['CASH', 'OFFICIAL'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

/**
 * Mirrors the Prisma enum `order_event_type`; an api test compares the two. DRIVER_ASSIGNED,
 * ACCOUNTING_REVIEWED and COMMENT_ADDED are part of the documented list but nothing writes them yet.
 */
export const ORDER_EVENT_TYPES = [
  'SUBMITTED',
  'STATUS_CHANGED',
  'ITEMS_EDITED',
  'PAYMENT_STATUS_CHANGED',
  'PAYMENT_METHOD_CHANGED',
  /** The manager changed the customer's payment plan while the order was SUBMITTED. */
  'PAYMENT_PLAN_CHANGED',
  'DRIVER_ASSIGNED',
  'ACCOUNTING_SKIPPED',
  'ACCOUNTING_REVIEWED',
  'COMMENT_ADDED',
  /** The warehouse scanned (or rescanned) a unit code while picking. */
  'UNIT_CODE_RECORDED',
  /** The warehouse removed a scanned unit code while picking. */
  'UNIT_CODE_CLEARED',
  /** The warehouse brought back the goods of an order rejected or cancelled after approval. */
  'GOODS_RETURNED',
  /** The manager changed the stock holds of an approved order. Staff-only (full view). */
  'ALLOCATION_CHANGED',
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/** Who a notification row is addressed to (resolved to Telegram chats by the worker). */
export const NOTIFICATION_RECIPIENT_KINDS = ['USER', 'ROLE', 'ORGANIZATION_CHAT'] as const;
export type NotificationRecipientKind = (typeof NOTIFICATION_RECIPIENT_KINDS)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** What a notification is about; the worker picks wording and language from it. */
export const NOTIFICATION_TYPES = [
  'ORDER_SUBMITTED',
  'ORDER_MANAGER_APPROVED',
  /** To the warehouse on a normal approval: prepare and scan; the release waits for accounting. */
  'ORDER_READY_TO_PREPARE',
  'ORDER_ACCOUNTING_CLEARED',
  'ORDER_REJECTED',
  'ORDER_CANCELLED',
  'ORDER_RELEASED',
  'ORDER_DELIVERED',
  'ORDER_RECEIVED',
  'ORDER_ITEMS_EDITED',
  'ORDER_PAYMENT_PLAN_CHANGED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const MAX_EDIT_CHANGES = 200;
export const ORDER_SEARCH_MAX_LENGTH = 40;

// ---------------------------------------------------------------------------------------
// Staff requests. The row version is REQUIRED: staff decide on what they saw.
// ---------------------------------------------------------------------------------------

/**
 * Does the warehouse have goods to bring back? NOT_NEEDED: the order is open, closed before the
 * manager's approval, or closed before this rule existed. PENDING: rejected or cancelled after
 * approval and nobody has said so yet. RETURNED: somebody did.
 */
export const GOODS_RETURN_STATES = ['NOT_NEEDED', 'PENDING', 'RETURNED'] as const;
export type GoodsReturnState = (typeof GOODS_RETURN_STATES)[number];

/** The staff list's periods; the server owns the business day (Asia/Tashkent). */
export const STAFF_ORDER_PERIODS = ['TODAY'] as const;
export type StaffOrderPeriod = (typeof STAFF_ORDER_PERIODS)[number];

/** Several statuses in one query value, comma separated ("REJECTED,CANCELLED"). */
const statusListSchema = z
  .string()
  .transform((text) => text.split(','))
  .pipe(z.array(orderStatusSchema).min(1).max(ORDER_STATUSES.length));

export const staffOrderListQuerySchema = customerOrderListQuerySchema.extend({
  /** Any of these statuses (a stage tab, the closed tab, a role's queue). Ignored with `status`. */
  statuses: statusListSchema.optional(),
  organizationId: idSchema.optional(),
  /** Placed by this person. Manager, accountant and admin only (who placed it is FULL-view). */
  placedByUserId: idSchema.optional(),
  /** Submitted on the current business day. */
  period: z.enum(STAFF_ORDER_PERIODS).optional(),
  /**
   * Part of the order number ("10005" or "io-10005"), the organization's name or, for the roles
   * that see it, the name of who placed the order; letter case is ignored.
   */
  search: z.string().trim().min(1).max(ORDER_SEARCH_MAX_LENGTH).optional(),
  /** Only the orders whose goods still have to come back (the warehouse's return list). */
  goodsReturn: z.literal('PENDING').optional(),
});
export type StaffOrderListQuery = z.output<typeof staffOrderListQuerySchema>;

export const STAFF_ORDER_COUNT_GROUPS = ['ORGANIZATION'] as const;

/**
 * The list's filters without paging: what the stage tabs count over (they send no `statuses`).
 * `groupBy=ORGANIZATION` adds the same counts per organization.
 */
export const staffOrderCountsQuerySchema = staffOrderListQuerySchema
  .omit({ status: true, group: true, limit: true, cursor: true })
  .extend({ groupBy: z.enum(STAFF_ORDER_COUNT_GROUPS).optional() });
export type StaffOrderCountsQuery = z.output<typeof staffOrderCountsQuerySchema>;

/**
 * FIFO: the manager took the plan the system proposed, so it must still be that plan when approved.
 * MANUAL: the manager chose lines; they only have to still have room.
 */
export const ALLOCATION_MODES = ['FIFO', 'MANUAL'] as const;
export const allocationModeSchema = z.enum(ALLOCATION_MODES);
export type AllocationMode = z.infer<typeof allocationModeSchema>;

/** More rows than any real plan: a line of an order rarely spreads over more than a few deliveries. */
export const MAX_ALLOCATIONS_PER_ORDER = 2000;

export const allocationRequestRowSchema = z.strictObject({
  orderItemId: idSchema,
  /** A delivery line (one product on one delivery_ref). */
  supplyLineId: idSchema,
  /**
   * Up to 3 decimals only because a legacy fractional order line (written before the whole-number
   * rule) must stay approvable. The server refuses a fraction for a whole order line.
   */
  quantity: quantityStringSchema,
});
export type AllocationRequestRow = z.infer<typeof allocationRequestRowSchema>;

const allocationPlanShape = {
  allocationMode: allocationModeSchema,
  allocations: z.array(allocationRequestRowSchema).max(MAX_ALLOCATIONS_PER_ORDER),
};

export const approveOrderRequestSchema = z.strictObject({
  /** Manager only: continue without the accountant's approval. */
  skipAccounting: z.boolean().optional(),
  /** Required: every approved order has a payment method ([C] 2026-10-24). */
  paymentMethod: paymentMethodSchema,
  comment: optionalCommentSchema,
  expectedRowVersion: rowVersionSchema,
  ...allocationPlanShape,
});
export type ApproveOrderRequest = z.output<typeof approveOrderRequestSchema>;

/** Reject (manager step), reject (accounting step) and staff cancel: a reason is required. */
export const orderDecisionWithReasonRequestSchema = z.strictObject({
  reason: requiredTextSchema,
  expectedRowVersion: rowVersionSchema,
});
export type OrderDecisionWithReasonRequest = z.output<typeof orderDecisionWithReasonRequestSchema>;

/** Accounting approval and "delivered": an optional note. */
export const orderDecisionWithCommentRequestSchema = z.strictObject({
  comment: optionalCommentSchema,
  expectedRowVersion: rowVersionSchema,
});
export type OrderDecisionWithCommentRequest = z.output<
  typeof orderDecisionWithCommentRequestSchema
>;

export const releaseOrderRequestSchema = z.strictObject({
  driverUserId: idSchema,
  comment: optionalCommentSchema,
  expectedRowVersion: rowVersionSchema,
});
export type ReleaseOrderRequest = z.output<typeof releaseOrderRequestSchema>;

export const editOrderItemsRequestSchema = z
  .strictObject({
    /** quantity null = remove the line. */
    changes: z
      .array(z.strictObject({ itemId: idSchema, quantity: wholeQuantityStringSchema.nullable() }))
      .min(1)
      .max(MAX_EDIT_CHANGES),
    reason: optionalCommentSchema,
    expectedRowVersion: rowVersionSchema,
  })
  .refine(
    (request) => new Set(request.changes.map((c) => c.itemId)).size === request.changes.length,
    {
      path: ['changes'],
      message: 'A line can be changed only once per edit',
    },
  );
export type EditOrderItemsRequest = z.output<typeof editOrderItemsRequestSchema>;

/** Manager only, after approval. Like the payment status it carries no row version. */
export const setPaymentMethodRequestSchema = z.strictObject({
  paymentMethod: paymentMethodSchema,
  comment: optionalCommentSchema,
});
export type SetPaymentMethodRequest = z.output<typeof setPaymentMethodRequestSchema>;

/** Manager only, while SUBMITTED. It changes the total, so unlike the method it carries the version. */
export const setPaymentPlanRequestSchema = z.strictObject({
  paymentPlan: paymentPlanSchema,
  reason: optionalCommentSchema,
  expectedRowVersion: rowVersionSchema,
});
export type SetPaymentPlanRequest = z.output<typeof setPaymentPlanRequestSchema>;

// ---------------------------------------------------------------------------------------
// Responses: staff orders
// ---------------------------------------------------------------------------------------

export const staffOrderPersonSchema = z.strictObject({
  userId: idSchema,
  fullName: z.string(),
  phone: z.string().nullable(),
});
export type StaffOrderPerson = z.infer<typeof staffOrderPersonSchema>;

/**
 * Who to call when the goods arrive. Built from the organization and its members (there is no
 * address field in the data model yet): the person who placed the order and the shop owner.
 */
export const deliveryContactSchema = z.strictObject({
  organizationName: z.string(),
  contacts: z.array(
    z.strictObject({
      userId: idSchema,
      fullName: z.string(),
      phone: z.string().nullable(),
      placedTheOrder: z.boolean(),
      isShopOwner: z.boolean(),
    }),
  ),
});
export type DeliveryContact = z.infer<typeof deliveryContactSchema>;

const staffAccountingSchema = z.strictObject({
  mode: z.enum(ACCOUNTING_MODES),
  clearedAt: isoInstantSchema.nullable(),
  reviewedAt: isoInstantSchema.nullable(),
  reviewedByUserId: idSchema.nullable(),
});

/**
 * How many pieces of an order line sit on which supply ([C] owner 2026-10-30: 4 Honor 14A, 3 from
 * 77343 and 1 from 34343). Staff only, money-free and without cost or supplier; the customer schemas
 * do not have it. The party is read live, so a number set later shows on older orders too. An empty
 * list on an approved order: it is older than the holds ("Not allocated").
 */
export const orderItemAllocationSchema = z.strictObject({
  supplyRef: z.string(),
  partyNumber: z.string().nullable(),
  quantity: quantityStringSchema,
});
export type OrderItemAllocation = z.infer<typeof orderItemAllocationSchema>;

/**
 * The order's own two price snapshots: what the manager's plan change recomputes from. Null deferred
 * = the plan DEFERRED is impossible for this line (no price then, or an order older than the plan).
 */
export const staffOrderItemSchema = customerOrderItemSchema.extend({
  fullUnitPrice: amountSchema,
  deferredUnitPrice: amountSchema.nullable(),
  allocations: z.array(orderItemAllocationSchema),
  /** False: a product outside the plan (no sheet «Товар_ID»), `allocations` is always empty. */
  stockTracked: z.boolean(),
});

/** The warehouse and the driver see what they need to pack and deliver: no prices, no accounting. */
export const fulfilmentOrderItemSchema = z.strictObject({
  id: idSchema,
  productId: idSchema,
  productCode: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: quantityStringSchema,
  /** The warehouse only: ABSENT for the driver, who delivers the box and picks from no supply. */
  allocations: z.array(orderItemAllocationSchema).optional(),
  /** False: a product outside the plan (no sheet «Товар_ID»); there is no supply to pick from. */
  stockTracked: z.boolean(),
});

const staffOrderBase = {
  id: idSchema,
  orderNumber: z.string(),
  organizationId: idSchema,
  organizationName: z.string(),
  status: orderStatusSchema,
  itemCount: z.int().nonnegative(),
  submittedAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  rowVersion: rowVersionSchema,
  driver: staffOrderPersonSchema.nullable(),
  goodsReturn: z.enum(GOODS_RETURN_STATES),
  /** Set only when a person recorded the return. */
  goodsReturnedAt: isoInstantSchema.nullable(),
};

const fullSummaryFields = {
  ...staffOrderBase,
  detail: z.literal('FULL'),
  paymentStatus: paymentStatusSchema,
  paymentPlan: paymentPlanSchema,
  totalAmount: amountSchema,
  currency: currencySchema,
  /** UZS per 1 USD, frozen when the order was placed. Manager, accountant and admin only. */
  usdRate: usdRateStringSchema,
  /** Sum of the lines' USD values, shown at two decimals: what the order counts for in the debt. */
  totalUsd: amountSchema,
  customerComment: z.string().nullable(),
  placedBy: staffOrderPersonSchema,
  priceListVersionId: idSchema,
  accounting: staffAccountingSchema,
  /**
   * Manager and accountant only: ABSENT for the admin. Null until the manager approves (and on
   * orders rejected or cancelled before approval).
   */
  paymentMethod: paymentMethodSchema.nullable().optional(),
};

const fulfilmentSummaryFields = { ...staffOrderBase, detail: z.literal('FULFILMENT') };

export const staffOrderFullSummarySchema = z.strictObject(fullSummaryFields);
export const staffOrderFulfilmentSummarySchema = z.strictObject(fulfilmentSummaryFields);
export const staffOrderSummarySchema = z.discriminatedUnion('detail', [
  staffOrderFullSummarySchema,
  staffOrderFulfilmentSummarySchema,
]);
export type StaffOrderSummary = z.infer<typeof staffOrderSummarySchema>;

/** `deliveryContact` is null for the accountant (manager, admin, warehouse and driver get it). */
export const staffOrderFullSchema = z.strictObject({
  ...fullSummaryFields,
  items: z.array(staffOrderItemSchema),
  deliveryContact: deliveryContactSchema.nullable(),
});
export const staffOrderFulfilmentSchema = z.strictObject({
  ...fulfilmentSummaryFields,
  items: z.array(fulfilmentOrderItemSchema),
  deliveryContact: deliveryContactSchema,
});
export const staffOrderSchema = z.discriminatedUnion('detail', [
  staffOrderFullSchema,
  staffOrderFulfilmentSchema,
]);
export type StaffOrder = z.infer<typeof staffOrderSchema>;

export const staffOrderListResponseSchema = z.strictObject({
  orders: z.array(staffOrderSummarySchema),
  nextCursor: idSchema.nullable(),
});
export type StaffOrderListResponse = z.infer<typeof staffOrderListResponseSchema>;

export const staffOrderStatusCountSchema = z.strictObject({
  count: z.int().nonnegative(),
  /** Sum of the order totals (so'm). Manager, accountant and admin only: absent for the others. */
  totalAmount: amountSchema.optional(),
  /** Sum of the orders' USD totals, each at its rate from submit. The same three roles only. */
  totalUsd: amountSchema.optional(),
  /** `totalUsd` at the current rate, whole so'm; null while no rate is known. The same three roles. */
  totalUzsEquivalent: amountSchema.nullable().optional(),
});
export type StaffOrderStatusCount = z.infer<typeof staffOrderStatusCountSchema>;

/**
 * Matching orders per status (a status without any is left out), for the stage tabs and the
 * list's count and sum, which a paged list cannot add up itself.
 */
export const staffOrderCountsResponseSchema = z.strictObject({
  byStatus: z.partialRecord(orderStatusSchema, staffOrderStatusCountSchema),
  /** With `groupBy=ORGANIZATION` only: every status together, per organization that has any. */
  byOrganization: z.record(idSchema, staffOrderStatusCountSchema).optional(),
});
export type StaffOrderCountsResponse = z.infer<typeof staffOrderCountsResponseSchema>;

// ---------------------------------------------------------------------------------------
// Responses: staff timeline
// ---------------------------------------------------------------------------------------

export const timelineNotificationSchema = z.strictObject({
  id: idSchema,
  type: z.enum(NOTIFICATION_TYPES),
  recipientKind: z.enum(NOTIFICATION_RECIPIENT_KINDS),
  recipientRole: z.enum(STAFF_ROLES).nullable(),
  recipientUserId: idSchema.nullable(),
  /** The person's name, or the organization's name for its chat. */
  recipientName: z.string().nullable(),
  status: z.enum(NOTIFICATION_STATUSES),
  attempts: z.int().nonnegative(),
  createdAt: isoInstantSchema,
  sentAt: isoInstantSchema.nullable(),
});
export type TimelineNotification = z.infer<typeof timelineNotificationSchema>;

export const staffTimelineEventSchema = z.strictObject({
  id: idSchema,
  type: z.enum(ORDER_EVENT_TYPES),
  occurredAt: isoInstantSchema,
  fromStatus: orderStatusSchema.nullable(),
  toStatus: orderStatusSchema.nullable(),
  actor: z.strictObject({
    userId: idSchema.nullable(),
    role: orderActorRoleSchema,
    name: z.string().nullable(),
  }),
  comment: z.string().nullable(),
  /** FULL detail only (null for the warehouse and the driver). */
  accountingMode: z
    .strictObject({
      from: z.enum(ACCOUNTING_MODES).nullable(),
      to: z.enum(ACCOUNTING_MODES),
    })
    .nullable(),
  /** Set when the event assigned a driver (the release). */
  driver: staffOrderPersonSchema.nullable(),
  itemsChange: orderItemsChangeSchema.nullable(),
  paymentChange: paymentChangeSchema.nullable(),
  /** Set on the manager's approval and on PAYMENT_METHOD_CHANGED; null for whoever may not see it. */
  paymentMethodChange: z
    .strictObject({ from: paymentMethodSchema.nullable(), to: paymentMethodSchema })
    .nullable(),
  /** Set on PAYMENT_PLAN_CHANGED. Never for the warehouse and the driver, who do not get that event. */
  paymentPlanChange: paymentPlanChangeSchema.nullable(),
  /** What was sent, or is waiting to be sent, because of this event. Empty for the FULFILMENT detail. */
  notifications: z.array(timelineNotificationSchema),
});
export type StaffTimelineEvent = z.infer<typeof staffTimelineEventSchema>;

export const staffTimelineResponseSchema = z.strictObject({
  orderId: idSchema,
  detail: z.enum(['FULL', 'FULFILMENT']),
  events: z.array(staffTimelineEventSchema),
});
export type StaffTimelineResponse = z.infer<typeof staffTimelineResponseSchema>;

// ---------------------------------------------------------------------------------------
// Routes. The api has a test that compares this table (and ORDER_ROUTES) with the Nest router in
// both directions. Every action carries `expectedRowVersion` (a stale one answers 409
// ORDER_CHANGED), except the payment status.
// ---------------------------------------------------------------------------------------

/** One selectable driver. Deliberately only id and name: no phone, no Telegram id. */
export const staffDriverSchema = z.strictObject({
  id: idSchema,
  fullName: z.string(),
});
export type StaffDriver = z.infer<typeof staffDriverSchema>;

export const staffDriverListResponseSchema = z.strictObject({
  items: z.array(staffDriverSchema),
});
export type StaffDriverListResponse = z.infer<typeof staffDriverListResponseSchema>;

// ---------------------------------------------------------------------------------------
// Picking: per-unit codes scanned by the warehouse ([C] 2026-10-25)
// ---------------------------------------------------------------------------------------

export const pickingCodeSchema = z.strictObject({
  kind: unitCodeKindSchema,
  slot: z.int().min(1).max(MAX_IMEI_SLOTS),
  value: z.string(),
  recordedAt: isoInstantSchema,
});
export type PickingCode = z.infer<typeof pickingCodeSchema>;

export const pickingSlotSchema = z.strictObject({
  kind: unitCodeKindSchema,
  slot: z.int().min(1).max(MAX_IMEI_SLOTS),
});
export type PickingSlot = z.infer<typeof pickingSlotSchema>;

export const pickingUnitSchema = z.strictObject({
  unitId: idSchema,
  unitNo: z.int().positive(),
  codes: z.array(pickingCodeSchema),
  /** Required (kind, slot) pairs still empty. Computed by the server on every read. */
  missing: z.array(pickingSlotSchema),
});
export type PickingUnit = z.infer<typeof pickingUnitSchema>;

export const pickingLineSchema = z.strictObject({
  itemId: idSchema,
  productId: idSchema,
  productCode: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: quantityStringSchema,
  /** The product's CURRENT rule (release checks the current rule, never a stored flag). */
  trackingType: trackingTypeSchema,
  markingRequired: z.boolean(),
  allocations: z.array(orderItemAllocationSchema),
  /** False: a product outside the plan (no sheet «Товар_ID»); `allocations` is always empty. */
  stockTracked: z.boolean(),
  units: z.array(pickingUnitSchema),
  /** How many units still miss a required code. */
  incompleteUnits: z.int().nonnegative(),
});
export type PickingLine = z.infer<typeof pickingLineSchema>;

export const pickingResponseSchema = z.strictObject({
  orderId: idSchema,
  orderNumber: z.string(),
  status: orderStatusSchema,
  rowVersion: z.int().positive(),
  /** Codes may be scanned (order MANAGER_APPROVED or ACCOUNTING_CLEARED and the caller may record). */
  editable: z.boolean(),
  /** Every required code is there: the release button may be used. */
  complete: z.boolean(),
  lines: z.array(pickingLineSchema),
});
export type PickingResponse = z.infer<typeof pickingResponseSchema>;

/** One scan. The server normalises and validates (packages/shared unit-codes) and checks uniqueness. */
export const recordUnitCodeRequestSchema = z.strictObject({
  kind: unitCodeKindSchema,
  slot: z.int().min(1).max(MAX_IMEI_SLOTS).default(1),
  value: z.string().min(1).max(MARKING_MAX_LENGTH),
});
export type RecordUnitCodeRequest = z.output<typeof recordUnitCodeRequestSchema>;

export const STAFF_PICKING_ROUTES = Object.freeze({
  getPicking: route('GET', '/staff/orders/:id/picking'),
  recordUnitCode: route('PUT', '/staff/orders/:id/units/:unitId/codes'),
  clearUnitCode: route('DELETE', '/staff/orders/:id/units/:unitId/codes/:kind/:slot'),
});

/** The warehouse's way to the driver list (the identity directory needs EDIT_CUSTOMERS). */
export const STAFF_DRIVER_ROUTES = Object.freeze({
  listDrivers: route('GET', '/staff/drivers'),
});

// ---------------------------------------------------------------------------------------
// Stock holds ([C] owner 2026-10-30). Manager only; no cost, no supplier.
// ---------------------------------------------------------------------------------------

/** The manager replaces the holds of an approved order (until the release). */
export const setOrderAllocationsRequestSchema = z.strictObject({
  comment: optionalCommentSchema,
  expectedRowVersion: rowVersionSchema,
  ...allocationPlanShape,
});
export type SetOrderAllocationsRequest = z.output<typeof setOrderAllocationsRequestSchema>;

/** Stock figures may be zero; quantityStringSchema (an ordered quantity) may not. */
const stockFigureSchema = z.string().regex(/^\d+\.\d{3}$/);

/** A delivery line the manager can hold from. `heldQuantity` counts OTHER orders only. */
export const allocationSupplyLineSchema = z.strictObject({
  supplyLineId: idSchema,
  deliveryRef: z.string(),
  deliveredAt: isoInstantSchema,
  availableQuantity: stockFigureSchema,
  heldQuantity: stockFigureSchema,
  /** available minus held, never below zero. */
  freeQuantity: stockFigureSchema,
});
export type AllocationSupplyLine = z.infer<typeof allocationSupplyLineSchema>;

export const allocationRowSchema = z.strictObject({
  supplyLineId: idSchema,
  deliveryRef: z.string(),
  quantity: quantityStringSchema,
});
export type AllocationRow = z.infer<typeof allocationRowSchema>;

/**
 * Why a hold needs a look. LINE_SHORT: the sheet now shows less than the line's holds, possibly
 * because this very order was shipped from the sheet. LINE_REMOVED: the line left the sheet and a
 * manager confirmed it. Computed on read; nothing changes by itself.
 */
export const ALLOCATION_ATTENTIONS = ['LINE_SHORT', 'LINE_REMOVED'] as const;
export type AllocationAttention = (typeof ALLOCATION_ATTENTIONS)[number];

export const allocationPreviewItemSchema = z.strictObject({
  orderItemId: idSchema,
  productId: idSchema,
  productCode: z.string(),
  name: z.string(),
  quantity: quantityStringSchema,
  /**
   * False for a staff-added product without a sheet «Товар_ID» [C, 2026-11-09]: it has no supply
   * lines and is outside the plan (no hold, never short), so `lines`, `fifo` and `current` are empty
   * and `shortQuantity` is zero. The UI shows "stock not tracked" instead of a plan.
   */
  stockTracked: z.boolean(),
  /** The live lines of the product, oldest first (the FIFO order). */
  lines: z.array(allocationSupplyLineSchema),
  /** The proposal; for an approved order, the ready alternative. */
  fifo: z.array(allocationRowSchema),
  /** What the free lines cannot cover. */
  shortQuantity: stockFigureSchema,
  /** SUBMITTED orders that came earlier and want this product. They hold nothing yet. */
  earlierDemand: z.strictObject({
    orders: z.number().int().nonnegative(),
    quantity: stockFigureSchema,
  }),
  /** The holds of this order now. */
  current: z.array(
    allocationRowSchema.extend({ attention: z.enum(ALLOCATION_ATTENTIONS).nullable() }),
  ),
});
export type AllocationPreviewItem = z.infer<typeof allocationPreviewItemSchema>;

export const allocationPreviewSchema = z.strictObject({
  orderId: idSchema,
  status: orderStatusSchema,
  rowVersion: rowVersionSchema,
  items: z.array(allocationPreviewItemSchema),
  /** Every line of the order can be covered from the free lines. */
  feasible: z.boolean(),
  /** Some hold of this order needs a look. */
  attention: z.boolean(),
  /** An order approved before holds existed: nothing is held for it. */
  notAllocated: z.boolean(),
  /** When a sync last changed a delivery line here; null when none is stored. */
  lastSheetChangeAt: isoInstantSchema.nullable(),
});
export type AllocationPreview = z.infer<typeof allocationPreviewSchema>;

export const STAFF_ORDER_ROUTES = Object.freeze({
  listOrders: route('GET', '/staff/orders'),
  countOrders: route('GET', '/staff/orders/counts'),
  getOrder: route('GET', '/staff/orders/:id'),
  getOrderTimeline: route('GET', '/staff/orders/:id/timeline'),
  approveOrder: route('POST', '/staff/orders/:id/approve'),
  getAllocationPreview: route('GET', '/staff/orders/:id/allocation-preview'),
  setOrderAllocations: route('POST', '/staff/orders/:id/allocations'),
  rejectOrder: route('POST', '/staff/orders/:id/reject'),
  cancelOrder: route('POST', '/staff/orders/:id/cancel'),
  accountingApproveOrder: route('POST', '/staff/orders/:id/accounting-approve'),
  accountingRejectOrder: route('POST', '/staff/orders/:id/accounting-reject'),
  releaseOrder: route('POST', '/staff/orders/:id/release'),
  deliverOrder: route('POST', '/staff/orders/:id/deliver'),
  markGoodsReturned: route('POST', '/staff/orders/:id/goods-returned'),
  editOrderItems: route('PATCH', '/staff/orders/:id/items'),
  setPaymentMethod: route('PUT', '/staff/orders/:id/payment-method'),
  setPaymentPlan: route('PUT', '/staff/orders/:id/payment-plan'),
});
