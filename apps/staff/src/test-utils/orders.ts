import type { Services } from '@/app/services';

import { fakeOrderId } from '@core/lib/fake-ids';
import { createTestServices, type TestServicesOptions } from './create-test-services';

/** The id the fake gives to the order with this display number (`IO-10491`). */
export const orderId = fakeOrderId;

/** Test services with the person already signed in, so the fake knows who is asking. */
export async function signedInServices(identityId: string, options: TestServicesOptions = {}) {
  const made = createTestServices({ ...options, identityId });
  await made.services.currentUser.ensureLoaded();
  return made;
}

/** Every order the person may see, read page by page like the store does. */
type Summary = Awaited<ReturnType<Services['ordersApi']['listOrders']>>['orders'][number];
type Detail = Awaited<ReturnType<Services['ordersApi']['getOrder']>>;

export async function listAll(services: Services): Promise<Summary[]> {
  const orders: Summary[] = [];
  let cursor: string | undefined;
  do {
    const page = await services.ordersApi.listOrders({ limit: 100, cursor });
    orders.push(...page.orders);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return orders;
}

/** The loaded list entry of an order, by display number. */
export function summaryByNumber(services: Services, number: string): Summary | undefined {
  return services.ordersStore.orders.value.find((o) => o.orderNumber === number);
}

/** The payment status of a loaded FULL list entry (the fulfilment roles have none). */
export function paymentOf(services: Services, number: string): string | undefined {
  const order = summaryByNumber(services, number);
  return order?.detail === 'FULL' ? order.paymentStatus : undefined;
}

/** The order as the signed-in person reads it from the api. */
export function detailByNumber(services: Services, number: string): Promise<Detail> {
  return services.ordersApi.getOrder(orderId(number));
}
