import { z } from 'zod';
import { PRODUCT_NAME_MAX_LENGTH } from './catalog.js';
import { PRODUCT_CATEGORY_MAX_LENGTH } from './staff-catalog.js';
import { isoInstantSchema, moneyStringSchema, productCodeSchema, uuidSchema } from './common.js';
import type { OrderStatus } from '../order-status.js';
import { PRICE_LIST_CURRENCIES } from './pricing.js';
import { brandNameSchema, brandResponseSchema } from './brands.js';
import { publishChangesWithRateResponseSchema } from './cost.js';
import { route } from './routes.js';

// STAFF-ONLY [C, owner 2026-11-09]: products added to the price list by staff without a sheet
// «Товар_ID». The system gives them a generated code (IO-000123, see catalog.ts). They have no
// stock and no cost lines, are outside the allocation plan, and can later be MERGED into the sheet
// product that stands for the same goods. Exported from the staff-cost entry only (the customer
// app never adds products). Every write below publishes a new PUBLISHED price list version in the
// same transaction, like POST /staff/price-list/publish, and takes the same `baseVersionNumber`.

const baseVersionNumber = z.number().int().positive().nullable();
const productName = z.string().trim().min(1).max(PRODUCT_NAME_MAX_LENGTH);
/** The category label customers browse by (`products.category`): the form's and the import's rule. */
const productCategory = z.string().trim().min(1).max(PRODUCT_CATEGORY_MAX_LENGTH);

// ---------------------------------------------------------------------------------------
// One product at a time ("Tovar qo'shish" on Narxlar)
// ---------------------------------------------------------------------------------------

/**
 * Creates the product (generated code, the name as its common name, the optional brand) and
 * publishes the current list + this price as the next version, in one transaction. 409
 * PRICE_LIST_CHANGED when `baseVersionNumber` is not the published one; 404 UNKNOWN_BRAND.
 */
export const createManualProductRequestSchema = z.strictObject({
  baseVersionNumber,
  name: productName,
  brandId: uuidSchema.nullable().default(null),
  /**
   * The category label customers browse by (the same `products.category` text the sheet fills for
   * sheet products) [P, design 2026-11-09]; null = none. Chosen from the existing labels or typed.
   */
  category: productCategory.nullable().default(null),
  basePrice: moneyStringSchema,
  deferredPrice: moneyStringSchema.nullable().default(null),
});
export type CreateManualProductRequest = z.output<typeof createManualProductRequestSchema>;

/** What the form shows while the name is typed (design 2026-11-09): read-only, nothing is written. */
export const manualProductCheckQuerySchema = z.strictObject({
  name: productName,
});
export type ManualProductCheckQuery = z.output<typeof manualProductCheckQuerySchema>;

/** An active product whose common name equals or closely resembles the typed one. */
export const similarProductSchema = z.strictObject({
  productId: uuidSchema,
  productCode: z.string(),
  name: z.string(),
  codeGenerated: z.boolean(),
  /** In the published price list now. */
  priced: z.boolean(),
});
export type SimilarProduct = z.infer<typeof similarProductSchema>;

export const manualProductCheckResponseSchema = z.strictObject({
  /** Exact match first (ignoring case and spacing), then near matches; at most 5. */
  similar: z.array(similarProductSchema).max(5),
  /** The brand the brand finder reads in the name ("Nomdan topildi"); null when none. */
  brandFound: brandResponseSchema.nullable(),
});
export type ManualProductCheckResponse = z.infer<typeof manualProductCheckResponseSchema>;

export const createManualProductResponseSchema = z.strictObject({
  productId: uuidSchema,
  /** The generated code (IO-000123). */
  productCode: z.string(),
  version: publishChangesWithRateResponseSchema,
});
export type CreateManualProductResponse = z.infer<typeof createManualProductResponseSchema>;

// ---------------------------------------------------------------------------------------
// Merge a generated-code product into the sheet product for the same goods
// ---------------------------------------------------------------------------------------

