// Staff-only entry: brands sort the price list Excel file into one sheet per brand.
import {
  BRAND_ROUTES,
  brandListResponseSchema,
  brandResponseSchema,
  productBrandResponseSchema,
  unbrandedProductListResponseSchema,
  type BrandListResponse,
  type BrandResponse,
  type ProductBrandResponse,
  type UnbrandedProductListResponse,
} from '@iorder/shared/staff-cost';
import type { HttpClient } from '@core/lib/http-client';

/**
 * The "Brendlar" page's calls (manager and admin; the server refuses everyone else). Two
 * implementations: HTTP (below) and the in-memory fake used in dev and tests.
 */
export interface BrandsApi {
  /** Every brand, sorted by name. */
  listBrands: () => Promise<BrandListResponse>;
  /** 409 DUPLICATE_BRAND_NAME when the name exists (letter case ignored). */
  createBrand: (name: string) => Promise<BrandResponse>;
  /** Active products whose brand neither staff set nor the name revealed; priced ones first. */
  unbrandedProducts: () => Promise<UnbrandedProductListResponse>;
  /** Remembered for the product; it wins over the brand found in the name from then on. */
  setProductBrand: (productId: string, brandId: string) => Promise<ProductBrandResponse>;
}

export function createHttpBrandsApi(http: HttpClient): BrandsApi {
  return {
    listBrands: () => http.request(BRAND_ROUTES.listBrands, brandListResponseSchema),
    createBrand: (name) =>
      http.request(BRAND_ROUTES.createBrand, brandResponseSchema, { body: { name } }),
    unbrandedProducts: () =>
      http.request(BRAND_ROUTES.unbrandedProducts, unbrandedProductListResponseSchema),
    setProductBrand: (productId, brandId) =>
      http.request(BRAND_ROUTES.setProductBrand, productBrandResponseSchema, {
        params: { id: productId },
        body: { brandId },
      }),
  };
}
