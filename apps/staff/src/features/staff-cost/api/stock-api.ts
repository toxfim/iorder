import {
  COST_ROUTES,
  SUPPLY_PARTY_ROUTES,
  setSupplyPartyResponseSchema,
  sheetSyncRequestResponseSchema,
  sheetSyncRunSchema,
  sheetSyncRunsResponseSchema,
  stockOverviewResponseSchema,
  supplyListResponseSchema,
  supplyRemovalDecisionResponseSchema,
  supplyRemovalListResponseSchema,
  unpricedProductsResponseSchema,
  type SetSupplyPartyRequest,
  type SetSupplyPartyResponse,
  type SheetSyncRequestResponse,
  type SheetSyncRun,
  type SheetSyncRunsResponse,
  type StockOverviewQuery,
  type StockOverviewResponse,
  type SupplyListResponse,
  type SupplyRemovalDecisionResponse,
  type SupplySearchQuery,
  type SupplyRemovalListResponse,
  type UnpricedProductsQuery,
  type UnpricedProductsResponse,
} from '@iorder/shared/staff-cost';
import { ApiNotFoundError } from '@core/lib/api-errors';
import type { DownloadedFile, HttpClient } from '@core/lib/http-client';

/**
 * Staff-only stock, unpriced products and the sheet sync: reading is for manager, accountant and
 * admin; deciding a removal request is for manager and admin (the server enforces both).
 */
export interface StockApi {
  /** Products with NO price in the current published list. */
  listUnpriced: (query?: UnpricedProductsQuery) => Promise<UnpricedProductsResponse>;
  listStock: (query?: StockOverviewQuery) => Promise<StockOverviewResponse>;
  /** The "Mega report" .xlsx: every delivery of every product, one row per product. */
  downloadMegaReport: () => Promise<DownloadedFile>;
  /** Newest first. */
  listSyncRuns: (limit?: number) => Promise<SheetSyncRunsResponse>;
  /** The newest run, or null when the sync never ran (the api answers 404 NOT_FOUND). */
  getLastSyncRun: () => Promise<SheetSyncRun | null>;
  /**
   * "Sync now" (manager, admin): queues one run for the worker. The result arrives later as a new
   * run; 409 SHEET_SYNC_QUEUE_UNAVAILABLE when the worker jobs are switched off.
   */
  requestSyncRun: () => Promise<SheetSyncRequestResponse>;
  /** Pending removal requests, oldest first. */
  listSupplyRemovals: () => Promise<SupplyRemovalListResponse>;
  /** 409 REMOVAL_REQUEST_NOT_PENDING when someone decided it already. */
  confirmSupplyRemoval: (requestId: string) => Promise<SupplyRemovalDecisionResponse>;
  dismissSupplyRemoval: (requestId: string) => Promise<SupplyRemovalDecisionResponse>;
  /** Live supplies, newest first. Manager only. */
  listSupplies: (query?: SupplySearchQuery) => Promise<SupplyListResponse>;
  /** Manager only. 409 SUPPLY_PARTY_CONFLICT, SUPPLY_PARTY_CHANGED or SUPPLY_NOT_AVAILABLE. */
  setSupplyParty: (request: SetSupplyPartyRequest) => Promise<SetSupplyPartyResponse>;
}

/**
 * Every page of a paged staff list in one answer. The pages filter, search and count on the client
 * over the whole list; reading only the first page (200 rows) hid every product after it once the
 * catalog grew past that (2026-11-13, 293 products on production).
 */
export async function allPages<T extends { items: unknown[]; nextCursor: string | null }>(
  fetchPage: (cursor: string | undefined) => Promise<T>,
): Promise<T> {
  const first = await fetchPage(undefined);
  const items = [...first.items];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const next = await fetchPage(cursor);
    items.push(...next.items);
    cursor = next.nextCursor;
  }
  return { ...first, items, nextCursor: null };
}

export function createHttpStockApi(http: HttpClient): StockApi {
  return {
    listUnpriced: (query = {}) =>
      allPages((cursor) =>
        http.request(COST_ROUTES.unpricedProducts, unpricedProductsResponseSchema, {
          query: { category: query.category, search: query.search, cursor },
        }),
      ),
    listStock: (query = {}) =>
      allPages((cursor) =>
        http.request(COST_ROUTES.stockOverview, stockOverviewResponseSchema, {
          query: {
            category: query.category,
            search: query.search,
            inStock: query.inStock === undefined ? undefined : String(query.inStock),
            cursor,
          },
        }),
      ),
    downloadMegaReport: () => http.requestFile(COST_ROUTES.megaReport),
    listSyncRuns: (limit) =>
      http.request(COST_ROUTES.sheetSyncRuns, sheetSyncRunsResponseSchema, {
        query: { limit: limit === undefined ? undefined : String(limit) },
      }),
    async getLastSyncRun() {
      try {
        return await http.request(COST_ROUTES.lastSheetSyncRun, sheetSyncRunSchema);
      } catch (caught) {
        // "Never ran" is a normal state of a new installation, not a failure.
        if (caught instanceof ApiNotFoundError) return null;
        throw caught;
      }
    },
    requestSyncRun: () =>
      http.request(COST_ROUTES.requestSheetSync, sheetSyncRequestResponseSchema),
    listSupplyRemovals: () =>
      http.request(COST_ROUTES.listSupplyRemovals, supplyRemovalListResponseSchema),
    confirmSupplyRemoval: (requestId) =>
      http.request(COST_ROUTES.confirmSupplyRemoval, supplyRemovalDecisionResponseSchema, {
        params: { id: requestId },
      }),
    dismissSupplyRemoval: (requestId) =>
      http.request(COST_ROUTES.dismissSupplyRemoval, supplyRemovalDecisionResponseSchema, {
        params: { id: requestId },
      }),
    listSupplies: (query = {}) =>
      http.request(SUPPLY_PARTY_ROUTES.listSupplies, supplyListResponseSchema, {
        query: { search: query.search },
      }),
    setSupplyParty: (request) =>
      http.request(SUPPLY_PARTY_ROUTES.setSupplyParty, setSupplyPartyResponseSchema, {
        body: request,
      }),
  };
}
