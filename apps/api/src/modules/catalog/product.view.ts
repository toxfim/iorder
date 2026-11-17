import type { Locale } from '@iorder/shared';
import type { TrackingType } from '@iorder/shared/staff-orders';
import type { Prisma } from '../../generated/prisma/client.js';

export interface ProductTranslationView {
  lang: Locale;
  name: string;
  description: string | null;
}

/** Domain shape of a product. The repository maps Prisma rows to it; nothing above sees Prisma. */
export interface ProductView {
  id: string;
  productCode: string;
  /** Staff-only: the sheet's category of the latest delivery. Never in a customer DTO. */
  category: string | null;
  /** Staff-managed category the code rule was copied from (template only). */
  categoryId: string | null;
  /** The per-unit code rule the warehouse scans while picking. Staff-only. */
  trackingType: TrackingType;
  markingRequired: boolean;
  /** false while the rule is the untouched default; see products.code_rule_configured. */
  codeRuleConfigured: boolean;
  isActive: boolean;
  /**
   * True for a product staff added without a sheet «Товар_ID» [C, 2026-11-09]: a generated code,
   * no stock, no cost lines, outside the allocation plan.
   */
  codeGenerated: boolean;
  /** The sheet product this generated-code product was merged into; null while it stands alone. */
  mergedIntoProductId: string | null;
  /** The brand STAFF chose (null: the brand finder decides). Staff-only. */
  brandId: string | null;
  createdAt: Date;
  updatedAt: Date;
  translations: ProductTranslationView[];
}

/** A product with its stock aggregate (staff-only; null when it has none). */
export interface ProductWithStock {
  product: ProductView;
  stockQuantity: Prisma.Decimal | null;
}

/** A staff-managed product category: a template of the code rule. */
export interface ProductCategoryView {
  id: string;
  name: string;
  trackingTypeDefault: TrackingType;
  markingRequiredDefault: boolean;
  isActive: boolean;
  productCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A sheet category with no staff category of the same name yet. */
export interface SheetCategoryView {
  name: string;
  productCount: number;
}

/** A brand: groups the price list Excel file into sheets ([C] 2026-10-28). */
export interface BrandView {
  id: string;
  name: string;
}
