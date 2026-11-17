import {
  LOCALES,
  PIECE_UNIT,
  PRODUCT_NAME_LANG,
  commonProductName,
  createProductRequestSchema,
  formatGeneratedProductCode,
  productCodeKey,
  publishChangesRequestSchema,
  updateProductRequestSchema,
  type ConflictReason,
  type PriceHistoryEntry,
  type PriceHistoryResponse,
  type PriceListSource,
  type PriceListStatus,
  type PublishChangesRequest,
} from '@iorder/shared';
import {
  PRICE_IMPORT_MAX_BYTES,
  createManualProductRequestSchema,
  createProductCategoriesRequestSchema,
  createProductCategoryRequestSchema,
  manualProductCheckQuerySchema,
  mergePreviewQuerySchema,
  mergeProductRequestSchema,
  priceImportConfirmRequestSchema,
  priceImportTemplateQuerySchema,
  suggestCategoryCodeRule,
  updateProductCategoryRequestSchema,
  updateProductTrackingRequestSchema,
  type BrandResponse,
  type CreateProductCategoryRequest,
  type MergePreviewResponse,
  type PriceImportFileError,
  type PriceImportPreviewRow,
  type PriceImportRowIssue,
  type PriceImportRowRequest,
  type ProductCategoryResponse,
  type SimilarProduct,
  type PublishChangesWithRateResponse,
  type StaffPriceListWithRateResponse,
  type StaffProductDetailListResponse,
  type StaffProductDetailResponse,
  type StaffVersionListWithRateResponse,
  type StaffVersionWithRateResponse,
} from '@iorder/shared/staff-cost';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
  type FieldIssue,
} from '@core/lib/api-errors';
import type { CatalogApi } from '@/features/catalog/api/catalog-api';
import { roundUzsForDisplay, usdToUzs } from '@/features/staff-cost/domain/decimal';
import { sameMoney } from '../domain/price-input';
import {
  FAKE_CODE_RULES,
  FAKE_CURRENT_ACTOR,
  FAKE_PRICE_BACKEND_MARKER,
  FAKE_PRODUCT_CATEGORY_SEEDS,
  FAKE_PRODUCT_SEEDS,
  FAKE_PUBLISHED_AUTHOR,
  FAKE_USD_RATE,
  FAKE_VERSION_NUMBERS,
  seedUsd,
} from './fake-price-fixtures';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import type { PricingApi } from './pricing-api';

/** Dev switcher states, like the demo pages: what the READ calls answer. */
export type { FakeScenario };

export interface FakePriceBackendOptions {
  readonly latencyMs?: number;
  readonly now?: () => Date;
  /** Read at call time, so a page can switch scenarios without recreating the backend. */
  readonly scenario?: () => FakeScenario;
  /** The primary photo of a product code (the photo fake); none when left out. */
  readonly primaryImage?: (productCode: string) => PrimaryImageUrls;
  /**
   * The brands the manual product calls check against (the brands fake); read at call time. Left
   * out: no brand catalog, so every brand id is accepted and every brand name of an import is
   * unknown.
   */
  readonly brands?: () => readonly BrandResponse[];
  /**
   * Stock and latest cost of a sheet product (the cost fake), for the merge preview; read at call
   * time. Left out: unknown stock, no cost.
   */
  readonly stock?: (productCode: string) => TargetStock;
  /** Live photos of a product code (the photo fake), for the merge preview. Left out: none. */
  readonly imageCount?: (productCode: string) => number;
}

/** The primary photo fields of the staff list rows (null without a primary photo). */
export interface PrimaryImageUrls {
  readonly imageUrl: string | null;
  readonly imageLargeUrl: string | null;
}

/** What the merge preview says about the sheet product: pieces (3 fraction digits) and USD cost. */
export interface TargetStock {
  readonly stockQuantity: string | null;
  readonly costUsd: string | null;
}

const NO_IMAGE: PrimaryImageUrls = { imageUrl: null, imageLargeUrl: null };
const NO_STOCK: TargetStock = { stockQuantity: null, costUsd: null };

/** What the cost and stock fakes need to know about the catalog and the price lists. */
export interface FakePriceBackendView {
  products: () => readonly StaffProductDetailResponse[];
  /** Products priced in the current published list. */
  publishedProductIds: () => ReadonlySet<string>;
  /** The CURRENT per-unit code rule of a product code (the orders fake picks with it). */
  productRule: (
    productCode: string,
  ) => Pick<StaffProductDetailResponse, 'trackingType' | 'markingRequired'>;
  /** The primary photo URLs of a product code, as the staff list rows carry them. */
  primaryImage: (productCode: string) => PrimaryImageUrls;
  /** False for a staff-added product (generated code): no stock, outside the allocation plan. */
  stockTracked: (productCode: string) => boolean;
}

type CategoryRecord = Omit<ProductCategoryResponse, 'productCount'>;

interface VersionRecord {
  id: string;
  number: number;
  status: PriceListStatus;
  note: string | null;
  source: PriceListSource;
  createdAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
  publishedByUserId: string | null;
  /** productId -> price with two fraction digits. */
  prices: Map<string, string>;
  /** productId -> deferred-payment ("Отсрочка") price; absent = none. */
  deferredPrices: Map<string, string>;
  /** productId -> recommended retail price (RRP); absent = none. */
  rrps: Map<string, string>;
  /** productId -> «Оптовик/Партнер» sale / deferred price [C, owner 2026-11-11]; absent = none. */
  wholesalePrices: Map<string, string>;
  wholesaleDeferredPrices: Map<string, string>;
  /** productId -> «Alif factoring» sale / deferred price [C, owner 2026-11-12]; absent = none. */
  alifPrices: Map<string, string>;
  alifDeferredPrices: Map<string, string>;
}

