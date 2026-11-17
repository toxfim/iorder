import { describe, expect, it, vi } from 'vitest';
import { NetworkError, RequestTimeoutError, UnauthenticatedError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  bodyText,
  confirmCartSubmission,
  click,
  findButton,
  mountCustomerApp,
  typeInto,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();

const productId = (code: string): string => fakeUuid(`customer-product:${code}`);

describe('entry states', () => {
  it('outside Telegram: offers browser sign-in without requesting private data', async () => {
    const getMe = vi.fn();
    const { wrapper } = await mountCustomerApp(null, '/prices', {
      decorate: (backend) => {
        const original = backend.meApi.getMe;
        backend.meApi.getMe = (...args) => {
          getMe();
          return original(...args);
        };
      },
    });
    expect(bodyText()).toContain(customerUz.auth.design.title);
    expect(bodyText()).toContain(customerUz.auth.telegram);
    expect(wrapper.find('input[autocomplete="username"]').exists()).toBe(true);
    expect(wrapper.find('input[autocomplete="current-password"]').exists()).toBe(true);
    expect(getMe).not.toHaveBeenCalled();
    expect(wrapper.find('nav.tabs').exists()).toBe(false);
  });

  it.each(['fake-nobody', 'fake-staff', 'fake-inactive-org'])(
    '%s sees the same denied state and no menu',
    async (who) => {
      const { wrapper } = await mountCustomerApp(who, '/orders');
      expect(bodyText()).toContain(customerUz.entry.denied.title);
      expect(bodyText()).toContain(customerUz.entry.denied.description);
      expect(bodyText()).not.toContain(customerUz.orders.title);
      expect(wrapper.find('nav.tabs').exists()).toBe(false);
    },
  );

  it('a failing profile request is an error with a retry, not a denial', async () => {
    let fail = true;
    const { services } = await mountCustomerApp('fake-owner', '/prices', {
      decorate: (backend) => {
        const original = backend.meApi.getMe;
        backend.meApi.getMe = (...args) =>
          fail ? Promise.reject(new NetworkError()) : original(...args);
      },
    });
    expect(bodyText()).toContain('Yuklab bo');
    expect(bodyText()).not.toContain(customerUz.entry.denied.title);
    fail = false;
    await click(findButton('Qayta urinish'));
    await waitFor(() => expect(services.session.state.value).toBe('ready'));
  });

  it('a member gets the five-item customer menu and no cart badge yet', async () => {
    const { wrapper } = await mountCustomerApp('fake-owner', '/prices');
    const tabs = wrapper.findAll('nav.tabs a').map((a) => a.text());
    expect(tabs[0]).toContain('Asosiy');
    expect(tabs[1]).toContain('Mahsulotlar');
    expect(tabs[2]).toContain('Buyurtmalar');
    expect(tabs[3]).toContain('Savat');
    expect(tabs[4]).toContain('Profil');
    expect(wrapper.find('nav.tabs .badge').exists()).toBe(false);
    expect(wrapper.find('nav.tabs a[href="/profile"]').exists()).toBe(true);
  });
});

describe('prices', () => {
  it('lists the published price list with unit, price and version, and no stock or cost', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W zaryadlovchi'));
    expect(bodyText()).toContain("89 000 so'm");
    expect(bodyText()).toContain('dona');
    expect(bodyText()).toContain("Narxlar ro'yxati v15");
    expect(bodyText()).not.toMatch(/qoldiq|tannarx|stock|cost/i);
    // Products that are inactive or unpriced are not in the list.
    expect(bodyText()).not.toContain('Eski 5W zaryadlovchi');
  });

  it('searches by name or code', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    const input = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    await typeInto(input, 'ugreen');
    expect(bodyText()).toContain('Ugreen 65W GaN adapter');
    expect(bodyText()).not.toContain('Baseus 20W');
    await typeInto(input, 'zzz-nothing');
    expect(bodyText()).toContain(customerUz.catalog.noResults);
  });

  it('shows the empty state while no price list is published', async () => {
    await mountCustomerApp('fake-owner', '/prices', { scenario: 'empty' });
    await waitFor(() => expect(bodyText()).toContain(customerUz.catalog.noPriceList.title));
  });

  it('shows the error state with a retry', async () => {
    await mountCustomerApp('fake-owner', '/prices', { scenario: 'error' });
    await waitFor(() => expect(bodyText()).toContain('Yuklab bo'));
    expect(findButton('Qayta urinish')).toBeTruthy();
  });

  it('adds a product: the stepper appears and the menu badge counts positions', async () => {
    const { wrapper, services } = await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    await click(document.body.querySelector('button[aria-label^="Savatga: Baseus"]') as Element);
    await waitFor(() => expect(services.cart.itemCount.value).toBe(1));
    expect(wrapper.find('nav.tabs .badge').text()).toBe('1');
    const input = document.body.querySelector(
      'input[aria-label="Baseus 20W zaryadlovchi: miqdor"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('1');
    // The change is announced to screen readers.
    expect(document.body.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Baseus 20W zaryadlovchi: savatda 1',
    );
  });
});

