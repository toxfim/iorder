import {
  CURRENCY,
  PIECE_UNIT,
  commonProductName,
  productImageMediaUrl,
  CUSTOMER_CATEGORY_MAX_LENGTH,
  PRICE_LIST_CURRENCIES,
  type PriceListCurrency,
  type CreateDraftResponse,
  type CustomerPriceListResponse,
  type PriceHistoryResponse,
  type StaffPriceListResponse,
  type StaffVersionResponse,
  type StaffVersionSummaryResponse,
} from '@iorder/shared';
import type {
  CreateDraftWithRateResponse,
  PublishChangesWithRateResponse,
  StaffPriceListWithRateResponse,
  StaffVersionListWithRateResponse,
  StaffVersionWithRateResponse,
} from '@iorder/shared/staff-cost';
import type { ProductView, SheetMatch } from '../../catalog/index.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { UsdRateSnapshot } from '../usd-rate/usd-rate.service.js';
import { toPieceCount, type OrderableStock } from '../orderable-stock.js';
import { formatMoney } from '../price-money.js';
import type {
  LastPriceChange,
  PriceHistoryEntry,
  PriceListView,
  VersionSummaryView,
  VersionView,
} from '../pricing.types.js';

// Two distinct, explicit allow-lists; the response SHAPES are defined in @iorder/shared (one
// definition for api and web). Nothing is spread from a source object, so a column added to a
// table later never reaches an API by accident (hard rule 7).

/**
 * One common product name for every reader (owner, 2026-10-28), so no language is needed.
 * `orderableStock`: the customer's stock figure per product; a product not in it shows none. A
 * caller that does not show stock from this DTO (the Excel file has its own column) passes none.
 */
export function toCustomerPriceListResponse(
  list: PriceListView,
  images: PrimaryImageMap,
  orderableStock: OrderableStock = new Map(),
): CustomerPriceListResponse {
  return {
    version: {
      number: list.version.number,
      // A published version always has a date; the DB check constraint guarantees it.
      publishedAt: (list.version.publishedAt ?? list.version.createdAt).toISOString(),
    },
    items: list.items.map(({ product, basePrice, deferredPrice, rrp }) => ({
      productId: product.id,
      productCode: product.productCode,
      unit: PIECE_UNIT,
      name: commonProductName(product.translations, product.productCode),
      price: formatMoney(basePrice),
      deferredPrice: deferredPrice === null ? null : formatMoney(deferredPrice),
      // Customer-visible by the owner's decision [C, 2026-11-09]; a price, never cost data.
      rrp: optionalMoney(rrp),
      // Customer-visible by the owner's decision [C, 2026-11-09]: whole pieces, a total over all
      // customers. Never the sheet's raw number, a cost or a supplier.
      orderableStock: toPieceCount(orderableStock.get(product.id)),
      // The service converted every price to UZS before the list reached this mapper.
      currency: CURRENCY,
      category: customerCategory(product.category),
      ...imageUrls(images.get(product.id) ?? null),
    })),
  };
}

