import {
  PRICING_ROUTES,
  priceHistoryResponseSchema,
  type PriceHistoryResponse,
  type PublishChangesRequest,
} from '@iorder/shared';
// Staff-only entry: the API adds `usdRateSnapshot` to every staff price list and version response.
import {
  MANUAL_PRODUCT_ROUTES,
  createManualProductResponseSchema,
  manualProductCheckResponseSchema,
  mergePreviewResponseSchema,
  mergeProductResponseSchema,
  priceImportConfirmResponseSchema,
  priceImportPreviewResponseSchema,
  publishChangesWithRateResponseSchema,
  staffPriceListWithRateResponseSchema,
  staffVersionListWithRateResponseSchema,
  type CreateManualProductRequest,
  type CreateManualProductResponse,
  type ManualProductCheckResponse,
  type MergePreviewResponse,
  type MergeProductRequest,
  type MergeProductResponse,
  type PriceImportConfirmRequest,
  type PriceImportConfirmResponse,
  type PriceImportPreviewResponse,
  type PriceImportTemplateKind,
  type PublishChangesWithRateResponse,
  type StaffPriceListWithRateResponse,
  type StaffVersionListWithRateResponse,
} from '@iorder/shared/staff-cost';
import type { DownloadedFile, HttpClient } from '@core/lib/http-client';

/**
 * Deadline of one import preview [P]: the server parses the whole workbook and looks every row up
 * before it answers, which can take longer than the default 30 s for a file near the row limit.
 */
export const PRICE_IMPORT_TIMEOUT_MS = 120_000;

/**
 * What the price list screens need from the backend. Payload types are the shared contract's;
 * there are two implementations: HTTP (below) and the in-memory fake used in dev and tests.
 *
 * The staff app has no drafts [C, 2026-10-28]: the edits of one save become a new PUBLISHED
 * version in one request, so the draft endpoints of the api are not part of this interface.
 */
export interface PricingApi {
  /** The published list. Answers 404 (ApiNotFoundError) until the first publish. */
  getCurrent: () => Promise<StaffPriceListWithRateResponse>;
  listVersions: () => Promise<StaffVersionListWithRateResponse>;
  getVersion: (versionId: string) => Promise<StaffPriceListWithRateResponse>;
  /**
   * Publishes the current list + upserts - removals as a new version, atomically. 409 reasons:
   * PRICE_LIST_CHANGED (another version was published meanwhile), INACTIVE_PRODUCT,
   * EMPTY_PRICE_LIST; 404 with `details.productIds` for unknown products.
   */
  publishChanges: (request: PublishChangesRequest) => Promise<PublishChangesWithRateResponse>;
  getPriceHistory: (productId: string) => Promise<PriceHistoryResponse>;

  // Staff-added products without a sheet «Товар_ID» [C, owner 2026-11-09] (manager, admin).

  /**
   * Creates a product with a generated code (IO-000123) and publishes the list with its price as
   * the next version, in one transaction. 409 PRICE_LIST_CHANGED on a stale base; 404 UNKNOWN_BRAND.
   */
  createManualProduct: (
    request: CreateManualProductRequest,
  ) => Promise<CreateManualProductResponse>;
  /** What the form shows while the name is typed: similar products and the brand read in the name. */
  checkManualProduct: (name: string) => Promise<ManualProductCheckResponse>;
  /**
   * Moves a generated-code product's prices, brand, name and photos onto the sheet product for the
   * same goods; the source becomes inactive. 409: PRICE_LIST_CHANGED, NOT_GENERATED_CODE,
   * TARGET_IS_GENERATED, PRODUCT_ALREADY_MERGED, INACTIVE_PRODUCT; 404 for unknown ids.
   */
  mergeProduct: (productId: string, request: MergeProductRequest) => Promise<MergeProductResponse>;
  /** What that merge would do (read-only); the same 404 / 409 reasons as the merge itself. */
  mergePreview: (productId: string, targetProductId: string) => Promise<MergePreviewResponse>;
  /** The .xlsx template: the header only, or filled with the generated-code products in the list. */
  downloadImportTemplate: (kind: PriceImportTemplateKind) => Promise<DownloadedFile>;
  /**
   * Reads an .xlsx (multipart, field `file`) and says per row what a confirm would do; nothing is
   * written. A refused file is a 422 with the reason in `details.reason` (PRICE_IMPORT_FILE_ERRORS).
   */
  importPreview: (file: File) => Promise<PriceImportPreviewResponse>;
  /**
   * Publishes the current list + these rows as the next version. 422 IMPORT_ROWS_INVALID with
   * `details.rows` when a row fails a check (nothing written); 409 PRICE_LIST_CHANGED.
   */
  importConfirm: (request: PriceImportConfirmRequest) => Promise<PriceImportConfirmResponse>;
}

export function createHttpPricingApi(http: HttpClient): PricingApi {
  return {
    getCurrent: () =>
      http.request(PRICING_ROUTES.staffCurrentPriceList, staffPriceListWithRateResponseSchema),
    listVersions: () =>
      http.request(PRICING_ROUTES.listVersions, staffVersionListWithRateResponseSchema),
    getVersion: (versionId) =>
      http.request(PRICING_ROUTES.getVersion, staffPriceListWithRateResponseSchema, {
        params: { id: versionId },
      }),
    publishChanges: (request) =>
      http.request(PRICING_ROUTES.publishChanges, publishChangesWithRateResponseSchema, {
        body: request,
      }),
    getPriceHistory: (productId) =>
      http.request(PRICING_ROUTES.productPriceHistory, priceHistoryResponseSchema, {
        params: { id: productId },
      }),
    createManualProduct: (request) =>
      http.request(MANUAL_PRODUCT_ROUTES.createManualProduct, createManualProductResponseSchema, {
        body: request,
      }),
    checkManualProduct: (name) =>
      http.request(MANUAL_PRODUCT_ROUTES.checkManualProduct, manualProductCheckResponseSchema, {
        query: { name },
      }),
    mergeProduct: (productId, request) =>
      http.request(MANUAL_PRODUCT_ROUTES.mergeProduct, mergeProductResponseSchema, {
        params: { id: productId },
        body: request,
      }),
    mergePreview: (productId, targetProductId) =>
      http.request(MANUAL_PRODUCT_ROUTES.mergePreview, mergePreviewResponseSchema, {
        params: { id: productId },
        query: { targetProductId },
      }),
    downloadImportTemplate: (kind) =>
      http.requestFile(MANUAL_PRODUCT_ROUTES.priceImportTemplate, { query: { kind } }),
    importPreview: (file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return http.request(
        MANUAL_PRODUCT_ROUTES.priceImportPreview,
        priceImportPreviewResponseSchema,
        {
          form,
          timeoutMs: PRICE_IMPORT_TIMEOUT_MS,
        },
      );
    },
    importConfirm: (request) =>
      http.request(MANUAL_PRODUCT_ROUTES.priceImportConfirm, priceImportConfirmResponseSchema, {
        body: request,
        timeoutMs: PRICE_IMPORT_TIMEOUT_MS,
      }),
  };
}
