import {
  MAX_ORDER_PAGE_SIZE,
  ORDER_REASON_MAX_LENGTH,
  ORDER_STATUSES,
  PAYMENT_PLANS,
  PAYMENT_STATUSES,
  customerOrderGroupSchema,
} from '@iorder/shared';
import {
  MAX_EDIT_CHANGES,
  ORDER_SEARCH_MAX_LENGTH,
  PAYMENT_METHODS,
  allocationModeSchema,
  allocationRequestRowSchema,
  MAX_ALLOCATIONS_PER_ORDER,
} from '@iorder/shared/staff-orders';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { MAX_QUANTITY, parseQuantity } from './order-lines.js';

// The service re-validates what the HTTP layer already validated: an order service must
// not trust its caller (hard rule 8). zod is the only validation library (ADR-001 §3.9).

const quantityText = z
  .string()
  .refine(
    (value) => parseQuantity(value) !== null,
    `Quantity must be a whole number from 1 to ${MAX_QUANTITY.toFixed(0)}`,
  );

const optionalText = z.string().max(ORDER_REASON_MAX_LENGTH).nullish();

export const transitionCommandSchema = z.strictObject({
  to: z.enum(ORDER_STATUSES),
  /** Required by reject and cancel (manager only); the state machine decides. */
  reason: optionalText,
  /** Required when releasing. */
  driverUserId: z.uuid().nullish(),
  /** Manager only, while approving a submitted order. */
  skipAccounting: z.boolean().optional(),
  /** Manager only, required while approving a submitted order; the state machine decides. */
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
  /** Manager only, required while approving; the service checks them under the supply lock. */
  allocationMode: allocationModeSchema.optional(),
  allocations: z.array(allocationRequestRowSchema).max(MAX_ALLOCATIONS_PER_ORDER).optional(),
  /**
   * The row_version the caller read; a newer version fails with ORDER_CHANGED. Customers may
   * omit it for their own receive; staff must send it (see the staff schemas below).
   */
  expectedRowVersion: z.int().positive().optional(),
});
export type TransitionCommand = z.input<typeof transitionCommandSchema>;

/** Staff decide on what they SAW: a stale decision must fail, so the version is required. */
export const staffTransitionCommandSchema = transitionCommandSchema.extend({
  expectedRowVersion: z.int().positive(),
});

export const editItemsCommandSchema = z
  .strictObject({
    /** quantity null = remove the line. */
    changes: z
      .array(z.strictObject({ itemId: z.uuid(), quantity: quantityText.nullable() }))
      .min(1)
      .max(MAX_EDIT_CHANGES),
    reason: optionalText,
    /** The row_version the manager read; a newer version fails with ORDER_CHANGED. */
    expectedRowVersion: z.int().positive().optional(),
  })
  .refine(
    (command) => new Set(command.changes.map((c) => c.itemId)).size === command.changes.length,
    {
      path: ['changes'],
      message: 'A line can be changed only once per edit',
    },
  );
export type EditItemsCommand = z.input<typeof editItemsCommandSchema>;

/** Editing is staff-only, so the version is always required. */
export const staffEditItemsCommandSchema = editItemsCommandSchema.refine(
  (command) => command.expectedRowVersion !== undefined,
  { path: ['expectedRowVersion'], message: 'Required: send the row version you read' },
);

export const paymentMethodCommandSchema = z.strictObject({
  paymentMethod: z.enum(PAYMENT_METHODS),
  comment: optionalText,
});
export type PaymentMethodCommand = z.input<typeof paymentMethodCommandSchema>;

/** Changes the total, so the version the manager read is required, like an item edit. */
export const paymentPlanCommandSchema = z.strictObject({
  paymentPlan: z.enum(PAYMENT_PLANS),
  reason: optionalText,
  expectedRowVersion: z.int().positive(),
});
export type PaymentPlanCommand = z.input<typeof paymentPlanCommandSchema>;

/** The customer's own change: no reason, and the version they read is required too. */
export const ownPaymentPlanCommandSchema = z.strictObject({
  paymentPlan: z.enum(PAYMENT_PLANS),
  expectedRowVersion: z.int().positive(),
});
export type OwnPaymentPlanCommand = z.input<typeof ownPaymentPlanCommandSchema>;

/** The warehouse decides on what it saw, like every staff decision. */
export const goodsReturnedCommandSchema = z.strictObject({
  comment: optionalText,
  expectedRowVersion: z.int().positive(),
});
export type GoodsReturnedCommand = z.input<typeof goodsReturnedCommandSchema>;

/** The manager decides on the plan and the order version they saw. */
export const setAllocationsCommandSchema = z.strictObject({
  allocationMode: allocationModeSchema,
  allocations: z.array(allocationRequestRowSchema).max(MAX_ALLOCATIONS_PER_ORDER),
  comment: optionalText,
  expectedRowVersion: z.int().positive(),
});
export type SetAllocationsCommand = z.input<typeof setAllocationsCommandSchema>;

export const orderListFiltersSchema = z.strictObject({
  status: z.enum(ORDER_STATUSES).optional(),
  group: customerOrderGroupSchema.optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  /** Staff only in effect: a customer's scope already pins the organization. */
  organizationId: z.uuid().optional(),
  limit: z.int().min(1).max(MAX_ORDER_PAGE_SIZE).optional(),
  /** Part of the order number, ignoring letter case. */
  search: z.string().trim().min(1).max(ORDER_SEARCH_MAX_LENGTH).optional(),
  cursor: z.uuid().optional(),
});
export type OrderListFilters = z.input<typeof orderListFiltersSchema>;

export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  return new ZodValidationPipe(schema).transform(input);
}
