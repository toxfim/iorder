import { z } from 'zod';
import { decimalPattern, decimalStringSchema, isoInstantSchema } from './common.js';
import {
  createDraftResponseSchema,
  publishChangesResponseSchema,
  staffPriceListResponseSchema,
  staffVersionResponseSchema,
  staffVersionSummaryResponseSchema,
} from './pricing.js';
import { route } from './routes.js';

// STAFF-ONLY contracts (hard rule 7, data-model §6.2): cost reference and the USD rate. Nothing
// in this file may be imported by a customer-facing schema. The api's leak tests allow-list
// the schemas of this file BY NAME (STAFF_ONLY_COST_SCHEMAS) and fail on a cost-like key
// anywhere else. Decimals are strings, never JSON numbers.

/**
 * The USD rate: UZS per 1 USD, positive, at most 4 fraction digits and 14 integer digits
 * (fits Decimal(18,4)). No sign, exponent, separators or leading zeros.
 */
export const USD_RATE_PATTERN = decimalPattern(14, 4);
export const USD_RATE_MESSAGE =
  'Rate must be a positive decimal string with at most 4 fraction digits';

export const usdRateStringSchema = decimalStringSchema({
  maxIntegerDigits: 14,
  maxFractionDigits: 4,
  positive: true,
  message: USD_RATE_MESSAGE,
});

export const updateUsdRateRequestSchema = z.strictObject({ rate: usdRateStringSchema });
export type UpdateUsdRateRequest = z.output<typeof updateUsdRateRequestSchema>;

export const USD_RATE_SOURCES = ['CHANNEL', 'MANUAL', 'CBU'] as const;
export type UsdRateSource = (typeof USD_RATE_SOURCES)[number];

/**
 * The current price-list USD rate [C, owner 2026-10-31, data-model §6.3]: the channel's post for
 * today (`CHANNEL`), else a rate a staff member entered within its 24 hours (`MANUAL`), else the
 * Central Bank + `USD_RATE_BANK_MARKUP_UZS` (`CBU`; `rate` already includes the markup).
 * - `rate` / `source` are null until a rate exists: no default rate is invented.
 * - `rateDate`: the day a CBU or CHANNEL rate is valid for (null for MANUAL).
 * - `updatedBy`: the display name of the actor of a MANUAL rate in force, never an id.
 * - `updatedByUserId`: that actor's id for the person card (null otherwise or an unknown person).
 * - `followsCentralBank`: no manual rate is within its 24 hours.
 * - `manualRate` / `manualExpiresAt`: a manual rate within its 24 hours, also while the channel's
 *   rate is the one in force (it then applies only if the channel has no post for the day).
 * - `lastRefreshFailedAt` / `lastChannelFailedAt`: set when the last bank refresh / channel read
 *   failed (cleared by a success). No message: flags for a warning, not a log.
 * Compatible extension of the first version (rate, updatedAt, updatedBy are unchanged).
 */
export const usdRateResponseSchema = z.strictObject({
  rate: usdRateStringSchema.nullable(),
  updatedAt: isoInstantSchema.nullable(),
  updatedBy: z.string().nullable(),
  updatedByUserId: z.uuid().nullable(),
  source: z.enum(USD_RATE_SOURCES).nullable(),
  rateDate: z.iso.date().nullable(),
  followsCentralBank: z.boolean(),
  manualRate: usdRateStringSchema.nullable(),
  manualExpiresAt: isoInstantSchema.nullable(),
  lastRefreshFailedAt: isoInstantSchema.nullable(),
  lastChannelFailedAt: isoInstantSchema.nullable(),
});
export type UsdRateResponse = z.infer<typeof usdRateResponseSchema>;

const decimalWithFraction = (digits: number) =>
  z.string().regex(new RegExp(`^\\d+\\.\\d{${digits}}$`));

/**
 * One delivery line (the staff-only table holds ALL delivery lines of the selected products).
 * Quantities have 3 fraction digits, USD cost and rate 4, UZS cost 2. Supplier, purchase method
 * and category are staff-only too (supplier and purchase method are cost-class data).
 */
