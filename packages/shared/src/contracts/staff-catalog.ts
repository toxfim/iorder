import { z } from 'zod';
import { staffProductListQuerySchema, staffProductResponseSchema } from './catalog.js';
import { isoInstantSchema, languageCodeSchema } from './common.js';
import { productPrimaryImageShape } from './product-images.js';
import { route } from './routes.js';
import { trackingTypeSchema } from './unit-codes.js';

// STAFF-ONLY catalog views (hard rule 7): the product category, the stock aggregate and the
// latest delivery come from the sheet (supplier, costs), so none of this may reach a customer DTO.
// Exported from the staff-cost entry only; the api leak tests allow-list these names.

export const PRODUCT_CATEGORY_MAX_LENGTH = 200;

const categoryFilterSchema = z.string().trim().min(1).max(PRODUCT_CATEGORY_MAX_LENGTH);
const quantityString = z.string().regex(/^\d+\.\d{3}$/);

/**
 * The staff product with the sheet's `category` of the latest delivery line (null until a
 * delivery is known). Replaces staffProductResponseSchema on the staff product endpoints (the
 * barrel schema cannot carry `category`).
 */
export const staffProductDetailResponseSchema = staffProductResponseSchema.extend({
  category: z.string().nullable(),
  /** The staff-managed category (template of the code rule), null when not linked. */
  categoryId: z.uuid().nullable(),
  /** The code rule the warehouse scans per unit while picking. */
  trackingType: trackingTypeSchema,
  markingRequired: z.boolean(),
  /**
   * false until someone (or a linked category template) set the rule: the stored NONE is then a
   * default, not a choice, and the editor suggests the company rule instead.
   */
  codeRuleConfigured: z.boolean(),
});
export type StaffProductDetailResponse = z.infer<typeof staffProductDetailResponseSchema>;

export const staffProductDetailListResponseSchema = z.strictObject({
  items: z.array(staffProductDetailResponseSchema),
});
export type StaffProductDetailListResponse = z.infer<typeof staffProductDetailListResponseSchema>;

/** Search over product code and names; `category` is an exact match. */
export const staffProductDetailListQuerySchema = staffProductListQuerySchema.extend({
  category: categoryFilterSchema.optional(),
});
export type StaffProductDetailListQuery = z.output<typeof staffProductDetailListQuerySchema>;

/** The newest delivery line of a product (what the unpriced / stock lists show about it). */
export const latestDeliverySchema = z.strictObject({
  deliveredAt: isoInstantSchema,
  supplier: z.string(),
  /** Null together while the line's cost is pending (its sheet cost cells are still empty). */
  costUsd: z
    .string()
    .regex(/^\d+\.\d{4}$/)
    .nullable(),
  costUzs: z
    .string()
    .regex(/^\d+\.\d{2}$/)
    .nullable(),
});
export type LatestDelivery = z.infer<typeof latestDeliverySchema>;

/** Distinct category with the number of products in it (for tabs). */
export const categoryCountSchema = z.strictObject({
  category: z.string(),
  count: z.number().int().positive(),
});
export type CategoryCount = z.infer<typeof categoryCountSchema>;

/** Page size of the unpriced and stock lists: default and maximum (current data fits one page). */
export const STAFF_LIST_PAGE_SIZE_DEFAULT = 200;
export const STAFF_LIST_PAGE_SIZE_MAX = 200;
export const STAFF_LIST_CURSOR_MAX_LENGTH = 512;

/** Optional paging of the staff lists; `cursor` is the opaque `nextCursor` of the previous page. */
const pageQueryShape = {
  limit: z.coerce.number().int().min(1).max(STAFF_LIST_PAGE_SIZE_MAX).optional(),
  cursor: z.string().min(1).max(STAFF_LIST_CURSOR_MAX_LENGTH).optional(),
};

/** `nextCursor` is null on the last page; `total` counts all rows matching the filters. */
const pageResponseShape = {
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
};

const productNamesSchema = z.array(z.strictObject({ lang: languageCodeSchema, name: z.string() }));

export const unpricedProductsQuerySchema = z.strictObject({
  category: categoryFilterSchema.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  ...pageQueryShape,
});
export type UnpricedProductsQuery = z.output<typeof unpricedProductsQuerySchema>;

/**
 * A product with NO price in the current published price list (also when no list is published).
 * `hasDraftPrice`: the open draft already prices it (so it will leave this list on publish).
 */
export const unpricedProductSchema = z.strictObject({
  productId: z.uuid(),
  productCode: z.string(),
  names: productNamesSchema,
  unit: z.string(),
  isActive: z.boolean(),
  category: z.string().nullable(),
  stockQuantity: quantityString.nullable(),
  latestDelivery: latestDeliverySchema.nullable(),
  hasDraftPrice: z.boolean(),
  ...productPrimaryImageShape,
});
export type UnpricedProduct = z.infer<typeof unpricedProductSchema>;

/**
 * `categories` counts the unpriced products that match `search` (the `category` filter does not
 * narrow it, so the tabs stay stable); `uncategorizedCount` is those without a category.
 */
export const unpricedProductsResponseSchema = z.strictObject({
  items: z.array(unpricedProductSchema),
  categories: z.array(categoryCountSchema),
  uncategorizedCount: z.number().int().nonnegative(),
  ...pageResponseShape,
});
export type UnpricedProductsResponse = z.infer<typeof unpricedProductsResponseSchema>;

export const stockOverviewQuerySchema = z.strictObject({
  category: categoryFilterSchema.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  /** true: stock above zero; false: no stock (zero or none). Omitted: all. */
  inStock: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  ...pageQueryShape,
});
export type StockOverviewQuery = z.output<typeof stockOverviewQuerySchema>;

