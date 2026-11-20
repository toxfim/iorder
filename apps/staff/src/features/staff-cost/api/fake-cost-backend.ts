import {
  RECENT_DELIVERIES_LIMIT,
  stockOverviewQuerySchema,
  unpricedProductsQuerySchema,
  updateUsdRateRequestSchema,
  type CategoryCount,
  type CostDelivery,
  type CostDeliverySummary,
  type LatestDelivery,
  type PriceListCostItem,
  type PriceListCostsResponse,
  type ProductCostReferenceResponse,
  type SheetSyncRun,
  type StaffProductDetailResponse,
  setSupplyPartyRequestSchema,
  SUPPLY_PRODUCT_NAMES_SHOWN,
  SUPPLY_SEARCH_LIMIT,
  type SetSupplyPartyResponse,
  type SupplySummary,
  type StockOverviewItem,
  type StockOverviewResponse,
  type SupplyRemovalDecisionResponse,
  type SupplyRemovalListResponse,
  type SupplyRemovalRequest,
  type UnpricedProduct,
  type UnpricedProductsResponse,
  type UpdateUsdRateRequest,
  type UsdRateResponse,
} from '@iorder/shared/staff-cost';
import type { ConflictReason, StaffRole } from '@iorder/shared';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import type { FakePriceBackendView } from '@/features/pricing/api/fake-price-backend';
import { fakeUuid as personId } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { canEditPrices, canRunSheetSync, canViewCost } from '@/features/staff-shell/price-access';
import { addQuantities, fromScaled, isPositiveQuantity, usdToUzs } from '../domain/decimal';
import type { CostApi } from './cost-api';
import {
  FAKE_COST_BACKEND_MARKER,
  FAKE_DELIVERIES,
  FAKE_DELIVERY_DAYS,
  FAKE_PURCHASE_METHODS,
  FAKE_RATE_DATE,
  FAKE_RATE_UPDATED_AT,
  FAKE_REMOVAL_SEEDS,
  FAKE_START_RATE,
  FAKE_SUPPLIERS,
  FAKE_SYNC_RUNS,
} from './fake-cost-fixtures';
import type { StockApi } from './stock-api';

export interface FakeCostBackendOptions {
  /** The catalog and price lists the fake must agree with. */
  readonly view: FakePriceBackendView;
  /** Roles of the signed-in person, read per call (permissions are modelled like the api's). */
  readonly roles: () => readonly StaffRole[];
  readonly actorName?: () => string;
  readonly latencyMs?: number;
  readonly now?: () => Date;
  readonly scenario?: () => FakeScenario;
}

export interface FakeCostBackendControls {
  /** While true, "follow the Central Bank" fails to refresh (the api sets lastRefreshFailedAt). */
  setCentralBankDown: (down: boolean) => void;
}

/** Read-only window for the price fake (the merge preview shows the sheet product's stock and cost). */
export interface FakeCostBackendView {
  /** Stock in pieces (3 fraction digits); null when the product has no live delivery. */
  stockQuantity: (productCode: string) => string | null;
  /** Latest live delivery's USD cost; null when unknown. */
  latestCostUsd: (productCode: string) => string | null;
}

interface DeliveryRecord {
  readonly productCode: string;
  readonly detail: CostDelivery;
  removed: boolean;
}

interface RemovalRecord {
  readonly request: SupplyRemovalRequest;
  status: 'PENDING' | 'CONFIRMED' | 'DISMISSED';
}

/** How long the fake "worker" takes to produce the run asked for with "sync now". */
export const FAKE_SYNC_DURATION_MS = 1_500;

const EMPTY_PAGE = {
  items: [],
  categories: [],
  uncategorizedCount: 0,
  nextCursor: null,
  total: 0,
} satisfies UnpricedProductsResponse & StockOverviewResponse;

function fakeUuid(prefix: number, counter: number): string {
  return `00000000-0000-4000-8${prefix.toString(16).padStart(3, '0')}-${counter
    .toString(16)
    .padStart(12, '0')}`;
}