export const costDeliverySchema = z.strictObject({
  deliveryRef: z.string(),
  supplier: z.string(),
  purchaseMethod: z.string(),
  category: z.string(),
  deliveredQuantity: decimalWithFraction(3),
  availableQuantity: decimalWithFraction(3),
  // Null, all three together, while the sheet's cost cells of the line are still empty ("cost
  // pending"): the line already counts for stock, its cost is not known yet.
  costUsd: decimalWithFraction(4).nullable(),
  usdRateUsed: decimalWithFraction(4).nullable(),
  costUzs: decimalWithFraction(2).nullable(),
  deliveredAt: isoInstantSchema,
  syncedAt: isoInstantSchema,
});
export type CostDelivery = z.infer<typeof costDeliverySchema>;

/** `latest` is the manager's reference line; `deliveries` are all rows, newest first. */
export const productCostReferenceResponseSchema = z.strictObject({
  productId: z.uuid(),
  productCode: z.string(),
  latest: costDeliverySchema.nullable(),
  deliveries: z.array(costDeliverySchema),
});
export type ProductCostReferenceResponse = z.infer<typeof productCostReferenceResponseSchema>;

// ---------------------------------------------------------------------------------------
// Staff price list VERSIONS with the USD rate snapshot (the exchange rate is cost-class data, so
// these variants live here and not in the shared barrel the customer bundle reaches).
// ---------------------------------------------------------------------------------------

/**
 * The USD rate in force when the version was published. `null` on the version when no rate existed
 * at publish time (publishing is never blocked by a missing rate) and on every DRAFT.
 */
export const usdRateSnapshotSchema = z.strictObject({
  rate: decimalWithFraction(4),
  source: z.enum(USD_RATE_SOURCES),
  rateDate: z.iso.date().nullable(),
});
export type UsdRateSnapshot = z.infer<typeof usdRateSnapshotSchema>;

const withSnapshot = { usdRateSnapshot: usdRateSnapshotSchema.nullable() };

export const staffVersionWithRateResponseSchema = staffVersionResponseSchema.extend(withSnapshot);
export type StaffVersionWithRateResponse = z.infer<typeof staffVersionWithRateResponseSchema>;

export const staffVersionSummaryWithRateResponseSchema =
  staffVersionSummaryResponseSchema.extend(withSnapshot);

export const staffVersionListWithRateResponseSchema = z.strictObject({
  items: z.array(staffVersionSummaryWithRateResponseSchema),
});
export type StaffVersionListWithRateResponse = z.infer<
  typeof staffVersionListWithRateResponseSchema
>;

/** Version detail / current staff list / result of an item upsert, with the snapshot. */
export const staffPriceListWithRateResponseSchema = z.strictObject({
  version: staffVersionWithRateResponseSchema,
  items: staffPriceListResponseSchema.shape.items,
});
export type StaffPriceListWithRateResponse = z.infer<typeof staffPriceListWithRateResponseSchema>;

export const createDraftWithRateResponseSchema = createDraftResponseSchema.extend(withSnapshot);
export type CreateDraftWithRateResponse = z.infer<typeof createDraftWithRateResponseSchema>;

/** Response of publish and of draft update / current draft. */
export const publishWithRateResponseSchema = staffVersionWithRateResponseSchema;

/** Response of POST /staff/price-list/publish (the new PUBLISHED version) with its snapshot. */
export const publishChangesWithRateResponseSchema =
  publishChangesResponseSchema.extend(withSnapshot);
export type PublishChangesWithRateResponse = z.infer<typeof publishChangesWithRateResponseSchema>;

// ---------------------------------------------------------------------------------------
// Supply removal requests: a stored delivery line that vanished from the sheet [C, data-model
// §6.3 item 3]. The manager confirms (soft removal) or dismisses; nothing is deleted without that.
// ---------------------------------------------------------------------------------------

export const SUPPLY_REMOVAL_STATUSES = ['PENDING', 'CONFIRMED', 'DISMISSED'] as const;
export type SupplyRemovalStatus = (typeof SUPPLY_REMOVAL_STATUSES)[number];

/** What staff need to decide: the delivery line as stored. */
export const supplyRemovalLineSchema = z.strictObject({
  deliveredAt: isoInstantSchema,
  supplier: z.string(),
  deliveredQuantity: decimalWithFraction(3),
  availableQuantity: decimalWithFraction(3),
  costUsd: decimalWithFraction(4).nullable(),
  usdRateUsed: decimalWithFraction(4).nullable(),
  costUzs: decimalWithFraction(2).nullable(),
});

export const supplyRemovalRequestSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  productCode: z.string(),
  deliveryRef: z.string(),
  detectedAt: isoInstantSchema,
  line: supplyRemovalLineSchema,
});
export type SupplyRemovalRequest = z.infer<typeof supplyRemovalRequestSchema>;

