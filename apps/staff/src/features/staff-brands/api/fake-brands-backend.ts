import {
  createBrandRequestSchema,
  type BrandResponse,
  type PriceListPostRecipientsResponse,
  type StaffPriceListWithRateResponse,
  type UnbrandedProduct,
} from '@iorder/shared/staff-cost';
import {
  priceTierOfLabel,
  type PriceTier,
  type StaffOrganizationSummary,
  type StaffRole,
} from '@iorder/shared';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import type { PriceListShareApi } from '@/features/pricing/api/price-list-share-api';
import type { PricingApi } from '@/features/pricing/api/pricing-api';
import { canEditPrices, canViewCost, canViewPriceAdmin } from '@/features/staff-shell/price-access';
import type { BrandsApi } from './brands-api';
import {
  FAKE_BRAND_NAMES,
  FAKE_BRANDS_BACKEND_MARKER,
  FAKE_POSTING_GROUP_COUNT,
  FAKE_UNBRANDED_SEEDS,
} from './fake-brands-fixtures';

export interface FakeBrandsBackendOptions {
  /** The published list the file is built from. */
  readonly pricingApi: PricingApi;
  /** Roles of the signed-in person, read per call (permissions are modelled like the api's). */
  readonly roles: () => readonly StaffRole[];
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  /**
   * The organizations a post reaches (the organizations fake's list); without it the post counts
   * FAKE_POSTING_GROUP_COUNT standard groups.
   */
  readonly organizations?: () => Promise<readonly StaffOrganizationSummary[]>;
}

/**
 * The api's recipient rule [C, owner 2026-11-11]: each organization once, skipped by the first
 * reason that applies (unbound, inactive, posting off); the rest get the file of their tier, a
 * GROUP in its chat, a PERSON in the private chat.
 */
export function countPostRecipients(
  orgs: readonly StaffOrganizationSummary[],
): PriceListPostRecipientsResponse {
  const result: PriceListPostRecipientsResponse = {
    recipients: {
      total: 0,
      byTier: { STANDARD: 0, WHOLESALE_PARTNER: 0, ALIF_FACTORING: 0 },
      byDestination: { GROUP: 0, PRIVATE: 0 },
    },
    skipped: { unbound: 0, inactive: 0, postingOff: 0, noPrices: 0 },
  };
  for (const org of orgs) {
    if (org.invite.status !== 'LINKED') result.skipped.unbound += 1;
    else if (org.status !== 'ACTIVE') result.skipped.inactive += 1;
    else if (!org.pricePostingEnabled) result.skipped.postingOff += 1;
    else {
      result.recipients.total += 1;
      result.recipients.byTier[priceTierOfLabel(org.label)] += 1;
      result.recipients.byDestination[org.type === 'GROUP' ? 'GROUP' : 'PRIVATE'] += 1;
    }
  }
  return result;
}

const byName = (a: BrandResponse, b: BrandResponse): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// A byte order mark, so Excel reads the UTF-8 names right.
const UTF8_BOM = String.fromCharCode(0xfeff);

const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/**
 * In-memory stand-in for the brand endpoints and the price list file and posting. It follows the
 * contract: brands and posting are for manager and admin, the file for every role that reads the
 * staff price list; a brand name is unique ignoring letter case (409 DUPLICATE_BRAND_NAME); a
 * product that got its brand leaves the unbranded list. The "Excel" file is a CSV here: the fake
 * cannot build a real .xlsx without a new dependency, and its file name says so.
 */