function buildDeliveries(): DeliveryRecord[] {
  const records: DeliveryRecord[] = [];
  let index = 0;
  for (const [productCode, specs] of Object.entries(FAKE_DELIVERIES)) {
    for (const spec of specs) {
      const day = FAKE_DELIVERY_DAYS[spec.day];
      if (!day) throw new Error(`Unknown delivery day ${spec.day}`);
      index += 1;
      records.push({
        productCode,
        removed: false,
        detail: {
          deliveryRef: `Z-${day.request + (index % 5)}`,
          supplier: FAKE_SUPPLIERS[index % FAKE_SUPPLIERS.length] ?? FAKE_SUPPLIERS[0],
          purchaseMethod: FAKE_PURCHASE_METHODS[index % FAKE_PURCHASE_METHODS.length] ?? 'Import',
          category: '',
          deliveredQuantity: fromScaled(BigInt(spec.delivered) * 1000n, 3),
          availableQuantity: fromScaled(BigInt(spec.available) * 1000n, 3),
          costUsd: spec.usd,
          usdRateUsed: day.rate,
          costUzs: usdToUzs(spec.usd, day.rate),
          deliveredAt: day.date,
          syncedAt: FAKE_RATE_UPDATED_AT,
        },
      });
    }
  }
  return records;
}

/**
 * In-memory stand-in for the staff cost, stock, USD-rate, removal and sync-report endpoints. It
 * follows the api's rules: cost data is for manager, accountant and admin; only manager and admin
 * change the rate or decide a removal; a decided request cannot be decided again (409
 * REMOVAL_REQUEST_NOT_PENDING); a confirmed removal stops counting for stock and history.
 */
