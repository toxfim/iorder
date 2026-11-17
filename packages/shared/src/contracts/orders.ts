import { z } from 'zod';
import { ORDER_STATUSES, PAYMENT_STATUSES } from '../order-status.js';
import { ORGANIZATION_ROLES, STAFF_ROLES } from '../roles.js';
import { decimalStringSchema, isoInstantSchema, orderableStockSchema } from './common.js';
import {
  ORDER_REASON_MAX_LENGTH,
  amountSchema,
  currencySchema,
  idSchema,
  optionalCommentSchema,
  rowVersionSchema,
} from './order-parts.js';

export { ORDER_REASON_MAX_LENGTH };

// Orders over HTTP, CUSTOMER side. Money and quantities are decimal STRINGS, timestamps ISO 8601
// UTC, ids uuid strings. Customer DTOs are explicit allow-lists: no accounting mode, no price list
// version, no staff user ids, no outbox data (hard rule 7 and the lifecycle's customer view).
// Everything staff-only (staff DTOs, staff requests, notification and accounting vocabulary,
// delivery contact, staff routes) lives in staff-orders.ts and is exported ONLY by the
// `@iorder/shared/staff-orders` entry, so the customer bundle cannot pull it in. Response schemas
// are strict, so a field added to a response without a contract change fails the api tests and
// the web parser.

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/** Who acted on an order: a staff role, the customer's organization role, or the system. */
export const ORDER_ACTOR_ROLES = [...STAFF_ROLES, ...ORGANIZATION_ROLES, 'SYSTEM'] as const;
export type OrderActorRole = (typeof ORDER_ACTOR_ROLES)[number];

export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const orderActorRoleSchema = z.enum(ORDER_ACTOR_ROLES);

/**
 * How the customer will pay for this order ("To'lov turi", owner 2026-10-29): FULL at once at the
 * sale price, or DEFERRED in parts at the deferred price. The customer chooses in the cart and may
 * change it for a short time after submitting; the manager may change it while the order is
 * SUBMITTED. It has nothing to do
 * with the staff-only payment method CASH/OFFICIAL ("Savdo turi") or the payment status.
 */
export const PAYMENT_PLANS = ['FULL', 'DEFERRED'] as const;
export type PaymentPlan = (typeof PAYMENT_PLANS)[number];
export const paymentPlanSchema = z.enum(PAYMENT_PLANS);

// ---------------------------------------------------------------------------------------
// Shared limits and building blocks
// ---------------------------------------------------------------------------------------

/** The request header that identifies one submit attempt. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** A client-generated key (for example a UUID): letters, digits and `_ . : -` only. */
export const idempotencyKeySchema = z
  .string({ error: `The ${IDEMPOTENCY_KEY_HEADER} header is required` })
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Use letters, digits and _ . : - only');

export const DEFAULT_ORDER_PAGE_SIZE = 25;
export const MAX_ORDER_PAGE_SIZE = 100;

/** A positive quantity: at most 6 integer and 3 fraction digits (up to 999999.999). */
export const quantityStringSchema = decimalStringSchema({
  maxIntegerDigits: 6,
  maxFractionDigits: 3,
  positive: true,
  message: 'Quantity must be a positive decimal string with at most 3 fraction digits',
});

/**
 * What a person may ORDER: whole pieces only (owner 2026-10-25: "bizda kasr miqdor bo'lmaydi").
 * `2` and `2.000` are accepted, `2.5` is not. Responses keep quantityStringSchema ("2.000").
 */
export const wholeQuantityStringSchema = quantityStringSchema.refine(
  (value) => !/\.\d*[1-9]/.test(value),
  'Quantity must be a whole number',
);

/** An amount that may be zero (totals of an empty cart, a rounded-down line). */

// ---------------------------------------------------------------------------------------
// Customer requests
// ---------------------------------------------------------------------------------------

export const setCartItemRequestSchema = z.strictObject({ quantity: wholeQuantityStringSchema });
export type SetCartItemRequest = z.output<typeof setCartItemRequestSchema>;

/**
 * Both required: the server never guesses the plan, and refuses (409 CART_TOTAL_CHANGED) when the
 * chosen plan's total is no longer the one the customer was shown.
 */
export const submitOrderRequestSchema = z.strictObject({
  paymentPlan: paymentPlanSchema,
  expectedTotalAmount: amountSchema,
});
export type SubmitOrderRequest = z.output<typeof submitOrderRequestSchema>;

/** The customer's own change, inside the window after submitting (lifecycle 3.3). */
export const changeOwnPaymentPlanRequestSchema = z.strictObject({
  paymentPlan: paymentPlanSchema,
  expectedRowVersion: rowVersionSchema,
});
export type ChangeOwnPaymentPlanRequest = z.output<typeof changeOwnPaymentPlanRequestSchema>;