/** A demo wholesale price: 92 % of the standard one, in whole cents (bigint, never a float). */
function demoWholesale(usd: string, percent: bigint): string {
  const [whole = '0', fraction = ''] = usd.split('.');
  const cents =
    (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0')) * percent;
  const rounded = (cents + 50n) / 100n;
  return `${rounded / 100n}.${(rounded % 100n).toString().padStart(2, '0')}`;
}

/** USD x the fake rate, whole so'm half up, like the api. */
function fakeUzs(usd: string): string {
  return `${roundUzsForDisplay(usdToUzs(usd, FAKE_USD_RATE))}.00`;
}

function optionalUzs(usd: string | null): string | null {
  return usd === null ? null : fakeUzs(usd);
}

/** `1690000` and `1690000.5` both become two-fraction-digit strings, like the api stores them. */
function twoDigits(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  return `${integer}.${fraction.padEnd(2, '0')}`;
}

/** The canned import preview raises a price by one dollar: string arithmetic, never a float. */
function plusOneDollar(price: string): string {
  const [integer = '0', fraction = '00'] = twoDigits(price).split('.');
  return `${BigInt(integer) + 1n}.${fraction}`;
}

// The fake "Excel" files are CSV (no .xlsx without a new dependency); a byte order mark keeps
// Excel reading the UTF-8 names right.
const UTF8_BOM = String.fromCharCode(0xfeff);
const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

// Valid v4-shaped ids so the shared `z.uuid()` response schemas accept them.
function fakeId(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

// Categories count on their own (variant 9), so the product and version ids stay as they were.
function categoryId(counter: number): string {
  return `00000000-0000-4000-9000-${counter.toString(16).padStart(12, '0')}`;
}

function toIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Parses a request with the shared schema, as the api's ZodValidationPipe does, so a fake 422 has
 * the same `details` shape (path + message) as a real one.
 */
function validated<T>(
  schema: {
    safeParse: (data: unknown) =>
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
        };
  },
  data: unknown,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiValidationError(
      'Request validation failed',
      'VALIDATION_FAILED',
      toIssues(result.error.issues),
    );
  }
  return result.data;
}

/**
 * In-memory stand-in for the pricing and catalog endpoints. It follows the real service's rules
 * (apps/api pricing.service.ts): no drafts, one PUBLISHED version, published versions are
 * immutable, every save publishes a new version atomically, inactive products cannot be priced,
 * the list cannot be left empty, price history derived from the published versions.
 */
