// The ready views ("Tayyor ko'rinishlar"), the brand filter and the sort order of Qoldiq (design
// «Qoldiq — yakuniy sahifa», approved 2026-11-19). Each view is a daily task: price what has no
// price, see what cannot be ordered, ask for a supply of what runs low, look at what just arrived.
// Display filters only, over the staff stock answer; the server still decides every action.

import { stockLevel, toScaled } from './decimal';

export const STOCK_PRESETS = ['all', 'unpriced', 'out', 'low', 'new'] as const;
export type StockPreset = (typeof STOCK_PRESETS)[number];

export const isStockPreset = (value: string): value is StockPreset =>
  (STOCK_PRESETS as readonly string[]).includes(value);

/** [P] "Yangi postavka": the newest live delivery arrived within this many days. */
export const NEW_DELIVERY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PresetItem {
  readonly isPriced: boolean;
  readonly availableQuantity: string | null;
  readonly latestDelivery: { readonly deliveredAt: string } | null;
}

/** Arrived within NEW_DELIVERY_DAYS before `nowMs` (a malformed date is never new). */
export function isNewDelivery(item: PresetItem, nowMs: number): boolean {
  const at = item.latestDelivery ? Date.parse(item.latestDelivery.deliveredAt) : Number.NaN;
  return Number.isFinite(at) && nowMs - at <= NEW_DELIVERY_DAYS * DAY_MS;
}

/**
 * An unknown stock (no stock aggregate) is neither "out" nor "low": only an exact zero is out,
 * the same reading as the customer stock cap.
 */
export function matchesPreset(item: PresetItem, preset: StockPreset, nowMs: number): boolean {
  switch (preset) {
    case 'all':
      return true;
    case 'unpriced':
      return !item.isPriced;
    case 'out':
      return stockLevel(item.availableQuantity) === 'out';
    case 'low':
      return stockLevel(item.availableQuantity) === 'low';
    case 'new':
      return isNewDelivery(item, nowMs);
  }
}

// --- brand ------------------------------------------------------------------------------------

export const BRAND_ALL = 'all';

export interface BrandOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export const matchesBrand = (brand: string | null, selected: string): boolean =>
  selected === BRAND_ALL || brand === selected;

/** Code unit order, the same on every device. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every brand of the given products with how many it keeps; products without one are left out. */
export function brandOptions(brands: readonly (string | null)[]): BrandOption[] {
  const counts = new Map<string, number>();
  for (const brand of brands) {
    if (brand !== null) counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([brand, count]) => ({ value: brand, label: brand, count }));
}

// --- sort -------------------------------------------------------------------------------------

export const STOCK_SORTS = ['latest', 'available', 'name'] as const;
export type StockSort = (typeof STOCK_SORTS)[number];

export const isStockSort = (value: string): value is StockSort =>
  (STOCK_SORTS as readonly string[]).includes(value);

export interface SortableItem {
  readonly productCode: string;
  readonly availableQuantity: string | null;
  readonly latestDelivery: { readonly deliveredAt: string } | null;
}

/** Thousandths of a quantity string; null when unknown or malformed. */
function thousandths(quantity: string | null): bigint | null {
  if (quantity === null) return null;
  try {
    return toScaled(quantity, 3);
  } catch {
    return null;
  }
}

/**
 * Newest supply first / most available first / name A–Z. Rows without the value (no delivery,
 * unknown stock) go last; ties keep the product code order, so the list never jumps.
 */
export function sortStock<T extends SortableItem>(
  items: readonly T[],
  sort: StockSort,
  nameOf: (item: T) => string,
): T[] {
  const byCode = (a: T, b: T): number => byCodeUnit(a.productCode, b.productCode);
  const compare = (a: T, b: T): number => {
    if (sort === 'name') return nameOf(a).localeCompare(nameOf(b), 'ru') || byCode(a, b);
    const primary =
      sort === 'available'
        ? descendingLastMissing(thousandths(a.availableQuantity), thousandths(b.availableQuantity))
        : descendingLastMissing(deliveredMs(a), deliveredMs(b));
    return primary || byCode(a, b);
  };
  return [...items].sort(compare);
}

function deliveredMs(item: SortableItem): number | null {
  const at = item.latestDelivery ? Date.parse(item.latestDelivery.deliveredAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** Larger first; a missing value after every present one. */
function descendingLastMissing<V extends number | bigint>(x: V | null, y: V | null): number {
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return x < y ? 1 : x > y ? -1 : 0;
}