export function createFakeBrandsBackend(options: FakeBrandsBackendOptions): {
  brandsApi: BrandsApi;
  priceListShareApi: PriceListShareApi;
  /** Read-only window for the price fake, whose manual products name a brand. */
  view: { brands: () => readonly BrandResponse[] };
} {
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? (() => 'ready');
  const brands: BrandResponse[] = FAKE_BRAND_NAMES.map((name) => ({
    id: fakeUuid(`brand:${name}`),
    name,
  }));
  const unbranded: UnbrandedProduct[] = FAKE_UNBRANDED_SEEDS.map((seed) => ({
    productId: fakeUuid(`unbranded:${seed.productCode}`),
    productCode: seed.productCode,
    name: seed.name,
    category: seed.category,
    priced: seed.priced,
  }));

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_BRANDS_BACKEND_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  function requireEditor(): void {
    if (!canEditPrices(options.roles())) throw new PermissionDeniedError();
  }

  function requireViewer(): void {
    if (!canViewPriceAdmin(options.roles())) throw new PermissionDeniedError();
  }

  const brandsApi: BrandsApi = {
    async listBrands() {
      const state = await beforeRead();
      requireViewer();
      return { items: state === 'empty' ? [] : [...brands].sort(byName) };
    },
    async createBrand(name) {
      await delay();
      requireEditor();
      const parsed = createBrandRequestSchema.safeParse({ name });
      if (!parsed.success) {
        throw new ApiValidationError(
          'Request validation failed',
          'VALIDATION_FAILED',
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        );
      }
      const wanted = parsed.data.name;
      if (brands.some((b) => b.name.toLowerCase() === wanted.toLowerCase())) {
        throw new ApiConflictError('Brand exists', 'CONFLICT', undefined, 'DUPLICATE_BRAND_NAME');
      }
      const brand = { id: fakeUuid(`brand:new:${brands.length}:${wanted}`), name: wanted };
      brands.push(brand);
      return brand;
    },
    async unbrandedProducts() {
      const state = await beforeRead();
      requireViewer();
      if (state === 'empty') return { items: [] };
      const items = [...unbranded].sort(
        (a, b) => Number(b.priced) - Number(a.priced) || a.name.localeCompare(b.name),
      );
      return { items };
    },
    async setProductBrand(productId, brandId) {
      await delay();
      requireEditor();
      const brand = brands.find((b) => b.id === brandId);
      const index = unbranded.findIndex((p) => p.productId === productId);
      if (!brand || index < 0) throw new ApiNotFoundError('Not found', 'NOT_FOUND');
      unbranded.splice(index, 1);
      return { productId, brand };
    },
  };

  async function publishedList(): Promise<StaffPriceListWithRateResponse> {
    try {
      return await options.pricingApi.getCurrent();
    } catch (caught) {
      if (caught instanceof ApiNotFoundError) {
        throw new ApiConflictError(
          'Nothing published',
          'CONFLICT',
          undefined,
          'NO_PUBLISHED_VERSION',
        );
      }
      throw caught;
    }
  }

  async function recipientsNow(): Promise<PriceListPostRecipientsResponse> {
    if (options.organizations) return countPostRecipients(await options.organizations());
    return {
      recipients: {
        total: FAKE_POSTING_GROUP_COUNT,
        byTier: { STANDARD: FAKE_POSTING_GROUP_COUNT, WHOLESALE_PARTNER: 0, ALIF_FACTORING: 0 },
        byDestination: { GROUP: FAKE_POSTING_GROUP_COUNT, PRIVATE: 0 },
      },
      skipped: { unbound: 0, inactive: 0, postingOff: 0, noPrices: 0 },
    };
  }

  const priceListShareApi: PriceListShareApi = {
    async downloadExcel(tier: PriceTier) {
      await delay();
      if (!canViewCost(options.roles())) throw new PermissionDeniedError();
      const list = await publishedList();
      // The «Оптовик/Партнер» file falls back to the standard prices where a product has none;
      // the «Alif factoring» file lists only the products with an Alif price (no fallback).
      const priceOf = (item: (typeof list.items)[number]): string | null => {
        if (tier === 'ALIF_FACTORING') return item.alifPrice;
        return tier === 'WHOLESALE_PARTNER'
          ? (item.wholesalePrice ?? item.basePrice)
          : item.basePrice;
      };
      const lines = [
        ['Tovar ID', 'Nomi', 'Narx'].map(csvCell).join(','),
        ...list.items.flatMap((item) => {
          const price = priceOf(item);
          return price === null
            ? []
            : [[item.productCode, item.names[0]?.name ?? '', price].map(csvCell).join(',')];
        }),
      ];
      const suffix =
        tier === 'WHOLESALE_PARTNER' ? '-ulgurji' : tier === 'ALIF_FACTORING' ? '-alif' : '';
      return {
        blob: new Blob([`${UTF8_BOM}${lines.join('\r\n')}\r\n`], {
          type: 'text/csv;charset=utf-8',
        }),
        fileName: `iorder-narxlar-v${list.version.number}${suffix}-demo.csv`,
      };
    },
    async recipients() {
      await delay();
      requireEditor();
      await publishedList();
      return recipientsNow();
    },
    async postToGroups() {
      await delay();
      requireEditor();
      const list = await publishedList();
      const { recipients, skipped } = await recipientsNow();
      return {
        versionNumber: list.version.number,
        queuedGroupCount: recipients.total,
        recipients,
        skipped,
      };
    },
  };

  return { brandsApi, priceListShareApi, view: { brands: () => [...brands].sort(byName) } };
}

export type FakeBrandsBackend = ReturnType<typeof createFakeBrandsBackend>;