export function createFakePriceBackend(options: FakePriceBackendOptions = {}): {
  pricingApi: PricingApi;
  catalogApi: CatalogApi;
  view: FakePriceBackendView;
} {
  const latencyMs = options.latencyMs ?? 0;
  const now = options.now ?? (() => new Date());
  const scenario = options.scenario ?? (() => 'ready');
  const primaryImage = (productCode: string): PrimaryImageUrls => {
    const urls = options.primaryImage?.(productCode) ?? NO_IMAGE;
    return { imageUrl: urls.imageUrl, imageLargeUrl: urls.imageLargeUrl };
  };
  let counter = 0;

  const products = new Map<string, StaffProductDetailResponse>();
  const productIdBySeed = new Map<string, string>();
  const versions: VersionRecord[] = [];
  const categories = new Map<string, CategoryRecord>();
  let categoryCounter = 0;
  // Staff-added products [C, 2026-11-09]: the sequence behind IO-000001, IO-000002, ... and the
  // brand staff chose per product (the product DTO does not carry it).
  let generatedSequence = 0;
  const brandOfProduct = new Map<string, string>();

  function seed(): void {
    const created = '2026-10-01T09:00:00.000Z';
    for (const category of FAKE_PRODUCT_CATEGORY_SEEDS) {
      const id = categoryId(++categoryCounter);
      categories.set(id, {
        id,
        name: category.name,
        trackingTypeDefault: category.trackingTypeDefault,
        markingRequiredDefault: category.markingRequiredDefault,
        isActive: category.archived !== true,
        createdAt: created,
        updatedAt: created,
      });
    }
    for (const item of FAKE_PRODUCT_SEEDS) {
      const id = fakeId(++counter);
      productIdBySeed.set(item.productCode, id);
      const rule = FAKE_CODE_RULES[item.productCode];
      const linked = item.category === null ? undefined : findCategoryByName(item.category);
      const names = LOCALES.map((lang) => ({ lang, name: item.names[lang], description: null }));
      products.set(id, {
        id,
        productCode: item.productCode,
        name: commonProductName(names, item.productCode),
        unit: PIECE_UNIT,
        category: item.category,
        categoryId: linked?.isActive ? linked.id : null,
        trackingType: rule?.trackingType ?? 'NONE',
        markingRequired: rule?.markingRequired ?? false,
        codeRuleConfigured: rule !== undefined || linked?.isActive === true,
        isActive: item.isActive,
        codeGenerated: false,
        mergedIntoProductId: null,
        translations: names,
        createdAt: created,
        updatedAt: created,
      });
    }
    const dates: Record<number, string> = {
      [FAKE_VERSION_NUMBERS.first]: '2026-10-05T03:30:00.000Z',
      [FAKE_VERSION_NUMBERS.second]: '2026-10-12T03:30:00.000Z',
      [FAKE_VERSION_NUMBERS.published]: '2026-10-19T03:30:00.000Z',
    };
    for (const number of Object.values(FAKE_VERSION_NUMBERS)) {
      const prices = new Map<string, string>();
      const wholesalePrices = new Map<string, string>();
      const wholesaleDeferredPrices = new Map<string, string>();
      const alifPrices = new Map<string, string>();
      const alifDeferredPrices = new Map<string, string>();
      FAKE_PRODUCT_SEEDS.forEach((item, index) => {
        const price = item.prices[number];
        const id = productIdBySeed.get(item.productCode);
        if (price === undefined || id === undefined) return;
        const usd = seedUsd(price);
        prices.set(id, usd);
        // Every other product of the published list has a wholesale price, some a deferred one
        // too; the rest show "as standard".
        if (number === FAKE_VERSION_NUMBERS.published && index % 2 === 0) {
          wholesalePrices.set(id, demoWholesale(usd, 92n));
          if (index % 4 === 0) wholesaleDeferredPrices.set(id, demoWholesale(usd, 97n));
        }
        // Every third product has an Alif price (the others are not offered to that tier).
        if (number === FAKE_VERSION_NUMBERS.published && index % 3 === 0) {
          alifPrices.set(id, demoWholesale(usd, 105n));
          alifDeferredPrices.set(id, demoWholesale(usd, 110n));
        }
      });
      versions.push({
        id: fakeId(++counter),
        number,
        status: number === FAKE_VERSION_NUMBERS.published ? 'PUBLISHED' : 'ARCHIVED',
        note: null,
        source: 'MANUAL',
        createdAt: dates[number] ?? created,
        publishedAt: dates[number] ?? created,
        publishedBy: FAKE_PUBLISHED_AUTHOR,
        publishedByUserId: fakeUuid(`person:${FAKE_PUBLISHED_AUTHOR}`),
        prices,
        deferredPrices: new Map(),
        rrps: new Map(),
        wholesalePrices,
        wholesaleDeferredPrices,
        alifPrices,
        alifDeferredPrices,
      });
    }
  }
  seed();

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  // Read calls honour the dev scenario; writes behave normally so the editor can be tried.
  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_PRICE_BACKEND_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  function findVersion(id: string): VersionRecord {
    const found = versions.find((v) => v.id === id);
    if (!found) throw new ApiNotFoundError('Price list version not found', 'NOT_FOUND');
    return found;
  }

  function published(): VersionRecord | undefined {
    return versions.find((v) => v.status === 'PUBLISHED');
  }

  function toVersion(record: VersionRecord): StaffVersionWithRateResponse {
    // Explicit allow-list, as the api's mappers do: never spread the stored record.
    return {
      id: record.id,
      number: record.number,
      status: record.status,
      note: record.note,
      source: record.source,
      createdAt: record.createdAt,
      publishedAt: record.publishedAt,
      publishedBy: record.publishedBy,
      publishedByUserId: record.publishedByUserId,
      // The real API fills this from the rate snapshot taken at publish; the fake has no rate.
      usdRateSnapshot: null,
    };
  }

  function toPriceList(record: VersionRecord): StaffPriceListWithRateResponse {
    const items = [...record.prices].flatMap(([productId, basePrice]) => {
      const product = products.get(productId);
      if (!product) return [];
      return [
        {
          productId,
          productCode: product.productCode,
          unit: product.unit,
          isActive: product.isActive,
          codeGenerated: product.codeGenerated,
          sheetMatch: product.codeGenerated ? sheetMatchOf(product) : null,
          names: product.translations.map(({ lang, name }) => ({ lang, name })),
          basePrice,
          deferredPrice: record.deferredPrices.get(productId) ?? null,
          rrp: record.rrps.get(productId) ?? null,
          wholesalePrice: record.wholesalePrices.get(productId) ?? null,
          wholesaleDeferredPrice: record.wholesaleDeferredPrices.get(productId) ?? null,
          alifPrice: record.alifPrices.get(productId) ?? null,
          alifDeferredPrice: record.alifDeferredPrices.get(productId) ?? null,
          currency: 'USD' as const,
          uzs: {
            basePrice: fakeUzs(basePrice),
            deferredPrice: optionalUzs(record.deferredPrices.get(productId) ?? null),
          },
          ...primaryImage(product.productCode),
        },
      ];
    });
    items.sort((a, b) => a.productCode.localeCompare(b.productCode));
    return { version: toVersion(record), items };
  }

  function requireProduct(id: string): StaffProductDetailResponse {
    const product = products.get(id);
    if (!product) throw new ApiNotFoundError('Product not found', 'NOT_FOUND');
    return product;
  }

  /** The api's "common name" comparison: letter case and spacing are ignored. */
  const commonNameKey = (name: string): string => name.toLocaleLowerCase().replace(/\s+/g, '');

  /** The active sheet product with the same common name as this product, if any (one is enough). */
  function sheetMatchOf(
    product: StaffProductDetailResponse,
  ): { productId: string; productCode: string; name: string } | null {
    const key = commonNameKey(product.name);
    const match = [...products.values()].find(
      (p) => p.isActive && !p.codeGenerated && commonNameKey(p.name) === key,
    );
    return match ? { productId: match.id, productCode: match.productCode, name: match.name } : null;
  }

  // --- product categories (templates of the per-unit code rule) ---------------------------

  function nameKey(name: string): string {
    return name.trim().toLocaleLowerCase();
  }

  /** Stores a new category and adopts the unlinked products of that sheet category whose rule was never set. */
  function addCategory(body: CreateProductCategoryRequest): CategoryRecord {
    const stamp = now().toISOString();
    const record: CategoryRecord = {
      id: categoryId(++categoryCounter),
      ...body,
      isActive: true,
      createdAt: stamp,
      updatedAt: stamp,
    };
    categories.set(record.id, record);
    for (const product of products.values()) {
      const adoptable =
        product.categoryId === null &&
        !product.codeRuleConfigured &&
        product.category !== null &&
        nameKey(product.category) === nameKey(body.name);
      if (adoptable) {
        setRule(product, {
          categoryId: record.id,
          trackingType: body.trackingTypeDefault,
          markingRequired: body.markingRequiredDefault,
        });
      }
    }
    return record;
  }

  function findCategoryByName(name: string): CategoryRecord | undefined {
    return [...categories.values()].find((c) => nameKey(c.name) === nameKey(name));
  }

  function requireCategory(id: string): CategoryRecord {
    const category = categories.get(id);
    if (!category) throw new ApiNotFoundError('Category not found', 'NOT_FOUND');
    return category;
  }

  function toCategory(record: CategoryRecord): ProductCategoryResponse {
    const productCount = [...products.values()].filter((p) => p.categoryId === record.id).length;
    return { ...record, productCount };
  }

  const duplicateCategory = (name: string): ApiConflictError =>
    new ApiConflictError(
      `A category named ${name} already exists`,
      'CONFLICT',
      undefined,
      'DUPLICATE_CATEGORY_NAME',
    );

  function setRule(
    product: StaffProductDetailResponse,
    rule: Pick<StaffProductDetailResponse, 'categoryId' | 'trackingType' | 'markingRequired'>,
  ): StaffProductDetailResponse {
    const updated = {
      ...product,
      ...rule,
      codeRuleConfigured: true,
      updatedAt: now().toISOString(),
    };
    products.set(product.id, updated);
    return updated;
  }

  const pricingApi: PricingApi = {
    async getCurrent() {
      const state = await beforeRead();
      const current = published();
      if (state === 'empty' || !current) {
        throw new ApiNotFoundError('No price list has been published yet', 'NOT_FOUND');
      }
      return toPriceList(current);
    },

    async listVersions(): Promise<StaffVersionListWithRateResponse> {
      const state = await beforeRead();
      if (state === 'empty') return { items: [] };
      const items = [...versions]
        .sort((a, b) => b.number - a.number)
        .map((v) => ({ ...toVersion(v), itemCount: v.prices.size }));
      return { items };
    },

    async getVersion(versionId) {
      await beforeRead();
      return toPriceList(findVersion(versionId));
    },

    async publishChanges(request) {
      await delay();
      return publishList(validated(publishChangesRequestSchema, request));
    },

    async getPriceHistory(productId): Promise<PriceHistoryResponse> {
      await beforeRead();
      const product = requireProduct(productId);
      const ordered = versions
        .filter((v) => v.publishedAt !== null && v.publishedBy !== null)
        .sort((a, b) => a.number - b.number);
      const entries: PriceHistoryEntry[] = [];
      const same = (a: string | null, b: string | null): boolean =>
        a === null || b === null ? a === b : sameMoney(a, b);
      let previous: string | null = null;
      let previousCash: string | null = null;
      let previousRrp: string | null = null;
      for (const version of ordered) {
        const current = version.prices.get(productId) ?? null;
        const currentCash = version.deferredPrices.get(productId) ?? null;
        const currentRrp = version.rrps.get(productId) ?? null;
        const unchanged =
          same(current, previous) &&
          same(currentCash, previousCash) &&
          same(currentRrp, previousRrp);
        if (!unchanged) {
          entries.push({
            versionId: version.id,
            versionNumber: version.number,
            publishedAt: version.publishedAt ?? '',
            publishedBy: version.publishedBy,
            publishedByUserId: version.publishedByUserId,
            source: version.source,
            oldPrice: previous,
            newPrice: current,
            oldDeferredPrice: previousCash,
            newDeferredPrice: currentCash,
            oldRrp: previousRrp,
            newRrp: currentRrp,
            oldCurrency: 'USD',
            currency: 'USD',
          });
        }
        previous = current;
        previousCash = currentCash;
        previousRrp = currentRrp;
      }
      return { productId, productCode: product.productCode, entries };
    },

    // --- staff-added products without a sheet «Товар_ID» [C, 2026-11-09] -------------------------

    async createManualProduct(request) {
      await delay();
      const body = validated(createManualProductRequestSchema, request);
      requireBaseVersion(body.baseVersionNumber);
      if (body.brandId !== null) requireBrand(body.brandId);
      const product = addGeneratedProduct(body.name, body.brandId, body.category);
      const version = publishList({
        baseVersionNumber: body.baseVersionNumber,
        upserts: [
          {
            productId: product.id,
            basePrice: body.basePrice,
            deferredPrice: body.deferredPrice,
            // The form has no RRP field: the price dialog or an import sets it later.
            rrp: null,
          },
        ],
        removedProductIds: [],
      });
      return { productId: product.id, productCode: product.productCode, version };
    },

    async checkManualProduct(name) {
      await beforeRead();
      const query = validated(manualProductCheckQuerySchema, { name });
      return { similar: similarProducts(query.name), brandFound: brandInName(query.name) };
    },

    async mergeProduct(productId, request) {
      await delay();
      const body = validated(mergeProductRequestSchema, request);
      const { source, target } = checkMergePair(productId, body.targetProductId);
      requireBaseVersion(body.baseVersionNumber);
      const current = published();
      const price = current?.prices.get(source.id);
      // Every check ran before the first write (one transaction on the api).
      const version =
        price === undefined
          ? null
          : publishList({
              baseVersionNumber: body.baseVersionNumber,
              upserts: [
                {
                  productId: target.id,
                  basePrice: price,
                  deferredPrice: current?.deferredPrices.get(source.id) ?? null,
                  rrp: current?.rrps.get(source.id) ?? null,
                },
              ],
              removedProductIds: [source.id],
            });
      const sourceBrand = brandOfProduct.get(source.id);
      if (sourceBrand !== undefined && !brandOfProduct.has(target.id)) {
        brandOfProduct.set(target.id, sourceBrand);
      }
      const stamp = now().toISOString();
      const targetTranslations = [...target.translations];
      for (const name of source.translations) {
        if (!targetTranslations.some((t) => t.lang === name.lang)) targetTranslations.push(name);
      }
      products.set(target.id, {
        ...target,
        translations: targetTranslations,
        name: commonProductName(targetTranslations, target.productCode),
        updatedAt: stamp,
      });
      products.set(source.id, {
        ...source,
        isActive: false,
        mergedIntoProductId: target.id,
        updatedAt: stamp,
      });
      return { sourceProductId: source.id, targetProductId: target.id, version };
    },

    async mergePreview(productId, targetProductId): Promise<MergePreviewResponse> {
      await beforeRead();
      const query = validated(mergePreviewQuerySchema, { targetProductId });
      const { source, target } = checkMergePair(productId, query.targetProductId);
      const current = published();
      const pricesOf = (product: StaffProductDetailResponse) => ({
        basePrice: current?.prices.get(product.id) ?? null,
        deferredPrice: current?.deferredPrices.get(product.id) ?? null,
      });
      const stock = options.stock?.(target.productCode) ?? NO_STOCK;
      return {
        source: {
          productId: source.id,
          productCode: source.productCode,
          name: source.name,
          brandName: brandName(brandOfProduct.get(source.id) ?? null),
          ...pricesOf(source),
          imageCount: options.imageCount?.(source.productCode) ?? 0,
          // The fake has no carts of its own.
          cartLineCount: 0,
        },
        target: {
          productId: target.id,
          productCode: target.productCode,
          name: target.name,
          brandName: brandName(brandOfProduct.get(target.id) ?? null),
          ...pricesOf(target),
          stockQuantity: stock.stockQuantity,
          costUsd: stock.costUsd,
        },
        // A merge republishes only when the source has a price to move (like the merge itself).
        nextVersionNumber: current?.prices.has(source.id) ? (current.number ?? 0) + 1 : null,
      };
    },

    async downloadImportTemplate(kind) {
      await delay();
      const query = validated(priceImportTemplateQuerySchema, { kind });
      // A CSV, like the fake price list file: the fake cannot build a real .xlsx without a new
      // dependency, and its file name says so.
      const generated =
        query.kind === 'empty'
          ? []
          : [...products.values()].filter((p) => p.codeGenerated && p.isActive);
      const current = published();
      const lines = [
        [
          'Tovar ID',
          'Nomi',
          'Brend',
          'Kategoriya',
          'Цена $',
          'Отсрочка $',
          'RRP $',
          'Оптовик/Партнер $',
          'Оптовик/Партнер Отсрочка $',
        ]
          .map(csvCell)
          .join(','),
        ...generated.map((p) =>
          [
            p.productCode,
            p.name,
            brandName(brandOfProduct.get(p.id) ?? null) ?? '',
            p.category ?? '',
            current?.prices.get(p.id) ?? '',
            current?.deferredPrices.get(p.id) ?? '',
            current?.rrps.get(p.id) ?? '',
            current?.wholesalePrices.get(p.id) ?? '',
            current?.wholesaleDeferredPrices.get(p.id) ?? '',
            current?.alifPrices.get(p.id) ?? '',
            current?.alifDeferredPrices.get(p.id) ?? '',
          ]
            .map(csvCell)
            .join(','),
        ),
      ];
      return {
        blob: new Blob([`${UTF8_BOM}${lines.join('\r\n')}\r\n`], {
          type: 'text/csv;charset=utf-8',
        }),
        fileName:
          query.kind === 'empty'
            ? 'iorder-narx-import-shablon-bosh-demo.csv'
            : 'iorder-narx-import-shablon-demo.csv',
      };
    },

    async importPreview(file) {
      await delay();
      // The fake reads nothing from the file: it only refuses what the api refuses up front and
      // answers a canned preview built from the current catalog, so every row kind can be seen.
      if (!file.name.toLowerCase().endsWith('.xlsx')) throw fileRefused('FILE_NOT_XLSX');
      if (file.size > PRICE_IMPORT_MAX_BYTES) throw fileRefused('FILE_TOO_LARGE');
      if (file.size === 0) throw fileRefused('FILE_EMPTY');
      const rows = cannedPreviewRows();
      return {
        baseVersionNumber: published()?.number ?? null,
        rows,
        summary: {
          newCount: rows.filter((r) => r.status === 'NEW').length,
          priceChangedCount: rows.filter((r) => r.status === 'PRICE_CHANGED').length,
          unchangedCount: rows.filter((r) => r.status === 'UNCHANGED').length,
          errorCount: rows.filter((r) => r.status === 'ERROR').length,
        },
      };
    },

    async importConfirm(request) {
      await delay();
      const body = validated(priceImportConfirmRequestSchema, request);
      requireBaseVersion(body.baseVersionNumber);
      // Every row is checked before anything is written (nothing is created on a refusal).
      const invalid = body.rows.flatMap((row, index) => {
        const issues = confirmRowIssues(row);
        return issues.length === 0 ? [] : [{ index, issues }];
      });
      if (invalid.length > 0) {
        throw new ApiValidationError(
          'Some rows cannot be imported',
          'IMPORT_ROWS_INVALID',
          invalid.map(({ index, issues }) => ({
            path: `rows.${index}`,
            message: issues.join(', '),
          })),
          { rows: invalid },
        );
      }
      const current = published();
      let createdCount = 0;
      let updatedCount = 0;
      let unchangedCount = 0;
      const sameOptional = (a: string | null, b: string | null): boolean =>
        a === null || b === null ? a === b : sameMoney(a, b);
      const upserts = body.rows.map((row) => {
        let productId: string;
        if (row.productCode === null) {
          // Only a new product takes the row's category; an existing one keeps its own.
          productId = addGeneratedProduct(row.name, brandIdByName(row.brandName), row.category).id;
          createdCount += 1;
        } else {
          productId = requireProductByCode(row.productCode).id;
          const before = current?.prices.get(productId);
          const sameOptionals =
            sameOptional(row.deferredPrice, current?.deferredPrices.get(productId) ?? null) &&
            sameOptional(row.rrp, current?.rrps.get(productId) ?? null);
          if (before !== undefined && sameMoney(before, row.basePrice) && sameOptionals) {
            unchangedCount += 1;
          } else {
            updatedCount += 1;
          }
        }
        return {
          productId,
          basePrice: row.basePrice,
          deferredPrice: row.deferredPrice,
          rrp: row.rrp,
          // Sent only by a file with the «Оптовик/Партнер» columns; omitted keeps them.
          ...(row.wholesalePrice !== undefined ? { wholesalePrice: row.wholesalePrice } : {}),
          ...(row.wholesaleDeferredPrice !== undefined
            ? { wholesaleDeferredPrice: row.wholesaleDeferredPrice }
            : {}),
          ...(row.alifPrice !== undefined ? { alifPrice: row.alifPrice } : {}),
          ...(row.alifDeferredPrice !== undefined
            ? { alifDeferredPrice: row.alifDeferredPrice }
            : {}),
        };
      });
      const version = publishList({
        baseVersionNumber: body.baseVersionNumber,
        upserts,
        removedProductIds: [],
      });
      return { version, createdCount, updatedCount, unchangedCount };
    },
  };

  // --- publishing (the one place a new version is made) ------------------------------------

  function requireBaseVersion(baseVersionNumber: number | null): void {
    const current = published();
    if ((current?.number ?? null) !== baseVersionNumber) {
      throw new ApiConflictError(
        'The price list changed meanwhile',
        'CONFLICT',
        { currentVersionNumber: current?.number ?? null },
        'PRICE_LIST_CHANGED',
      );
    }
  }

  /** The published list + upserts - removals as the next PUBLISHED version (hard rule 5). */
  function publishList(body: PublishChangesRequest): PublishChangesWithRateResponse {
    const current = published();
    requireBaseVersion(body.baseVersionNumber);
    const missing = body.upserts.filter((i) => !products.has(i.productId)).map((i) => i.productId);
    if (missing.length > 0) {
      throw new ApiNotFoundError('Unknown product', 'NOT_FOUND', { productIds: missing });
    }
    const inactive = body.upserts
      .filter((i) => products.get(i.productId)?.isActive === false)
      .map((i) => i.productId);
    if (inactive.length > 0) {
      throw new ApiConflictError(
        'Inactive products cannot be priced',
        'CONFLICT',
        { productIds: inactive },
        'INACTIVE_PRODUCT',
      );
    }
    // The new list: the published one without its inactive products (counted), minus the
    // removals, plus the upserts. Every check ran before the first write (one transaction).
    const prices = new Map<string, string>();
    const deferredPrices = new Map<string, string>();
    const rrps = new Map<string, string>();
    const wholesalePrices = new Map<string, string>();
    const wholesaleDeferredPrices = new Map<string, string>();
    const alifPrices = new Map<string, string>();
    const alifDeferredPrices = new Map<string, string>();
    let skippedInactiveCount = 0;
    for (const [productId, price] of current?.prices ?? []) {
      if (products.get(productId)?.isActive === false) {
        skippedInactiveCount += 1;
        continue;
      }
      prices.set(productId, price);
      const cash = current?.deferredPrices.get(productId);
      if (cash !== undefined) deferredPrices.set(productId, cash);
      const rrp = current?.rrps.get(productId);
      if (rrp !== undefined) rrps.set(productId, rrp);
      const wholesale = current?.wholesalePrices.get(productId);
      if (wholesale !== undefined) wholesalePrices.set(productId, wholesale);
      const wholesaleDeferred = current?.wholesaleDeferredPrices.get(productId);
      if (wholesaleDeferred !== undefined)
        wholesaleDeferredPrices.set(productId, wholesaleDeferred);
      const alif = current?.alifPrices.get(productId);
      if (alif !== undefined) alifPrices.set(productId, alif);
      const alifDeferred = current?.alifDeferredPrices.get(productId);
      if (alifDeferred !== undefined) alifDeferredPrices.set(productId, alifDeferred);
    }
    for (const productId of body.removedProductIds) {
      prices.delete(productId);
      deferredPrices.delete(productId);
      rrps.delete(productId);
      wholesalePrices.delete(productId);
      wholesaleDeferredPrices.delete(productId);
      alifPrices.delete(productId);
      alifDeferredPrices.delete(productId);
    }
    // An upsert replaces the whole item, like the api: an optional price left out is removed.
    const setOptional = (map: Map<string, string>, id: string, value: string | null): void => {
      if (value === null) map.delete(id);
      else map.set(id, twoDigits(value));
    };
    for (const upsert of body.upserts) {
      const { productId, basePrice, deferredPrice, rrp } = upsert;
      prices.set(productId, twoDigits(basePrice));
      setOptional(deferredPrices, productId, deferredPrice);
      setOptional(rrps, productId, rrp);
      // The wholesale tier: omitted keeps what the list has, null removes [C, owner 2026-11-11].
      if (upsert.wholesalePrice !== undefined) {
        setOptional(wholesalePrices, productId, upsert.wholesalePrice);
      }
      if (upsert.wholesaleDeferredPrice !== undefined) {
        setOptional(wholesaleDeferredPrices, productId, upsert.wholesaleDeferredPrice);
      }
      // A deferred wholesale price never outlives the wholesale sale price.
      if (!wholesalePrices.has(productId)) wholesaleDeferredPrices.delete(productId);
      // The Alif factoring tier, the same way [C, owner 2026-11-12].
      if (upsert.alifPrice !== undefined) setOptional(alifPrices, productId, upsert.alifPrice);
      if (upsert.alifDeferredPrice !== undefined) {
        setOptional(alifDeferredPrices, productId, upsert.alifDeferredPrice);
      }
      if (!alifPrices.has(productId)) alifDeferredPrices.delete(productId);
    }
    if (prices.size === 0) {
      throw new ApiConflictError(
        'The price list cannot be left empty',
        'CONFLICT',
        undefined,
        'EMPTY_PRICE_LIST',
      );
    }
    if (current) current.status = 'ARCHIVED';
    const stamp = now().toISOString();
    const version: VersionRecord = {
      id: fakeId(++counter),
      number: Math.max(0, ...versions.map((v) => v.number)) + 1,
      status: 'PUBLISHED',
      note: null,
      source: 'MANUAL',
      createdAt: stamp,
      publishedAt: stamp,
      publishedBy: FAKE_CURRENT_ACTOR,
      publishedByUserId: fakeUuid(`person:${FAKE_CURRENT_ACTOR}`),
      prices,
      deferredPrices,
      rrps,
      wholesalePrices,
      wholesaleDeferredPrices,
      alifPrices,
      alifDeferredPrices,
    };
    versions.push(version);
    return { ...toVersion(version), skippedInactiveCount };
  }

  // --- staff-added products: helpers ---------------------------------------------------------

  function knownBrands(): readonly BrandResponse[] {
    return options.brands?.() ?? [];
  }

  function requireBrand(brandId: string): void {
    if (options.brands !== undefined && !knownBrands().some((b) => b.id === brandId)) {
      // The api's shape: a plain 404 whose details name the reason.
      throw new ApiNotFoundError('Unknown brand', 'NOT_FOUND', { reason: 'UNKNOWN_BRAND' });
    }
  }

  const brandName = (brandId: string | null): string | null =>
    knownBrands().find((b) => b.id === brandId)?.name ?? null;

  /** The brand named in an import row (letter case ignored, like the api's brand names). */
  const brandIdByName = (name: string | null): string | null =>
    name === null
      ? null
      : (knownBrands().find((b) => nameKey(b.name) === nameKey(name))?.id ?? null);

  function addGeneratedProduct(
    name: string,
    brandId: string | null,
    category: string | null = null,
  ): StaffProductDetailResponse {
    const stamp = now().toISOString();
    const product: StaffProductDetailResponse = {
      id: fakeId(++counter),
      productCode: formatGeneratedProductCode(++generatedSequence),
      name,
      unit: PIECE_UNIT,
      category,
      categoryId: null,
      trackingType: 'NONE',
      markingRequired: false,
      codeRuleConfigured: false,
      isActive: true,
      codeGenerated: true,
      mergedIntoProductId: null,
      translations: [{ lang: PRODUCT_NAME_LANG, name, description: null }],
      createdAt: stamp,
      updatedAt: stamp,
    };
    products.set(product.id, product);
    if (brandId !== null) brandOfProduct.set(product.id, brandId);
    return product;
  }

  const productByCode = (productCode: string): StaffProductDetailResponse | undefined =>
    [...products.values()].find(
      (p) => productCodeKey(p.productCode) === productCodeKey(productCode),
    );

  function requireProductByCode(productCode: string): StaffProductDetailResponse {
    const product = productByCode(productCode);
    if (!product) throw new ApiNotFoundError('Product not found', 'NOT_FOUND');
    return product;
  }

  const mergeRefused = (reason: ConflictReason): ApiConflictError =>
    new ApiConflictError(`Merge refused: ${reason}`, 'CONFLICT', undefined, reason);

  /** The checks a merge and its preview share (404 for unknown ids, then the 409 reasons). */
  function checkMergePair(
    sourceId: string,
    targetId: string,
  ): { source: StaffProductDetailResponse; target: StaffProductDetailResponse } {
    const source = requireProduct(sourceId);
    const target = requireProduct(targetId);
    if (!source.codeGenerated) throw mergeRefused('NOT_GENERATED_CODE');
    if (source.mergedIntoProductId !== null) throw mergeRefused('PRODUCT_ALREADY_MERGED');
    if (target.codeGenerated) throw mergeRefused('TARGET_IS_GENERATED');
    if (!target.isActive) {
      throw new ApiConflictError(
        'The target product is inactive',
        'CONFLICT',
        { productIds: [target.id] },
        'INACTIVE_PRODUCT',
      );
    }
    return { source, target };
  }

  /**
   * The name check of the form: the active product with the same common name first, then the
   * ones whose common name contains the typed one (or the reverse); at most five.
   */
  function similarProducts(name: string): SimilarProduct[] {
    const key = commonNameKey(name);
    const priced = published();
    const active = [...products.values()].filter((p) => p.isActive);
    const exact = active.filter((p) => commonNameKey(p.name) === key);
    const near = active.filter((p) => {
      const other = commonNameKey(p.name);
      return other !== key && key.length >= 3 && (other.includes(key) || key.includes(other));
    });
    return [...exact, ...near].slice(0, 5).map((p) => ({
      productId: p.id,
      productCode: p.productCode,
      name: p.name,
      codeGenerated: p.codeGenerated,
      priced: priced?.prices.has(p.id) ?? false,
    }));
  }

  /** The brand finder of the fake: a known brand name standing as a word in the product name. */
  function brandInName(name: string): BrandResponse | null {
    const words = name.toLocaleLowerCase().split(/[\s,()/-]+/);
    return knownBrands().find((brand) => words.includes(brand.name.toLocaleLowerCase())) ?? null;
  }

  const fileRefused = (reason: PriceImportFileError): ApiValidationError =>
    new ApiValidationError(`File refused: ${reason}`, 'PRICE_IMPORT_FILE_INVALID', [], { reason });

  /** The checks a confirm repeats on a row (the preview's verdict may be stale by then). */
  function confirmRowIssues(row: PriceImportRowRequest): PriceImportRowIssue[] {
    const issues: PriceImportRowIssue[] = [];
    if (row.brandName !== null && brandIdByName(row.brandName) === null)
      issues.push('UNKNOWN_BRAND');
    if (row.productCode !== null) {
      const product = productByCode(row.productCode);
      if (!product) issues.push('UNKNOWN_PRODUCT_CODE');
      else if (product.mergedIntoProductId !== null) issues.push('PRODUCT_MERGED');
      else if (!product.isActive) issues.push('PRODUCT_INACTIVE');
    }
    return issues;
  }

  /**
   * One row of every kind the import screen shows, over the current catalog: a price change, an
   * unchanged price, two new products (one with a name that exists already), and errors.
   */
  function cannedPreviewRows(): PriceImportPreviewRow[] {
    const current = published();
    const priced = [...products.values()]
      .filter((p) => p.isActive && !p.codeGenerated && current?.prices.has(p.id))
      .sort((a, b) => a.productCode.localeCompare(b.productCode));
    const [changed, unchanged] = priced;
    const brandOf = (product: StaffProductDetailResponse): string | null =>
      brandName(brandOfProduct.get(product.id) ?? null);
    const existing = (
      rowNumber: number,
      product: StaffProductDetailResponse | undefined,
      status: 'PRICE_CHANGED' | 'UNCHANGED',
    ): PriceImportPreviewRow[] => {
      if (!product) return [];
      const price = current?.prices.get(product.id) ?? '0.00';
      const deferred = current?.deferredPrices.get(product.id) ?? null;
      const rrp = current?.rrps.get(product.id) ?? null;
      const wholesale = current?.wholesalePrices.get(product.id) ?? null;
      const wholesaleDeferred = current?.wholesaleDeferredPrices.get(product.id) ?? null;
      const alif = current?.alifPrices.get(product.id) ?? null;
      const alifDeferred = current?.alifDeferredPrices.get(product.id) ?? null;
      return [
        {
          rowNumber,
          productCode: product.productCode,
          productId: product.id,
          codeGenerated: product.codeGenerated,
          name: product.name,
          brandName: brandOf(product),
          // An existing product keeps its category: the preview shows none for it, like the api.
          category: null,
          basePrice: status === 'PRICE_CHANGED' ? plusOneDollar(price) : price,
          deferredPrice: deferred,
          // The changed row also gets a new RRP, so the screen shows a "was -> becomes" RRP.
          rrp: status === 'PRICE_CHANGED' ? plusOneDollar(plusOneDollar(price)) : rrp,
          currentBasePrice: price,
          currentDeferredPrice: deferred,
          currentRrp: rrp,
          // The canned file has the «Оптовик/Партнер» columns: the changed row gets a new one.
          wholesalePrice: status === 'PRICE_CHANGED' ? price : wholesale,
          wholesaleDeferredPrice: wholesaleDeferred,
          wholesaleGiven: true,
          currentWholesalePrice: wholesale,
          currentWholesaleDeferredPrice: wholesaleDeferred,
          // The canned file has no Alif columns: the import keeps those prices.
          alifPrice: alif,
          alifDeferredPrice: alifDeferred,
          alifGiven: false,
          currentAlifPrice: alif,
          currentAlifDeferredPrice: alifDeferred,
          status,
          issues: [],
          warnings: [],
        },
      ];
    };
    const fresh = (
      rowNumber: number,
      name: string,
      brand: string | null,
      basePrice: string | null,
      verdict: Pick<PriceImportPreviewRow, 'status' | 'issues' | 'warnings'>,
      extra: Partial<Pick<PriceImportPreviewRow, 'category' | 'rrp'>> = {},
    ): PriceImportPreviewRow => ({
      rowNumber,
      productCode: null,
      productId: null,
      codeGenerated: null,
      name,
      brandName: brand,
      category: null,
      basePrice,
      deferredPrice: null,
      rrp: null,
      currentBasePrice: null,
      currentDeferredPrice: null,
      currentRrp: null,
      wholesalePrice: null,
      wholesaleDeferredPrice: null,
      wholesaleGiven: true,
      currentWholesalePrice: null,
      currentWholesaleDeferredPrice: null,
      alifPrice: null,
      alifDeferredPrice: null,
      alifGiven: false,
      currentAlifPrice: null,
      currentAlifDeferredPrice: null,
      ...verdict,
      ...extra,
    });
    const firstBrand = knownBrands()[0]?.name ?? null;
    return [
      ...existing(2, changed, 'PRICE_CHANGED'),
      ...existing(3, unchanged, 'UNCHANGED'),
      fresh(
        4,
        'Demo powerbank 20000 mAh',
        firstBrand,
        '18.50',
        { status: 'NEW', issues: [], warnings: ['CODE_WILL_BE_GENERATED'] },
        { category: 'Powerbanklar', rrp: '24.90' },
      ),
      fresh(5, unchanged?.name ?? 'Demo kabel', null, '3.20', {
        status: 'NEW',
        issues: [],
        warnings: ['CODE_WILL_BE_GENERATED', 'SAME_NAME_EXISTS'],
      }),
      {
        ...fresh(6, 'Demo quloqchin', null, '12.00', { status: 'ERROR', issues: [], warnings: [] }),
        productCode: '99999',
        issues: ['UNKNOWN_PRODUCT_CODE'],
      },
      fresh(7, 'Demo adapter 65W', null, null, {
        status: 'ERROR',
        issues: ['PRICE_MISSING'],
        warnings: [],
      }),
    ];
  }

  const catalogApi: CatalogApi = {
    async listProducts(): Promise<StaffProductDetailListResponse> {
      const state = await beforeRead();
      if (state === 'empty') return { items: [] };
      return {
        items: [...products.values()].sort((a, b) => a.productCode.localeCompare(b.productCode)),
      };
    },

    async getProduct(productId) {
      await beforeRead();
      return requireProduct(productId);
    },

    async createProduct(request) {
      await delay();
      const body = validated(createProductRequestSchema, request);
      // Stored and shown as entered (the schema already trimmed it and checked the characters, a
      // 422 otherwise); uniqueness ignores letter case, like the api's product_code_key.
      const productCode = body.productCode;
      const key = productCodeKey(productCode);
      if ([...products.values()].some((p) => productCodeKey(p.productCode) === key)) {
        throw new ApiConflictError(
          `Product code ${productCode} already exists`,
          'CONFLICT',
          undefined,
          'DUPLICATE_PRODUCT_CODE',
        );
      }
      const stamp = now().toISOString();
      const created: StaffProductDetailResponse = {
        id: fakeId(++counter),
        productCode,
        name: body.name,
        unit: PIECE_UNIT,
        category: null,
        categoryId: null,
        trackingType: 'NONE',
        markingRequired: false,
        codeRuleConfigured: false,
        isActive: true,
        codeGenerated: false,
        mergedIntoProductId: null,
        translations: [{ lang: PRODUCT_NAME_LANG, name: body.name, description: null }],
        createdAt: stamp,
        updatedAt: stamp,
      };
      products.set(created.id, created);
      return created;
    },

    async updateProduct(productId, request) {
      await delay();
      const body = validated(updateProductRequestSchema, request);
      const current = requireProduct(productId);
      // Like the api: the one name goes into the PRODUCT_NAME_LANG row, the others are kept.
      const translations = current.translations.filter((t) => t.lang !== PRODUCT_NAME_LANG);
      if (body.name !== undefined) {
        translations.push({ lang: PRODUCT_NAME_LANG, name: body.name, description: null });
      } else {
        const kept = current.translations.find((t) => t.lang === PRODUCT_NAME_LANG);
        if (kept) translations.push(kept);
      }
      const updated: StaffProductDetailResponse = {
        ...current,
        name: commonProductName(translations, current.productCode),
        isActive: body.isActive ?? current.isActive,
        translations,
        updatedAt: now().toISOString(),
      };
      products.set(productId, updated);
      return updated;
    },

    async listCategories() {
      const state = await beforeRead();
      if (state === 'empty') return { items: [] };
      return {
        items: [...categories.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(toCategory),
      };
    },

    async listSheetCategories() {
      const state = await beforeRead();
      if (state === 'empty') return { items: [] };
      const byKey = new Map<string, { name: string; productCount: number }>();
      for (const product of products.values()) {
        if (product.category === null || findCategoryByName(product.category)) continue;
        const key = nameKey(product.category);
        const entry = byKey.get(key) ?? { name: product.category, productCount: 0 };
        byKey.set(key, { name: entry.name, productCount: entry.productCount + 1 });
      }
      return {
        items: [...byKey.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, entry]) => {
            const rule = suggestCategoryCodeRule(entry.name);
            return {
              ...entry,
              suggestedTrackingType: rule.trackingType,
              suggestedMarkingRequired: rule.markingRequired,
            };
          }),
      };
    },

    async createCategory(request) {
      await delay();
      const body = validated(createProductCategoryRequestSchema, request);
      if (findCategoryByName(body.name)) throw duplicateCategory(body.name);
      return toCategory(addCategory(body));
    },

    async createCategories(request) {
      await delay();
      const body = validated(createProductCategoriesRequestSchema, request);
      // All or nothing, like the api's single transaction.
      const taken = body.items.find((item) => findCategoryByName(item.name));
      if (taken) throw duplicateCategory(taken.name);
      return { items: body.items.map((item) => toCategory(addCategory(item))) };
    },

    async updateCategory(id, request) {
      await delay();
      const body = validated(updateProductCategoryRequestSchema, request);
      const current = requireCategory(id);
      if (body.name !== undefined) {
        const holder = findCategoryByName(body.name);
        if (holder && holder.id !== id) throw duplicateCategory(body.name);
      }
      // Not retroactive: the linked products keep their own rule.
      const updated: CategoryRecord = {
        ...current,
        name: body.name ?? current.name,
        trackingTypeDefault: body.trackingTypeDefault ?? current.trackingTypeDefault,
        markingRequiredDefault: body.markingRequiredDefault ?? current.markingRequiredDefault,
        isActive: body.isActive ?? current.isActive,
        updatedAt: now().toISOString(),
      };
      categories.set(id, updated);
      return toCategory(updated);
    },

    async updateProductTracking(productId, request) {
      await delay();
      const body = validated(updateProductTrackingRequestSchema, request);
      const product = requireProduct(productId);
      let defaults: Partial<Pick<StaffProductDetailResponse, 'trackingType' | 'markingRequired'>> =
        {};
      if (typeof body.categoryId === 'string') {
        const category = requireCategory(body.categoryId);
        if (!category.isActive) {
          throw new ApiConflictError(
            'The category is archived',
            'CONFLICT',
            undefined,
            'CATEGORY_ARCHIVED',
          );
        }
        if (category.id !== product.categoryId) {
          defaults = {
            trackingType: category.trackingTypeDefault,
            markingRequired: category.markingRequiredDefault,
          };
        }
      }
      return setRule(product, {
        categoryId: body.categoryId === undefined ? product.categoryId : body.categoryId,
        trackingType: body.trackingType ?? defaults.trackingType ?? product.trackingType,
        markingRequired:
          body.markingRequired ?? defaults.markingRequired ?? product.markingRequired,
      });
    },
  };

  // Read-only window for the other fakes (cost, stock) that must agree with this catalog.
  const view: FakePriceBackendView = {
    products: () => [...products.values()],
    publishedProductIds: () => new Set(published()?.prices.keys() ?? []),
    productRule: (productCode) => {
      const product = [...products.values()].find((p) => p.productCode === productCode);
      return product
        ? { trackingType: product.trackingType, markingRequired: product.markingRequired }
        : { trackingType: 'NONE', markingRequired: false };
    },
    primaryImage,
    stockTracked: (productCode) => productByCode(productCode)?.codeGenerated !== true,
  };

  return { pricingApi, catalogApi, view };
}