/** Customers may omit the version for their own receive; a stale one answers ORDER_CHANGED. Customers cannot cancel (2026-10-22). */
export const customerReceiveOrderRequestSchema = z
  .strictObject({
    comment: optionalCommentSchema,
    expectedRowVersion: rowVersionSchema.optional(),
  })
  .default({});
export type CustomerReceiveOrderRequest = z.output<typeof customerReceiveOrderRequestSchema>;

const pageLimitSchema = z.coerce.number().int().min(1).max(MAX_ORDER_PAGE_SIZE);

export const CUSTOMER_ORDER_GROUP_STATUSES = {
  ACTIVE: ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED'],
  COMPLETED: ['RECEIVED', 'REJECTED', 'CANCELLED'],
} as const;
export const customerOrderGroupSchema = z.enum(['ACTIVE', 'COMPLETED']);
export type CustomerOrderGroup = z.infer<typeof customerOrderGroupSchema>;
export const customerOrderSearchSchema = z.string().trim().min(1).max(40);

export const customerOrderListQuerySchema = z.strictObject({
  status: orderStatusSchema.optional(),
  group: customerOrderGroupSchema.optional(),
  search: customerOrderSearchSchema.optional(),
  paymentStatus: paymentStatusSchema.optional(),
  limit: pageLimitSchema.optional(),
  /** The `nextCursor` of the previous page. */
  cursor: idSchema.optional(),
});
export type CustomerOrderListQuery = z.output<typeof customerOrderListQuerySchema>;

// ---------------------------------------------------------------------------------------
// Responses: cart
// ---------------------------------------------------------------------------------------

/**
 * Why a cart line keeps the order from being placed. INACTIVE, NOT_PRICED and INCOMPLETE: the
 * product cannot be ordered at all, so the line shows no price. STOCK_EXCEEDED [C, 2026-11-09]:
 * the product is priced and active, but the stock fell below the quantity after it was put in the
 * cart; the line keeps its prices and `orderableStock` says how many can still be ordered. With
 * `orderableStock` 0 nothing is left: there is no quantity to lower to, the line has to be removed.
 */
export const CART_LINE_PROBLEMS = [
  'INACTIVE',
  'NOT_PRICED',
  'INCOMPLETE',
  'STOCK_EXCEEDED',
] as const;
export type CartLineProblem = (typeof CART_LINE_PROBLEMS)[number];

export const cartLineSchema = z.strictObject({
  productId: idSchema,
  productCode: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: quantityStringSchema,
  /** The sale price (plan FULL). Null while the product cannot be ordered (see CART_LINE_PROBLEMS). */
  unitPrice: amountSchema.nullable(),
  lineTotal: amountSchema.nullable(),
  /** The deferred price (plan DEFERRED). Null when the product has none or cannot be ordered. */
  deferredUnitPrice: amountSchema.nullable(),
  deferredLineTotal: amountSchema.nullable(),
  /**
   * The recommended retail price (RRP) of one piece [C, 2026-11-09]: information for the shop, in
   * no total and in no order. Null when the product has none or cannot be ordered.
   */
  rrp: amountSchema.nullable(),
  /**
   * How many pieces of the product can be ordered now [C, 2026-11-09]; the quantity cannot be set
   * above it, and 0 means out of stock. Null = no figure and no cap, also on a line whose product
   * cannot be ordered for another reason.
   */
  orderableStock: orderableStockSchema,
  problem: z.enum(CART_LINE_PROBLEMS).nullable(),
});
export type CartLine = z.infer<typeof cartLineSchema>;

export const cartResponseSchema = z.strictObject({
  /** The published price list the cart is priced with; null while none is published. */
  priceListVersionNumber: z.int().nullable(),
  lines: z.array(cartLineSchema),
  /** What plan FULL costs. */
  totalAmount: amountSchema,
  /** What plan DEFERRED costs; null (the plan cannot be chosen) unless every line has a deferred price. */
  deferredTotalAmount: amountSchema.nullable(),
  currency: currencySchema,
  canSubmit: z.boolean(),
});
export type CartResponse = z.infer<typeof cartResponseSchema>;

/**
 * `details` of 409 STOCK_LIMIT_EXCEEDED: every refused product with the figure it may be ordered
 * at now; 0 = out of stock. Never null here: a product without a figure has no cap and is never
 * refused.
 */
export const stockLimitExceededDetailsSchema = z.object({
  lines: z
    .array(z.strictObject({ productId: idSchema, orderableStock: z.int().nonnegative() }))
    .min(1),
});
export type StockLimitExceededDetails = z.infer<typeof stockLimitExceededDetailsSchema>;

// ---------------------------------------------------------------------------------------
// Responses: customer orders
// ---------------------------------------------------------------------------------------

export const customerOrderItemSchema = z.strictObject({
  id: idSchema,
  productId: idSchema,
  productCode: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: quantityStringSchema,
  unitPrice: amountSchema,
  lineTotal: amountSchema,
});
export type CustomerOrderItem = z.infer<typeof customerOrderItemSchema>;

