import type { PriceTier } from '@iorder/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ProductView } from '../catalog/index.js';
import type { VersionStatus } from './version-status.js';

export interface VersionView {
  id: string;
  number: number;
  status: VersionStatus;
  publishedAt: Date | null;
  publishedBy: string | null;
  note: string | null;
  source: 'MANUAL' | 'SHEET_IMPORT';
  createdAt: Date;
}

export interface VersionSummaryView extends VersionView {
  itemCount: number;
}

/**
 * The prices of one item: sale ("Цена"), optional deferred-payment ("Отсрочка", null = none) and the
 * optional recommended retail price ("RRP" [C, 2026-11-09], null = none). An order is charged at the
 * first or the second; the RRP is information for the customer and never enters a total.
 */
export interface ItemPrices {
  basePrice: Prisma.Decimal;
  deferredPrice: Prisma.Decimal | null;
  rrp: Prisma.Decimal | null;
  /**
   * The «Оптовик/Партнер» tier [C, owner 2026-11-11]: null = none (that tier then gets the STANDARD
   * prices [P]). Never in a customer-facing view: `resolveTier` replaces base/deferred with the
   * caller's tier and clears these.
   */
  wholesalePrice: Prisma.Decimal | null;
  wholesaleDeferredPrice: Prisma.Decimal | null;
  /**
   * The «Alif factoring» tier [C, owner 2026-11-12]: null sale price = the product is NOT offered to
   * that tier (no fallback). Cleared in a customer-facing view like the wholesale prices.
   */
  alifPrice: Prisma.Decimal | null;
  alifDeferredPrice: Prisma.Decimal | null;
}

export interface ItemView extends ItemPrices {
  productId: string;
  currency: string;
}

/** An item joined with its product (the join is done in the service through CatalogService). */
export interface PricedProduct extends ItemPrices {
  product: ProductView;
  currency: string;
  /** The prices in UZS at the list's `usdRate`; null = a USD price while no rate is known. */
  uzs: ItemPrices | null;
  /** The prices as the list has them in USD; null = a legacy so'm item. Staff-only: the order snapshot. */
  usd: ItemPrices | null;
}

export interface PriceListView {
  version: VersionView;
  /**
   * The tier `basePrice`/`deferredPrice` are in: set on a customer (or export) view, whose wholesale
   * fields are then null; null on the staff view, which carries both tiers.
   */
  priceTier: PriceTier | null;
  items: PricedProduct[];
  /** The USD rate in force when the list was read (staff-only value); null = none set yet. */
  usdRate: Prisma.Decimal | null;
}

export interface PriceHistoryEntry {
  versionId: string;
  versionNumber: number;
  publishedAt: Date;
  publishedBy: string;
  source: 'MANUAL' | 'SHEET_IMPORT';
  /** null = the product was not in the previous published version. */
  oldPrice: Prisma.Decimal | null;
  /** null = the product was removed from the list in this version. */
  newPrice: Prisma.Decimal | null;
  oldDeferredPrice: Prisma.Decimal | null;
  newDeferredPrice: Prisma.Decimal | null;
  oldRrp: Prisma.Decimal | null;
  newRrp: Prisma.Decimal | null;
  oldCurrency: string;
  currency: string;
}

/** The latest published version that changed a product's prices ("O'zgargan" in Narxlar). */
export interface LastPriceChange {
  versionNumber: number;
  publishedAt: Date;
  /** The publisher's user id; null when the version records none. */
  publishedBy: string | null;
}