/**
 * The manual product's prices (when it is in the list), its brand (when the target has none), its
 * staff-entered name (when the target has no name in that language), its photos and open cart
 * lines move to `targetProductId`; the manual product becomes inactive, leaves the list and gets
 * `mergedIntoProductId`. Old orders keep their snapshots. 409 reasons: PRICE_LIST_CHANGED,
 * NOT_GENERATED_CODE (the source is a sheet product), TARGET_IS_GENERATED (the target is not a
 * sheet product), PRODUCT_ALREADY_MERGED, INACTIVE_PRODUCT (the target); 404 for unknown ids.
 */
export const mergeProductRequestSchema = z.strictObject({
  baseVersionNumber,
  targetProductId: uuidSchema,
});
export type MergeProductRequest = z.output<typeof mergeProductRequestSchema>;

/** What the merge dialog shows before the person confirms (design 2026-11-09). Read-only. */
export const mergePreviewQuerySchema = z.strictObject({
  targetProductId: uuidSchema,
});
export type MergePreviewQuery = z.output<typeof mergePreviewQuerySchema>;

const previewPrices = {
  /** Published USD prices; null when the product is not in the list (or has no deferred price). */
  basePrice: moneyStringSchema.nullable(),
  deferredPrice: moneyStringSchema.nullable(),
};

export const mergePreviewResponseSchema = z.strictObject({
  source: z.strictObject({
    productId: uuidSchema,
    productCode: z.string(),
    name: z.string(),
    brandName: z.string().nullable(),
    ...previewPrices,
    /** Live photos that will move to the target. */
    imageCount: z.number().int().nonnegative(),
    /** Open cart lines (all organizations) that will move to the target. */
    cartLineCount: z.number().int().nonnegative(),
  }),
  target: z.strictObject({
    productId: uuidSchema,
    productCode: z.string(),
    name: z.string(),
    brandName: z.string().nullable(),
    ...previewPrices,
    /** The stock aggregate in pieces (3 fraction digits, like the stock lists); null when unknown. */
    stockQuantity: z
      .string()
      .regex(/^\d+\.\d{3}$/)
      .nullable(),
    /** Latest delivery cost in USD (4 fraction digits); null when unknown or the caller may not view cost. */
    costUsd: z.string().nullable(),
  }),
  /** The version number the merge will publish; null when the source is not priced (no publish). */
  nextVersionNumber: z.number().int().positive().nullable(),
});
export type MergePreviewResponse = z.infer<typeof mergePreviewResponseSchema>;

export const mergeProductResponseSchema = z.strictObject({
  sourceProductId: uuidSchema,
  targetProductId: uuidSchema,
  /** The new version; null when the source had no price in the list (nothing to republish). */
  version: publishChangesWithRateResponseSchema.nullable(),
});
export type MergeProductResponse = z.infer<typeof mergeProductResponseSchema>;

// ---------------------------------------------------------------------------------------
// Excel import ("Excel yuklash" on Narxlar): template -> preview -> confirm
// ---------------------------------------------------------------------------------------

/** Rows in one file / one confirm (the header row not counted). */
export const PRICE_IMPORT_MAX_ROWS = 2000;
/** The .xlsx upload limit (design 2026-11-09: "5 MB gacha"); PRICE_IMPORT_MAX_ROWS text rows are far below it. */
export const PRICE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Which template to download: the header only, or filled with the generated-code products in the list. */
export const PRICE_IMPORT_TEMPLATE_KINDS = ['empty', 'filled'] as const;
export type PriceImportTemplateKind = (typeof PRICE_IMPORT_TEMPLATE_KINDS)[number];
export const priceImportTemplateQuerySchema = z.strictObject({
  kind: z.enum(PRICE_IMPORT_TEMPLATE_KINDS).default('filled'),
});
export type PriceImportTemplateQuery = z.output<typeof priceImportTemplateQuerySchema>;

