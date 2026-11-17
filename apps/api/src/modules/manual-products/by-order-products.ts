import { commonProductName } from '@iorder/shared';
import { Prisma } from '../../generated/prisma/client.js';
import type { BrandView, ProductView } from '../catalog/index.js';
import type { OpenDemandLine } from '../orders/index.js';
import type { ItemView } from '../pricing/index.js';

// The "by order" list (staff vocabulary [C, owner 2026-11-09]: a staff-added product without a
// sheet «Товар_ID» is brought when an order arrives). Pure: what the services read goes in, the
// rows of the page come out, so the counting and the order of the rows are tested without a
// database.

/** A by-order product with the open orders that wait for it. No cost, no stock: it has neither. */
export interface ByOrderProductView {
  product: ProductView;
  name: string;
  brandName: string | null;
  /** The published prices; null when the product is not in the list. */
  price: Pick<ItemView, 'basePrice' | 'deferredPrice' | 'currency'> | null;
  openQuantity: Prisma.Decimal;
  /** The order that waits longest first. */
  orders: OpenDemandLine[];
}

export interface ByOrderInput {
  products: readonly ProductView[];
  brands: ReadonlyMap<string, BrandView | null>;
  /** Items of the PUBLISHED list (any product). */
  publishedItems: readonly ItemView[];
  /** Open lines, oldest order first (the order the orders module returns them in). */
  lines: readonly OpenDemandLine[];
}

// UTF-16 code unit order, the same on every server (localeCompare depends on the ICU data).
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function byName(a: ByOrderProductView, b: ByOrderProductView): number {
  return (
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.product.productCode, b.product.productCode)
  );
}

/**
 * Products that are needed now first, the one whose order waits longest at the top [P]; then the
 * rest by name. A product an order waits for is never dropped, whatever its state.
 */
export function buildByOrderProducts(input: ByOrderInput): ByOrderProductView[] {
  const prices = new Map(input.publishedItems.map((item) => [item.productId, item]));
  const linesOf = new Map<string, OpenDemandLine[]>();
  for (const line of input.lines) {
    const list = linesOf.get(line.productId);
    if (list === undefined) linesOf.set(line.productId, [line]);
    else list.push(line);
  }
  const rows = input.products.map((product): ByOrderProductView => {
    const orders = linesOf.get(product.id) ?? [];
    const item = prices.get(product.id);
    return {
      product,
      name: commonProductName(product.translations, product.productCode),
      brandName: input.brands.get(product.id)?.name ?? null,
      price:
        item === undefined
          ? null
          : {
              basePrice: item.basePrice,
              deferredPrice: item.deferredPrice,
              currency: item.currency,
            },
      openQuantity: orders.reduce((sum, line) => sum.plus(line.quantity), new Prisma.Decimal(0)),
      orders,
    };
  });
  const oldest = (row: ByOrderProductView): number =>
    row.orders[0]?.submittedAt.getTime() ?? Number.POSITIVE_INFINITY;
  return rows.sort((a, b) => {
    const needed = Number(b.orders.length > 0) - Number(a.orders.length > 0);
    if (needed !== 0) return needed;
    // Two idle products are both "infinitely" far: fall through to the name.
    const waiting = a.orders.length > 0 ? oldest(a) - oldest(b) : 0;
    return waiting || byName(a, b);
  });
}