/** Blank sheet values mean "no category"; the contract allows only a trimmed, non-empty label. */
function customerCategory(category: string | null): string | null {
  if (category === null) return null;
  // Any run of whitespace or control characters (tabs, newlines, NBSP) becomes one space, so the
  // label cannot break a line or hide text in the customer's tab list.
  const collapsed = category.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  // The contract limit counts UTF-16 units, so cut there, then drop a high surrogate left alone
  // at the end (an emoji split in half); trim again because the cut can end on a space.
  let cut = collapsed.slice(0, CUSTOMER_CATEGORY_MAX_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  cut = cut.trim();
  return cut === '' ? null : cut;
}

/** Actor id -> display name. An id missing here is shown as "unknown", never as the id itself. */
export type PersonNames = ReadonlyMap<string, string>;

function publisher(
  userId: string | null,
  names: PersonNames,
): { publishedBy: string | null; publishedByUserId: string | null } {
  const name = userId === null ? undefined : names.get(userId);
  return name === undefined
    ? { publishedBy: null, publishedByUserId: null }
    : { publishedBy: name, publishedByUserId: userId };
}

export function toStaffVersionResponse(
  version: VersionView,
  names: PersonNames,
): StaffVersionResponse {
  return {
    id: version.id,
    number: version.number,
    status: version.status,
    note: version.note,
    source: version.source,
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    ...publisher(version.publishedBy, names),
  };
}

export function toCreateDraftResponse(
  version: VersionView,
  skippedInactiveCount: number,
  names: PersonNames,
): CreateDraftResponse {
  return { ...toStaffVersionResponse(version, names), skippedInactiveCount };
}

export function toStaffVersionSummaryResponse(
  version: VersionSummaryView,
  names: PersonNames,
): StaffVersionSummaryResponse {
  return { ...toStaffVersionResponse(version, names), itemCount: version.itemCount };
}

/** productId -> live primary photo id of the listed products. */
export type PrimaryImageMap = ReadonlyMap<string, string>;

/** Explicit fields only: the catalog view behind a match is never spread into the DTO. */
function toSheetMatch(
  match: SheetMatch | undefined,
): StaffPriceListResponse['items'][number]['sheetMatch'] {
  return match === undefined
    ? null
    : { productId: match.productId, productCode: match.productCode, name: match.name };
}

function imageUrls(imageId: string | null): {
  imageUrl: string | null;
  imageLargeUrl: string | null;
} {
  return {
    imageUrl: imageId === null ? null : productImageMediaUrl(imageId, 'thumb'),
    imageLargeUrl: imageId === null ? null : productImageMediaUrl(imageId, 'large'),
  };
}

/** productId -> the sheet product a generated-code item stands for (absent = none). */
export type SheetMatchMap = ReadonlyMap<string, SheetMatch>;

/** Staff-only per-product facts of the list beyond its prices (empty outside the current list). */
export interface StaffItemExtras {
  readonly brands: ReadonlyMap<string, string | null>;
  readonly lastChanges: ReadonlyMap<string, LastPriceChange>;
}

export const NO_STAFF_ITEM_EXTRAS: StaffItemExtras = { brands: new Map(), lastChanges: new Map() };

export function toStaffPriceListResponse(
  list: PriceListView,
  images: PrimaryImageMap,
  names: PersonNames,
  sheetMatches: SheetMatchMap,
  extras: StaffItemExtras = NO_STAFF_ITEM_EXTRAS,
): StaffPriceListResponse {
  return {
    version: toStaffVersionResponse(list.version, names),
    items: list.items.map((item) => ({
      ...staffItemPrices(item),
      productId: item.product.id,
      productCode: item.product.productCode,
      unit: PIECE_UNIT,
      isActive: item.product.isActive,
      codeGenerated: item.product.codeGenerated,
      sheetMatch: toSheetMatch(
        item.product.codeGenerated ? sheetMatches.get(item.product.id) : undefined,
      ),
      names: item.product.translations.map((t) => ({ lang: t.lang, name: t.name })),
      brand: extras.brands.get(item.product.id) ?? null,
      lastChange: toPriceChange(extras.lastChanges.get(item.product.id), names),
      ...imageUrls(images.get(item.product.id) ?? null),
    })),
  };
}

function toPriceChange(
  change: LastPriceChange | undefined,
  names: PersonNames,
): StaffPriceListResponse['items'][number]['lastChange'] {
  if (!change) return null;
  return {
    versionNumber: change.versionNumber,
    changedAt: change.publishedAt.toISOString(),
    changedBy: change.publishedBy === null ? null : (names.get(change.publishedBy) ?? null),
  };
}

/** The staff list's prices: every tier as stored (staff-only; never a customer mapper's input). */
function staffItemPrices(
  item: PriceListView['items'][number],
): Pick<
  StaffPriceListResponse['items'][number],
  | 'basePrice'
  | 'deferredPrice'
  | 'rrp'
  | 'wholesalePrice'
  | 'wholesaleDeferredPrice'
  | 'alifPrice'
  | 'alifDeferredPrice'
  | 'currency'
  | 'uzs'
> {
  return {
    basePrice: formatMoney(item.basePrice),
    deferredPrice: optionalMoney(item.deferredPrice),
    rrp: optionalMoney(item.rrp),
    wholesalePrice: optionalMoney(item.wholesalePrice),
    wholesaleDeferredPrice: optionalMoney(item.wholesaleDeferredPrice),
    alifPrice: optionalMoney(item.alifPrice),
    alifDeferredPrice: optionalMoney(item.alifDeferredPrice),
    currency: listCurrency(item.currency),
    uzs: item.uzs && {
      basePrice: formatMoney(item.uzs.basePrice),
      deferredPrice: optionalMoney(item.uzs.deferredPrice),
    },
  };
}

export function toPriceHistoryResponse(
  product: ProductView,
  entries: readonly PriceHistoryEntry[],
  names: PersonNames,
): PriceHistoryResponse {
  return {
    productId: product.id,
    productCode: product.productCode,
    entries: entries.map((e) => ({
      versionId: e.versionId,
      versionNumber: e.versionNumber,
      publishedAt: e.publishedAt.toISOString(),
      ...publisher(e.publishedBy, names),
      source: e.source,
      oldPrice: e.oldPrice ? formatMoney(e.oldPrice) : null,
      newPrice: e.newPrice ? formatMoney(e.newPrice) : null,
      oldDeferredPrice: e.oldDeferredPrice ? formatMoney(e.oldDeferredPrice) : null,
      newDeferredPrice: e.newDeferredPrice ? formatMoney(e.newDeferredPrice) : null,
      oldRrp: optionalMoney(e.oldRrp),
      newRrp: optionalMoney(e.newRrp),
      oldCurrency: listCurrency(e.oldCurrency),
      currency: listCurrency(e.currency),
    })),
  };
}

function optionalMoney(value: Prisma.Decimal | null): string | null {
  return value === null ? null : formatMoney(value);
}

/** The CHECK constraint allows only these; anything else is a bug, not data to pass on. */
function listCurrency(currency: string): PriceListCurrency {
  const known = PRICE_LIST_CURRENCIES.find((c) => c === currency);
  if (!known) throw new Error(`Unknown price list currency ${currency}`);
  return known;
}

// ---------------------------------------------------------------------------------------
// Staff variants WITH the USD rate snapshot (cost-class: contracts live in @iorder/shared/staff-cost)
// ---------------------------------------------------------------------------------------

export type SnapshotMap = ReadonlyMap<string, UsdRateSnapshot>;

function toSnapshotDto(
  snapshot: UsdRateSnapshot | undefined,
): StaffVersionWithRateResponse['usdRateSnapshot'] {
  return snapshot
    ? { rate: snapshot.rate.toFixed(4), source: snapshot.source, rateDate: snapshot.rateDate }
    : null;
}

export function toStaffVersionWithRate(
  version: VersionView,
  snapshots: SnapshotMap,
  names: PersonNames,
): StaffVersionWithRateResponse {
  return {
    ...toStaffVersionResponse(version, names),
    usdRateSnapshot: toSnapshotDto(snapshots.get(version.id)),
  };
}

export function toStaffVersionListWithRate(
  versions: readonly VersionSummaryView[],
  snapshots: SnapshotMap,
  names: PersonNames,
): StaffVersionListWithRateResponse {
  return {
    items: versions.map((v) => ({
      ...toStaffVersionSummaryResponse(v, names),
      usdRateSnapshot: toSnapshotDto(snapshots.get(v.id)),
    })),
  };
}

export function toStaffPriceListWithRate(
  list: PriceListView,
  snapshots: SnapshotMap,
  images: PrimaryImageMap,
  names: PersonNames,
  sheetMatches: SheetMatchMap,
  extras: StaffItemExtras = NO_STAFF_ITEM_EXTRAS,
): StaffPriceListWithRateResponse {
  const base = toStaffPriceListResponse(list, images, names, sheetMatches, extras);
  return { version: toStaffVersionWithRate(list.version, snapshots, names), items: base.items };
}

export function toCreateDraftWithRate(
  version: VersionView,
  skippedInactiveCount: number,
  snapshots: SnapshotMap,
  names: PersonNames,
): CreateDraftWithRateResponse {
  return { ...toStaffVersionWithRate(version, snapshots, names), skippedInactiveCount };
}

export function toPublishChangesWithRate(
  version: VersionView,
  skippedInactiveCount: number,
  snapshots: SnapshotMap,
  names: PersonNames,
): PublishChangesWithRateResponse {
  return { ...toStaffVersionWithRate(version, snapshots, names), skippedInactiveCount };
}
