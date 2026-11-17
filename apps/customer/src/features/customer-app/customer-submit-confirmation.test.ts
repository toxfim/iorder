import { describe, expect, it, vi } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  click,
  findButton,
  findModalButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { cartFingerprint } from '@/features/customer-orders/composables/submit-key';
import { ApiConflictError } from '@core/lib/api-errors';
import { coreUz } from '@core/i18n/messages/uz';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();
const productId = fakeUuid('customer-product:BASEUS-20W');

describe('cart submission confirmation', () => {
  it('shows server totals and keeps the cart unchanged on cancel without submitting', async () => {
    const submit = vi.fn();
    const { services, router } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        const original = backend.ordersApi.submit;
        backend.ordersApi.submit = (key, request) => {
          submit(key, request);
          return original(key, request);
        };
      },
    });
    await services.cart.setQuantity(productId, '2');
    services.cart.choosePlan('FULL');
    await click(findButton(customerUz.cart.submit));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("178 000 so'm");
    expect(submit).not.toHaveBeenCalled();
    await click(findModalButton('Bekor qilish'));
    expect(services.cart.quantityOf(productId)).toBe('2');
    expect(submit).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('customer-cart');
  });

  it('submits once only after confirming, even if confirmation is double-clicked', async () => {
    const submit = vi.fn();
    const { services, router } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        const original = backend.ordersApi.submit;
        backend.ordersApi.submit = (key, request) => {
          submit(key, request);
          return original(key, request);
        };
      },
    });
    await services.cart.setQuantity(productId, '2');
    services.cart.choosePlan('FULL');
    await click(findButton(customerUz.cart.submit));
    expect(submit).not.toHaveBeenCalled();
    const confirm = findModalButton('Tasdiqlash va yuborish');
    confirm.click();
    confirm.click();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('invalidates confirmation when the cart changes before confirmation', async () => {
    const submit = vi.fn();
    const { services } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        backend.ordersApi.submit = submit;
      },
    });
    await services.cart.setQuantity(productId, '2');
    services.cart.choosePlan('FULL');
    await click(findButton(customerUz.cart.submit));
    await services.cart.setQuantity(productId, '3');
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('payment plan in the cart', () => {
  const glass = fakeUuid('customer-product:HOCO-GLASS-A15');
  const plan = (name: string): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>(`[data-testid="payment-plan-${name}"]`);

  it('starts with nothing chosen: both totals, no figure of its own, the button asks for the plan', async () => {
    const submit = vi.fn();
    const { services } = await mountCustomerApp('fake-owner', '/cart', {
      plan: null,
      decorate: (backend) => {
        backend.ordersApi.submit = submit;
      },
    });
    await services.cart.setQuantity(productId, '2');
    const choice = document.querySelector('[data-testid="payment-plan"]');
    await waitFor(() => expect(choice?.textContent).toContain("195 800 so'm"));
    expect(choice?.textContent).toContain("178 000 so'm");
    expect(document.querySelector('[data-testid="payment-plan-warning"]')?.textContent).toBe(
      customerUz.cart.plan.warning,
    );
    expect(plan('FULL')?.checked).toBe(false);
    expect(plan('DEFERRED')?.checked).toBe(false);
    expect(document.querySelector('[data-testid="summary-plan"]')?.textContent).toBe(
      customerUz.cart.plan.notChosen,
    );
    expect(document.querySelector('.summary__total')?.textContent).not.toContain('178 000');
    expect(document.querySelector('.line__total')).toBeNull();
    // Each line names both prices instead.
    const prices = [...document.querySelectorAll('[data-testid="line-plan-price"]')];
    expect(prices.map((p) => p.textContent?.trim())).toEqual([
      `${customerUz.plan.FULL}: 89 000 so'm`,
      expect.stringContaining('97 900'),
    ]);
    // The button does not say "order" yet, and pressing it never submits (the behaviour of the
    // press is covered in customer-cart/cart-plan-choice.test.ts).
    expect(() => findButton(customerUz.cart.submit)).toThrow();
    const button = findButton(customerUz.cart.plan.choose);
    expect(button.disabled).toBe(false);
    await click(button);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('the chosen plan prices the lines and goes to the server with its total', async () => {
    const submit = vi.fn();
    const { services, router } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        const original = backend.ordersApi.submit;
        backend.ordersApi.submit = (key, request) => {
          submit(key, request);
          return original(key, request);
        };
      },
    });
    await services.cart.setQuantity(productId, '2');
    await waitFor(() => expect(plan('DEFERRED')?.disabled).toBe(false));
    plan('DEFERRED')?.click();
    await waitFor(() =>
      expect(document.querySelector('[data-testid="summary-plan"]')?.textContent).toBe(
        customerUz.plan.DEFERRED,
      ),
    );
    expect(findButton(customerUz.cart.submit).disabled).toBe(false);
    expect(document.querySelector('.summary__total')?.textContent).toContain("195 800 so'm");
    expect(document.querySelector('.line__total')?.textContent).toContain("195 800 so'm");

    await click(findButton(customerUz.cart.submit));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[data-testid="confirm-plan"]')?.textContent).toBe(
      customerUz.plan.DEFERRED,
    );
    expect(dialog?.textContent).toContain("195 800 so'm");
    await click(findModalButton('Tasdiqlash va yuborish'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(submit).toHaveBeenCalledWith(expect.any(String), {
      paymentPlan: 'DEFERRED',
      expectedTotalAmount: '195800.00',
    });
    // The next order starts with nothing chosen again.
    expect(services.cart.paymentPlan.value).toBeNull();
  });

  it('a total refused by the server re-reads the cart and says why; the note goes with the cart', async () => {
    const { services, router } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        backend.ordersApi.submit = () =>
          Promise.reject(
            new ApiConflictError(
              'The total changed',
              'CONFLICT',
              { currentTotalAmount: '1.00' },
              'CART_TOTAL_CHANGED',
            ),
          );
      },
    });
    await services.cart.setQuantity(productId, '2');
    services.cart.choosePlan('FULL');
    await waitFor(() => expect(findButton(customerUz.cart.submit).disabled).toBe(false));
    const load = vi.spyOn(services.cart, 'load');
    await click(findButton(customerUz.cart.submit));
    await click(findModalButton('Tasdiqlash va yuborish'));
    await waitFor(() =>
      expect(document.querySelector('.summary__notes')?.textContent).toContain(
        coreUz.apiErrors.cartTotalChanged,
      ),
    );
    expect(router.currentRoute.value.name).toBe('customer-cart');
    expect(services.cart.quantityOf(productId)).toBe('2');
    load.mockRestore();
    services.cart.choosePlan('DEFERRED');
    await waitFor(() => expect(document.querySelector('.summary__notes')).toBeNull());
  });

  it('disables the plan and says why when a product has no deferred price', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/cart', { plan: null });
    await services.cart.setQuantity(productId, '1');
    await services.cart.setQuantity(glass, '1');
    await waitFor(() => expect(plan('DEFERRED')?.disabled).toBe(true));
    expect(document.querySelector('[data-testid="payment-plan-reason"]')?.textContent).toContain(
      'Himoya oynasi (Hoco, A15)',
    );
    expect(plan('FULL')?.checked).toBe(false);
  });

  it('clears to nothing and says so when the chosen plan becomes impossible', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/cart');
    await services.cart.setQuantity(productId, '1');
    await waitFor(() => expect(plan('DEFERRED')?.disabled).toBe(false));
    plan('DEFERRED')?.click();
    await waitFor(() => expect(services.cart.paymentPlan.value).toBe('DEFERRED'));
    await services.cart.setQuantity(glass, '1');
    await waitFor(() => expect(services.cart.paymentPlan.value).toBeNull());
    expect(document.querySelector('.summary__notes')?.textContent).toContain(
      customerUz.cart.plan.reset,
    );
    await services.cart.remove(glass);
    await waitFor(() => expect(document.querySelector('.summary__notes')).toBeNull());
  });

  it('the plan is part of the retry key: another plan never replays the old order', () => {
    const lines = [{ productId, quantity: '1.000' }];
    expect(cartFingerprint(lines, 'FULL')).not.toBe(cartFingerprint(lines, 'DEFERRED'));
  });
});