export const customerOrderSummarySchema = z.strictObject({
  id: idSchema,
  orderNumber: z.string(),
  status: orderStatusSchema,
  paymentStatus: paymentStatusSchema,
  paymentPlan: paymentPlanSchema,
  totalAmount: amountSchema,
  currency: currencySchema,
  itemCount: z.int().nonnegative(),
  customerComment: z.string().nullable(),
  /** A colleague of the same organization may have placed it. */
  placedByName: z.string(),
  placedByMe: z.boolean(),
  submittedAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  rowVersion: rowVersionSchema,
});
export type CustomerOrderSummary = z.infer<typeof customerOrderSummarySchema>;

export const customerOrderSchema = customerOrderSummarySchema.extend({
  items: z.array(customerOrderItemSchema),
  /** Until when the customer may still change the plan; null: not (or no longer) possible. */
  paymentPlanChangeableUntil: isoInstantSchema.nullable(),
  /** What the order costs under each plan, only while the change is possible. */
  paymentPlanTotals: z
    .strictObject({ FULL: amountSchema, DEFERRED: amountSchema.nullable() })
    .nullable(),
});
export type CustomerOrder = z.infer<typeof customerOrderSchema>;

export const customerOrderListResponseSchema = z.strictObject({
  orders: z.array(customerOrderSummarySchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: idSchema.nullable(),
});
export type CustomerOrderListResponse = z.infer<typeof customerOrderListResponseSchema>;

// ---------------------------------------------------------------------------------------
// Responses: timeline
// ---------------------------------------------------------------------------------------

export const ITEM_LINE_CHANGES = ['QUANTITY_CHANGED', 'REMOVED'] as const;

/** One line of an edit. Money fields are null for roles that see no prices (warehouse, driver). */
export const orderLineChangeSchema = z.strictObject({
  productCode: z.string(),
  name: z.string(),
  change: z.enum(ITEM_LINE_CHANGES),
  oldQuantity: quantityStringSchema,
  /** Null when the line was removed. */
  newQuantity: quantityStringSchema.nullable(),
  oldLineTotal: amountSchema.nullable(),
  newLineTotal: amountSchema.nullable(),
});
export type OrderLineChange = z.infer<typeof orderLineChangeSchema>;

export const orderItemsChangeSchema = z.strictObject({
  oldTotal: amountSchema.nullable(),
  newTotal: amountSchema.nullable(),
  lines: z.array(orderLineChangeSchema),
});
export type OrderItemsChange = z.infer<typeof orderItemsChangeSchema>;

export const paymentChangeSchema = z.strictObject({
  from: paymentStatusSchema,
  to: paymentStatusSchema,
});
export type PaymentChange = z.infer<typeof paymentChangeSchema>;

/** The payment plan was changed: the prices and the total moved with it. */
export const paymentPlanChangeSchema = z.strictObject({
  from: paymentPlanSchema,
  to: paymentPlanSchema,
  oldTotal: amountSchema,
  newTotal: amountSchema,
});
export type PaymentPlanChange = z.infer<typeof paymentPlanChangeSchema>;

/**
 * Event kinds a customer sees. The accounting skip is shown as the plain status change to
 * ACCOUNTING_CLEARED; whether accounting was skipped is staff information.
 */
export const CUSTOMER_TIMELINE_EVENT_TYPES = [
  'SUBMITTED',
  'STATUS_CHANGED',
  'ITEMS_EDITED',
  'PAYMENT_STATUS_CHANGED',
  'PAYMENT_PLAN_CHANGED',
] as const;

/**
 * A customer sees the role of a staff actor ("Menejer") and a name only for members of their own
 * organization. A null actor means "the system" or a step the customer does not need to attribute.
 */
export const customerTimelineActorSchema = z.strictObject({
  role: orderActorRoleSchema,
  name: z.string().nullable(),
});

export const customerTimelineEventSchema = z.strictObject({
  id: idSchema,
  type: z.enum(CUSTOMER_TIMELINE_EVENT_TYPES),
  occurredAt: isoInstantSchema,
  fromStatus: orderStatusSchema.nullable(),
  toStatus: orderStatusSchema.nullable(),
  actor: customerTimelineActorSchema.nullable(),
  /** Rejection and cancel reasons as written, the reason of an edit or plan change, a customer's own note. */
  comment: z.string().nullable(),
  itemsChange: orderItemsChangeSchema.nullable(),
  paymentChange: paymentChangeSchema.nullable(),
  paymentPlanChange: paymentPlanChangeSchema.nullable(),
  /** True once a message about this event reached the organization's chat (or the placer). */
  customerNotified: z.boolean(),
});
export type CustomerTimelineEvent = z.infer<typeof customerTimelineEventSchema>;

export const customerTimelineResponseSchema = z.strictObject({
  orderId: idSchema,
  events: z.array(customerTimelineEventSchema),
});
export type CustomerTimelineResponse = z.infer<typeof customerTimelineResponseSchema>;
