import type { PriceListCurrency, StaffPriceChange } from '@iorder/shared';
import type { StaffPriceListWithRateResponse } from '@iorder/shared/staff-cost';
import type { LocalizedName } from './localized-name';

/** The two prices of a row in one currency; null = none (or not known in that currency). */
export interface PriceAmounts {
  readonly price: string | null;
  readonly deferredPrice: string | null;
}

export interface SheetMatch {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string;
}

/** One product of a published price list version, as the read-only screens show it. */
export interface PriceRow {
  readonly productId: string;
  readonly productCode: string;
  /** Always PIECE_UNIT (pieces only); shown through formatUnit. */
  readonly unit: string;
  readonly isActive: boolean;
  /** A staff-added product without a sheet «Товар_ID» [C, 2026-11-09]: no stock is ever shown. */
  readonly codeGenerated: boolean;
  /** For a generated-code product: the sheet product with the same name (the likely merge target). */
  readonly sheetMatch: SheetMatch | null;
  readonly names: readonly LocalizedName[];
  /** The sale price ("Цена") as stored, in `currency` (USD since 2026-10-29). */
  readonly price: string;
  /** The deferred-payment price ("Отсрочка") as stored; null = none. */
  readonly deferredPrice: string | null;
  /** The recommended retail price (RRP) as stored, in `currency` [C, 2026-11-09]; null = none. */
  readonly rrp: string | null;
  /**
   * The «Оптовик/Партнер» tier as stored, in `currency` [C, owner 2026-11-11]; null = none (that
   * tier's customers then see the standard prices). The api sends no so'm figure for them.
   */
  readonly wholesalePrice: string | null;
  readonly wholesaleDeferredPrice: string | null;
  /**
   * The «Alif factoring» tier as stored, in `currency` [C, owner 2026-11-12]; null = none (the
   * product is then not offered to that tier's customers at all).
   */
  readonly alifPrice: string | null;
  readonly alifDeferredPrice: string | null;
  readonly currency: PriceListCurrency;
  /** Both prices in so'm at the current rate; null = a USD price while no rate is set. */
  readonly uzs: PriceAmounts | null;
  /** The brand by the price list file's rule (staff choice, else the brand finder); null = none. */
  readonly brand: string | null;
  /** When and by whom the product's prices last changed; null when not known (not the current list). */
  readonly lastChange: StaffPriceChange | null;
  /** The primary photo (thumb and large variant); null without one. */
  readonly imageUrl: string | null;
  readonly imageLargeUrl: string | null;
}

export function toPriceRows(list: StaffPriceListWithRateResponse | null): PriceRow[] {
  return (list?.items ?? [])
    .map((item) => ({
      productId: item.productId,
      productCode: item.productCode,
      unit: item.unit,
      isActive: item.isActive,
      codeGenerated: item.codeGenerated,
      sheetMatch: item.sheetMatch,
      names: item.names,
      price: item.basePrice,
      deferredPrice: item.deferredPrice,
      rrp: item.rrp,
      wholesalePrice: item.wholesalePrice,
      wholesaleDeferredPrice: item.wholesaleDeferredPrice,
      alifPrice: item.alifPrice,
      alifDeferredPrice: item.alifDeferredPrice,
      currency: item.currency,
      uzs: item.uzs && { price: item.uzs.basePrice, deferredPrice: item.uzs.deferredPrice },
      brand: item.brand,
      lastChange: item.lastChange,
      imageUrl: item.imageUrl,
      imageLargeUrl: item.imageLargeUrl,
    }))
    .sort((a, b) => a.productCode.localeCompare(b.productCode));
}

/**
 * The row's prices in the currency the page shows. Prices are kept in USD [owner 2026-10-29]; an
 * older row priced in so'm has no USD amount (it gets one when it is re-priced).
 */
export function amountsIn(row: PriceRow, currency: PriceListCurrency): PriceAmounts {
  if (currency === 'UZS') return row.uzs ?? { price: null, deferredPrice: null };
  return row.currency === 'USD'
    ? { price: row.price, deferredPrice: row.deferredPrice }
    : { price: null, deferredPrice: null };
}

/** The row's «Оптовик/Партнер» prices in USD; both null when it has none (or an older so'm row). */
export function wholesaleUsd(row: PriceRow): PriceAmounts {
  return row.currency === 'USD'
    ? { price: row.wholesalePrice, deferredPrice: row.wholesaleDeferredPrice }
    : { price: null, deferredPrice: null };
}

/** The row's «Alif factoring» prices in USD; both null when it has none (or an older so'm row). */
export function alifUsd(row: PriceRow): PriceAmounts {
  return row.currency === 'USD'
    ? { price: row.alifPrice, deferredPrice: row.alifDeferredPrice }
    : { price: null, deferredPrice: null };
}
