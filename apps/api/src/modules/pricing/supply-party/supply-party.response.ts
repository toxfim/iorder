import type { SupplyListResponse } from '@iorder/shared/staff-cost';
import type { SupplyView } from './supply-party.service.js';

// STAFF-ONLY explicit allow-list mapper: no cost and no supplier, ever.

export function toSupplyListResponse(page: {
  items: readonly SupplyView[];
  total: number;
}): SupplyListResponse {
  return {
    total: page.total,
    items: page.items.map((supply) => ({
      deliveryRef: supply.deliveryRef,
      productCount: supply.productCount,
      products: supply.products.map((product) => ({
        productCode: product.productCode,
        names: product.translations.map((t) => ({ lang: t.lang, name: t.name })),
      })),
      totalQuantity: supply.totalQuantity.toFixed(3),
      deliveredAt: supply.deliveredAt.toISOString(),
      partyNumber: supply.partyNumber,
    })),
  };
}
