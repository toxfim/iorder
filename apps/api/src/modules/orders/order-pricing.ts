import { PIECE_UNIT, commonProductName, type PaymentPlan, type PriceTier } from '@iorder/shared';
import { Prisma } from '../../generated/prisma/client.js';
import type { ProductView } from '../catalog/index.js';
import { uzsToUsd } from '../pricing/index.js';
import { lineTotal, sumAmounts } from './order-lines.js';

// Pricing a cart with a published price list version. PURE: the caller loads the version and the
// products. The result is the SNAPSHOT that becomes `order_items` (hard rule 4).

export interface PriceBookEntry {
  product: ProductView;
  /** The sale price (plan FULL). */
  unitPrice: Prisma.Decimal;
  /** The deferred price (plan DEFERRED); null = the product has none. */
  deferredUnitPrice: Prisma.Decimal | null;
  /** The sale price as the list has it in USD; null on a legacy so'm item. Staff-only. */
  fullUnitPriceUsd: Prisma.Decimal | null;
  /** The deferred price as the list has it in USD; null when the item has none in USD. Staff-only. */
  deferredUnitPriceUsd: Prisma.Decimal | null;
  /**
   * The recommended retail price (RRP) in UZS [C, 2026-11-09]; null = none. Shown on the cart line
   * only: it is not a price of any plan, so it never reaches a snapshot line or a total.
   */
  rrp: Prisma.Decimal | null;
}

/** One published price list version with its products, keyed by product id. */
export interface PriceBook {
  versionId: string;
  versionNumber: number;
  /** The tier every price of this book is in: the organization's, when the book was read. */
  priceTier: PriceTier;
  /** The rate these so'm prices were converted with; null while no rate setting exists. */
  usdRate: Prisma.Decimal | null;
  entries: ReadonlyMap<string, PriceBookEntry>;
}

export interface SnapshotLine {
  productId: string;
  productCode: string;
  name: string;
  unit: string;
  quantity: Prisma.Decimal;
  /** What the line is charged at: the snapshot of the chosen plan. */
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  fullUnitPrice: Prisma.Decimal;
  deferredUnitPrice: Prisma.Decimal | null;
  fullUnitPriceUsd: Prisma.Decimal | null;
  deferredUnitPriceUsd: Prisma.Decimal | null;
}

export interface PricingResult {
  lines: SnapshotLine[];
  total: Prisma.Decimal;
  /** Products that are inactive, unknown or missing from the price list. */
  unorderableProductIds: string[];
  /** Plan DEFERRED only: orderable products without a deferred price. A price is never guessed. */
  missingDeferredProductIds: string[];
}

/** The two price snapshots of a line. */
export interface PlanPrices {
  fullUnitPrice: Prisma.Decimal;
  deferredUnitPrice: Prisma.Decimal | null;
}

/** The price a line costs under a plan; null when the plan is impossible for it. */
export function unitPriceForPlan(prices: PlanPrices, plan: PaymentPlan): Prisma.Decimal | null {
  return plan === 'FULL' ? prices.fullUnitPrice : prices.deferredUnitPrice;
}

/**
 * Why a product cannot go into an order snapshot, or null when it can. A snapshot without a name
 * would be rejected by the database (`order_items_snapshots_not_blank`), so it is a clear conflict
 * here instead. The unit is always the piece (owner, 2026-10-28), so it can no longer be missing.
 */
export function orderabilityProblem(
  product: Pick<ProductView, 'productCode' | 'isActive' | 'translations'>,
): 'INACTIVE' | 'INCOMPLETE' | null {
  if (!product.isActive) return 'INACTIVE';
  const name = commonProductName(product.translations, product.productCode).trim();
  if (name === '' || product.productCode.trim() === '') return 'INCOMPLETE';
  return null;
}