/** Pending requests, oldest first. `total` is the number of pending requests (for a badge). */
export const supplyRemovalListResponseSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  items: z.array(supplyRemovalRequestSchema),
});
export type SupplyRemovalListResponse = z.infer<typeof supplyRemovalListResponseSchema>;

export const supplyRemovalDecisionResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['CONFIRMED', 'DISMISSED']),
  decidedAt: isoInstantSchema,
  /** The decider's display name, never an id. */
  decidedBy: z.string().nullable(),
});
export type SupplyRemovalDecisionResponse = z.infer<typeof supplyRemovalDecisionResponseSchema>;

/** How many deliveries `recent` lists per product (newest first). */
export const RECENT_DELIVERIES_LIMIT = 5;

/** The few fields the price list shows about a delivery (latest line and the hover list). */
export const costDeliverySummarySchema = z.strictObject({
  deliveredAt: isoInstantSchema,
  deliveryRef: z.string(),
  supplier: z.string(),
  costUsd: decimalWithFraction(4).nullable(),
  usdRateUsed: decimalWithFraction(4).nullable(),
  costUzs: decimalWithFraction(2).nullable(),
});
export type CostDeliverySummary = z.infer<typeof costDeliverySummarySchema>;

/**
 * Cost reference for every product of the CURRENT published price list, in one response.
 * `latest` is the newest delivery (null when none), `recent` up to RECENT_DELIVERIES_LIMIT
 * newest first (so `recent[0]` equals `latest`), `stockQuantity` the stock aggregate (null when
 * the product has none). Staff-only; never merged into the price list DTOs.
 */
export const priceListCostItemSchema = z.strictObject({
  productId: z.uuid(),
  latest: costDeliverySummarySchema.nullable(),
  recent: z.array(costDeliverySummarySchema).max(RECENT_DELIVERIES_LIMIT),
  stockQuantity: decimalWithFraction(3).nullable(),
  /** Distinct suppliers of ALL live delivery lines (not only `recent`), sorted. */
  suppliers: z.array(z.string()),
});
export type PriceListCostItem = z.infer<typeof priceListCostItemSchema>;

export const priceListCostsResponseSchema = z.strictObject({
  versionNumber: z.number().int(),
  items: z.array(priceListCostItemSchema),
});
export type PriceListCostsResponse = z.infer<typeof priceListCostsResponseSchema>;

