import { z } from 'zod';
import { amountSchema, currencySchema } from './order-parts.js';
import { route } from './routes.js';

// What the customer owes ([C] 2026-10-26): one amount per organization, the received orders minus
// the payments the manager recorded. The customer sees only the amount, never the payments
// themselves [P]. An overpayment shows as zero due.
export const customerBalanceResponseSchema = z.strictObject({
  amountDue: amountSchema,
  currency: currencySchema,
});
export type CustomerBalanceResponse = z.infer<typeof customerBalanceResponseSchema>;

export const CUSTOMER_BALANCE_ROUTES = Object.freeze({
  getBalance: route('GET', '/me/balance'),
});
