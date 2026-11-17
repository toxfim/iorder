import { z } from 'zod';
import { isoInstantSchema } from './common.js';
import { route } from './routes.js';

// My Products wire contract (customer app); the api implements it in the orders module
// (customer-goods.*). These DTOs contain no inventory or staff-only fields.
export const customerMilestonesSchema = z.strictObject({
  orderedAt: isoInstantSchema,
  confirmedAt: isoInstantSchema.nullable(),
  deliveredAt: isoInstantSchema.nullable(),
});
export type CustomerMilestones = z.infer<typeof customerMilestonesSchema>;
export const customerUnitCodeSchema = z.strictObject({
  kind: z.enum(['IMEI', 'SERIAL', 'MARKING']),
  slot: z.int().positive(),
  value: z.string().min(1).max(512),
});
export type CustomerUnitCode = z.infer<typeof customerUnitCodeSchema>;
export const customerGoodsGroupSchema = z.strictObject({
  productId: z.uuid(),
  productCode: z.string(),
  name: z.string(),
  icon: z.enum(['phone', 'headphones', 'tv', 'box']),
  unitCount: z.int().nonnegative(),
  codeCount: z.int().nonnegative(),
  codeKinds: z.array(customerUnitCodeSchema.shape.kind),
  lastDeliveredAt: isoInstantSchema,
});
export type CustomerGoodsGroup = z.infer<typeof customerGoodsGroupSchema>;
export const customerReceivedUnitSchema = z.strictObject({
  id: z.uuid(),
  unitNumber: z.int().positive(),
  codes: z.array(customerUnitCodeSchema),
  orderId: z.uuid(),
  orderNumber: z.string(),
  milestones: customerMilestonesSchema,
  receivedAt: isoInstantSchema.nullable(),
});
export type CustomerReceivedUnit = z.infer<typeof customerReceivedUnitSchema>;
export const customerGoodsSummarySchema = z.strictObject({
  hasProducts: z.boolean(),
  productCount: z.int().nonnegative(),
  unitCount: z.int().nonnegative(),
  discoveryPending: z.boolean(),
});
export type CustomerGoodsSummary = z.infer<typeof customerGoodsSummarySchema>;
export const customerGoodsListSchema = z.strictObject({
  products: z.array(customerGoodsGroupSchema),
  nextCursor: z.string().nullable(),
});
export type CustomerGoodsList = z.infer<typeof customerGoodsListSchema>;
export const customerGoodsProductSchema = z.strictObject({
  product: customerGoodsGroupSchema,
  units: z.array(customerReceivedUnitSchema),
  nextCursor: z.string().nullable(),
});
export type CustomerGoodsProduct = z.infer<typeof customerGoodsProductSchema>;
export const customerGoodsUnitSchema = z.strictObject({
  product: customerGoodsGroupSchema,
  unit: customerReceivedUnitSchema,
});
export type CustomerGoodsUnit = z.infer<typeof customerGoodsUnitSchema>;
export const CUSTOMER_GOODS_PAGE_SIZE_DEFAULT = 20;
export const CUSTOMER_GOODS_PAGE_SIZE_MAX = 50;
export const CUSTOMER_GOODS_SEARCH_MAX_LENGTH = 512;
export const CUSTOMER_GOODS_CURSOR_MAX_LENGTH = 512;
/** Query of the goods list and of one product's units. The cursor is opaque and query-bound. */
export const customerGoodsQuerySchema = z.strictObject({
  search: z.string().trim().max(CUSTOMER_GOODS_SEARCH_MAX_LENGTH).optional(),
  cursor: z.string().min(1).max(CUSTOMER_GOODS_CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CUSTOMER_GOODS_PAGE_SIZE_MAX)
    .default(CUSTOMER_GOODS_PAGE_SIZE_DEFAULT),
});
export type CustomerGoodsQuery = z.output<typeof customerGoodsQuerySchema>;
export const CUSTOMER_GOODS_ROUTES = Object.freeze({
  summary: route('GET', '/me/products/summary'),
  list: route('GET', '/me/products'),
  product: route('GET', '/me/products/:productId'),
  unit: route('GET', '/me/products/:productId/units/:unitId'),
  acknowledgeDiscovery: route('POST', '/me/products/discovery/ack'),
});
