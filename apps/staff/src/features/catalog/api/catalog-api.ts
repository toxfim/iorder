import {
  CATALOG_ROUTES,
  type CreateProductRequest,
  type UpdateProductRequest,
} from '@iorder/shared';
import {
  PRODUCT_TRACKING_ROUTES,
  productCategoryListResponseSchema,
  productCategoryResponseSchema,
  sheetCategoryListResponseSchema,
  staffProductDetailListResponseSchema,
  staffProductDetailResponseSchema,
  type CreateProductCategoriesRequest,
  type CreateProductCategoryRequest,
  type ProductCategoryListResponse,
  type ProductCategoryResponse,
  type SheetCategoryListResponse,
  type StaffProductDetailListResponse,
  type StaffProductDetailResponse,
  type UpdateProductCategoryRequest,
  type UpdateProductTrackingRequest,
} from '@iorder/shared/staff-cost';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Product management for staff (create, rename, change unit, activate/deactivate). The staff
 * detail shape carries the sheet's `category` and a nullable `unit` (sheet-created products).
 * Product categories are templates of the per-unit code rule ([C] 2026-10-25): manager and admin.
 */
export interface CatalogApi {
  listProducts: () => Promise<StaffProductDetailListResponse>;
  getProduct: (productId: string) => Promise<StaffProductDetailResponse>;
  /** 409 when the product code already exists. */
  createProduct: (request: CreateProductRequest) => Promise<StaffProductDetailResponse>;
  updateProduct: (
    productId: string,
    request: UpdateProductRequest,
  ) => Promise<StaffProductDetailResponse>;
  /** Every category, archived ones included, with the number of linked products. */
  listCategories: () => Promise<ProductCategoryListResponse>;
  /** 409 DUPLICATE_CATEGORY_NAME. Links unlinked products whose sheet category has this name. */
  createCategory: (request: CreateProductCategoryRequest) => Promise<ProductCategoryResponse>;
  /** Sheet categories («Категория») that have no category of the same name yet. */
  listSheetCategories: () => Promise<SheetCategoryListResponse>;
  /** Several categories at once, all or nothing (409 DUPLICATE_CATEGORY_NAME). */
  createCategories: (
    request: CreateProductCategoriesRequest,
  ) => Promise<ProductCategoryListResponse>;
  /** Not retroactive: products already linked keep their own rule. */
  updateCategory: (
    categoryId: string,
    request: UpdateProductCategoryRequest,
  ) => Promise<ProductCategoryResponse>;
  /** The product's own code rule; 409 CATEGORY_ARCHIVED when linking an archived category. */
  updateProductTracking: (
    productId: string,
    request: UpdateProductTrackingRequest,
  ) => Promise<StaffProductDetailResponse>;
}

export function createHttpCatalogApi(http: HttpClient): CatalogApi {
  return {
    listProducts: () =>
      http.request(CATALOG_ROUTES.listProducts, staffProductDetailListResponseSchema),
    getProduct: (productId) =>
      http.request(CATALOG_ROUTES.getProduct, staffProductDetailResponseSchema, {
        params: { id: productId },
      }),
    createProduct: (request) =>
      http.request(CATALOG_ROUTES.createProduct, staffProductDetailResponseSchema, {
        body: request,
      }),
    updateProduct: (productId, request) =>
      http.request(CATALOG_ROUTES.updateProduct, staffProductDetailResponseSchema, {
        params: { id: productId },
        body: request,
      }),
    listCategories: () =>
      http.request(PRODUCT_TRACKING_ROUTES.listCategories, productCategoryListResponseSchema),
    createCategory: (request) =>
      http.request(PRODUCT_TRACKING_ROUTES.createCategory, productCategoryResponseSchema, {
        body: request,
      }),
    listSheetCategories: () =>
      http.request(PRODUCT_TRACKING_ROUTES.listSheetCategories, sheetCategoryListResponseSchema),
    createCategories: (request) =>
      http.request(PRODUCT_TRACKING_ROUTES.createCategories, productCategoryListResponseSchema, {
        body: request,
      }),
    updateCategory: (categoryId, request) =>
      http.request(PRODUCT_TRACKING_ROUTES.updateCategory, productCategoryResponseSchema, {
        params: { id: categoryId },
        body: request,
      }),
    updateProductTracking: (productId, request) =>
      http.request(
        PRODUCT_TRACKING_ROUTES.updateProductTracking,
        staffProductDetailResponseSchema,
        {
          params: { id: productId },
          body: request,
        },
      ),
  };
}