export function createFakeCostBackend(options: FakeCostBackendOptions): {
  costApi: CostApi;
  stockApi: StockApi;
  controls: FakeCostBackendControls;
  view: FakeCostBackendView;
} {
  const { view, roles } = options;
  const latencyMs = options.latencyMs ?? 0;
  const now = options.now ?? (() => new Date());
  const scenario = options.scenario ?? (() => 'ready');
  const actorName = options.actorName ?? (() => 'Fake Cost Manager');

  const deliveries = buildDeliveries();
  let centralBankDown = false;
  // "Sync now": runs the fake worker would have produced, newest first, and whether one is pending.
  const requestedRuns: SheetSyncRun[] = [];
  let syncPending = false;
  let rate: UsdRateResponse = {
    rate: FAKE_START_RATE,
    updatedAt: FAKE_RATE_UPDATED_AT,
    updatedBy: null,
    updatedByUserId: null,
    source: 'CBU',
    rateDate: FAKE_RATE_DATE,
    followsCentralBank: true,
    manualRate: null,
    manualExpiresAt: null,
    lastRefreshFailedAt: null,
    lastChannelFailedAt: null,
  };

  const categoryOf = new Map<string, string>();
  // Party numbers by supply: one seeded party, so the conflict questions show in the demo.
  const parties = new Map<string, string>(
    [...new Set(deliveries.map((d) => d.detail.deliveryRef))]
      .sort()
      .slice(0, 1)
      .map((ref) => [ref, '5']),
  );
  const removals: RemovalRecord[] = FAKE_REMOVAL_SEEDS.flatMap((seed, index) => {
    const day = FAKE_DELIVERY_DAYS[seed.day];
    const target = deliveries.find(
      (d) => d.productCode === seed.productCode && d.detail.deliveredAt === day?.date,
    );
    const product = view.products().find((p) => p.productCode === seed.productCode);
    if (!target || !product) return [];
    const { detail } = target;
    return [
      {
        status: 'PENDING' as const,
        request: {
          id: fakeUuid(0x9a, index + 1),
          productId: product.id,
          productCode: seed.productCode,
          deliveryRef: detail.deliveryRef,
          detectedAt: seed.detectedAt,
          line: {
            deliveredAt: detail.deliveredAt,
            supplier: detail.supplier,
            deliveredQuantity: detail.deliveredQuantity,
            availableQuantity: detail.availableQuantity,
            costUsd: detail.costUsd,
            usdRateUsed: detail.usdRateUsed,
            costUzs: detail.costUzs,
          },
        },
      },
    ];
  });

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  // Dev scenario switcher, like the price backend: what the READ calls answer.
  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_COST_BACKEND_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  async function readAs(): Promise<'empty' | null> {
    const state = await beforeRead();
    if (!canViewCost(roles())) throw new PermissionDeniedError();
    return state;
  }

  function requireEditor(): void {
    if (!canEditPrices(roles())) throw new PermissionDeniedError();
  }

  // --- derived data -------------------------------------------------------------------------

  const productCode = (productId: string): string | undefined =>
    view.products().find((p) => p.id === productId)?.productCode;

  /** Live lines of a product, newest first (ties: larger request id first, like the api). */
  function liveDeliveries(code: string): CostDelivery[] {
    return deliveries
      .filter((d) => d.productCode === code && !d.removed)
      .map((d) => d.detail)
      .sort(
        (a, b) =>
          b.deliveredAt.localeCompare(a.deliveredAt) || b.deliveryRef.localeCompare(a.deliveryRef),
      );
  }

  function stockOf(code: string): string | null {
    const live = liveDeliveries(code);
    return live.length === 0 ? null : addQuantities(live.map((d) => d.availableQuantity));
  }

  const summaryOf = (d: CostDelivery): CostDeliverySummary => ({
    deliveredAt: d.deliveredAt,
    deliveryRef: d.deliveryRef,
    supplier: d.supplier,
    costUsd: d.costUsd,
    usdRateUsed: d.usdRateUsed,
    costUzs: d.costUzs,
  });

  const latestOf = (code: string): LatestDelivery | null => {
    const first = liveDeliveries(code)[0];
    return first
      ? {
          deliveredAt: first.deliveredAt,
          supplier: first.supplier,
          costUsd: first.costUsd,
          costUzs: first.costUzs,
        }
      : null;
  };

  /** The category follows the newest live line; a product without lines keeps its catalog value. */
  const categoryFor = (product: StaffProductDetailResponse): string | null =>
    categoryOf.get(product.productCode) ?? product.category;

  function matches(product: StaffProductDetailResponse, search: string | undefined): boolean {
    const needle = search?.trim().toLowerCase();
    if (!needle) return true;
    return (
      product.productCode.toLowerCase().includes(needle) ||
      product.translations.some((t) => t.name.toLowerCase().includes(needle))
    );
  }

  function categoryCounts(
    products: readonly StaffProductDetailResponse[],
  ): Pick<UnpricedProductsResponse, 'categories' | 'uncategorizedCount'> {
    const counts = new Map<string, number>();
    let uncategorizedCount = 0;
    for (const product of products) {
      const category = categoryFor(product);
      if (category === null) uncategorizedCount += 1;
      else counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    // Code unit order, not locale order, like the api.
    const categories: CategoryCount[] = [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, count]) => ({ category, count }));
    return { categories, uncategorizedCount };
  }

  const names = (product: StaffProductDetailResponse) =>
    product.translations.map(({ lang, name }) => ({ lang, name }));

  function parseQuery<T>(
    schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
    raw: unknown,
  ): T {
    const result = schema.safeParse(raw);
    if (!result.success || result.data === undefined) {
      throw new ApiValidationError('Request validation failed', 'VALIDATION_FAILED', [
        { path: 'query', message: 'Invalid query' },
      ]);
    }
    return result.data;
  }

  // A demo stand-in for the api's brand rule (staff choice, else the brand finder): the first
  // known brand word in any name of the product.
  const DEMO_BRANDS = ['Xiaomi', 'Samsung', 'Huawei', 'Apple', 'Baseus', 'Ugreen', 'JBL'];
  const brandOf = (product: StaffProductDetailResponse): string | null =>
    DEMO_BRANDS.find((brand) =>
      product.translations.some((t) =>
        t.name
          .toLowerCase()
          .split(/[\s,()/-]+/)
          .includes(brand.toLowerCase()),
      ),
    ) ?? null;

  // Distinct suppliers of the live lines, sorted like the api (code unit order).
  const suppliersOf = (code: string): string[] =>
    [...new Set(liveDeliveries(code).map((d) => d.supplier))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

  // --- cost api -------------------------------------------------------------------------------

  const costApi: CostApi = {
    async getPriceListCosts(): Promise<PriceListCostsResponse> {
      const state = await readAs();
      const priced = view.publishedProductIds();
      if (state === 'empty' || priced.size === 0) {
        throw new ApiNotFoundError('No price list has been published yet', 'NOT_FOUND');
      }
      const items: PriceListCostItem[] = view
        .products()
        .filter((p) => priced.has(p.id))
        .map((p) => {
          const live = liveDeliveries(p.productCode);
          const recent = live.slice(0, RECENT_DELIVERIES_LIMIT).map(summaryOf);
          return {
            productId: p.id,
            latest: recent[0] ?? null,
            recent,
            stockQuantity: stockOf(p.productCode),
            suppliers: suppliersOf(p.productCode),
          };
        });
      return { versionNumber: 14, items };
    },

    async getProductCostReference(productId): Promise<ProductCostReferenceResponse> {
      await readAs();
      const code = productCode(productId);
      if (code === undefined) throw new ApiNotFoundError('Product not found', 'NOT_FOUND');
      const product = view.products().find((p) => p.id === productId);
      const category = (product && categoryFor(product)) ?? '';
      const live = liveDeliveries(code).map((d) => ({ ...d, category }));
      return { productId, productCode: code, latest: live[0] ?? null, deliveries: live };
    },

    async getUsdRate() {
      await readAs();
      return rate;
    },

    async setUsdRate(request: UpdateUsdRateRequest) {
      await delay();
      requireEditor();
      const body = parseQuery(updateUsdRateRequestSchema, request);
      const stamp = now().toISOString();
      const [integer = '0', fraction = ''] = body.rate.split('.');
      rate = {
        rate: `${integer}.${fraction.padEnd(4, '0')}`,
        updatedAt: stamp,
        updatedBy: actorName(),
        updatedByUserId: personId(`person:${actorName()}`),
        source: 'MANUAL',
        rateDate: null,
        followsCentralBank: false,
        manualRate: `${integer}.${fraction.padEnd(4, '0')}`,
        manualExpiresAt: new Date(now().getTime() + 24 * 60 * 60_000).toISOString(),
        lastRefreshFailedAt: rate.lastRefreshFailedAt,
        lastChannelFailedAt: rate.lastChannelFailedAt,
      };
      return rate;
    },

    async followCentralBank() {
      await delay();
      requireEditor();
      const stamp = now().toISOString();
      rate = centralBankDown
        ? {
            ...rate,
            followsCentralBank: true,
            manualRate: null,
            manualExpiresAt: null,
            lastRefreshFailedAt: stamp,
          }
        : {
            rate: FAKE_START_RATE,
            updatedAt: stamp,
            updatedBy: null,
            updatedByUserId: null,
            source: 'CBU',
            rateDate: stamp.slice(0, 10),
            followsCentralBank: true,
            manualRate: null,
            manualExpiresAt: null,
            lastRefreshFailedAt: null,
            lastChannelFailedAt: null,
          };
      return rate;
    },
  };

  // --- stock api ------------------------------------------------------------------------------

  const stockApi: StockApi = {
    async listUnpriced(query = {}): Promise<UnpricedProductsResponse> {
      const state = await readAs();
      const parsed = parseQuery(unpricedProductsQuerySchema, query);
      if (state === 'empty') return EMPTY_PAGE;
      const priced = view.publishedProductIds();
      const unpriced = view
        .products()
        .filter((p) => !priced.has(p.id) && matches(p, parsed.search));
      const items: UnpricedProduct[] = unpriced
        .filter((p) => parsed.category === undefined || categoryFor(p) === parsed.category)
        .sort((a, b) => a.productCode.localeCompare(b.productCode))
        .map((p) => ({
          productId: p.id,
          productCode: p.productCode,
          names: names(p),
          unit: p.unit,
          isActive: p.isActive,
          category: categoryFor(p),
          stockQuantity: stockOf(p.productCode),
          latestDelivery: latestOf(p.productCode),
          // The staff app has no drafts any more; the contract field stays for the api.
          hasDraftPrice: false,
          ...view.primaryImage(p.productCode),
        }));
      return { items, ...categoryCounts(unpriced), nextCursor: null, total: items.length };
    },

    async listStock(query = {}): Promise<StockOverviewResponse> {
      const state = await readAs();
      // The api receives `inStock` as the strings 'true' / 'false'.
      const parsed = parseQuery(stockOverviewQuerySchema, {
        ...query,
        ...(query.inStock === undefined ? {} : { inStock: String(query.inStock) }),
      });
      if (state === 'empty') return EMPTY_PAGE;
      const priced = view.publishedProductIds();
      const candidates = view
        .products()
        .filter((p) => stockOf(p.productCode) !== null || liveDeliveries(p.productCode).length > 0)
        .filter((p) => matches(p, parsed.search))
        .filter(
          (p) =>
            parsed.inStock === undefined ||
            isPositiveQuantity(stockOf(p.productCode)) === parsed.inStock,
        );
      const items: StockOverviewItem[] = candidates
        .filter((p) => parsed.category === undefined || categoryFor(p) === parsed.category)
        .sort((a, b) => a.productCode.localeCompare(b.productCode))
        .map((p) => ({
          productId: p.id,
          productCode: p.productCode,
          names: names(p),
          unit: p.unit,
          isActive: p.isActive,
          category: categoryFor(p),
          stockQuantity: stockOf(p.productCode),
          // The orders fake keeps its own holds: nothing is held on this demo page.
          heldQuantity: '0.000',
          availableQuantity: stockOf(p.productCode),
          isPriced: priced.has(p.id),
          latestDelivery: latestOf(p.productCode),
          deliveryCount: liveDeliveries(p.productCode).length,
          suppliers: suppliersOf(p.productCode),
          brand: brandOf(p),
          ...view.primaryImage(p.productCode),
        }));
      return { items, ...categoryCounts(candidates), nextCursor: null, total: items.length };
    },

    // A CSV stand-in with the real file's columns (the api builds the .xlsx); demo data only.
    async downloadMegaReport() {
      await readAs();
      const cell = (value: string): string => `"${value.replace(/"/g, '""')}"`;
      const rows = view
        .products()
        .map((p) => ({ p, live: liveDeliveries(p.productCode).reverse() }))
        .filter(({ live }) => live.length > 0)
        .sort((a, b) => a.p.productCode.localeCompare(b.p.productCode, 'ru', { numeric: true }));
      const bands = Math.max(1, ...rows.map((r) => r.live.length));
      const header = ['ID товара', 'Наименование товара'];
      for (let n = 1; n <= bands; n += 1) {
        header.push(`Поставка ${n}: ID заявки`, 'Доступное кол-во', 'Цена закупа $');
      }
      const lines = [
        header.map(cell).join(','),
        ...rows.map(({ p, live }) =>
          [
            p.productCode,
            names(p)[0]?.name ?? '',
            ...live.flatMap((d) => [d.deliveryRef, d.availableQuantity, d.costUsd ?? 'нет цены']),
          ]
            .map(cell)
            .join(','),
        ),
      ];
      return {
        blob: new Blob([`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`], {
          type: 'text/csv;charset=utf-8',
        }),
        fileName: 'Mega_report-demo.csv',
      };
    },

    async listSyncRuns(limit = 20) {
      const state = await readAs();
      return {
        items: state === 'empty' ? [] : [...requestedRuns, ...FAKE_SYNC_RUNS].slice(0, limit),
      };
    },

    async getLastSyncRun(): Promise<SheetSyncRun | null> {
      const state = await readAs();
      return state === 'empty' ? null : (requestedRuns[0] ?? FAKE_SYNC_RUNS[0] ?? null);
    },

    // "Sync now": like the api, answers at once and the run shows up a little later (the worker
    // would do it). A second request while one is pending is ALREADY_QUEUED (exclusive queue).
    async requestSyncRun() {
      await delay();
      if (!canRunSheetSync(roles())) throw new PermissionDeniedError();
      if (syncPending) return { outcome: 'ALREADY_QUEUED' as const };
      syncPending = true;
      const startedAt = now();
      setTimeout(() => {
        const base = FAKE_SYNC_RUNS[0];
        if (base) {
          requestedRuns.unshift({
            ...base,
            id: fakeUuid(0x5c, requestedRuns.length + 1),
            startedAt: startedAt.toISOString(),
            finishedAt: now().toISOString(),
            trigger: 'MANUAL',
            status: 'OK',
            errorCode: null,
          });
        }
        syncPending = false;
      }, FAKE_SYNC_DURATION_MS);
      return { outcome: 'QUEUED' as const };
    },

    async listSupplyRemovals(): Promise<SupplyRemovalListResponse> {
      const state = await readAs();
      // Oldest detection first, like the api.
      const items =
        state === 'empty'
          ? []
          : removals
              .filter((r) => r.status === 'PENDING')
              .sort((a, b) => a.request.detectedAt.localeCompare(b.request.detectedAt));
      return { total: items.length, items: items.map((r) => r.request) };
    },

    async listSupplies(query = {}) {
      const state = await beforeRead();
      if (!roles().includes('MANAGER')) throw new PermissionDeniedError();
      if (state === 'empty') return { items: [], total: 0 };
      const search = query.search?.trim().toLowerCase() ?? '';
      const refs = [
        ...new Set(deliveries.filter((d) => !d.removed).map((d) => d.detail.deliveryRef)),
      ].filter((ref) => ref.toLowerCase().includes(search));
      const rows = refs.map((ref) => supplyOf(ref));
      rows.sort(
        (a, b) =>
          b.deliveredAt.localeCompare(a.deliveredAt) || a.deliveryRef.localeCompare(b.deliveryRef),
      );
      return { items: rows.slice(0, SUPPLY_SEARCH_LIMIT), total: rows.length };
    },

    async setSupplyParty(rawRequest) {
      await delay();
      if (!roles().includes('MANAGER')) throw new PermissionDeniedError();
      const request = setSupplyPartyRequestSchema.parse(rawRequest);
      return decideParty(request);
    },

    async confirmSupplyRemoval(requestId) {
      return decide(requestId, 'CONFIRMED');
    },

    async dismissSupplyRemoval(requestId) {
      return decide(requestId, 'DISMISSED');
    },
  };

  function supplyOf(deliveryRef: string): SupplySummary {
    const lines = deliveries.filter((d) => d.detail.deliveryRef === deliveryRef && !d.removed);
    const products = lines
      .map((d) => view.products().find((p) => p.productCode === d.productCode))
      .flatMap((p) => (p === undefined ? [] : [p]))
      .sort((a, b) => a.productCode.localeCompare(b.productCode));
    return {
      deliveryRef,
      productCount: lines.length,
      products: products
        .slice(0, SUPPLY_PRODUCT_NAMES_SHOWN)
        .map((p) => ({ productCode: p.productCode, names: names(p) })),
      totalQuantity: addQuantities(lines.map((d) => d.detail.deliveredQuantity)),
      deliveredAt: lines
        .map((d) => d.detail.deliveredAt)
        .sort()
        .at(-1) as string,
      partyNumber: parties.get(deliveryRef) ?? null,
    };
  }

  /** As SupplyPartyService.setParty: the same refusals in the same order. */
  function decideParty(
    request: ReturnType<typeof setSupplyPartyRequestSchema.parse>,
  ): SetSupplyPartyResponse {
    const { deliveryRefs, partyNumber } = request;
    const live = new Set(deliveries.filter((d) => !d.removed).map((d) => d.detail.deliveryRef));
    const gone = deliveryRefs.filter((ref) => !live.has(ref));
    const refuse = (message: string, details: unknown, reason: ConflictReason): ApiConflictError =>
      new ApiConflictError(message, 'CONFLICT', details, reason);
    if (gone.length > 0) {
      throw refuse(
        'A chosen supply no longer exists',
        { deliveryRefs: gone },
        'SUPPLY_NOT_AVAILABLE',
      );
    }
    const members = [...parties]
      .filter(([ref, party]) => party === partyNumber && !deliveryRefs.includes(ref))
      .map(([ref]) => ref)
      .sort();
    const seenMembers = request.seenPartyMembers;
    const changedUnderfoot =
      request.seenParties.some(
        (seen) => (parties.get(seen.deliveryRef) ?? null) !== seen.partyNumber,
      ) ||
      (seenMembers !== undefined &&
        (seenMembers.length !== members.length || seenMembers.some((m) => !members.includes(m))));
    if (changedUnderfoot) {
      throw refuse(
        'Another manager changed this',
        {
          parties: deliveryRefs.map((deliveryRef) => ({
            deliveryRef,
            partyNumber: parties.get(deliveryRef) ?? null,
          })),
          partyMembers: members,
        },
        'SUPPLY_PARTY_CHANGED',
      );
    }
    const alreadySet = deliveryRefs.filter((ref) => parties.get(ref) === partyNumber);
    const toSet = deliveryRefs.filter((ref) => parties.get(ref) !== partyNumber);
    const replacing = request.onPartyConflict === 'REPLACE_MEMBERS';
    if (toSet.length === 0 && !(replacing && members.length > 0)) {
      return {
        outcome: 'NOTHING_TO_DO',
        partyNumber,
        changed: [],
        alreadySet,
        removedFromParty: [],
      };
    }
    const supplyConflicts = toSet.flatMap((deliveryRef) => {
      const party = parties.get(deliveryRef);
      return party === undefined ? [] : [{ deliveryRef, partyNumber: party }];
    });
    if (
      (supplyConflicts.length > 0 && request.onSupplyConflict !== 'REPLACE') ||
      (members.length > 0 && request.onPartyConflict === undefined)
    ) {
      throw refuse(
        'The manager has to decide first',
        { supplyConflicts, partyMembers: members },
        'SUPPLY_PARTY_CONFLICT',
      );
    }
    const changed = toSet.map((deliveryRef) => {
      const from = parties.get(deliveryRef) ?? null;
      parties.set(deliveryRef, partyNumber);
      return { deliveryRef, from, to: partyNumber };
    });
    const removedFromParty = replacing ? members : [];
    for (const ref of removedFromParty) parties.delete(ref);
    return { outcome: 'CHANGED', partyNumber, changed, alreadySet, removedFromParty };
  }

  async function decide(
    requestId: string,
    status: 'CONFIRMED' | 'DISMISSED',
  ): Promise<SupplyRemovalDecisionResponse> {
    await delay();
    requireEditor();
    const record = removals.find((r) => r.request.id === requestId);
    if (!record) throw new ApiNotFoundError('Removal request not found', 'NOT_FOUND');
    if (record.status !== 'PENDING') {
      throw new ApiConflictError(
        'This removal request was already decided',
        'CONFLICT',
        undefined,
        'REMOVAL_REQUEST_NOT_PENDING',
      );
    }
    record.status = status;
    if (status === 'CONFIRMED') {
      const line = deliveries.find(
        (d) =>
          d.productCode === record.request.productCode &&
          d.detail.deliveryRef === record.request.deliveryRef,
      );
      // Soft removal: the line stays stored but stops counting for stock and cost history.
      if (line) line.removed = true;
    }
    return { id: requestId, status, decidedAt: now().toISOString(), decidedBy: actorName() };
  }

  return {
    costApi,
    stockApi,
    controls: {
      setCentralBankDown: (down) => {
        centralBankDown = down;
      },
    },
    view: {
      stockQuantity: stockOf,
      latestCostUsd: (code) => latestOf(code)?.costUsd ?? null,
    },
  };
}
