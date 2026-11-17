import type {
  CustomerHomeRecommendationsResponse,
  CustomerRecommendationItem,
} from '@iorder/shared';
import type { Prisma } from '../../../generated/prisma/client.js';
import { toCustomerPriceListResponse, type OrderableStock } from '../../pricing/index.js';
import type { HomeRecommendationsView } from '../customer-recommendations.service.js';

/**
 * Every card goes through the CUSTOMER PRICE LIST mapper (the one allow-list of what a customer
 * sees of a product, hard rule 7) and then drops the category, which the home does not show.
 * Nothing is spread from a product row.
 */
export function toCustomerHomeRecommendationsResponse(
  view: HomeRecommendationsView,
  images: ReadonlyMap<string, string>,
  orderableStock: OrderableStock,
): CustomerHomeRecommendationsResponse {
  if (view.list === null) return { reorder: [], matching: [], newerModel: null };
  const cards = new Map<string, CustomerRecommendationItem>();
  for (const item of toCustomerPriceListResponse(view.list, images, orderableStock).items) {
    // Every field but the category, named one by one: nothing is spread from the list item.
    cards.set(item.productId, {
      productId: item.productId,
      productCode: item.productCode,
      unit: item.unit,
      name: item.name,
      price: item.price,
      deferredPrice: item.deferredPrice,
      rrp: item.rrp,
      orderableStock: item.orderableStock,
      currency: item.currency,
      imageUrl: item.imageUrl,
      imageLargeUrl: item.imageLargeUrl,
    });
  }
  const cardOf = (productId: string): CustomerRecommendationItem => {
    const card = cards.get(productId);
    // The service picked every product from the same list; a miss is a programming error.
    if (card === undefined) throw new Error(`Recommended product ${productId} is not in the list`);
    return card;
  };
  return {
    reorder: view.reorder.map((row) => ({
      ...cardOf(row.product.product.id),
      usualQuantity: wholeQuantity(row.usualQuantity),
      lastReceivedAt: row.lastReceivedAt.toISOString(),
      timesOrdered: row.timesOrdered,
    })),
    matching: view.matching.map((row) => ({
      ...cardOf(row.product.product.id),
      boughtProductName: row.boughtProductName,
    })),
    newerModel:
      view.newerModel === null
        ? null
        : {
            ...cardOf(view.newerModel.product.product.id),
            replacesProductName: view.newerModel.replacesProductName,
            replacesTimesOrdered: view.newerModel.replacesTimesOrdered,
          },
  };
}

/** Whole pieces as the cart request wants them ("20", never "20.000"). */
function wholeQuantity(quantity: Prisma.Decimal): string {
  return quantity.toFixed(0);
}
