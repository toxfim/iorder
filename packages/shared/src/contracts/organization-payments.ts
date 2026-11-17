import { z } from 'zod';
import { moneyStringSchema, isoInstantSchema } from './common.js';
import { usdRateStringSchema } from './cost.js';
import { amountSchema, idSchema, requiredTextSchema } from './order-parts.js';
import { route } from './routes.js';

// Organization payments ([C] 2026-10-26). The debt is kept per organization, not per order: the
// total of its RECEIVED orders minus the payments. Only the manager records a payment (amount,
// date, optional comment), never for a particular order; only the admin corrects or voids one.
// The orders' PAID / UNPAID follows from the payments, oldest received order first.
//
// Owner rule: the debt is counted in USD. An order counts at its rate from submit; a payment is made
// in USD or so'm, chosen per payment, and a so'm payment carries its own required rate. Every figure
// of the balance is USD; the so'm equivalents use the current rate [P]. Staff-only entry.

export const PAYMENT_COMMENT_MAX_LENGTH = 500;

const paymentCommentSchema = z.string().trim().min(1).max(PAYMENT_COMMENT_MAX_LENGTH);
/** A calendar day in Asia/Tashkent, YYYY-MM-DD. The server refuses a day in the future. */
const paidOnSchema = z.iso.date();

export const PAYMENT_CURRENCIES = ['USD', 'UZS'] as const;
export const paymentCurrencySchema = z.enum(PAYMENT_CURRENCIES);
export type PaymentCurrency = z.infer<typeof paymentCurrencySchema>;

export const organizationPaymentSchema = z.strictObject({
  id: idSchema,
  organizationId: idSchema,
  /** In `currency`, as the manager entered it. */
  amount: amountSchema,
  currency: paymentCurrencySchema,
  /** UZS per 1 USD of a so'm payment; null on a USD payment. */
  rate: usdRateStringSchema.nullable(),
  /** What the payment counts for in the debt. */
  amountUsd: amountSchema,
  /** A so'm payment's own amount; a USD payment at the current rate; null while no rate is known. */
  amountUzs: amountSchema.nullable(),
  paidOn: paidOnSchema,
  comment: z.string().nullable(),
  recordedByName: z.string(),
  recordedByUserId: idSchema,
  recordedAt: isoInstantSchema,
  /** Set when the admin voided the payment; a voided payment no longer counts. */
  voidedAt: isoInstantSchema.nullable(),
  voidReason: z.string().nullable(),
  updatedAt: isoInstantSchema,
});
export type OrganizationPayment = z.infer<typeof organizationPaymentSchema>;

/** The balance figures in so'm at the current rate: display only, the debt itself is USD. */
const balanceUzsEquivalentSchema = z.strictObject({
  receivedTotal: amountSchema,
  paidTotal: amountSchema,
  amountDue: amountSchema,
  overpaid: amountSchema,
});

export const organizationBalanceResponseSchema = z.strictObject({
  organizationId: idSchema,
  currency: z.literal('USD'),
  /** Sum of the USD totals of the organization's RECEIVED orders. */
  receivedTotal: amountSchema,
  /** Sum of the USD values of the payments that are not voided. */
  paidTotal: amountSchema,
  /** receivedTotal - paidTotal, never below zero. */
  amountDue: amountSchema,
  /** paidTotal - receivedTotal, never below zero; kept until a rule for it is decided. */
  overpaid: amountSchema,
  /** The current rate setting; null while none exists. */
  usdRate: usdRateStringSchema.nullable(),
  /** Null while no rate exists. */
  uzsEquivalent: balanceUzsEquivalentSchema.nullable(),
  /** Newest first, voided ones included. */
  payments: z.array(organizationPaymentSchema),
});
export type OrganizationBalanceResponse = z.infer<typeof organizationBalanceResponseSchema>;

export const recordPaymentRequestSchema = z
  .strictObject({
    amount: moneyStringSchema,
    currency: paymentCurrencySchema,
    /** Required on a so'm payment, refused on a USD payment. */
    rate: usdRateStringSchema.optional(),
    paidOn: paidOnSchema,
    comment: paymentCommentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.currency === 'UZS' && value.rate === undefined) {
      context.addIssue({ code: 'custom', path: ['rate'], message: "A so'm payment needs a rate" });
    }
    if (value.currency === 'USD' && value.rate !== undefined) {
      context.addIssue({ code: 'custom', path: ['rate'], message: 'A USD payment has no rate' });
    }
  });
export type RecordPaymentRequest = z.output<typeof recordPaymentRequestSchema>;

/**
 * Admin only. `comment: null` removes the comment. The reason is kept in the history. Switching to
 * USD drops the rate; switching to so'm must bring one. A rate alone corrects a so'm payment's rate;
 * the service refuses it on a USD payment.
 */
export const correctPaymentRequestSchema = z
  .strictObject({
    amount: moneyStringSchema.optional(),
    currency: paymentCurrencySchema.optional(),
    rate: usdRateStringSchema.optional(),
    paidOn: paidOnSchema.optional(),
    comment: paymentCommentSchema.nullable().optional(),
    reason: requiredTextSchema,
  })
  .refine(
    (value) =>
      value.amount !== undefined ||
      value.currency !== undefined ||
      value.rate !== undefined ||
      value.paidOn !== undefined ||
      value.comment !== undefined,
    'Provide at least one field to change',
  )
  .superRefine((value, context) => {
    if (value.currency === 'UZS' && value.rate === undefined) {
      context.addIssue({ code: 'custom', path: ['rate'], message: "A so'm payment needs a rate" });
    }
    if (value.currency === 'USD' && value.rate !== undefined) {
      context.addIssue({ code: 'custom', path: ['rate'], message: 'A USD payment has no rate' });
    }
  });
export type CorrectPaymentRequest = z.output<typeof correctPaymentRequestSchema>;

export const voidPaymentRequestSchema = z.strictObject({ reason: requiredTextSchema });
export type VoidPaymentRequest = z.output<typeof voidPaymentRequestSchema>;

export const ORGANIZATION_PAYMENT_ROUTES = Object.freeze({
  getBalance: route('GET', '/staff/organizations/:id/balance'),
  recordPayment: route('POST', '/staff/organizations/:id/payments'),
  correctPayment: route('PATCH', '/staff/organization-payments/:id'),
  voidPayment: route('POST', '/staff/organization-payments/:id/void'),
});