describe('cart', () => {
  it('shows the empty state with a way to the prices', async () => {
    await mountCustomerApp('fake-owner', '/cart');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.empty.title));
    expect(bodyText()).toContain(customerUz.cart.empty.action);
  });

  it('explains a product that cannot be ordered, blocks submission, and lets it be removed', async () => {
    await mountCustomerApp('fake-seller', '/cart', { seedProblemCart: true });
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.problem.INACTIVE));
    expect(bodyText()).toContain(customerUz.cart.blocked);
    expect(findButton(customerUz.cart.submit).disabled).toBe(true);
    await click(findButton(customerUz.cart.remove));
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.empty.title));
  });

  it('shows the totals the server computed, and re-sends a typed quantity', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/cart');
    await services.cart.setQuantity(productId('BASEUS-20W'), '2');
    await waitFor(() => expect(bodyText()).toContain("178 000 so'm"));

    const input = document.body.querySelector(
      'input[aria-label="Baseus 20W zaryadlovchi: miqdor"]',
    ) as HTMLInputElement;
    await typeInto(input, '3');
    await waitFor(() => expect(bodyText()).toContain("267 000 so'm"));
    expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBe('3');

    await typeInto(input, '0');
    expect(bodyText()).toContain(customerUz.quantity.invalid);
    expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBe('3');
  });

  it('the minus button at the smallest step removes the line', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/cart');
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain('Hoco USB-C kabel 1 m'));
    await click(document.body.querySelector('button[aria-label^="Kamaytirish"]') as Element);
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.empty.title));
  });
});

describe('placing an order', () => {
  async function cartWithOneLine() {
    const mounted = await mountCustomerApp('fake-owner', '/cart');
    await mounted.services.cart.setQuantity(productId('HOCO-USBC-1M'), '4');
    await waitFor(() => expect(bodyText()).toContain('74 000'));
    return mounted;
  }

  it('submits, empties the cart and shows the success screen with a link to the status', async () => {
    const { router, services } = await cartWithOneLine();
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    await waitFor(() => expect(bodyText()).toContain(customerUz.placed.title));
    expect(bodyText()).toMatch(/IO-\d+/);
    expect(services.cart.itemCount.value).toBe(0);

    await click(
      [...document.body.querySelectorAll('a')].find((a) =>
        (a.textContent ?? '').includes(customerUz.placed.viewStatus),
      ) as Element,
    );
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-order'));
  });

  it('a double tap sends one request', async () => {
    const submit = vi.fn();
    const { services } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (backend) => {
        const original = backend.ordersApi.submit;
        backend.ordersApi.submit = (key, request) => {
          submit(key, request);
          return original(key, request);
        };
      },
    });
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    const submitButton = findButton(customerUz.cart.submit);
    submitButton.click();
    submitButton.click();
    await confirmCartSubmission();
    await waitFor(() => expect(bodyText()).toContain(customerUz.placed.title));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('after a network error the retry sends the SAME key and creates one order', async () => {
    const keys: string[] = [];
    let drop = true;
    const { backend, services } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (b) => {
        const original = b.ordersApi.submit;
        b.ordersApi.submit = async (key, request) => {
          keys.push(key);
          // The first attempt reaches the server but the answer is lost on the way back.
          const order = await original(key, request);
          if (drop) {
            drop = false;
            throw new NetworkError();
          }
          return order;
        };
      },
    });
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));

    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    expect(bodyText()).toContain(customerUz.cart.retrySafe);
    expect(JSON.parse(window.sessionStorage.getItem('iorder.submitKey') ?? '{}').key).toBe(keys[0]);

    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(bodyText()).toContain(customerUz.placed.title));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(window.sessionStorage.getItem('iorder.submitKey')).toBeNull();

    const orders = await backend.ordersApi.list({ limit: 100 });
    expect(orders.orders.filter((o) => o.totalAmount === '18500.00')).toHaveLength(1);
  });

  it('a refusal shows the reason in words, drops the key and reloads the cart', async () => {
    const { services, backend } = await mountCustomerApp('fake-owner', '/cart');
    await services.cart.setQuantity(productId('BASEUS-20W'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    // The product is withdrawn after the cart page was loaded.
    backend.deactivateProduct('BASEUS-20W');
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(bodyText()).toContain("buyurtma qilib bo'lmaydi"));
    expect(bodyText()).toContain(customerUz.cart.problem.INACTIVE);
    expect(window.sessionStorage.getItem('iorder.submitKey')).toBeNull();
    expect(findButton(customerUz.cart.submit).disabled).toBe(true);
  });

  it('a timeout, then a changed cart: the next order gets a NEW key and is a different order', async () => {
    const keys: string[] = [];
    let drop = true;
    const { backend, services } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (b) => {
        const original = b.ordersApi.submit;
        b.ordersApi.submit = async (key, request) => {
          keys.push(key);
          const order = await original(key, request);
          if (drop) {
            drop = false;
            throw new RequestTimeoutError();
          }
          return order;
        };
      },
    });
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    expect(bodyText()).toContain(customerUz.cart.retrySafe);
    expect(window.sessionStorage.getItem('iorder.submitKey')).not.toBeNull();

    // The person changes the cart before trying again.
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '3');
    expect(window.sessionStorage.getItem('iorder.submitKey')).toBeNull();
    await waitFor(() => expect(findButton(customerUz.cart.submit).disabled).toBe(false));
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(bodyText()).toContain(customerUz.placed.title));

    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    const orders = await backend.ordersApi.list({ limit: 100 });
    expect(orders.orders.filter((o) => o.totalAmount === '55500.00')).toHaveLength(1);
  });

  it('a 401 in the middle of a submit marks the session denied and drops the key', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (b) => {
        b.ordersApi.submit = () => Promise.reject(new UnauthenticatedError());
      },
    });
    await services.cart.setQuantity(productId('HOCO-USBC-1M'), '1');
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.submit));
    // The real http client calls this hook before it throws.
    const mark = services.session.markDenied;
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    mark();
    await waitFor(() => expect(bodyText()).toContain(customerUz.entry.denied.title));
    expect(bodyText()).toContain(customerUz.entry.denied.description);
    expect(window.sessionStorage.getItem('iorder.submitKey')).toBeNull();
  });
});
