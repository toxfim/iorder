import { z } from 'zod';
import { decimalStringSchema } from './common.js';
import { CURRENCY } from './pricing.js';

// Small building blocks used by both order contract files: orders.ts (customer, in the package
// barrel) and staff-orders.ts (staff-only entry). Not re-exported from the barrel as a whole;
// orders.ts re-exports the one constant customers need.

export const ORDER_REASON_MAX_LENGTH = 1000;

/** An amount that may be zero (totals of an empty cart, a rounded-down line). */
export const amountSchema = decimalStringSchema({ maxIntegerDigits: 16, maxFractionDigits: 2 });
export const rowVersionSchema = z.int().positive();
export const requiredTextSchema = z.string().trim().min(1).max(ORDER_REASON_MAX_LENGTH);
export const optionalCommentSchema = z.string().trim().max(ORDER_REASON_MAX_LENGTH).optional();
export const idSchema = z.uuid();
export const currencySchema = z.literal(CURRENCY);
