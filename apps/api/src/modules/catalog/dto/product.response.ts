import { PIECE_UNIT, commonProductName } from '@iorder/shared';
import type {
  ProductCategoryResponse,
  StaffProductDetailResponse,
} from '@iorder/shared/staff-cost';
import type { ProductCategoryView, ProductView } from '../product.view.js';

/**
 * Explicit allow-list mapper: new columns never reach the API by accident. STAFF-ONLY: it carries
 * the category, which comes from the sheet (the customer price list mapper is separate).
 */
export function toStaffProductResponse(product: ProductView): StaffProductDetailResponse {
  return {
    id: product.id,
    productCode: product.productCode,
    name: commonProductName(product.translations, product.productCode),
    unit: PIECE_UNIT,
    category: product.category,
    categoryId: product.categoryId,
    trackingType: product.trackingType,
    markingRequired: product.markingRequired,
    codeRuleConfigured: product.codeRuleConfigured,
    isActive: product.isActive,
    codeGenerated: product.codeGenerated,
    mergedIntoProductId: product.mergedIntoProductId,
    translations: product.translations.map((t) => ({
      lang: t.lang,
      name: t.name,
      description: t.description,
    })),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toProductCategoryResponse(category: ProductCategoryView): ProductCategoryResponse {
  return {
    id: category.id,
    name: category.name,
    trackingTypeDefault: category.trackingTypeDefault,
    markingRequiredDefault: category.markingRequiredDefault,
    isActive: category.isActive,
    productCount: category.productCount,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}
