import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import LoginPage from '@/features/auth/components/LoginPage.vue';
import { en } from '@/i18n/messages/en';
import { ru } from '@/i18n/messages/ru';
import { uz } from '@/i18n/messages/uz';
import { createAppRouter } from '@/router';
import { TEST_HANDOFF_CODE, createTestServices } from '@/test-utils/create-test-services';
import {
  ApiNotFoundError,
  ApiRateLimitedError,
  NetworkError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { markAppOutdated } from '@core/lib/app-outdated';
import { createHttpClient } from '@core/lib/http-client';
import { setPageLeaver } from '@core/lib/leave-page';
import { siteHintCookieName } from '@core/lib/site-hint';
import { CUSTOMER_SITE_ROLES, mayOpenCustomerSite } from './access';
import { createHttpCustomerSiteApi, type CustomerSiteApi } from './api/customer-site-api';
import { createCustomerSiteStore } from './composables/customer-site-store';
import { HANDOFF_INTENT_KEY, markHandoffIntent } from './handoff-intent';

// Staff continue on the customer site with their dashboard sign-in ([C] 2026-11-09): the sidebar
// entry, the page that asks for the one-time code and sends the browser on, and the hint.

const SITE = 'https://order.iorder.uz';
const wrappers: VueWrapper[] = [];

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { value, configurable: true });
}

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  setPageLeaver();
  window.sessionStorage.clear();
  setReferrer('');
  // An answer the schema refused marks the app as outdated until the next exchange.
  markAppOutdated(false);
});