/** Names of every schema exported from this file; the cost-leak tests allow-list exactly these. */
export const STAFF_ONLY_COST_SCHEMAS = [
  // Newer-model pairs the manager confirms (names and codes, no cost): the price management area.
  'productSuccessionProductSchema',
  'productSuccessionSchema',
  'productSuccessionListQuerySchema',
  'productSuccessionListResponseSchema',
  'decideProductSuccessionRequestSchema',
  'findProductSuccessionsResponseSchema',
  // Party numbers on supplies (manager; refs, quantities and dates, no cost).
  'partyNumberSchema',
  'setSupplyPartyRequestSchema',
  'setSupplyPartyResponseSchema',
  'supplyListResponseSchema',
  'supplyNotAvailableDetailsSchema',
  'supplyPartyChangedDetailsSchema',
  'supplyPartyConflictDetailsSchema',
  'supplyPartyStateSchema',
  'supplySearchQuerySchema',
  'supplySummarySchema',
  'usdRateStringSchema',
  'updateUsdRateRequestSchema',
  'usdRateResponseSchema',
  'costDeliverySchema',
  'productCostReferenceResponseSchema',
  'costDeliverySummarySchema',
  'priceListCostItemSchema',
  'priceListCostsResponseSchema',
  'usdRateSnapshotSchema',
  'staffVersionWithRateResponseSchema',
  'staffVersionSummaryWithRateResponseSchema',
  'staffVersionListWithRateResponseSchema',
  'staffPriceListWithRateResponseSchema',
  'createDraftWithRateResponseSchema',
  'publishWithRateResponseSchema',
  'publishChangesWithRateResponseSchema',
  'supplyRemovalLineSchema',
  'supplyRemovalRequestSchema',
  'supplyRemovalListResponseSchema',
  'supplyRemovalDecisionResponseSchema',
  // Staff-added products without a sheet code and the price list Excel import (staff-cost entry).
  'createManualProductRequestSchema',
  'createManualProductResponseSchema',
  'mergeProductRequestSchema',
  'mergeProductResponseSchema',
  'priceImportConfirmRequestSchema',
  'priceImportConfirmResponseSchema',
  'priceImportPreviewResponseSchema',
  'priceImportPreviewRowSchema',
  'priceImportRowRequestSchema',
  'priceImportSummarySchema',
  'manualProductCheckQuerySchema',
  'manualProductCheckResponseSchema',
  'similarProductSchema',
  'mergePreviewQuerySchema',
  'mergePreviewResponseSchema',
  'priceImportTemplateQuerySchema',
  // The by-order products with their open-order demand (staff vocabulary, never a customer's).
  'byOrderOpenOrderSchema',
  'byOrderProductSchema',
  'byOrderProductsResponseSchema',
  // staff-catalog.ts
  'staffProductDetailResponseSchema',
  'staffProductDetailListResponseSchema',
  'staffProductDetailListQuerySchema',
  'latestDeliverySchema',
  'categoryCountSchema',
  'unpricedProductsQuerySchema',
  'unpricedProductSchema',
  'unpricedProductsResponseSchema',
  'createProductCategoryRequestSchema',
  'createProductCategoriesRequestSchema',
  'productCategoryListResponseSchema',
  'sheetCategoryResponseSchema',
  'sheetCategoryListResponseSchema',
  'productCategoryResponseSchema',
  'updateProductCategoryRequestSchema',
  'updateProductTrackingRequestSchema',
  'stockOverviewQuerySchema',
  'stockOverviewItemSchema',
  'stockOverviewResponseSchema',
  // sheet-sync-runs.ts
  'sheetSyncRunCountsSchema',
  'sheetSyncRejectedRowSchema',
  'sheetSyncSkippedSupplierSchema',
  'sheetSyncCostMismatchSchema',
  'sheetSyncRunSchema',
  'sheetSyncRunsQuerySchema',
  'sheetSyncRunsResponseSchema',
  'sheetSyncRequestResponseSchema',
  // Brands of the price list Excel file and the "send to the groups" answer (contracts/brands.ts).
  'brandNameSchema',
  'brandResponseSchema',
  'brandListResponseSchema',
  'createBrandRequestSchema',
  'unbrandedProductSchema',
  'unbrandedProductListResponseSchema',
  'setProductBrandRequestSchema',
  'productBrandResponseSchema',
  'priceListPostResponseSchema',
  'priceListPostRecipientsSchema',
  'priceListPostSkippedSchema',
  'priceListPostRecipientsResponseSchema',
] as const;

export const COST_ROUTES = Object.freeze({
  productCostReference: route('GET', '/staff/products/:id/cost-reference'),
  /** Cost reference + stock of every product of the CURRENT published list, in one call. */
  currentPriceListCosts: route('GET', '/staff/price-list/current/costs'),
  getUsdRate: route('GET', '/staff/usd-rate'),
  setUsdRate: route('PUT', '/staff/usd-rate'),
  /** Switch back to following the Central Bank (and refresh once). Manager and admin. */
  followCentralBank: route('POST', '/staff/usd-rate/follow-central-bank'),
  /** Pending removal requests (manager, accountant, admin may view). */
  listSupplyRemovals: route('GET', '/staff/supply-removals'),
  /** Manager and admin only. */
  confirmSupplyRemoval: route('POST', '/staff/supply-removals/:id/confirm'),
  dismissSupplyRemoval: route('POST', '/staff/supply-removals/:id/dismiss'),
  /**
   * Products with NO price in the current published list. NOTE: the path also matches
   * `GET /staff/products/:id`; the api registers this controller first (see AppModule).
   */
  unpricedProducts: route('GET', '/staff/products/unpriced'),
  /** Every product with a stock aggregate or deliveries (staff-only). */
  stockOverview: route('GET', '/staff/stock'),
  /** The "Mega report" .xlsx: every live delivery line, one row per product (staff-only). */
  megaReport: route('GET', '/staff/stock/mega-report'),
  /** Persisted sheet sync reports, newest first (max 50). */
  sheetSyncRuns: route('GET', '/staff/sheet-sync/runs'),
  /** The newest run, or 404 NOT_FOUND when the sync never ran. */
  lastSheetSyncRun: route('GET', '/staff/sheet-sync/runs/last'),
  /** "Sync now" (manager, admin): queues one run for the worker; 202 with the outcome. */
  requestSheetSync: route('POST', '/staff/sheet-sync/runs'),
});
