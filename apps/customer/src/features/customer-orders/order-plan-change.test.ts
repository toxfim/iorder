import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import { ApiConflictError } from '@core/lib/api-errors';
import { waitFor } from '@core/test-utils/wait';
import {
  CUSTOMER_TEST_NOW,
  click,
  findModalButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { customerUz } from '@/features/customer-app/messages/uz';

useCustomerTestLifecycle();
const productId = fakeUuid('customer-product:BASEUS-20W');

const control = (): Element | null => document.querySelector('[data-testid="plan-change"]');
const option = (name: string): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(`[data-testid="payment-plan-${name}"]`);
const planRow = (): string | null | undefined =>
  document.querySelector('[data-testid="order-payment-plan"]')?.textContent;

/** Places an order at 2 x 89 000 in full and opens its page. */
async function openPlacedOrder(): ReturnType<typeof mountCustomerApp> {
  const app = await mountCustomerApp('fake-owner', '/cart');
  const { services, router } = app;
  await services.cart.setQuantity(productId, '2');
  const { totalAmount } = services.cart.cart.value ?? { totalAmount: '0' };
  const order = await services.ordersApi.submit('order-plan-change-key', {
    paymentPlan: 'FULL',
    expectedTotalAmount: totalAmount,
  });
  services.cart.clear();
  await router.push({ name: 'customer-order', params: { id: order.id } });
  await waitFor(() => expect(planRow()).toContain(customerUz.plan.FULL));
  return app;
}

describe('the customer changes the plan on the order page', () => {
  // Only the date: the device clock agrees with the fake backend's, the countdown still ticks.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CUSTOMER_TEST_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows both totals and the time; the change needs a confirmation with the new total', async () => {
    const { services } = await openPlacedOrder();
    await waitFor(() => expect(control()).not.toBeNull());
    expect(control()?.textContent).toContain("178 000 so'm");
    expect(control()?.textContent).toContain("195 800 so'm");
    expect(document.querySelector('[data-testid="plan-change-time"]')?.textContent).toMatch(
      /\d:\d\d/,
    );
    expect(option('FULL')?.checked).toBe(true);
    // The same visible choice as in the cart, but a plan is already made: the title only names
    // it, with no "required" mark and no "choose here" ring.
    expect(control()?.querySelector('legend')?.textContent?.trim()).toBe(
      customerUz.cart.plan.title,
    );
    expect(control()?.querySelector('[data-testid="payment-plan-required"]')).toBeNull();
    expect(option('FULL')?.required).toBe(false);
    expect(control()?.querySelector('.plan--attention')).toBeNull();
    expect(option('FULL')?.closest('label')?.querySelector('.plan__circle')).not.toBeNull();
    expect(option('FULL')?.closest('label')?.classList.contains('plan__option--on')).toBe(true);

    option('DEFERRED')?.click();
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("195 800 so'm"),
    );
    const change = vi.spyOn(services.ordersApi, 'changePaymentPlan');
    await click(findModalButton(customerUz.order.planChange.confirmAction));
    await waitFor(() => expect(planRow()).toContain(customerUz.plan.DEFERRED));
    expect(change).toHaveBeenCalledWith(expect.any(String), {
      paymentPlan: 'DEFERRED',
      expectedRowVersion: 1,
    });
    expect(document.querySelector('.order-total')?.textContent).toContain("195 800 so'm");
    expect(option('DEFERRED')?.checked).toBe(true);
    // The change moved the amount to pay, so the history names it: the plans and both totals.
    const row = document.querySelector(
      '[data-testid="order-history"] > li[data-kind="PLAN_CHANGED"]',
    );
    expect(row?.textContent).toContain(customerUz.order.history.PLAN_CHANGED);
    expect(row?.textContent).toContain(`${customerUz.plan.FULL} → ${customerUz.plan.DEFERRED}`);
    expect(row?.textContent).toContain("Jami: 178 000 so'm → 195 800 so'm");
  });

  it('cancelling the confirmation changes nothing and the option can be tapped again', async () => {
    const { services } = await openPlacedOrder();
    await waitFor(() => expect(control()).not.toBeNull());
    const change = vi.spyOn(services.ordersApi, 'changePaymentPlan');
    option('DEFERRED')?.click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await click(findModalButton('Bekor qilish'));
    await waitFor(() => expect(option('FULL')?.checked).toBe(true));
    expect(change).not.toHaveBeenCalled();
    option('DEFERRED')?.click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  });

  it('hides the control when the server refuses, even if the fresh read fails', async () => {
    const { services } = await openPlacedOrder();
    await waitFor(() => expect(control()).not.toBeNull());
    vi.spyOn(services.ordersApi, 'changePaymentPlan').mockRejectedValue(
      new ApiConflictError('Over', 'CONFLICT', undefined, 'PAYMENT_PLAN_WINDOW_ENDED'),
    );
    vi.spyOn(services.ordersApi, 'get').mockRejectedValue(new Error('offline'));
    option('DEFERRED')?.click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await click(findModalButton(customerUz.order.planChange.confirmAction));
    await waitFor(() => expect(control()).toBeNull());
    expect(planRow()).toContain(customerUz.plan.FULL);
  });

  it('hides the control when the time ends on the screen', async () => {
    await openPlacedOrder();
    await waitFor(() => expect(control()).not.toBeNull());
    vi.setSystemTime(new Date(CUSTOMER_TEST_NOW.getTime() + 3 * 60 * 1000));
    await waitFor(() => expect(control()).toBeNull());
    expect(planRow()).toContain(customerUz.plan.FULL);
  });

  it('shows no control on an order without an end time', async () => {
    const { router, services } = await mountCustomerApp('fake-owner', '/orders');
    const { orders } = await services.ordersApi.list();
    const seeded = orders.find((order) => order.status === 'SUBMITTED');
    expect(seeded).toBeDefined();
    await router.push({ name: 'customer-order', params: { id: seeded?.id ?? '' } });
    await waitFor(() => expect(planRow()).not.toBeUndefined());
    expect(control()).toBeNull();
  });
});
