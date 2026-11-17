import type {
  ProductCategoryResponse,
  StaffProductDetailResponse,
} from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import { ApiConflictError, NetworkError } from '@core/lib/api-errors';
import {
  CATEGORY_NAME_MAX,
  TRACKING_TYPES,
  buildCreateCategoryRequest,
  buildTrackingRequest,
  buildUpdateCategoryRequest,
  describeCatalogError,
  emptyCategoryForm,
  formFromCategory,
  ruleFromProduct,
  ruleSummaryKey,
} from './category-form';

const AT = '2026-10-01T09:00:00.000Z';
const CATEGORY: ProductCategoryResponse = {
  id: '00000000-0000-4000-9000-000000000001',
  name: 'Telefonlar',
  trackingTypeDefault: 'IMEI',
  markingRequiredDefault: true,
  isActive: true,
  productCount: 3,
  createdAt: AT,
  updatedAt: AT,
};
const PRODUCT: StaffProductDetailResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  productCode: '10491',
  name: 'Galaxy A15',
  unit: 'PIECE',
  category: 'Смартфоны',
  categoryId: null,
  trackingType: 'NONE',
  markingRequired: false,
  codeRuleConfigured: false,
  isActive: true,
  codeGenerated: false,
  mergedIntoProductId: null,
  translations: [{ lang: 'UZ', name: 'Galaxy A15', description: null }],
  createdAt: AT,
  updatedAt: AT,
};

describe('category form', () => {
  it('offers the three tracking types of the shared contract', () => {
    expect(TRACKING_TYPES).toEqual(['NONE', 'IMEI', 'SERIAL']);
  });

  it('builds a create request with the trimmed name, or names the error', () => {
    expect(
      buildCreateCategoryRequest({
        name: '  Telefonlar ',
        trackingTypeDefault: 'IMEI',
        markingRequiredDefault: true,
      }),
    ).toEqual({
      ok: true,
      request: { name: 'Telefonlar', trackingTypeDefault: 'IMEI', markingRequiredDefault: true },
    });
    expect(buildCreateCategoryRequest({ ...emptyCategoryForm(), name: '   ' })).toEqual({
      ok: false,
      error: 'nameRequired',
    });
    expect(
      buildCreateCategoryRequest({
        ...emptyCategoryForm(),
        name: 'x'.repeat(CATEGORY_NAME_MAX + 1),
      }),
    ).toEqual({ ok: false, error: 'nameTooLong' });
  });

  it('sends only what changed when editing, and nothing when nothing changed', () => {
    const same = formFromCategory(CATEGORY);
    expect(buildUpdateCategoryRequest(CATEGORY, same)).toEqual({ ok: true, request: null });
    expect(
      buildUpdateCategoryRequest(CATEGORY, { ...same, markingRequiredDefault: false }),
    ).toEqual({ ok: true, request: { markingRequiredDefault: false } });
    expect(buildUpdateCategoryRequest(CATEGORY, { ...same, name: '' })).toEqual({
      ok: false,
      error: 'nameRequired',
    });
  });
});

describe('product code rule', () => {
  it('names a rule for the list', () => {
    expect(ruleSummaryKey({ trackingType: 'IMEI', markingRequired: true })).toBe(
      'products.rule.summary.IMEI_MARKING',
    );
    expect(ruleSummaryKey({ trackingType: 'NONE', markingRequired: false })).toBe(
      'products.rule.summary.NONE',
    );
  });

  it('suggests the company rule from the sheet category while no rule was set', () => {
    expect(ruleFromProduct(PRODUCT)).toEqual({ trackingType: 'IMEI', markingRequired: false });
    expect(ruleFromProduct({ ...PRODUCT, category: 'Роботы-пылесосы' })).toEqual({
      trackingType: 'SERIAL',
      markingRequired: true,
    });
    // No sheet category: the SN suggestion, never a missing-category prerequisite.
    expect(ruleFromProduct({ ...PRODUCT, category: null })).toEqual({
      trackingType: 'SERIAL',
      markingRequired: false,
    });
  });

  it('keeps a configured rule as saved, an explicit NONE included', () => {
    const configured = { ...PRODUCT, codeRuleConfigured: true };
    expect(ruleFromProduct(configured)).toEqual({ trackingType: 'NONE', markingRequired: false });
  });

  it('sends a never-set rule in full, so the suggestion the manager saw is what the server stores', () => {
    expect(buildTrackingRequest(PRODUCT, ruleFromProduct(PRODUCT))).toEqual({
      trackingType: 'IMEI',
      markingRequired: false,
    });
    // The manager overrides the suggestion: the override is sent.
    expect(buildTrackingRequest(PRODUCT, { trackingType: 'NONE', markingRequired: false })).toEqual(
      { trackingType: 'NONE', markingRequired: false },
    );
  });

  it('sends only the changed field of a configured rule, and nothing when unchanged', () => {
    const configured = { ...PRODUCT, codeRuleConfigured: true, trackingType: 'SERIAL' as const };
    expect(buildTrackingRequest(configured, ruleFromProduct(configured))).toBeNull();
    expect(
      buildTrackingRequest(configured, { trackingType: 'SERIAL', markingRequired: true }),
    ).toEqual({ markingRequired: true });
  });

  it('words the category conflicts and leaves the rest to the shared mapping', () => {
    const duplicate = new ApiConflictError('x', 'CONFLICT', undefined, 'DUPLICATE_CATEGORY_NAME');
    expect(describeCatalogError('createProduct', duplicate).key).toBe(
      'products.categories.errors.duplicate',
    );
    const archived = new ApiConflictError('x', 'CONFLICT', undefined, 'CATEGORY_ARCHIVED');
    expect(describeCatalogError('updateProduct', archived).key).toBe(
      'products.categories.errors.archived',
    );
    expect(describeCatalogError('load', new NetworkError()).key).toBe('apiErrors.network');
  });
});
