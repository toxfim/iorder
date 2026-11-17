import { PRICE_LIST_CURRENCIES, type PriceListCurrency } from '@iorder/shared';
import type { ByOrderProduct, ByOrderProductsResponse } from '@iorder/shared/staff-cost';
import { formatMoney } from '../../pricing/index.js';
import type { ByOrderProductView } from '../by-order-products.js';

// Explicit allow-list (hard rule 7): every field is named here, nothing is spread from a catalog
// view, a price row or an order line. STAFF-ONLY: no customer endpoint may carry this type.

/** Pieces with three fraction digits, like the stock lists. */
const QUANTITY_DIGITS = 3;

function currencyOf(value: string): PriceListCurrency {
  const known = PRICE_LIST_CURRENCIES.find((currency) => currency === value);
  if (known === undefined) throw new Error(`Unknown price list currency: ${value}`);
  return known;
}

function toByOrderProduct(view: ByOrderProductView): ByOrderProduct {
  const { product, price } = view;
  return {
    productId: product.id,
    productCode: product.productCode,
    name: view.name,
    brandName: view.brandName,
    category: product.category,
    isActive: product.isActive && product.mergedIntoProductId === null,
    basePrice: price === null ? null : formatMoney(price.basePrice),
    deferredPrice:
      price === null || price.deferredPrice === null ? null : formatMoney(price.deferredPrice),
    currency: price === null ? null : currencyOf(price.currency),
    openQuantity: view.openQuantity.toFixed(QUANTITY_DIGITS),
    openOrderCount: view.orders.length,
    orders: view.orders.map((line) => ({
      orderId: line.orderId,
      orderNumber: line.orderNumber,
      organizationName: line.organizationName,
      status: line.status,
      quantity: line.quantity.toFixed(QUANTITY_DIGITS),
      submittedAt: line.submittedAt.toISOString(),
    })),
  };
}

export function toByOrderProductsResponse(
  views: readonly ByOrderProductView[],
): ByOrderProductsResponse {
  return { items: views.map(toByOrderProduct) };
}
