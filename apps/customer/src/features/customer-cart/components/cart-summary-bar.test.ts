import { describe, expect, it } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from '@/features/customer-app/messages/uz';
import { mountCustomerApp, useCustomerTestLifecycle } from '@/test-utils/customer-app';

useCustomerTestLifecycle();
const baseus = fakeUuid('customer-product:BASEUS-20W');
const glass = fakeUuid('customer-product:HOCO-GLASS-A15');

const text = (id: string): string | undefined =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim();

// The bar on the price list may never show a figure that reads as the charge when it is not.
describe('the cart bar on the price list', () => {
  it('names the sale total as a condition while no plan is chosen', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices', { plan: null });
    await services.cart.setQuantity(baseus, '2');
    await waitFor(() => expect(text('bar-total')).toBe("178 000 so'm"));
    expect(text('bar-plan')).toBe(customerUz.catalog.cartBar.ifFull);
  });

  it('shows the chosen plan with its own total', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices', { plan: null });
    await services.cart.setQuantity(baseus, '2');
    services.cart.choosePlan('DEFERRED');
    await waitFor(() => expect(text('bar-total')).toBe("195 800 so'm"));
    expect(text('bar-plan')).toBe(customerUz.plan.DEFERRED);
  });

  it('goes back to the condition when the chosen plan becomes impossible', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices', { plan: null });
    await services.cart.setQuantity(baseus, '1');
    services.cart.choosePlan('DEFERRED');
    await services.cart.setQuantity(glass, '1');
    await waitFor(() => expect(text('bar-plan')).toBe(customerUz.catalog.cartBar.ifFull));
    expect(text('bar-total')).toBe("125 000 so'm");
  });
});
