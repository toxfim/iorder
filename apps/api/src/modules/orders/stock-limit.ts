import { ConflictError } from '../../common/errors/domain-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { toPieceCount, type OrderableStock } from '../pricing/index.js';

// PURE. A customer cannot order more pieces of a product than can be ordered now [C, 2026-11-09].
// The rule binds the CUSTOMER's cart and submit only: the manager's later edits of an order are not
// capped (the allocation plan warns there), and nothing here reserves stock (hard rule 10).

export interface StockLimitLine {
  productId: string;
  /** How many pieces can be ordered now; zero = out of stock. */
  orderableStock: Prisma.Decimal;
}

/**
 * The cap of a product; null = none (no figure: unknown or untracked stock). Zero is a cap: the
 * product is out of stock and every quantity exceeds it.
 */
export function stockLimitOf(stock: OrderableStock, productId: string): Prisma.Decimal | null {
  return stock.get(productId) ?? null;
}

export function exceedsStock(quantity: Prisma.Decimal, limit: Prisma.Decimal | null): boolean {
  return limit !== null && quantity.gt(limit);
}

/** The lines that ask for more than can be ordered now, in the order given. */
export function linesOverStock(
  items: readonly { productId: string; quantity: Prisma.Decimal }[],
  stock: OrderableStock,
): StockLimitLine[] {
  return items.flatMap((item) => {
    const limit = stockLimitOf(stock, item.productId);
    return limit !== null && exceedsStock(item.quantity, limit)
      ? [{ productId: item.productId, orderableStock: limit }]
      : [];
  });
}

/**
 * The typed refusal, the same for a cart change and a submit. `details.lines` carries the current
 * figure of each refused product so the client can show it (stockLimitExceededDetailsSchema).
 */
export function stockLimitExceeded(lines: readonly StockLimitLine[]): ConflictError {
  return new ConflictError(
    'More was asked for than can be ordered right now',
    'STOCK_LIMIT_EXCEEDED',
    {
      lines: lines.map((line) => ({
        productId: line.productId,
        orderableStock: toPieceCount(line.orderableStock),
      })),
    },
  );
}
