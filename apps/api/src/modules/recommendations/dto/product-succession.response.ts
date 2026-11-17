import { commonProductName } from '@iorder/shared';
import type {
  ProductSuccession,
  ProductSuccessionListResponse,
  ProductSuccessionProduct,
} from '@iorder/shared/staff-cost';
import type { ProductView } from '../../catalog/index.js';
import type { SuccessionRow } from '../recommendations.repository.js';
import type { SuccessionListView } from '../product-successions.service.js';

/** Actor id -> display name; an unknown id shows as "unknown" and never as the id. */
export type PersonNames = ReadonlyMap<string, string>;

function toSide(
  productId: string,
  products: ReadonlyMap<string, ProductView>,
  priced: ReadonlySet<string>,
): ProductSuccessionProduct {
  const product = products.get(productId);
  // The foreign keys guarantee the product exists; a miss is a programming error.
  if (product === undefined) throw new Error(`Product ${productId} of a succession is unknown`);
  return {
    productId: product.id,
    productCode: product.productCode,
    name: commonProductName(product.translations, product.productCode),
    priced: priced.has(product.id),
    isActive: product.isActive,
  };
}

export function toProductSuccession(
  row: SuccessionRow,
  products: ReadonlyMap<string, ProductView>,
  priced: ReadonlySet<string>,
  names: PersonNames,
): ProductSuccession {
  return {
    id: row.id,
    older: toSide(row.olderProductId, products, priced),
    newer: toSide(row.newerProductId, products, priced),
    status: row.status,
    proposedAt: row.proposedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy === null ? null : (names.get(row.decidedBy) ?? 'unknown'),
    decidedByUserId: row.decidedBy !== null && names.has(row.decidedBy) ? row.decidedBy : null,
  };
}

export function toProductSuccessionListResponse(
  view: SuccessionListView,
  names: PersonNames,
): ProductSuccessionListResponse {
  return {
    items: view.rows.map((row) => toProductSuccession(row, view.products, view.priced, names)),
    counts: { ...view.counts },
  };
}