/**
 * The template's columns, in order. The headers are matched by meaning (the parser accepts the
 * UZ / RU / EN wording the template is downloaded in), so a renamed column is a FILE_HEADERS_INVALID
 * error, never a silently skipped column.
 */
export const PRICE_IMPORT_COLUMNS = [
  'productCode',
  'name',
  'brand',
  /** "Kategoriya" [C, 2026-11-09]: optional; the label a NEW product gets (see the row request). */
  'category',
  'basePrice',
  'deferredPrice',
  /** "RRP" [C, 2026-11-09]: optional recommended retail price in USD. */
  'rrp',
] as const;
export type PriceImportColumn = (typeof PRICE_IMPORT_COLUMNS)[number];

/**
 * Optional columns AFTER the required ones [C, owner 2026-11-11]: the «Оптовик/Партнер» tier's
 * sale and deferred price in USD. Found by header (any of the accepted wordings), in this order. A
 * file WITHOUT them leaves every product's wholesale prices as they are [P]; a file with them sets
 * them (an empty cell = none).
 */
export const PRICE_IMPORT_WHOLESALE_COLUMNS = ['wholesalePrice', 'wholesaleDeferredPrice'] as const;
export type PriceImportWholesaleColumn = (typeof PRICE_IMPORT_WHOLESALE_COLUMNS)[number];

/**
 * Optional columns of the «Alif factoring» tier [C, owner 2026-11-12], after the wholesale ones,
 * found by header in this order. Same rule as the wholesale columns [P]: a file WITHOUT them keeps
 * every product's Alif prices; a file with them sets them (an empty cell = none, and then the
 * product is not offered to that tier).
 */
export const PRICE_IMPORT_ALIF_COLUMNS = ['alifPrice', 'alifDeferredPrice'] as const;
export type PriceImportAlifColumn = (typeof PRICE_IMPORT_ALIF_COLUMNS)[number];

export const PRICE_IMPORT_ROW_STATUSES = ['NEW', 'PRICE_CHANGED', 'UNCHANGED', 'ERROR'] as const;
export type PriceImportRowStatus = (typeof PRICE_IMPORT_ROW_STATUSES)[number];

/** Why a row cannot be imported (the UI translates the code; the raw cell is shown next to it). */
export const PRICE_IMPORT_ROW_ISSUES = [
  /** Empty name cell. */
  'NAME_MISSING',
  'NAME_TOO_LONG',
  /** Empty or unreadable "Цена $" cell. */
  'PRICE_MISSING',
  'PRICE_INVALID',
  'DEFERRED_PRICE_INVALID',
  /** Unreadable "RRP" cell (an empty one is fine: the product then has no RRP). */
  'RRP_INVALID',
  /** The "Kategoriya" cell is longer than PRODUCT_CATEGORY_MAX_LENGTH. */
  'CATEGORY_TOO_LONG',
  /** Unreadable «Оптовик/Партнер» cells (empty ones are fine: no wholesale price). */
  'WHOLESALE_PRICE_INVALID',
  'WHOLESALE_DEFERRED_PRICE_INVALID',
  /** A wholesale deferred price without a wholesale sale price. */
  'WHOLESALE_PRICE_MISSING',
  /** Unreadable «Alif factoring» cells (empty ones are fine: no Alif price). */
  'ALIF_PRICE_INVALID',
  'ALIF_DEFERRED_PRICE_INVALID',
  /** An Alif deferred price without an Alif sale price. */
  'ALIF_PRICE_MISSING',
  /** The «Товар_ID» cell has characters the product code rule refuses. */
  'CODE_FORMAT_INVALID',
  /** A «Товар_ID» no product has: a sheet product is created by the sync, never by this import. */
  'UNKNOWN_PRODUCT_CODE',
  'PRODUCT_INACTIVE',
  /** The product was merged into another one; price the target instead. */
  'PRODUCT_MERGED',
  /** No brand of that name exists (brands are created on the Brands page first). */
  'UNKNOWN_BRAND',
  /** The same «Товар_ID» appears on an earlier row of the file. */
  'DUPLICATE_CODE_IN_FILE',
] as const;
export type PriceImportRowIssue = (typeof PRICE_IMPORT_ROW_ISSUES)[number];

