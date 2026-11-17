import { describe, expect, it, vi } from 'vitest';
import { ApiConflictError, ApiRateLimitedError, ApiValidationError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  bodyText,
  confirmCartSubmission,
  click,
  findButton,
  findModalButton,
  mountCustomerApp,
  typeInto,
  useCustomerTestLifecycle,
  type MountOptions,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();

const productId = (code: string): string => fakeUuid(`customer-product:${code}`);
const field = (index: number): HTMLInputElement =>
  document.body.querySelectorAll<HTMLInputElement>('.modal input')[index] as HTMLInputElement;
const dialogOpen = (): boolean => document.body.querySelector('.modal') !== null;

type Backend = Parameters<NonNullable<MountOptions['decorate']>>[0];

async function newcomerWithCart(decorate?: (backend: Backend) => void) {
  const mounted = await mountCustomerApp('fake-newcomer', '/cart', { decorate });
  await mounted.services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
  await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
  return mounted;
}

async function fillContact(name: string, digits: string): Promise<void> {
  await typeInto(field(0), name);
  await typeInto(field(1), digits);
}

describe('the contact asked at the first order', () => {
  it('asks once, saves the contact and then places the order by itself', async () => {
    const submit = vi.fn();
    const setContact = vi.fn();
    const { services, router } = await newcomerWithCart((backend) => {
      const originalSubmit = backend.ordersApi.submit;
      backend.ordersApi.submit = (key, request) => {
        submit(key);
        return originalSubmit(key, request);
      };
      const originalSet = backend.meApi.setContact;
      backend.meApi.setContact = (request) => {
        setContact(request);
        return originalSet(request);
      };
    });
    expect(services.session.needsContact.value).toBe(true);

    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    expect(dialogOpen()).toBe(true);
    expect(bodyText()).toContain(customerUz.contact.title);
    expect(submit).not.toHaveBeenCalled();
    // The name starts from the one the person has; the phone starts empty.
    expect(field(0).value).toBe('Dilshod Karimov');
    expect(field(1).value).toBe('');

    await fillContact('  Dilshod Karimov ', '998935550147');
    expect(field(1).value).toBe('998 93 555 0147');
    await click(findModalButton(customerUz.contact.submit));

    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(setContact).toHaveBeenCalledTimes(1);
    expect(setContact).toHaveBeenCalledWith({
      fullName: 'Dilshod Karimov',
      phone: '+998935550147',
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(services.session.needsContact.value).toBe(false);
    // The phone is never put into the storage or the URL.
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('935550147');
    expect(router.currentRoute.value.fullPath).not.toContain('935550147');
  });

  it('the second order does not ask again', async () => {
    const { services, router } = await newcomerWithCart();
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await fillContact('Dilshod Karimov', '998935550147');
    await click(findModalButton(customerUz.contact.submit));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));

    await router.push('/cart');
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '2');
    // The first order's plan is not carried over.
    services.cart.choosePlan('FULL');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(dialogOpen()).toBe(false);
  });

  it('a customer who already has a phone never sees the dialog', async () => {
    const { services, router } = await mountCustomerApp('fake-owner', '/cart');
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(bodyText()).not.toContain(customerUz.contact.title);
  });

  it('validates before any request: an empty name or a short phone sends nothing', async () => {
    const setContact = vi.fn();
    await newcomerWithCart((backend) => {
      const original = backend.meApi.setContact;
      backend.meApi.setContact = (request) => {
        setContact(request);
        return original(request);
      };
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await fillContact('   ', '99877');
    await click(findModalButton(customerUz.contact.submit));
    expect(setContact).not.toHaveBeenCalled();
    expect(bodyText()).toContain(customerUz.contact.errors.name);
    expect(bodyText()).toContain(customerUz.contact.errors.phone);
    expect(field(1).getAttribute('aria-invalid')).toBe('true');
    expect(field(1).getAttribute('aria-describedby')).toBeTruthy();
    expect(dialogOpen()).toBe(true);
  });

  it('Enter while an IME is composing does not save; a plain Enter does', async () => {
    const setContact = vi.fn();
    await newcomerWithCart((backend) => {
      const original = backend.meApi.setContact;
      backend.meApi.setContact = (request) => {
        setContact(request);
        return original(request);
      };
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await fillContact('Dilshod Karimov', '998935550147');
    const press = (init: KeyboardEventInit): void => {
      field(0).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }),
      );
    };
    press({ isComposing: true });
    press({ keyCode: 229 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setContact).not.toHaveBeenCalled();
    press({});
    await waitFor(() => expect(setContact).toHaveBeenCalledTimes(1));
  });

  it('keeps only digits in the phone field', async () => {
    await newcomerWithCart();
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await typeInto(field(1), '+998 (93) abc 555-01-47');
    expect(field(1).value).toBe('998 93 555 0147');
  });

  it('closing the dialog sends nothing and keeps the cart', async () => {
    const submit = vi.fn();
    const { services } = await newcomerWithCart((backend) => {
      const original = backend.ordersApi.submit;
      backend.ordersApi.submit = (key, request) => {
        submit(key, request);
        return original(key, request);
      };
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    expect(dialogOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(submit).not.toHaveBeenCalled();
    expect(services.cart.itemCount.value).toBe(1);
    expect(services.session.needsContact.value).toBe(true);
  });

  it('a stale client: the server says CONTACT_REQUIRED, the same dialog opens and the order follows', async () => {
    let refuse = true;
    const { services, router } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        const original = backend.ordersApi.submit;
        backend.ordersApi.submit = (key, request) => {
          if (!refuse) return original(key, request);
          refuse = false;
          return Promise.reject(
            new ApiConflictError('x', 'CONFLICT', undefined, 'CONTACT_REQUIRED'),
          );
        };
      },
    });
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    expect(services.session.needsContact.value).toBe(false);
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    expect(dialogOpen()).toBe(true);
    expect(window.sessionStorage.getItem('iorder.submitKey')).toBeNull();
    // Same values as stored: the server treats a repeat as a no-op.
    await fillContact('Anvar Soliyev', '998901112233');
    await click(findModalButton(customerUz.contact.submit));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
  });

  it('a refusal without a field stays open with one general text and places no order', async () => {
    const submit = vi.fn();
    await newcomerWithCart((backend) => {
      backend.meApi.setContact = () => Promise.reject(new ApiConflictError('x', 'CONFLICT'));
      const original = backend.ordersApi.submit;
      backend.ordersApi.submit = (key, request) => {
        submit(key, request);
        return original(key, request);
      };
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await fillContact('Dilshod Karimov', '998935550147');
    await click(findModalButton(customerUz.contact.submit));
    expect(dialogOpen()).toBe(true);
    expect(document.body.querySelector('.modal .confirm__error[role="alert"]')).not.toBeNull();
    expect(document.body.querySelector('.modal .field__error')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows a rate-limit text for 429', async () => {
    await newcomerWithCart((backend) => {
      backend.meApi.setContact = () =>
        Promise.reject(new ApiRateLimitedError('x', 'RATE_LIMITED', 30));
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await fillContact('Dilshod Karimov', '998935550147');
    await click(findModalButton(customerUz.contact.submit));
    expect(bodyText()).toContain(customerUz.contact.errors.rateLimited);
    expect(dialogOpen()).toBe(true);
  });

  describe('a server validation error is shown for the field it names', () => {
    const alertText = (): string =>
      document.body.querySelector('.modal [role="alert"]')?.textContent?.trim() ?? '';

    async function failWith(issues: { path: string; message: string }[]): Promise<void> {
      await newcomerWithCart((backend) => {
        backend.meApi.setContact = () =>
          Promise.reject(new ApiValidationError('x', 'VALIDATION_FAILED', issues));
      });
      await click(findButton(customerUz.cart.submit));
      await confirmCartSubmission();
      await fillContact('Dilshod Karimov', '998935550147');
      await click(findModalButton(customerUz.contact.submit));
      expect(dialogOpen()).toBe(true);
    }

    // The text sits under the field the server named, not in the general line of the dialog.
    const fieldError = (index: number): string =>
      document.body
        .querySelectorAll('.modal .field')
        [index]?.querySelector('.field__error')
        ?.textContent?.trim() ?? '';

    it('fullName gives the name text at the name field', async () => {
      await failWith([{ path: 'fullName', message: 'bad' }]);
      expect(alertText()).toBe(customerUz.contact.errors.name);
      expect(fieldError(0)).toBe(customerUz.contact.errors.name);
      expect(fieldError(1)).toBe('');
      expect(document.body.querySelector('.modal .confirm__error')).toBeNull();
    });

    it('phone gives the phone text at the phone field', async () => {
      await failWith([{ path: 'phone', message: 'bad' }]);
      expect(alertText()).toBe(customerUz.contact.errors.phone);
      expect(fieldError(0)).toBe('');
      expect(fieldError(1)).toBe(customerUz.contact.errors.phone);
    });

    it('an unknown field falls back to a generic text, not a field text', async () => {
      await failWith([{ path: '', message: 'bad' }]);
      expect(alertText()).not.toBe('');
      expect(alertText()).not.toBe(customerUz.contact.errors.name);
      expect(alertText()).not.toBe(customerUz.contact.errors.phone);
    });
  });

  it('a double press of the save button sends one request', async () => {
    const setContact = vi.fn();
    await newcomerWithCart((backend) => {
      const original = backend.meApi.setContact;
      backend.meApi.setContact = (request) => {
        setContact(request);
        return original(request);
      };
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await fillContact('Dilshod Karimov', '998935550147');
    const save = findModalButton(customerUz.contact.submit);
    save.click();
    save.click();
    await waitFor(() => expect(bodyText()).toContain(customerUz.placed.title));
    expect(setContact).toHaveBeenCalledTimes(1);
  });
});