async function mountApp(
  identity: string | undefined,
  path: string,
  options: {
    site?: string | null;
    api?: Partial<CustomerSiteApi>;
    mark?: (siteUrl: string) => void;
  } = {},
) {
  const made = createTestServices({
    ...(identity === undefined ? {} : { identityId: identity }),
    customerSiteUrl: options.site === undefined ? SITE : options.site,
  });
  const customerSiteApi = { ...made.services.customerSiteApi, ...options.api };
  const services: Services = {
    ...made.services,
    customerSiteApi,
    customerSiteStore: createCustomerSiteStore(customerSiteApi, options.mark ?? (() => undefined)),
  };
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(path);
  const host = defineComponent({ render: () => h(RouterView) });
  const wrapper = mount(host, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  await flushPromises();
  return { services, router, wrapper };
}

const entry = (): HTMLAnchorElement | null =>
  document.body.querySelector('[data-testid="customer-site-entry"]');

describe('who is offered the customer site', () => {
  it('the roles that may be viewers there: never the warehouse or the driver', () => {
    expect([...CUSTOMER_SITE_ROLES].sort()).toEqual([
      'ACCOUNTANT',
      'ADMIN',
      'MANAGER',
      'PURCHASING_MANAGER',
    ]);
    expect(mayOpenCustomerSite(['DRIVER', 'WAREHOUSE_MANAGER'])).toBe(false);
    expect(mayOpenCustomerSite(['DRIVER', 'ACCOUNTANT'])).toBe(true);
    expect(mayOpenCustomerSite([])).toBe(false);
  });
});

describe('the sidebar entry "Mijoz sahifasi"', () => {
  it('opens the handoff page of the dashboard in a new tab, and names the site', async () => {
    await mountApp('manager', '/staff/dashboard');
    const link = entry();
    expect(link).not.toBeNull();
    // The code is asked for by the page it opens, so it is never older than that moment.
    expect(link?.getAttribute('href')).toBe('/handoff');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener');
    expect(link?.getAttribute('aria-label')).toBe(uz.customerSite.openInNewTab);
    expect(link?.querySelector('.card__title')?.textContent).toBe('Mijoz sahifasi');
    expect(link?.querySelector('.card__version')?.textContent).toBe('order.iorder.uz');
    // No secret and no address of the other site in the link itself.
    expect(link?.outerHTML).not.toContain(TEST_HANDOFF_CODE);
  });

  it('pressing it states the intent the handoff page acts on', async () => {
    await mountApp('manager', '/staff/dashboard');
    expect(window.sessionStorage.getItem(HANDOFF_INTENT_KEY)).toBeNull();
    const link = entry();
    // jsdom cannot open the new tab; the click handler runs before the navigation would.
    link?.addEventListener('click', (event) => event.preventDefault());
    link?.click();
    expect(window.sessionStorage.getItem(HANDOFF_INTENT_KEY)).not.toBeNull();
  });

  it('sits above the price list card as one more card of the same shape (icon, two lines)', async () => {
    await mountApp('manager', '/staff/dashboard');
    const cards = Array.from(document.body.querySelectorAll('.sidebar__bottom > .card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toBe(entry());
    for (const card of cards) {
      expect(card.querySelectorAll(':scope > .card__icon')).toHaveLength(1);
      expect(card.querySelectorAll(':scope > .card__text > span')).toHaveLength(2);
    }
  });

  it.each(['accountant', 'admin'])('is shown to the %s', async (identity) => {
    await mountApp(identity, '/staff');
    expect(entry()).not.toBeNull();
  });

  it.each(['warehouse', 'driver'])(
    'is hidden from the %s and nothing is asked',
    async (identity) => {
      const getSite = vi.fn(() => Promise.resolve<string | null>(SITE));
      await mountApp(identity, '/staff', { api: { getSite } });
      expect(entry()).toBeNull();
      expect(getSite).not.toHaveBeenCalled();
    },
  );

  it('is hidden when the api names no site (not configured, or opened as a Mini App)', async () => {
    await mountApp('manager', '/staff/dashboard', { site: null });
    expect(entry()).toBeNull();
  });

  it('is hidden, and the shell works, when the question fails', async () => {
    await mountApp('manager', '/staff/dashboard', {
      api: { getSite: () => Promise.reject(new NetworkError()) },
    });
    expect(entry()).toBeNull();
    expect(document.body.querySelector('.shell__sidebar')).not.toBeNull();
  });

  it('has a name in all three languages', () => {
    expect([uz, ru, en].map((messages) => messages.customerSite.entry)).toEqual([
      'Mijoz sahifasi',
      'Сайт для клиентов',
      'Customer site',
    ]);
  });
});

describe('the customer site store', () => {
  it('asks once, keeps the answer and renews the hint for the site', async () => {
    const getSite = vi.fn(() => Promise.resolve<string | null>(SITE));
    const mark = vi.fn();
    const store = createCustomerSiteStore({ getSite, requestHandoff: vi.fn() }, mark);
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()]);
    await store.ensureLoaded();
    expect(getSite).toHaveBeenCalledTimes(1);
    expect(store.url.value).toBe(SITE);
    expect(mark.mock.calls).toEqual([[SITE]]);
  });

  it('leaves no hint when there is no site', async () => {
    const mark = vi.fn();
    const store = createCustomerSiteStore(
      { getSite: () => Promise.resolve(null), requestHandoff: vi.fn() },
      mark,
    );
    await store.ensureLoaded();
    expect(store.url.value).toBeNull();
    expect(mark).not.toHaveBeenCalled();
  });

  it('a failed read hides the entry and is asked again later', async () => {
    const getSite = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(SITE);
    const store = createCustomerSiteStore({ getSite, requestHandoff: vi.fn() }, vi.fn());
    await store.ensureLoaded();
    expect(store.url.value).toBeNull();
    await store.ensureLoaded();
    expect(store.url.value).toBe(SITE);
  });

  it('reset forgets the answer of the previous person, also one still on its way', async () => {
    let answer: (value: string | null) => void = () => undefined;
    const getSite = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          answer = resolve;
        }),
    );
    const mark = vi.fn();
    const store = createCustomerSiteStore({ getSite, requestHandoff: vi.fn() }, mark);
    const reading = store.ensureLoaded();
    store.reset();
    answer(SITE);
    await reading;
    expect(store.url.value).toBeNull();
    expect(mark).not.toHaveBeenCalled();
  });
});

describe('the http adapter', () => {
  it('reads the site and asks for a code with an empty body: no return address is ever sent', async () => {
    const calls: { method: string; url: string; body: string | null }[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const body = url.endsWith('/handoff')
        ? { url: `${SITE}/#handoff=${TEST_HANDOFF_CODE}`, expiresAt: '2026-11-09T10:00:00.000Z' }
        : { url: SITE };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const api = createHttpCustomerSiteApi(createHttpClient({ baseUrl: '/api', fetchImpl }));

    expect(await api.getSite()).toBe(SITE);
    expect(await api.requestHandoff()).toBe(`${SITE}/#handoff=${TEST_HANDOFF_CODE}`);
    expect(calls).toEqual([
      { method: 'GET', url: '/api/staff/customer-site', body: null },
      { method: 'POST', url: '/api/staff/customer-site/handoff', body: '{}' },
    ]);
  });

  it('refuses an answer that is not an http(s) address', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ url: 'javascript:alert(1)', expiresAt: '2026-11-09T10:00:00.000Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ) as unknown as typeof fetch;
    const api = createHttpCustomerSiteApi(createHttpClient({ baseUrl: '/api', fetchImpl }));
    await expect(api.requestHandoff()).rejects.toThrow();
  });
});