/** The row is importable, but worth a look. */
export const PRICE_IMPORT_ROW_WARNINGS = [
  /** No «Товар_ID», and an active product with the same name (ignoring case) exists already. */
  'SAME_NAME_EXISTS',
  /** The same name appears on another code-less row of the file (two products would be made). */
  'DUPLICATE_NAME_IN_FILE',
  /** A code-less row: a product with a generated code will be created. */
  'CODE_WILL_BE_GENERATED',
] as const;
export type PriceImportRowWarning = (typeof PRICE_IMPORT_ROW_WARNINGS)[number];

/** Why the whole file is refused (422 with this code in `details.reason`). */
export const PRICE_IMPORT_FILE_ERRORS = [
  'FILE_NOT_XLSX',
  'FILE_TOO_LARGE',
  'FILE_HEADERS_INVALID',
  'FILE_EMPTY',
  'FILE_TOO_MANY_ROWS',
] as const;
export type PriceImportFileError = (typeof PRICE_IMPORT_FILE_ERRORS)[number];

/** A row of the file as the server read it, with its verdict. Nothing is written by a preview. */
export const priceImportPreviewRowSchema = z.strictObject({
  /** 1-based row number in the sheet (the header is row 1, so data starts at 2). */
  rowNumber: z.number().int().positive(),
  /** The «Товар_ID» cell, trimmed; null when empty (a new product). */
  productCode: z.string().nullable(),
  /** The product the code names; null for a new product or an unknown code. */
  productId: uuidSchema.nullable(),
  /** True when `productCode` names a generated-code (staff-added) product. */
  codeGenerated: z.boolean().nullable(),
  name: z.string(),
  /** The brand cell, trimmed; null when empty. */
  brandName: z.string().nullable(),
  /**
   * The category cell, trimmed; null when empty. Free text like the staff form's category: a label
   * no product has yet is simply a new label. Stored only for a NEW product (a code-less row); an
   * existing product keeps its category and the cell is ignored, like the brand cell.
   */
  category: z.string().nullable(),
  /** Parsed prices in USD; null when the cell is empty or unreadable (then an issue says why). */
  basePrice: moneyStringSchema.nullable(),
  deferredPrice: moneyStringSchema.nullable(),
  /** The recommended retail price (RRP) in USD; null = none (an unreadable cell has an issue). */
  rrp: moneyStringSchema.nullable(),
  /**
   * The «Оптовик/Партнер» prices in USD; null = none, or the file has no wholesale columns (then
   * `wholesaleGiven` is false and the import keeps the current ones).
   */
  wholesalePrice: moneyStringSchema.nullable(),
  wholesaleDeferredPrice: moneyStringSchema.nullable(),
  wholesaleGiven: z.boolean(),
  /** The «Alif factoring» prices in USD, like the wholesale ones (`alifGiven` false = no columns). */
  alifPrice: moneyStringSchema.nullable(),
  alifDeferredPrice: moneyStringSchema.nullable(),
  alifGiven: z.boolean(),
  /** The published prices of the product now, for the "was -> becomes" column; null when none. */
  currentBasePrice: moneyStringSchema.nullable(),
  currentDeferredPrice: moneyStringSchema.nullable(),
  currentRrp: moneyStringSchema.nullable(),
  currentWholesalePrice: moneyStringSchema.nullable(),
  currentWholesaleDeferredPrice: moneyStringSchema.nullable(),
  currentAlifPrice: moneyStringSchema.nullable(),
  currentAlifDeferredPrice: moneyStringSchema.nullable(),
  status: z.enum(PRICE_IMPORT_ROW_STATUSES),
  issues: z.array(z.enum(PRICE_IMPORT_ROW_ISSUES)),
  warnings: z.array(z.enum(PRICE_IMPORT_ROW_WARNINGS)),
});
export type PriceImportPreviewRow = z.infer<typeof priceImportPreviewRowSchema>;

