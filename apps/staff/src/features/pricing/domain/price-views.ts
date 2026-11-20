// The ready views ("Tayyor ko'rinishlar"), the price type filter and the sort order of Narxlar
// (design «Narxlar — yakuniy sahifa», approved 2026-11-19). Each view is a task: the products
// brought by order, the ones the wholesale tier has no price for, the ones priced below their
// latest cost. Display filters only, over the staff list; the server still decides every action.
// The view set and the sort choices are [P] in the design note.

import { compareMoney } from '@core/lib/money';

export const PRICE_PRESETS = ['all', 'byOrder', 'noWholesale', 'belowCost'] as const;
export type PricePreset = (typeof PRICE_PRESETS)[number];

export const isPricePreset = (value: string): value is PricePreset =>
  (PRICE_PRESETS as readonly string[]).includes(value);

/** Which tiers a product has its own price for. */
export const PRICE_TYPES = ['all', 'standardOnly', 'hasWholesale', 'hasAlif'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const isPriceType = (value: string): value is PriceType =>
  (PRICE_TYPES as readonly string[]).includes(value);

export interface PriceViewItem {
  /** A staff-added product ("Buyurtma orqali" [C, 2026-11-09]). */
  readonly codeGenerated: boolean;
  readonly wholesalePrice: string | null;
  readonly alifPrice: string | null;
  /** The sale price is below the latest cost; false when the cost is not known or not shown. */
  readonly belowCost: boolean;
}

export function matchesPreset(item: PriceViewItem, preset: PricePreset): boolean {
  switch (preset) {
    case 'all':
      return true;
    case 'byOrder':
      return item.codeGenerated;
    case 'noWholesale':
      return item.wholesalePrice === null;
    case 'belowCost':
      return item.belowCost;
  }
}

export function matchesPriceType(item: PriceViewItem, type: PriceType): boolean {
  switch (type) {
    case 'all':
      return true;
    case 'standardOnly':
      return item.wholesalePrice === null && item.alifPrice === null;
    case 'hasWholesale':
      return item.wholesalePrice !== null;
    case 'hasAlif':
      return item.alifPrice !== null;
  }
}

// --- sort -------------------------------------------------------------------------------------

export const PRICE_SORTS = ['changed', 'price', 'markup', 'name'] as const;
export type PriceSort = (typeof PRICE_SORTS)[number];

export const isPriceSort = (value: string): value is PriceSort =>
  (PRICE_SORTS as readonly string[]).includes(value);

export interface SortablePrice {
  readonly productCode: string;
  /** The sale price in USD; null when it has none in USD (an older so'm row). */
  readonly usdPrice: string | null;
  /** The markup over the latest cost in tenths of a percent; null when unknown or not shown. */
  readonly markupTenths: bigint | null;
  /** ISO instant of the last price change; null when unknown. */
  readonly changedAt: string | null;
}

/** Code unit order, the same on every device. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A missing value after every present one; otherwise `compare`. */
function missingLast<V>(x: V | null, y: V | null, compare: (a: V, b: V) => number): number {
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return compare(x, y);
}

const instant = (iso: string | null): number | null => {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

/**
 * Latest change first / highest price first / lowest markup first (what needs a look) / name A–Z.
 * Rows without the value go last; ties keep the product code order, so the list never jumps.
 */
export function sortPrices<T extends SortablePrice>(
  items: readonly T[],
  sort: PriceSort,
  nameOf: (item: T) => string,
): T[] {
  const compare = (a: T, b: T): number => {
    switch (sort) {
      case 'name':
        return nameOf(a).localeCompare(nameOf(b), 'ru');
      case 'price':
        return missingLast(a.usdPrice, b.usdPrice, (x, y) => compareMoney(y, x));
      case 'markup':
        return missingLast(a.markupTenths, b.markupTenths, (x, y) => (x < y ? -1 : x > y ? 1 : 0));
      case 'changed':
        return missingLast(instant(a.changedAt), instant(b.changedAt), (x, y) => y - x);
    }
  };
  return [...items].sort((a, b) => compare(a, b) || byCodeUnit(a.productCode, b.productCode));
}
