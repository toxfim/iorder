import { describe, expect, it, vi } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import { ApiConflictError } from '@core/lib/api-errors';
import { coreUz } from '@core/i18n/messages/uz';
import { waitFor } from '@core/test-utils/wait';
import {
  bodyText,
  click,
  confirmCartSubmission,
  findButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { FAKE_STAFF_ORDER_ORGANIZATION } from './api/fake-customer-data';
import { customerEn } from './messages/en';
import { customerRu } from './messages/ru';
import { customerUz } from './messages/uz';

// A company employee using the customer app as a viewer ([C] 2026-11-09). The fake backend mirrors
// the server: `fake-viewer` cannot place an order (production), `fake-viewer-ordering` can, into
// one test organization (staging). The app shows viewer mode from `/me` alone.

useCustomerTestLifecycle();
const productId = fakeUuid('customer-product:BASEUS-20W');

const notice = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="viewer-notice"]');
const submitButton = (): HTMLButtonElement => findButton(customerUz.cart.submit);

describe('the viewer notice', () => {
  it('opens the app for a viewer and says, on every page, that they view it as an employee', async () => {
    const { wrapper, router } = await mountCustomerApp('fake-viewer', '/prices');
    expect(wrapper.find('nav.tabs').exists()).toBe(true);
    expect(bodyText()).not.toContain(customerUz.entry.denied.title);
    expect(notice()?.textContent).toContain(customerUz.viewer.label);
    expect(notice()?.textContent).toContain(customerUz.viewer.notice);
    // The price list is there, like for a customer.
    expect(bodyText()).toContain('Baseus 20W zaryadlovchi');

    for (const path of ['/', '/orders', '/cart', '/profile', '/my-products']) {
      await router.push(path);
      await waitFor(() => expect(router.currentRoute.value.path).toBe(path));
      expect(notice()?.textContent, path).toContain(customerUz.viewer.notice);
    }
  });

  it('names the organization the order is written to when ordering is on', async () => {
    await mountCustomerApp('fake-viewer-ordering', '/prices');
    const expected = customerUz.viewer.noticeOrdering.replace(
      '{organization}',
      FAKE_STAFF_ORDER_ORGANIZATION,
    );
    expect(notice()?.textContent).toContain(expected);
    expect(notice()?.textContent).not.toContain(customerUz.viewer.notice);
  });

  it('a customer never sees it', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    expect(notice()).toBeNull();
  });

  it('an employee whose role does not open the app still gets the plain denied screen', async () => {
    const { wrapper } = await mountCustomerApp('fake-staff', '/prices');
    expect(bodyText()).toContain(customerUz.entry.denied.title);
    expect(wrapper.find('nav.tabs').exists()).toBe(false);
    expect(notice()).toBeNull();
  });

  it('has its texts in all three languages', () => {
    const keys = Object.keys(customerUz.viewer).sort();
    expect(Object.keys(customerRu.viewer).sort()).toEqual(keys);
    expect(Object.keys(customerEn.viewer).sort()).toEqual(keys);
    for (const catalog of [customerUz, customerRu, customerEn]) {
      for (const text of Object.values(catalog.viewer)) expect(text.trim()).not.toBe('');
      expect(catalog.viewer.noticeOrdering).toContain('{organization}');
    }
  });
});