/** A product that has a stock aggregate or at least one delivery line. Indicative, not a reservation. */
export const stockOverviewItemSchema = z.strictObject({
  productId: z.uuid(),
  productCode: z.string(),
  names: productNamesSchema,
  unit: z.string(),
  isActive: z.boolean(),
  category: z.string().nullable(),
  stockQuantity: quantityString.nullable(),
  /** Active holds of approved orders. Zero when nothing is held. */
  heldQuantity: quantityString,
  /** Sheet stock minus holds, never below zero; null when the product has no stock aggregate. */
  availableQuantity: quantityString.nullable(),
  /** In the current published price list. */
  isPriced: z.boolean(),
  latestDelivery: latestDeliverySchema.nullable(),
  deliveryCount: z.number().int().nonnegative(),
  /** Distinct suppliers of the live delivery lines, sorted (staff supplier filter). */
  suppliers: z.array(z.string()),
  ...productPrimaryImageShape,
});
export type StockOverviewItem = z.infer<typeof stockOverviewItemSchema>;

export const stockOverviewResponseSchema = z.strictObject({
  items: z.array(stockOverviewItemSchema),
  /** Counts over the products matching `search` and `inStock`; `category` does not narrow it. */
  categories: z.array(categoryCountSchema),
  uncategorizedCount: z.number().int().nonnegative(),
  ...pageResponseShape,
});
export type StockOverviewResponse = z.infer<typeof stockOverviewResponseSchema>;

// ---------------------------------------------------------------------------------------
// Product categories and the per-unit code rule ([C] 2026-10-25, reference-distributor model)
// ---------------------------------------------------------------------------------------

/** A category is a TEMPLATE: its defaults are copied onto a product when it is linked. */
export const productCategoryResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  trackingTypeDefault: trackingTypeSchema,
  markingRequiredDefault: z.boolean(),
  isActive: z.boolean(),
  /** Products currently linked to the category. */
  productCount: z.int().nonnegative(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type ProductCategoryResponse = z.infer<typeof productCategoryResponseSchema>;

export const productCategoryListResponseSchema = z.strictObject({
  items: z.array(productCategoryResponseSchema),
});
export type ProductCategoryListResponse = z.infer<typeof productCategoryListResponseSchema>;

const categoryNameSchema = z.string().trim().min(1).max(PRODUCT_CATEGORY_MAX_LENGTH);

/**
 * Creating a category also links the not-yet-linked products whose sheet category («Категория»)
 * has the same name (ignoring case) and copies the defaults onto them.
 */
export const createProductCategoryRequestSchema = z.strictObject({
  name: categoryNameSchema,
  trackingTypeDefault: trackingTypeSchema,
  markingRequiredDefault: z.boolean(),
});
export type CreateProductCategoryRequest = z.output<typeof createProductCategoryRequestSchema>;

/**
 * A sheet category («Категория» of the products) that has no staff category of the same name yet
 * (ignoring case and outer spaces): staff still have to say which code it needs.
 */
export const sheetCategoryResponseSchema = z.strictObject({
  name: z.string(),
  /** Products whose sheet category has this name. */
  productCount: z.int().nonnegative(),
  /** The company's rule for this name (`suggestCategoryCodeRule`); staff confirm or change it. */
  suggestedTrackingType: trackingTypeSchema,
  suggestedMarkingRequired: z.boolean(),
});
export type SheetCategoryResponse = z.infer<typeof sheetCategoryResponseSchema>;

export const sheetCategoryListResponseSchema = z.strictObject({
  items: z.array(sheetCategoryResponseSchema),
});
export type SheetCategoryListResponse = z.infer<typeof sheetCategoryListResponseSchema>;

export const PRODUCT_CATEGORY_BULK_MAX = 200;

/**
 * Creates several categories in ONE transaction (all or nothing), each exactly like
 * `createProductCategoryRequestSchema`. Names must differ ignoring case.
 */
export const createProductCategoriesRequestSchema = z.strictObject({
  items: z
    .array(createProductCategoryRequestSchema)
    .min(1)
    .max(PRODUCT_CATEGORY_BULK_MAX)
    .refine(
      (items) => new Set(items.map((i) => i.name.toLowerCase())).size === items.length,
      'Category names must be unique',
    ),
});
export type CreateProductCategoriesRequest = z.output<typeof createProductCategoriesRequestSchema>;

/** Not retroactive: products already linked keep their own rule. */
export const updateProductCategoryRequestSchema = z
  .strictObject({
    name: categoryNameSchema.optional(),
    trackingTypeDefault: trackingTypeSchema.optional(),
    markingRequiredDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change');
export type UpdateProductCategoryRequest = z.output<typeof updateProductCategoryRequestSchema>;

/**
 * The product's own code rule. Linking a category (`categoryId`) copies its defaults for the
 * fields this request does not send; explicit fields win. `categoryId: null` unlinks and keeps the
 * rule as it is.
 */
export const updateProductTrackingRequestSchema = z
  .strictObject({
    categoryId: z.uuid().nullable().optional(),
    trackingType: trackingTypeSchema.optional(),
    markingRequired: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change');
export type UpdateProductTrackingRequest = z.output<typeof updateProductTrackingRequestSchema>;

export const PRODUCT_TRACKING_ROUTES = Object.freeze({
  listCategories: route('GET', '/staff/product-categories'),
  createCategory: route('POST', '/staff/product-categories'),
  listSheetCategories: route('GET', '/staff/product-categories/sheet'),
  createCategories: route('POST', '/staff/product-categories/bulk'),
  updateCategory: route('PATCH', '/staff/product-categories/:id'),
  updateProductTracking: route('PUT', '/staff/products/:id/tracking'),
});
