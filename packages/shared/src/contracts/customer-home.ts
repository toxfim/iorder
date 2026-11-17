import { z } from 'zod';
import { isoInstantSchema, moneyStringSchema, orderableStockSchema } from './common.js';
import { wholeQuantityStringSchema } from './orders.js';
import { CURRENCY } from './pricing.js';
import { productPrimaryImageShape } from './product-images.js';
import { route } from './routes.js';

// The customer home page, design "2a" [C, owner 2026-11-09]: recommendations that match what the
// customer's organization bought before. Every item is a product of the CURRENT published price
// list in the same allow-listed shape as the customer price list (hard rule 7), minus the category:
// no cost, no supplier, nothing about other organizations. Strict objects, so a leak fails to parse.

/** A product card of the home page: the customer price list item without its category. */
export const customerRecommendationItemSchema = z.strictObject({
  productId: z.uuid(),
  productCode: z.string(),
  unit: z.string(),
  name: z.string(),
  /** The sale price in UZS. */
  price: moneyStringSchema,
  /** The deferred-payment price in UZS; null = none. */
  deferredPrice: moneyStringSchema.nullable(),
  /** The recommended retail price in UZS [C, 2026-11-09]; null = none. */
  rrp: moneyStringSchema.nullable(),
  /** How many pieces can be ordered now; 0 = out of stock, null = no figure and no cap. */
  orderableStock: orderableStockSchema,
  currency: z.literal(CURRENCY),
  ...productPrimaryImageShape,
});
export type CustomerRecommendationItem = z.infer<typeof customerRecommendationItemSchema>;

/**
 * "Time to reorder": a product the organization received before. `usualQuantity` is the quantity
 * of its LAST received order (whole pieces), the one-tap add puts exactly that in the cart.
 */
export const customerReorderItemSchema = customerRecommendationItemSchema.extend({
  usualQuantity: wholeQuantityStringSchema,
  /** When the last order holding this product was received. */
  lastReceivedAt: isoInstantSchema,
  /** In how many received orders the product appeared. */
  timesOrdered: z.int().positive(),
});
export type CustomerReorderItem = z.infer<typeof customerReorderItemSchema>;

/**
 * "Matches what you bought": a product of a category the organization buys from, not bought yet.
 * `boughtProductName` names the product the customer bought in that category (the "why" line); the
 * category itself stays staff vocabulary and is not sent.
 */
export const customerMatchingItemSchema = customerRecommendationItemSchema.extend({
  boughtProductName: z.string(),
});
export type CustomerMatchingItem = z.infer<typeof customerMatchingItemSchema>;

/**
 * "New model": the newer product of a pair STAFF confirmed, whose older product the organization
 * bought. `replacesProductName` is that older product; `replacesTimesOrdered` how often it was
 * received. Never an unconfirmed pair.
 */
export const customerNewerModelItemSchema = customerRecommendationItemSchema.extend({
  replacesProductName: z.string(),
  replacesTimesOrdered: z.int().positive(),
});
export type CustomerNewerModelItem = z.infer<typeof customerNewerModelItemSchema>;

/**
 * `GET /me/recommendations`: all three blocks in one answer. `reorder` is ordered by the longest
 * time since the last receipt first; `matching` by the most recently bought category first. A
 * staff viewer has no organization and gets three empty blocks.
 */
export const customerHomeRecommendationsResponseSchema = z.strictObject({
  reorder: z.array(customerReorderItemSchema),
  matching: z.array(customerMatchingItemSchema),
  newerModel: customerNewerModelItemSchema.nullable(),
});
export type CustomerHomeRecommendationsResponse = z.infer<
  typeof customerHomeRecommendationsResponseSchema
>;

export const CUSTOMER_HOME_ROUTES = Object.freeze({
  getRecommendations: route('GET', '/me/recommendations'),
});
