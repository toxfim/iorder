import type { CustomerBalanceApi } from '@/features/customer-balance/api/customer-balance-api';
import type { CustomerAuthApi } from '@/features/customer-session/api/customer-auth-api';
import type { CustomerGoodsApi } from '@/features/customer-goods/api/customer-goods-api';
import type { CustomerHomeApi } from '@/features/customer-home/api/customer-home-api';
import type { GoodsSummaryStore } from '@/features/customer-goods/composables/goods-summary';
import { inject, type InjectionKey } from 'vue';
import type { CartStore } from '@/features/customer-cart/composables/cart-store';
import type { CustomerPriceApi } from '@/features/customer-catalog/api/customer-price-api';
import type { CustomerOrdersApi } from '@/features/customer-orders/api/customer-orders-api';
import type { CustomerSession } from '@/features/customer-session/composables/customer-session';

// Interfaces and the injection key only: this file is part of the production bundle and must
// never import a fake adapter.
export interface CustomerServices {
  readonly auth?: CustomerAuthApi;
  readonly goodsApi: CustomerGoodsApi;
  readonly goods: GoodsSummaryStore;
  readonly session: CustomerSession;
  readonly priceApi: CustomerPriceApi;
  readonly cart: CartStore;
  readonly ordersApi: CustomerOrdersApi;
  /** What the person's organization has to pay (the amount only). */
  readonly balanceApi: CustomerBalanceApi;
  /** The home recommendations of the person's organization. */
  readonly homeApi: CustomerHomeApi;
}

export const customerServicesKey: InjectionKey<CustomerServices> = Symbol('customer-services');

export function useCustomerServices(): CustomerServices {
  const services = inject(customerServicesKey);
  if (!services) throw new Error('Customer services were not provided to the app');
  return services;
}
