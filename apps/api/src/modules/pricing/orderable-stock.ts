import { Prisma } from '../../generated/prisma/client.js';

// PURE. The one stock figure a customer may see [C, 2026-11-09]: how many whole pieces of a product
// can be ordered now. It is derived from what the staff stock page calls "available" (each live
// delivery line's quantity minus the holds of approved orders), so both always tell the same story.

/**
 * productId -> whole pieces a customer may order now. An entry of ZERO is a figure too: the product
 * is tracked and nothing is free (the sheet says zero, or approved orders hold everything), so it
 * is out of stock and cannot be ordered. A product WITHOUT an entry has no figure and no cap: its
 * stock is unknown (no stock aggregate) or not tracked (a staff-added product). The company brings
 * such goods on order, so they stay orderable in any quantity.
 */
export type OrderableStock = ReadonlyMap<string, Prisma.Decimal>;

/**
 * The figure of a TRACKED product from its free stock. Whole pieces only: half a piece cannot be
 * ordered. Nothing whole free is zero (out of stock), never "no figure": a product with 3 pieces is
 * capped at 3, so one with none cannot be unlimited. Whether a product has a figure at all is the
 * caller's question (does it have a stock aggregate, is it staff-added).
 */
export function orderablePieces(free: Prisma.Decimal): Prisma.Decimal {
  return Prisma.Decimal.max(free.floor(), 0);
}

/**
 * The figure as the JSON integer of the contracts; null = none. DECIMAL(18,3) stock stays far inside
 * the safe integer range, the clamp only keeps a corrupt value from becoming a wrong number.
 */
export function toPieceCount(pieces: Prisma.Decimal | null | undefined): number | null {
  if (pieces === null || pieces === undefined) return null;
  return Math.min(pieces.toNumber(), Number.MAX_SAFE_INTEGER);
}