export const priceImportSummarySchema = z.strictObject({
  newCount: z.number().int().nonnegative(),
  priceChangedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});
export type PriceImportSummary = z.infer<typeof priceImportSummarySchema>;

/**
 * Response of POST /staff/price-list/import/preview (multipart, field `file`). The client sends
 * the importable rows back in the confirm request; the server validates them again.
 */
export const priceImportPreviewResponseSchema = z.strictObject({
  /** The published version the preview was computed against (null before the first publish). */
  baseVersionNumber: baseVersionNumber,
  rows: z.array(priceImportPreviewRowSchema).max(PRICE_IMPORT_MAX_ROWS),
  summary: priceImportSummarySchema,
});
export type PriceImportPreviewResponse = z.infer<typeof priceImportPreviewResponseSchema>;

/** One confirmed row: an existing product (by code) to re-price, or a new product (null code). */
export const priceImportRowRequestSchema = z.strictObject({
  productCode: productCodeSchema.nullable(),
  name: productName,
  brandName: brandNameSchema.nullable().default(null),
  /** The category label of a NEW product (the staff form's rule); ignored for an existing one. */
  category: productCategory.nullable().default(null),
  basePrice: moneyStringSchema,
  deferredPrice: moneyStringSchema.nullable().default(null),
  /** null = the product has no RRP after the import (like `deferredPrice`). */
  rrp: moneyStringSchema.nullable().default(null),
  /** «Оптовик/Партнер» prices: OMITTED = keep the current ones (send them only when wholesaleGiven). */
  wholesalePrice: moneyStringSchema.nullable().optional(),
  wholesaleDeferredPrice: moneyStringSchema.nullable().optional(),
  /** «Alif factoring» prices: OMITTED = keep the current ones (send them only when alifGiven). */
  alifPrice: moneyStringSchema.nullable().optional(),
  alifDeferredPrice: moneyStringSchema.nullable().optional(),
});
export type PriceImportRowRequest = z.output<typeof priceImportRowRequestSchema>;

/**
 * Publishes the current list + these rows as the next version in ONE transaction. A row that
 * fails any preview check is 422 IMPORT_ROWS_INVALID with `details.rows` (row index + issues) and
 * nothing is written; UNCHANGED rows are accepted and do nothing. Products missing from the file
 * stay in the list. 409 PRICE_LIST_CHANGED like the publish endpoint.
 */
export const priceImportConfirmRequestSchema = z
  .strictObject({
    baseVersionNumber,
    rows: z.array(priceImportRowRequestSchema).min(1).max(PRICE_IMPORT_MAX_ROWS),
  })
  .refine(({ rows }) => {
    const codes = rows.map((r) => r.productCode?.toLowerCase()).filter((c) => c !== undefined);
    return new Set(codes).size === codes.length;
  }, 'Each product code may appear once');
export type PriceImportConfirmRequest = z.output<typeof priceImportConfirmRequestSchema>;

export const priceImportConfirmResponseSchema = z.strictObject({
  version: publishChangesWithRateResponseSchema,
  /** Products created with a generated code. */
  createdCount: z.number().int().nonnegative(),
  /** Existing products whose prices changed. */
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
});
export type PriceImportConfirmResponse = z.infer<typeof priceImportConfirmResponseSchema>;

// ---------------------------------------------------------------------------------------
// "Buyurtma orqali" (by order): the staff page of these products with what open orders wait for
// ---------------------------------------------------------------------------------------

