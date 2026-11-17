import {
  ORDER_ROUTES,
  cartResponseSchema,
  type CartResponse,
  type SetCartItemRequest,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/** The cart of the signed-in person in their organization. Every call answers the priced cart. */
export interface CartApi {
  get: () => Promise<CartResponse>;
  setItem: (productId: string, request: SetCartItemRequest) => Promise<CartResponse>;
  /** Removing a product that is not in the cart is not an error. */
  removeItem: (productId: string) => Promise<CartResponse>;
}

export function createHttpCartApi(http: HttpClient): CartApi {
  return {
    get: () => http.request(ORDER_ROUTES.getCart, cartResponseSchema),
    setItem: (productId, request) =>
      http.request(ORDER_ROUTES.setCartItem, cartResponseSchema, {
        params: { productId },
        body: request,
      }),
    removeItem: (productId) =>
      http.request(ORDER_ROUTES.removeCartItem, cartResponseSchema, { params: { productId } }),
  };
}