describe('the cart of a viewer', () => {
  it('works, but the order button is off and says why', async () => {
    const submit = vi.fn();
    const { services } = await mountCustomerApp('fake-viewer', '/cart', {
      decorate: (backend) => {
        backend.ordersApi.submit = submit;
      },
    });
    await services.cart.setQuantity(productId, '2');
    expect(services.cart.quantityOf(productId)).toBe('2');
    expect(bodyText()).toContain('Baseus 20W zaryadlovchi');

    const button = submitButton();
    expect(button.disabled).toBe(true);
    const reason = document.querySelector<HTMLElement>('[data-testid="viewer-cannot-order"]');
    expect(reason?.textContent).toContain(customerUz.viewer.cannotOrder);
    // The reason is tied to the button for assistive technology.
    expect(button.getAttribute('aria-describedby')).toBe(reason?.id);

    await click(button);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('is not asked to choose a plan: the reason wins over "choose a plan"', async () => {
    const { services } = await mountCustomerApp('fake-viewer', '/cart', { plan: null });
    await services.cart.setQuantity(productId, '2');
    // Still "order", still off, with the reason: choosing a plan would not help an employee.
    const button = submitButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-step')).toBe('order');
    expect(
      [...document.querySelectorAll('button')].some((b) =>
        (b.textContent ?? '').includes(customerUz.cart.plan.choose),
      ),
    ).toBe(false);
    expect(document.querySelector('[data-testid="viewer-cannot-order"]')?.textContent).toContain(
      customerUz.viewer.cannotOrder,
    );

    await click(button);
    const choice = document.querySelector('[data-testid="payment-plan"]');
    expect(choice?.classList.contains('plan--attention')).toBe(false);
    expect(document.activeElement?.getAttribute('type')).not.toBe('radio');
  });

  it('with ordering on and no plan, is taken to the choice like a customer', async () => {
    const submit = vi.fn();
    const { services } = await mountCustomerApp('fake-viewer-ordering', '/cart', {
      plan: null,
      decorate: (backend) => {
        backend.ordersApi.submit = submit;
      },
    });
    await services.cart.setQuantity(productId, '2');
    const button = findButton(customerUz.cart.plan.choose);
    expect(button.disabled).toBe(false);
    await click(button);
    expect(
      document.querySelector('[data-testid="payment-plan"]')?.classList.contains('plan--attention'),
    ).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('is enabled when the server says ordering is on, and the order is placed', async () => {
    const submit = vi.fn();
    const { services, router } = await mountCustomerApp('fake-viewer-ordering', '/cart', {
      decorate: (backend) => {
        const original = backend.ordersApi.submit;
        backend.ordersApi.submit = (key, request) => {
          submit(key, request);
          return original(key, request);
        };
      },
    });
    await services.cart.setQuantity(productId, '2');
    expect(document.querySelector('[data-testid="viewer-cannot-order"]')).toBeNull();
    const button = submitButton();
    expect(button.disabled).toBe(false);

    await click(button);
    // The confirmation names the organization the order goes to; no contact is asked of staff.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      FAKE_STAFF_ORDER_ORGANIZATION,
    );
    await confirmCartSubmission();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(submit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(bodyText()).toContain(customerUz.placed.title));

    // The viewer finds the order they placed, and only that one.
    await router.push('/orders');
    await waitFor(() => expect(document.querySelectorAll('.card__number')).toHaveLength(1));
    expect(bodyText()).not.toContain(customerUz.orders.empty.title);
  });

  it('shows the server`s refusal in the person`s language if the order is refused after all', async () => {
    const { services, router } = await mountCustomerApp('fake-viewer-ordering', '/cart', {
      decorate: (backend) => {
        // The setting was switched off after the page loaded: the server is the authority.
        backend.ordersApi.submit = () =>
          Promise.reject(
            new ApiConflictError(
              'Staff members cannot place orders here',
              'CONFLICT',
              undefined,
              'STAFF_ORDERING_DISABLED',
            ),
          );
      },
    });
    await services.cart.setQuantity(productId, '2');
    await click(submitButton());
    await confirmCartSubmission();
    await waitFor(() => expect(bodyText()).toContain(coreUz.apiErrors.staffOrderingDisabled));
    expect(router.currentRoute.value.name).toBe('customer-cart');
    expect(services.cart.quantityOf(productId)).toBe('2');
  });
});

describe('the organization pages of a viewer are empty, not broken', () => {
  it('orders: the empty state', async () => {
    await mountCustomerApp('fake-viewer', '/orders');
    await waitFor(() => expect(bodyText()).toContain(customerUz.orders.empty.title));
    expect(document.querySelector('[data-state="error"]')).toBeNull();
    expect(document.querySelector('[data-state="denied"]')).toBeNull();
  });

  it('amount to pay: nothing due, no error', async () => {
    await mountCustomerApp('fake-viewer', '/profile');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="nothing-due"]')?.textContent).toContain(
        customerUz.balance.nothingDue,
      ),
    );
    expect(document.querySelector('[data-testid="amount-due"]')).toBeNull();
    expect(bodyText()).not.toContain(customerUz.balance.error);
  });

  it('profile: the viewer block instead of a shop, and no customer login section', async () => {
    await mountCustomerApp('fake-viewer', '/profile');
    expect(document.querySelector('[data-testid="viewer-profile"]')?.textContent).toContain(
      customerUz.viewer.noShop,
    );
    expect(bodyText()).not.toContain(customerUz.presentation.groupLinked);
    // Nothing promises a contact form: employees enter none.
    expect(bodyText()).not.toContain(customerUz.presentation.phoneMissing);
    expect(document.querySelector('.credentials__title')).toBeNull();
  });

  it('a customer keeps the shop block on the profile', async () => {
    await mountCustomerApp('fake-owner', '/profile');
    expect(bodyText()).toContain(customerUz.presentation.groupLinked);
    expect(document.querySelector('[data-testid="viewer-profile"]')).toBeNull();
  });

  it('home and my products open without an error or a denial', async () => {
    for (const path of ['/', '/my-products']) {
      await mountCustomerApp('fake-viewer', path);
      await waitFor(() => expect(notice()).not.toBeNull());
      expect(document.querySelector('[data-state="error"]'), path).toBeNull();
      expect(document.querySelector('[data-state="denied"]'), path).toBeNull();
      expect(bodyText(), path).not.toContain(customerUz.entry.denied.title);
    }
  });
});
