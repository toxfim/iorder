import {
  PRODUCT_CATEGORY_MAX_LENGTH,
  createProductCategoryRequestSchema,
  suggestCategoryCodeRule,
  productCategoryResponseSchema,
  updateProductCategoryRequestSchema,
  updateProductTrackingRequestSchema,
  type CreateProductCategoryRequest,
  type ProductCategoryResponse,
  type StaffProductDetailResponse,
  type UpdateProductCategoryRequest,
  type UpdateProductTrackingRequest,
} from '@iorder/shared/staff-cost';
import { ApiConflictError } from '@core/lib/api-errors';
import { describePricingError, type DescribedError } from '@core/lib/price-errors';

// The per-unit code rule on the staff catalog screens ([C] 2026-10-25, reference-distributor model): a
// category is a TEMPLATE (its defaults are copied onto a product when linked, never later), and
// every product has its own rule: NONE / IMEI / SERIAL plus an independent marking flag.

export type TrackingType = ProductCategoryResponse['trackingTypeDefault'];

/** NONE, IMEI, SERIAL, read from the shared contract (never copied here). */
export const TRACKING_TYPES: readonly TrackingType[] =
  productCategoryResponseSchema.shape.trackingTypeDefault.options;

export interface CodeRule {
  readonly trackingType: TrackingType;
  readonly markingRequired: boolean;
}

/** i18n keys under `products.rule.summary` naming a rule ("IMEI + marking", "Quantity goods"). */
export function ruleSummaryKey(rule: CodeRule): string {
  const base = rule.trackingType === 'NONE' ? 'NONE' : rule.trackingType;
  return `products.rule.summary.${base}${rule.markingRequired ? '_MARKING' : ''}`;
}

// --- category form -------------------------------------------------------------------------

export interface CategoryFormValues {
  name: string;
  trackingTypeDefault: TrackingType;
  markingRequiredDefault: boolean;
}

/** Message keys under `products.categories.form.errors`. */
export type CategoryNameError = 'nameRequired' | 'nameTooLong';

export type CategoryFormResult<R> =
  | { readonly ok: true; readonly request: R }
  | { readonly ok: false; readonly error: CategoryNameError };

export const CATEGORY_NAME_MAX = PRODUCT_CATEGORY_MAX_LENGTH;

export function emptyCategoryForm(): CategoryFormValues {
  return { name: '', trackingTypeDefault: 'NONE', markingRequiredDefault: false };
}

export function formFromCategory(category: ProductCategoryResponse): CategoryFormValues {
  return {
    name: category.name,
    trackingTypeDefault: category.trackingTypeDefault,
    markingRequiredDefault: category.markingRequiredDefault,
  };
}

// The tracking fields are closed choices, so only the name can be wrong.
function nameError(name: string): CategoryNameError {
  return name.trim() === '' ? 'nameRequired' : 'nameTooLong';
}

/** Validates with the shared create schema and builds the request. */
export function buildCreateCategoryRequest(
  values: CategoryFormValues,
): CategoryFormResult<CreateProductCategoryRequest> {
  const parsed = createProductCategoryRequestSchema.safeParse(values);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, error: nameError(values.name) };
}

/** Only what changed; `null` when nothing did (the dialog then just closes). */
export function buildUpdateCategoryRequest(
  original: ProductCategoryResponse,
  values: CategoryFormValues,
): CategoryFormResult<UpdateProductCategoryRequest | null> {
  const draft: Record<string, unknown> = {};
  if (values.name.trim() !== original.name) draft.name = values.name;
  if (values.trackingTypeDefault !== original.trackingTypeDefault) {
    draft.trackingTypeDefault = values.trackingTypeDefault;
  }
  if (values.markingRequiredDefault !== original.markingRequiredDefault) {
    draft.markingRequiredDefault = values.markingRequiredDefault;
  }
  if (Object.keys(draft).length === 0) return { ok: true, request: null };
  const parsed = updateProductCategoryRequestSchema.safeParse(draft);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, error: nameError(values.name) };
}

// --- the product's own rule ----------------------------------------------------------------

export type ProductRuleValues = CodeRule;

/**
 * What the product editor starts from: the saved rule once someone set it, otherwise the
 * company rule for the sheet category (phones IMEI, everything else SN, marking for the listed
 * categories). A product without a sheet category gets the SN suggestion.
 */
export function ruleFromProduct(product: StaffProductDetailResponse): ProductRuleValues {
  if (product.codeRuleConfigured) {
    return { trackingType: product.trackingType, markingRequired: product.markingRequired };
  }
  return suggestCategoryCodeRule(product.category ?? '');
}

/**
 * The tracking request, or null when nothing needs saving. A rule that was never set is always
 * sent in full, so saving the editor stores the suggestion the manager saw (and marks the rule
 * configured on the server); a configured rule sends only what changed. The template link
 * (`categoryId`) is never touched here.
 */
export function buildTrackingRequest(
  product: StaffProductDetailResponse,
  values: ProductRuleValues,
): UpdateProductTrackingRequest | null {
  const draft: Record<string, unknown> = {};
  if (!product.codeRuleConfigured || values.trackingType !== product.trackingType) {
    draft.trackingType = values.trackingType;
  }
  if (!product.codeRuleConfigured || values.markingRequired !== product.markingRequired) {
    draft.markingRequired = values.markingRequired;
  }
  if (Object.keys(draft).length === 0) return null;
  const parsed = updateProductTrackingRequestSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
}

/** The category conflicts get their own words; everything else the shared pricing mapping. */
export function describeCatalogError(
  operation: 'load' | 'createProduct' | 'updateProduct',
  error: unknown,
): DescribedError {
  if (error instanceof ApiConflictError) {
    if (error.reason === 'DUPLICATE_CATEGORY_NAME') {
      return { key: 'products.categories.errors.duplicate' };
    }
    if (error.reason === 'CATEGORY_ARCHIVED') return { key: 'products.categories.errors.archived' };
  }
  return describePricingError(operation, error);
}
