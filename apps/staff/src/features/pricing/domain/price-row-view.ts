import type { PriceRow } from './price-rows';

// What one product of Narxlar shows, already formatted by the page (design «Narxlar — yakuniy
// sahifa», approved 2026-11-19), so the table, the C3·a card and the phone row only lay it out.

export type PriceStockTone = 'ok' | 'low' | 'out';

export interface PriceRowView {
  readonly row: PriceRow;
  readonly name: string;
  /** The free stock as text ("28 dona" / "Qolmagan"); null = not shown (unknown, by order, role). */
  readonly stock: { readonly text: string; readonly tone: PriceStockTone } | null;
  /** The standard sale price in the shown currency; null when it has none in that currency. */
  readonly sale: string | null;
  /** The standard deferred price in the shown currency; null = none. */
  readonly deferred: string | null;
  /** The sale price is below the latest cost. */
  readonly belowCost: boolean;
  /**
   * «Оптовик/Партнер» (always USD [owner 2026-11-19]). `fromStandard`: the tier has no price of
   * its own, so its customers see the standard prices ([P]); `price`/`deferred` are then the
   * standard ones in the shown currency.
   */
  readonly wholesale: {
    readonly price: string | null;
    readonly deferred: string | null;
    readonly fromStandard: boolean;
  };
  /** «Alif factoring» (always USD); null = not offered to that tier at all [C, 2026-11-12]. */
  readonly alif: { readonly price: string; readonly deferred: string | null } | null;
  /** Markup over the latest cost: "+13.3%" / "▼ 3.2%" and its full text; null = unknown/hidden. */
  readonly markup: { readonly short: string; readonly full: string } | null;
  /** "bugun 09:41" and who; null when not known. */
  readonly changed: { readonly when: string; readonly who: string | null } | null;
}