describe('the handoff page /handoff', () => {
  // Security review, 2026-11-10: the page acts only on an intent of the person (the sidebar card
  // was pressed, or the customer site sent them), never on a bare navigation any site could cause.
  beforeEach(() => markHandoffIntent());

  it('asks for a code with the dashboard session and sends the browser to the address the api gave', async () => {
    const leave = vi.fn();
    setPageLeaver(leave);
    const requestHandoff = vi.fn(() => Promise.resolve(`${SITE}/#handoff=${TEST_HANDOFF_CODE}`));
    const { wrapper } = await mountApp('manager', '/handoff', { api: { requestHandoff } });

    expect(requestHandoff).toHaveBeenCalledTimes(1);
    expect(leave.mock.calls).toEqual([[`${SITE}/#handoff=${TEST_HANDOFF_CODE}`]]);
    // While the browser leaves, the page says what is happening; the code is never rendered.
    expect(wrapper.get('[data-state="opening"]').text()).toContain(uz.customerSite.handoff.opening);
    expect(wrapper.html()).not.toContain(TEST_HANDOFF_CODE);
    // Outside the shell: the person is only passing through.
    expect(document.body.querySelector('.shell__sidebar')).toBeNull();
  });

  it('leaves the hint for the customer site: the address only, never the code', async () => {
    setPageLeaver(vi.fn());
    const mark = vi.fn();
    await mountApp('manager', '/handoff', { mark });
    expect(mark.mock.calls).toEqual([[`${SITE}/`]]);
    expect(JSON.stringify(mark.mock.calls)).not.toContain(TEST_HANDOFF_CODE);
  });

  it('a person who is not signed in meets the sign-in first and continues here afterwards', async () => {
    const leave = vi.fn();
    setPageLeaver(leave);
    const { router, services } = await mountApp(undefined, '/handoff');
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/handoff');
    expect(leave).not.toHaveBeenCalled();
    // The intent survives the sign-in (the same tab).
    expect(window.sessionStorage.getItem(HANDOFF_INTENT_KEY)).not.toBeNull();

    await services.currentUser.signIn('manager');
    await router.replace('/handoff');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('customer-site-handoff');
    expect(leave).toHaveBeenCalledTimes(1);
  });

  describe('without an intent of the person', () => {
    beforeEach(() => window.sessionStorage.removeItem(HANDOFF_INTENT_KEY));

    it('a bare navigation (any site can cause one) asks for nothing and shows a button', async () => {
      const leave = vi.fn();
      setPageLeaver(leave);
      const requestHandoff = vi.fn(() => Promise.resolve(`${SITE}/#handoff=${TEST_HANDOFF_CODE}`));
      const { wrapper } = await mountApp('manager', '/handoff', { api: { requestHandoff } });

      expect(requestHandoff).not.toHaveBeenCalled();
      expect(leave).not.toHaveBeenCalled();
      const button = wrapper.get('[data-testid="handoff-continue"]');
      expect(button.text()).toBe(uz.customerSite.handoff.continueButton);
      expect(wrapper.text()).toContain(uz.customerSite.handoff.confirmTitle);
      expect(wrapper.find('a.handoff__back').exists()).toBe(true);

      await button.trigger('click');
      await flushPromises();
      expect(requestHandoff).toHaveBeenCalledTimes(1);
      expect(leave.mock.calls).toEqual([[`${SITE}/#handoff=${TEST_HANDOFF_CODE}`]]);
    });

    it('a referrer from another site is no intent', async () => {
      setReferrer('https://evil.example/');
      const requestHandoff = vi.fn(() => Promise.resolve(SITE));
      const { wrapper } = await mountApp('manager', '/handoff', { api: { requestHandoff } });
      expect(requestHandoff).not.toHaveBeenCalled();
      expect(wrapper.find('[data-testid="handoff-continue"]').exists()).toBe(true);
    });

    it('the customer site sending the person here is an intent (its origin is the referrer)', async () => {
      setReferrer(`${SITE}/`);
      const leave = vi.fn();
      setPageLeaver(leave);
      const requestHandoff = vi.fn(() => Promise.resolve(`${SITE}/#handoff=${TEST_HANDOFF_CODE}`));
      await mountApp('manager', '/handoff', { api: { requestHandoff } });
      expect(requestHandoff).toHaveBeenCalledTimes(1);
      expect(leave).toHaveBeenCalledTimes(1);
    });

    it('a look-alike referrer is not the customer site', async () => {
      setReferrer('https://order.iorder.uz.evil.example/');
      const requestHandoff = vi.fn(() => Promise.resolve(SITE));
      await mountApp('manager', '/handoff', { api: { requestHandoff } });
      expect(requestHandoff).not.toHaveBeenCalled();
    });
  });

  it('the intent is used up by one visit', async () => {
    setPageLeaver(vi.fn());
    await mountApp('manager', '/handoff');
    expect(window.sessionStorage.getItem(HANDOFF_INTENT_KEY)).toBeNull();
  });

  it.each(['warehouse', 'driver'])(
    'is closed to the %s: no code is asked for',
    async (identity) => {
      const requestHandoff = vi.fn(() => Promise.resolve(SITE));
      const { router } = await mountApp(identity, '/handoff', { api: { requestHandoff } });
      expect(router.currentRoute.value.name).toBe('forbidden');
      expect(requestHandoff).not.toHaveBeenCalled();
    },
  );

  it('never goes to anything but an http(s) address', async () => {
    const leave = vi.fn();
    setPageLeaver(leave);
    const { wrapper } = await mountApp('manager', '/handoff', {
      api: { requestHandoff: () => Promise.resolve('javascript:alert(document.domain)') },
    });
    expect(leave).not.toHaveBeenCalled();
    expect(wrapper.get('[data-state="error"]').text()).toContain(
      uz.customerSite.handoff.failedTitle,
    );
  });

  it('a failure offers another try and the way back to the dashboard', async () => {
    const leave = vi.fn();
    setPageLeaver(leave);
    const requestHandoff = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(`${SITE}/#handoff=${TEST_HANDOFF_CODE}`);
    const { wrapper } = await mountApp('manager', '/handoff', { api: { requestHandoff } });

    const failed = wrapper.get('[data-state="error"]');
    expect(failed.text()).toContain(uz.customerSite.handoff.failedTitle);
    expect(failed.text()).toContain(uz.customerSite.handoff.failedDescription);
    const back = wrapper.get('a.handoff__back');
    expect(back.text()).toBe(uz.customerSite.handoff.backToDashboard);
    expect(back.attributes('href')).toBe('/');
    expect(leave).not.toHaveBeenCalled();

    await failed.get('button').trigger('click');
    await flushPromises();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('says to wait when the server throttles', async () => {
    const { wrapper } = await mountApp('manager', '/handoff', {
      api: {
        requestHandoff: () =>
          Promise.reject(new ApiRateLimitedError('slow down', 'RATE_LIMITED', 30)),
      },
    });
    expect(wrapper.get('[data-state="error"]').text()).toContain(
      uz.customerSite.handoff.rateLimited,
    );
  });

  it.each([
    ['the site is not configured', new ApiNotFoundError('no site', 'NOT_FOUND')],
    ['the server refuses the person', new PermissionDeniedError()],
  ])('offers no retry when %s', async (_name, error) => {
    const { wrapper } = await mountApp('manager', '/handoff', {
      api: { requestHandoff: () => Promise.reject(error) },
    });
    const state = wrapper.get('[data-state="denied"]');
    expect(state.text()).toContain(uz.customerSite.handoff.unavailableTitle);
    expect(state.find('button').exists()).toBe(false);
    expect(wrapper.find('a.handoff__back').exists()).toBe(true);
  });
});

describe('the hint that lets the customer site continue by itself', () => {
  it('is taken back on the sign-in page: nobody is signed in here, so there is nothing to continue with', async () => {
    const name = siteHintCookieName(window.location.hostname);
    document.cookie = `${name}=1; Path=/`;
    expect(document.cookie).toContain(name);

    const { services } = createTestServices();
    const router = createAppRouter(services.currentUser, createMemoryHistory());
    await router.push('/login');
    const wrapper = mount(LoginPage, {
      global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
    });
    wrappers.push(wrapper);
    await flushPromises();

    expect(document.cookie).not.toContain(name);
  });
});
