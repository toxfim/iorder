import { z } from 'zod';
import { uuidSchema } from './common.js';
import { route } from './routes.js';

// STAFF-ONLY: brands group the price list Excel file into one sheet per brand (owner,
// 2026-10-28). The brand of a product is found in its name ("brand finder"); a product whose name
// matches no known brand is listed for the manager and the admin, who pick or create its brand.
// That choice is stored on the product and wins over the finder from then on.

export const BRAND_NAME_MAX_LENGTH = 80;

export const brandNameSchema = z.string().trim().min(1).max(BRAND_NAME_MAX_LENGTH);

export const brandResponseSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
});
export type BrandResponse = z.infer<typeof brandResponseSchema>;

/** All brands, sorted by name (case-insensitive). */
export const brandListResponseSchema = z.strictObject({
  items: z.array(brandResponseSchema),
});
export type BrandListResponse = z.infer<typeof brandListResponseSchema>;

/** 409 DUPLICATE_BRAND_NAME when a brand with the same name (case-insensitive) exists. */
export const createBrandRequestSchema = z.strictObject({ name: brandNameSchema });
export type CreateBrandRequest = z.output<typeof createBrandRequestSchema>;

/** An active product whose brand is neither set by staff nor found in its name. */
export const unbrandedProductSchema = z.strictObject({
  productId: uuidSchema,
  productCode: z.string(),
  name: z.string(),
  /** The sheet's category, null when unknown. */
  category: z.string().nullable(),
  /** True when the product is in the published price list (it is in the Excel file now). */
  priced: z.boolean(),
});
export type UnbrandedProduct = z.infer<typeof unbrandedProductSchema>;

/** Priced products first, then by name. */
export const unbrandedProductListResponseSchema = z.strictObject({
  items: z.array(unbrandedProductSchema),
});
export type UnbrandedProductListResponse = z.infer<typeof unbrandedProductListResponseSchema>;

export const setProductBrandRequestSchema = z.strictObject({ brandId: uuidSchema });
export type SetProductBrandRequest = z.output<typeof setProductBrandRequestSchema>;

export const productBrandResponseSchema = z.strictObject({
  productId: uuidSchema,
  brand: brandResponseSchema,
});
export type ProductBrandResponse = z.infer<typeof productBrandResponseSchema>;

const count = z.number().int().nonnegative();

/**
 * Who gets the price list file [C, owner 2026-11-11]: each organization the file of ITS tier,
 * a GROUP in its group chat, a PERSON in the bound person's private chat with the bot.
 */
export const priceListPostRecipientsSchema = z.strictObject({
  total: count,
  byTier: z.strictObject({ STANDARD: count, WHOLESALE_PARTNER: count, ALIF_FACTORING: count }),
  byDestination: z.strictObject({ GROUP: count, PRIVATE: count }),
});
export type PriceListPostRecipients = z.infer<typeof priceListPostRecipientsSchema>;

/**
 * Organizations a post leaves out, by reason. Each organization is counted once, under the first
 * reason that applies, in this order: unbound, inactive, postingOff, noPrices.
 */
export const priceListPostSkippedSchema = z.strictObject({
  /** No chat bound yet: a staff-created organization whose invite was never used [P]. */
  unbound: count,
  /** Bound but INACTIVE. */
  inactive: count,
  /** ACTIVE, but price posting is switched off. */
  postingOff: count,
  /**
   * Would be sent, but its price tier has no priced product (an Alif factoring organization before
   * any Alif price exists): an empty file is never sent [P, review 2026-11-12].
   */
  noPrices: count,
});
export type PriceListPostSkipped = z.infer<typeof priceListPostSkippedSchema>;

/** GET /staff/price-list/post-to-groups/recipients: what a post would do right now. */
export const priceListPostRecipientsResponseSchema = z.strictObject({
  recipients: priceListPostRecipientsSchema,
  skipped: priceListPostSkippedSchema,
});
export type PriceListPostRecipientsResponse = z.infer<typeof priceListPostRecipientsResponseSchema>;

/** Answer of "send the price list to the groups now". */
export const priceListPostResponseSchema = z.strictObject({
  /** Published version the file is built from. */
  versionNumber: z.number().int().positive(),
  /** Chats a file was queued for, groups and private chats together (= recipients.total). */
  queuedGroupCount: count,
  recipients: priceListPostRecipientsSchema,
  skipped: priceListPostSkippedSchema,
});
export type PriceListPostResponse = z.infer<typeof priceListPostResponseSchema>;

// MANAGER and ADMIN only (brands and posting); the Excel download is open to every staff role
// that may read the staff price list.
export const BRAND_ROUTES = Object.freeze({
  listBrands: route('GET', '/staff/brands'),
  createBrand: route('POST', '/staff/brands'),
  unbrandedProducts: route('GET', '/staff/brands/unbranded-products'),
  setProductBrand: route('PUT', '/staff/products/:id/brand'),
  /** The same .xlsx file the groups receive (attachment response). */
  downloadPriceListExcel: route('GET', '/staff/price-list/current/excel'),
  postPriceListToGroups: route('POST', '/staff/price-list/post-to-groups'),
  /** Who a post would reach now (counts only), for the confirm dialog. */
  priceListPostRecipients: route('GET', '/staff/price-list/post-to-groups/recipients'),
});
