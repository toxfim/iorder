import {
  PRODUCT_CODE_RULE,
  normalizeProductCode,
  createProductRequestSchema,
  updateProductRequestSchema,
  type CreateProductRequest,
  type UpdateProductRequest,
} from '@iorder/shared';
import type { StaffProductDetailResponse } from '@iorder/shared/staff-cost';

// One product name for every reader (owner, 2026-10-28) and no unit: the company sells whole
// pieces only, so the server sets the unit itself.

export interface ProductFormValues {
  productCode: string;
  name: string;
}

export type ProductFormField = 'productCode' | 'name';
export type ProductFormErrors = Partial<Record<ProductFormField, string>>;

/**
 * Values for the hint and error texts, read from the shared rule (never copied here): the
 * maximum length and the allowed symbols besides Latin letters and digits, as "- . _ /".
 */
export function productCodeRuleParams(): { max: number; symbols: string } {
  const symbols = PRODUCT_CODE_RULE.charset.replace('A-Za-z0-9', '');
  return { max: PRODUCT_CODE_RULE.maxLength, symbols: [...symbols].join(' ') };
}

export function emptyForm(): ProductFormValues {
  return { productCode: '', name: '' };
}

/** The common name the api resolved (a staff-entered one, else the sheet's). */
export function formFromProduct(product: StaffProductDetailResponse): ProductFormValues {
  return { productCode: product.productCode, name: product.name };
}

export type FormResult<R> =
  | { readonly ok: true; readonly request: R }
  | { readonly ok: false; readonly errors: ProductFormErrors };

// Message keys under `products.form.errors`; the schema's English text is never shown.
function fieldErrors(issues: readonly { path: readonly PropertyKey[] }[]): ProductFormErrors {
  const errors: ProductFormErrors = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '');
    if (field === 'productCode') errors.productCode ??= 'productCode';
    else if (field === 'name') errors.name ??= 'name';
  }
  return errors;
}

/** Validates with the shared create schema and builds the request. */
export function buildCreateRequest(values: ProductFormValues): FormResult<CreateProductRequest> {
  const parsed = createProductRequestSchema.safeParse({
    productCode: normalizeProductCode(values.productCode),
    name: values.name,
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, errors: fieldErrors(parsed.error.issues) };
}

/**
 * Sends only what changed (the product code never travels: it cannot be edited). `null` request means
 * nothing changed, so the dialog can simply close.
 */
export function buildUpdateRequest(
  original: StaffProductDetailResponse,
  values: ProductFormValues,
): FormResult<UpdateProductRequest | null> {
  const draft: Record<string, unknown> = {};
  // A cleared name is sent and refused by the shared schema below (reported as a name error).
  if (values.name.trim() !== original.name) draft.name = values.name;
  if (Object.keys(draft).length === 0) return { ok: true, request: null };

  const parsed = updateProductRequestSchema.safeParse(draft);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, errors: fieldErrors(parsed.error.issues) };
}