/** Lines are ordered by product code so an order always reads the same way. */
export function priceItems(
  book: PriceBook,
  items: readonly { productId: string; quantity: Prisma.Decimal }[],
  plan: PaymentPlan,
): PricingResult {
  const lines: SnapshotLine[] = [];
  const unorderableProductIds: string[] = [];
  const missingDeferredProductIds: string[] = [];
  for (const item of items) {
    const entry = book.entries.get(item.productId);
    if (!entry || orderabilityProblem(entry.product) !== null) {
      unorderableProductIds.push(item.productId);
      continue;
    }
    const prices = { fullUnitPrice: entry.unitPrice, deferredUnitPrice: entry.deferredUnitPrice };
    const unitPrice = unitPriceForPlan(prices, plan);
    if (unitPrice === null) {
      missingDeferredProductIds.push(item.productId);
      continue;
    }
    lines.push({
      productId: item.productId,
      productCode: entry.product.productCode,
      name: commonProductName(entry.product.translations, entry.product.productCode),
      unit: PIECE_UNIT,
      quantity: item.quantity,
      unitPrice,
      lineTotal: lineTotal(item.quantity, unitPrice),
      ...prices,
      fullUnitPriceUsd: entry.fullUnitPriceUsd,
      deferredUnitPriceUsd: entry.deferredUnitPriceUsd,
    });
  }
  lines.sort((a, b) => a.productCode.localeCompare(b.productCode));
  return {
    lines,
    total: sumAmounts(lines.map((l) => l.lineTotal)),
    unorderableProductIds,
    missingDeferredProductIds,
  };
}

/** What a line's USD value is worked out from. */
export interface UsdPricedLine {
  quantity: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  fullUnitPriceUsd: Prisma.Decimal | null;
  deferredUnitPriceUsd: Prisma.Decimal | null;
}

/**
 * The USD value of a line. A line charged at a USD snapshot is quantity x that price, so an exact USD
 * payment matches it; a line priced in legacy so'm, or older than the snapshots, is its so'm total at
 * the order's frozen rate. Six decimals, half up.
 */
export function lineUsd(
  line: UsdPricedLine,
  plan: PaymentPlan,
  usdRate: Prisma.Decimal,
): Prisma.Decimal {
  const usdPrice = plan === 'FULL' ? line.fullUnitPriceUsd : line.deferredUnitPriceUsd;
  return usdPrice === null
    ? uzsToUsd(line.lineTotal, usdRate)
    : line.quantity.mul(usdPrice).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

/** An order's USD total: the sum of its lines, never a conversion of its so'm total. */
export function orderTotalUsd(
  lines: readonly UsdPricedLine[],
  plan: PaymentPlan,
  usdRate: Prisma.Decimal,
): Prisma.Decimal {
  return sumAmounts(lines.map((line) => lineUsd(line, plan, usdRate)));
}

export interface RepricedOrder<TItem> {
  lines: (TItem & { unitPrice: Prisma.Decimal; lineTotal: Prisma.Decimal })[];
  total: Prisma.Decimal;
  missingDeferredProductIds: string[];
}

/**
 * The lines of an existing order under another plan, from the order's OWN snapshots and never from
 * the current price list (hard rule 4). When a line has no price for the plan the result has
 * `missingDeferredProductIds` and must not be written.
 */
export function repriceForPlan<
  TItem extends PlanPrices & { productId: string; quantity: Prisma.Decimal },
>(items: readonly TItem[], plan: PaymentPlan): RepricedOrder<TItem> {
  const lines: RepricedOrder<TItem>['lines'] = [];
  const missingDeferredProductIds: string[] = [];
  for (const item of items) {
    const unitPrice = unitPriceForPlan(item, plan);
    if (unitPrice === null) {
      missingDeferredProductIds.push(item.productId);
      continue;
    }
    lines.push({ ...item, unitPrice, lineTotal: lineTotal(item.quantity, unitPrice) });
  }
  return {
    lines,
    total: sumAmounts(lines.map((line) => line.lineTotal)),
    missingDeferredProductIds,
  };
}
