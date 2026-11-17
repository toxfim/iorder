import { z } from 'zod';
import { isoInstantSchema, uuidSchema } from './common.js';
import { route } from './routes.js';

// STAFF-ONLY: "newer model" pairs [C, owner 2026-11-09]. The system PROPOSES pairs (an older
// product -> a newer product of the same line) from product names and brands; a manager or an
// admin CONFIRMS or REJECTS each one in the staff app. Only a CONFIRMED pair ever reaches a
// customer (the "Yangi model" block of the customer home). Decisions are kept in audit_log.

export const PRODUCT_SUCCESSION_STATUSES = ['PROPOSED', 'CONFIRMED', 'REJECTED'] as const;
export type ProductSuccessionStatus = (typeof PRODUCT_SUCCESSION_STATUSES)[number];

/** The two decisions a person can take; PROPOSED is only ever written by the generator. */
export const PRODUCT_SUCCESSION_DECISIONS = ['CONFIRMED', 'REJECTED'] as const;
export type ProductSuccessionDecision = (typeof PRODUCT_SUCCESSION_DECISIONS)[number];

/** One side of a pair, with what the reviewer needs to judge it. */
export const productSuccessionProductSchema = z.strictObject({
  productId: uuidSchema,
  productCode: z.string(),
  name: z.string(),
  /** True when the product is in the current published price list. */
  priced: z.boolean(),
  isActive: z.boolean(),
});
export type ProductSuccessionProduct = z.infer<typeof productSuccessionProductSchema>;

export const productSuccessionSchema = z.strictObject({
  id: uuidSchema,
  older: productSuccessionProductSchema,
  newer: productSuccessionProductSchema,
  status: z.enum(PRODUCT_SUCCESSION_STATUSES),
  proposedAt: isoInstantSchema,
  decidedAt: isoInstantSchema.nullable(),
  /** The display name of the person who decided, never an id; null while PROPOSED. */
  decidedBy: z.string().nullable(),
  /** That person's id for the person card; null while PROPOSED or for an unknown person. */
  decidedByUserId: uuidSchema.nullable(),
});
export type ProductSuccession = z.infer<typeof productSuccessionSchema>;

export const productSuccessionListQuerySchema = z.strictObject({
  status: z.enum(PRODUCT_SUCCESSION_STATUSES).default('PROPOSED'),
});
export type ProductSuccessionListQuery = z.output<typeof productSuccessionListQuerySchema>;

/** The pairs in one status, newest proposal first, plus how many pairs sit in each status. */
export const productSuccessionListResponseSchema = z.strictObject({
  items: z.array(productSuccessionSchema),
  counts: z.strictObject({
    PROPOSED: z.int().nonnegative(),
    CONFIRMED: z.int().nonnegative(),
    REJECTED: z.int().nonnegative(),
  }),
});
export type ProductSuccessionListResponse = z.infer<typeof productSuccessionListResponseSchema>;

/**
 * A decision on one pair. A decided pair may be decided again the other way (a wrong click is
 * corrected by the same people), never set back to PROPOSED.
 */
export const decideProductSuccessionRequestSchema = z.strictObject({
  decision: z.enum(PRODUCT_SUCCESSION_DECISIONS),
});
export type DecideProductSuccessionRequest = z.output<typeof decideProductSuccessionRequestSchema>;

/** The answer of "find proposals": how many NEW pairs were proposed (existing rows are never touched). */
export const findProductSuccessionsResponseSchema = z.strictObject({
  proposedCount: z.int().nonnegative(),
});
export type FindProductSuccessionsResponse = z.infer<typeof findProductSuccessionsResponseSchema>;

export const PRODUCT_SUCCESSION_ROUTES = Object.freeze({
  listProductSuccessions: route('GET', '/staff/product-successions'),
  findProductSuccessions: route('POST', '/staff/product-successions/find'),
  decideProductSuccession: route('POST', '/staff/product-successions/:id/decision'),
});