/**
 * STAFF VOCABULARY ONLY [C, owner 2026-11-09]: a staff-added product without a sheet «Товар_ID» is
 * not kept in the warehouse, it is brought when an order arrives ("buyurtma orqali"). The customer
 * must never learn this: no customer schema, response or text carries the type.
 *
 * The statuses in which an order still WAITS for such goods [P]: the goods have not left the
 * warehouse yet. From RELEASED on they were handed over; REJECTED and CANCELLED need nothing.
 */
export const BY_ORDER_OPEN_STATUSES = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
] as const satisfies readonly OrderStatus[];
export type ByOrderOpenStatus = (typeof BY_ORDER_OPEN_STATUSES)[number];

/** Pieces with three fraction digits, like the stock lists (`5.000`); zero is allowed. */
const piecesSchema = z.string().regex(/^\d+\.\d{3}$/);

/** One open order that waits for a by-order product. */
export const byOrderOpenOrderSchema = z.strictObject({
  orderId: uuidSchema,
  orderNumber: z.string(),
  organizationName: z.string(),
  status: z.enum(BY_ORDER_OPEN_STATUSES),
  /** The line's quantity in this order. */
  quantity: piecesSchema,
  submittedAt: isoInstantSchema,
});
export type ByOrderOpenOrder = z.infer<typeof byOrderOpenOrderSchema>;

/**
 * A by-order product with its open demand. No cost and no stock: such a product has neither (no
 * `price_reference` line, no `stock_cache` row), so there is nothing to hide per role.
 */
export const byOrderProductSchema = z.strictObject({
  productId: uuidSchema,
  productCode: z.string(),
  name: z.string(),
  /** The staff-chosen brand or the one found in the name; null when none. */
  brandName: z.string().nullable(),
  category: z.string().nullable(),
  /**
   * False: removed from sale (deactivated, or merged into a sheet product). Such a product is
   * listed only while an open order still waits for it.
   */
  isActive: z.boolean(),
  /** The published sale price ("Цена"), in `currency`; null when the product is not in the list. */
  basePrice: moneyStringSchema.nullable(),
  /** The published deferred price ("Отсрочка"); null = none, or not in the list. */
  deferredPrice: moneyStringSchema.nullable(),
  /** The currency of the two prices; null when the product is not in the list. */
  currency: z.enum(PRICE_LIST_CURRENCIES).nullable(),
  /** Pieces waiting in open orders (the sum over `orders`). */
  openQuantity: piecesSchema,
  /** How many open orders wait for it (the length of `orders`). */
  openOrderCount: z.number().int().nonnegative(),
  /** The open orders, the one waiting longest first. */
  orders: z.array(byOrderOpenOrderSchema),
});
export type ByOrderProduct = z.infer<typeof byOrderProductSchema>;

/**
 * GET /staff/by-order-products. Products that are needed now come first (the one whose order waits
 * longest first [P]), then the rest by name.
 */
export const byOrderProductsResponseSchema = z.strictObject({
  items: z.array(byOrderProductSchema),
});
export type ByOrderProductsResponse = z.infer<typeof byOrderProductsResponseSchema>;

export const MANUAL_PRODUCT_ROUTES = Object.freeze({
  createManualProduct: route('POST', '/staff/products/manual'),
  /** Name check for the form (similar products, brand found in the name). Read-only. */
  checkManualProduct: route('GET', '/staff/products/manual/check'),
  mergeProduct: route('POST', '/staff/products/:id/merge'),
  /** What a merge would do; `?targetProductId=`. Read-only. */
  mergePreview: route('GET', '/staff/products/:id/merge-preview'),
  /** The .xlsx template, filled with the generated-code products in the list (header only when none). */
  priceImportTemplate: route('GET', '/staff/price-list/import/template'),
  priceImportPreview: route('POST', '/staff/price-list/import/preview'),
  priceImportConfirm: route('POST', '/staff/price-list/import'),
  /**
   * The by-order products with their open-order demand. Its own prefix: under `/staff/products`
   * the catalog's `/:id` route would read the segment as a product id.
   */
  byOrderProducts: route('GET', '/staff/by-order-products'),
});
