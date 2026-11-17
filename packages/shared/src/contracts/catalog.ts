import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../roles.js';
import {
  isoInstantSchema,
  languageCodeSchema,
  productCodeKey,
  productCodeSchema,
  uuidSchema,
} from './common.js';

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * The company sells whole pieces only (owner, 2026-10-28): every product has this unit, the apps
 * translate it for display. The stored `products.unit` column is no longer read.
 */
export const PIECE_UNIT = 'PIECE';

/**
 * One product name for every reader, whatever the interface language (owner, 2026-10-28). Staff
 * write it into this language's row; older per-language rows are kept, not deleted.
 */
export const PRODUCT_NAME_LANG: Locale = DEFAULT_LOCALE;

/**
 * The product's common name: the first non-blank name in the fixed order UZ, RU, EN (never the
 * reader's language), so a staff-entered name wins over the sheet's Russian one. `fallback` (the
 * product code) when there is none.
 */
export function commonProductName(
  names: readonly { lang: Locale; name: string }[],
  fallback: string,
): string {
  for (const lang of LOCALES) {
    const name = names.find((n) => n.lang === lang)?.name.trim();
    if (name) return name;
  }
  return fallback;
}

export const PRODUCT_NAME_MAX_LENGTH = 200;

/**
 * Products staff add WITHOUT a sheet «Товар_ID» [C, owner 2026-11-09] get a code the system makes:
 * `IO-` + a zero-padded sequence number (IO-000123). The prefix is reserved: the sheet sync rejects
 * a «Товар_ID» that starts with it, so a generated code can never be mistaken for a sheet one.
 * `products.code_generated` records the origin; this pattern only recognises the shape.
 */
export const GENERATED_PRODUCT_CODE_PREFIX = 'IO-';
export const GENERATED_PRODUCT_CODE_DIGITS = 6;
export const GENERATED_PRODUCT_CODE_PATTERN = new RegExp(
  `^${GENERATED_PRODUCT_CODE_PREFIX}\\d{${GENERATED_PRODUCT_CODE_DIGITS},}$`,
);

/** True when the code has the reserved generated shape (case-insensitive, like every code match). */
export function hasGeneratedProductCodePrefix(productCode: string): boolean {
  return productCodeKey(productCode).startsWith(GENERATED_PRODUCT_CODE_PREFIX.toLowerCase());
}

/** The stored form of the n-th generated code: IO-000001, IO-000002, ... */
export function formatGeneratedProductCode(sequenceNumber: number): string {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber <= 0) {
    throw new RangeError('A generated product code needs a positive sequence number');
  }
  return `${GENERATED_PRODUCT_CODE_PREFIX}${String(sequenceNumber).padStart(GENERATED_PRODUCT_CODE_DIGITS, '0')}`;
}

// Strict: a cost-like field (or the old unit / per-language names) is a validation error, not
// silently dropped.
export const createProductRequestSchema = z.strictObject({
  productCode: productCodeSchema,
  name: text(PRODUCT_NAME_MAX_LENGTH),
});
export type CreateProductRequest = z.output<typeof createProductRequestSchema>;

// The product code is not editable: it is the key that links to the Google Sheet later.
export const updateProductRequestSchema = z
  .strictObject({
    name: text(PRODUCT_NAME_MAX_LENGTH).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change');
export type UpdateProductRequest = z.output<typeof updateProductRequestSchema>;

/** Optional case-insensitive search over product code (normalized) and product names. */
export const staffProductListQuerySchema = z.strictObject({
  search: z.string().trim().min(1).max(100).optional(),
});
export type StaffProductListQuery = z.output<typeof staffProductListQuerySchema>;

/** `name` is the common name; `translations` are the stored rows it was chosen from. */
export const staffProductResponseSchema = z.strictObject({
  id: z.uuid(),
  productCode: z.string(),
  name: z.string(),
  unit: z.string(),
  isActive: z.boolean(),
  /**
   * True for a product staff added without a sheet «Товар_ID» (its code is system-made, it has no
   * stock and no cost lines, and it is outside the allocation plan) [C, 2026-11-09].
   */
  codeGenerated: z.boolean(),
  /** The sheet product this generated-code product was merged into; null while it stands alone. */
  mergedIntoProductId: uuidSchema.nullable(),
  translations: z.array(
    z.strictObject({
      lang: languageCodeSchema,
      name: z.string(),
      description: z.string().nullable(),
    }),
  ),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type StaffProductResponse = z.infer<typeof staffProductResponseSchema>;

export const staffProductListResponseSchema = z.strictObject({
  items: z.array(staffProductResponseSchema),
});
export type StaffProductListResponse = z.infer<typeof staffProductListResponseSchema>;
