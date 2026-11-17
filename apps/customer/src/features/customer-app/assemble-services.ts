import { createGoodsSummary } from '@/features/customer-goods/composables/goods-summary';
import type { CustomerGoodsApi } from '@/features/customer-goods/api/customer-goods-api';
import type { CustomerHomeApi } from '@/features/customer-home/api/customer-home-api';
import type { MeResponse } from '@iorder/shared';
import type { CartApi } from '@/features/customer-cart/api/cart-api';
import { createCartStore } from '@/features/customer-cart/composables/cart-store';
import type { CustomerPriceApi } from '@/features/customer-catalog/api/customer-price-api';
import type { CustomerBalanceApi } from '@/features/customer-balance/api/customer-balance-api';
import type { CustomerOrdersApi } from '@/features/customer-orders/api/customer-orders-api';
import type { MeApi } from '@/features/customer-session/api/me-api';
import { readCustomerToken } from '@/features/customer-session/website-session';
import { readInitData } from '@core/telegram/launch';
import { createCustomerSession } from '@/features/customer-session/composables/customer-session';
import type { CustomerServices } from './services';

export interface CustomerApis {
  readonly meApi: MeApi;
  readonly goodsApi: CustomerGoodsApi;
  readonly priceApi: CustomerPriceApi;
  readonly cartApi: CartApi;
  readonly ordersApi: CustomerOrdersApi;
  readonly balanceApi: CustomerBalanceApi;
  readonly homeApi: CustomerHomeApi;
}

/** Wires the stores around a set of API adapters (real HTTP or the dev/test fakes). */
export function assembleCustomerServices(
  apis: CustomerApis,
  onMe?: (me: MeResponse) => void,
  initData: () => string | null = readInitData,
): CustomerServices {
  return {
    session: createCustomerSession({
      meApi: apis.meApi,
      readInitData: () => initData() ?? readCustomerToken(),
      onMe,
    }),
    goodsApi: apis.goodsApi,
    goods: createGoodsSummary(apis.goodsApi),
    priceApi: apis.priceApi,
    cart: createCartStore(apis.cartApi),
    ordersApi: apis.ordersApi,
    balanceApi: apis.balanceApi,
    homeApi: apis.homeApi,
  };
}
