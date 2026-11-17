// @vitest-environment-options { "url": "https://dev.order.iorder.uz/" }
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomerLogin from '@/features/customer-app/components/CustomerLogin.vue';
import { customerEn } from '@/features/customer-app/messages/en';
import { customerRu } from '@/features/customer-app/messages/ru';
import { customerUz } from '@/features/customer-app/messages/uz';
import { customerServicesKey } from '@/features/customer-app/services';
import { createHttpClient } from '@core/lib/http-client';
import { setPageLeaver } from '@core/lib/leave-page';
import { forgetInitData } from '@core/telegram/launch';
import { createCustomerAuthApi } from './api/customer-auth-api';
import {
  HANDOFF_OPT_OUT_SECONDS,
  HANDOFF_TRIED_SECONDS,
  continueFromCompanySite,
  handoffFailed,
  markHandoffFailed,
  suppressAutomaticHandoff,
  takeHandoffArrival,
  type HandoffDeps,
} from './site-handoff';
import { readCustomerToken, setCustomerToken } from './website-session';

// Continuing on this site with a sign-in made on the company's own site ([C] 2026-11-09). The
// page address is a real host here (see the first line), so the hint cookie on the shared parent
// domain behaves as in a browser; site-handoff-localhost.test.ts covers local development.

const CODE = 'c0de'.repeat(11).slice(0, 43);
const STAFF_PAGE = 'https://dev.dashboard.iorder.uz/handoff';
const HINT = 'iorder_site_hint_dev_dashboard_iorder_uz';

function setUrl(pathAndMore: string): void {
  window.history.replaceState(null, '', pathAndMore);
}

function setHint(name = HINT): void {
  document.cookie = `${name}=1; Path=/; Domain=iorder.uz`;
}

function clearCookies(): void {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=', 1)[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0; Domain=iorder.uz`;
  }
}

let clock = Date.parse('2026-11-10T09:00:00Z');
const tick = (ms: number): void => {
  clock += ms;
};

function deps(
  overrides: {
    exchange?: () => Promise<void>;
    handoffPage?: () => Promise<string | null>;
    hasSession?: boolean;
    currentToken?: string | null;
    inTelegram?: boolean;
  } = {},
) {
  const exchange = overrides.exchange ?? (() => Promise.resolve());
  const handoffPage = overrides.handoffPage ?? (() => Promise.resolve<string | null>(STAFF_PAGE));
  return {
    exchange: vi.fn<(code: string) => Promise<void>>(() => exchange()),
    revokeSession: vi.fn<(token: string) => Promise<void>>(() => Promise.resolve()),
    handoffPage: vi.fn(() => handoffPage()),
    hasSession: vi.fn(() => overrides.hasSession ?? false),
    currentToken: vi.fn(() => overrides.currentToken ?? null),
    inTelegram: vi.fn(() => overrides.inTelegram ?? false),
    now: () => clock,
  } satisfies HandoffDeps;
}

let leave = vi.fn();

beforeEach(() => {
  leave = vi.fn();
  setPageLeaver(leave);
  setUrl('/');
});

afterEach(() => {
  setPageLeaver();
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearCookies();
  setCustomerToken(null);
  forgetInitData();
  markHandoffFailed(false);
  document.body.innerHTML = '';
});

describe('a handoff code in the address', () => {
  it('is taken out of the address bar at once; the page and its query stay', () => {
    setUrl(`/prices?brand=anker#handoff=${CODE}`);

    expect(takeHandoffArrival()).toEqual({ kind: 'code', code: CODE });

    expect(window.location.hash).toBe('');
    expect(window.location.href).toBe('https://dev.order.iorder.uz/prices?brand=anker');
    expect(window.location.href).not.toContain(CODE);
    // Taken once: a second look finds nothing.
    expect(takeHandoffArrival()).toEqual({ kind: 'none' });
  });

  it('is read from the fragment only, never from the query string', () => {
    setUrl(`/?handoff=${CODE}`);
    expect(takeHandoffArrival()).toEqual({ kind: 'none' });
  });

  it.each(['short', `${CODE}x`, '', 'javascript:alert(1)', `${CODE.slice(0, 42)}!`])(
    'refuses %j as malformed without asking the server, and still cleans the address bar',
    (value) => {
      setUrl(`/#handoff=${encodeURIComponent(value)}`);
      expect(takeHandoffArrival()).toEqual({ kind: 'malformed' });
      expect(window.location.hash).toBe('');
    },
  );

  it('leaves every other fragment alone', () => {
    setUrl('/orders#section-2');
    expect(takeHandoffArrival()).toEqual({ kind: 'none' });
    expect(window.location.hash).toBe('#section-2');
  });

  it('is ignored on a Telegram launch: there Telegram signs the person in', () => {
    setUrl(`/#tgWebAppData=signed&handoff=${CODE}`);
    expect(takeHandoffArrival()).toEqual({ kind: 'none' });
    // Untouched: the launch reader consumes the whole fragment next.
    expect(window.location.hash).toContain('tgWebAppData=signed');
  });
});

describe('arriving with a code', () => {
  it('exchanges it for a session and shows the page the person asked for', async () => {
    window.sessionStorage.setItem('iorder.customer.handoff.return', '/prices?brand=anker');
    const d = deps();

    expect(await continueFromCompanySite({ kind: 'code', code: CODE }, d)).toBe('stay');

    expect(d.exchange.mock.calls).toEqual([[CODE]]);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/prices?brand=anker');
    expect(window.sessionStorage.getItem('iorder.customer.handoff.return')).toBeNull();
    expect(handoffFailed.value).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    expect(d.handoffPage).not.toHaveBeenCalled();
  });

  it('a refused code shows the normal sign-in with a short note, and the tab does not try again', async () => {
    setHint();
    const d = deps({ exchange: vi.fn(() => Promise.reject(new Error('401'))) });

    expect(await continueFromCompanySite({ kind: 'code', code: CODE }, d)).toBe('stay');
    expect(handoffFailed.value).toBe(true);

    // The person reloads the sign-in page: no second trip, although the hint is still there.
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(leave).not.toHaveBeenCalled();
    expect(d.handoffPage).not.toHaveBeenCalled();
  });

  it('a malformed code is not sent to the server at all', async () => {
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'malformed' }, d)).toBe('stay');
    expect(d.exchange).not.toHaveBeenCalled();
    expect(handoffFailed.value).toBe(true);
  });

  it('a person already signed in here keeps their session when the code is refused, without a note', async () => {
    const d = deps({
      exchange: vi.fn(() => Promise.reject(new Error('401'))),
      hasSession: true,
      currentToken: 'o'.repeat(43),
    });
    await continueFromCompanySite({ kind: 'code', code: CODE }, d);
    expect(handoffFailed.value).toBe(false);
    expect(d.revokeSession).not.toHaveBeenCalled();
  });

  // Security review, 2026-11-10 (6c): the session a handoff replaces is ended on the server too.
  it('ends the session it replaces on the server, after the new one is in place', async () => {
    const order: string[] = [];
    const d = deps({ hasSession: true, currentToken: 'o'.repeat(43) });
    d.exchange.mockImplementation(() => {
      order.push('exchange');
      return Promise.resolve();
    });
    d.revokeSession.mockImplementation(() => {
      order.push('revoke');
      return Promise.resolve();
    });
    await continueFromCompanySite({ kind: 'code', code: CODE }, d);
    expect(d.revokeSession).toHaveBeenCalledWith('o'.repeat(43));
    expect(order).toEqual(['exchange', 'revoke']);
  });

  it('a failed revocation of the replaced session does not disturb the new one', async () => {
    const d = deps({
      hasSession: true,
      currentToken: 'o'.repeat(43),
      exchange: () => Promise.resolve(),
    });
    d.revokeSession.mockRejectedValue(new Error('offline'));
    expect(await continueFromCompanySite({ kind: 'code', code: CODE }, d)).toBe('stay');
    expect(handoffFailed.value).toBe(false);
  });

  it('never restores a remembered page that is not a path of this site', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'prices']) {
      setUrl('/');
      window.sessionStorage.setItem('iorder.customer.handoff.return', bad);
      await continueFromCompanySite({ kind: 'code', code: CODE }, deps());
      expect(window.location.href, bad).toBe('https://dev.order.iorder.uz/');
    }
  });
});

describe('opening the site directly', () => {
  it('a visitor without the hint is never sent anywhere and causes no request', async () => {
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(d.handoffPage).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it('with the hint and no session: goes once to the page the api names, and remembers where the person was', async () => {
    setHint();
    setUrl('/orders?status=open');
    const d = deps();

    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('leaving');

    expect(leave.mock.calls).toEqual([[STAFF_PAGE]]);
    expect(window.sessionStorage.getItem('iorder.customer.handoff.return')).toBe(
      '/orders?status=open',
    );
    // Nothing of this site travels in the address it goes to.
    expect(String(leave.mock.calls[0]?.[0])).not.toContain('orders');
  });

  // Security review, 2026-11-10 (6a): the guard is per browser (localStorage), not per tab.
  it('at most one automatic attempt per browser for a while: no loop, also from a new tab', async () => {
    setHint();
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('leaving');

    // The other site showed its sign-in page; the person came back, or opened new tabs.
    window.sessionStorage.clear();
    for (let visit = 0; visit < 3; visit += 1) {
      expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    }
    expect(leave).toHaveBeenCalledTimes(1);
    expect(d.handoffPage).toHaveBeenCalledTimes(1);

    // The guard lifts by itself later, so a later visit may continue automatically again.
    tick(HANDOFF_TRIED_SECONDS * 1000 + 1);
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('leaving');
    expect(leave).toHaveBeenCalledTimes(2);
  });

  it('an explicit sign-out here holds off the automatic attempt for twelve hours, in every tab', async () => {
    setHint();
    suppressAutomaticHandoff(clock);
    window.sessionStorage.clear();
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    tick((HANDOFF_OPT_OUT_SECONDS - 60) * 1000);
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(d.handoffPage).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    expect(HANDOFF_OPT_OUT_SECONDS).toBe(12 * 3600);

    tick(61 * 1000);
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('leaving');
  });

  it('a code that arrives after a sign-out is still exchanged (the person pressed the entry)', async () => {
    suppressAutomaticHandoff(clock);
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'code', code: CODE }, d)).toBe('stay');
    expect(d.exchange).toHaveBeenCalledWith(CODE);
  });

  it('does nothing for a person who is signed in here', async () => {
    setHint();
    const d = deps({ hasSession: true });
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(d.handoffPage).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it('does nothing inside Telegram, with or without a code', async () => {
    setHint();
    const d = deps({ inTelegram: true });
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(await continueFromCompanySite({ kind: 'code', code: CODE }, d)).toBe('stay');
    expect(d.exchange).not.toHaveBeenCalled();
    expect(d.handoffPage).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  // The cookie is not a credential and not an address: only the api says where to go.
  it('never goes to an address from the cookie, and ignores the hint of another installation', async () => {
    document.cookie =
      'iorder_site_hint_dashboard_iorder_uz=https://evil.example; Path=/; Domain=iorder.uz';
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    // It asked (some hint exists) but the hint is not the one of the site the api named.
    expect(d.handoffPage).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    // ... and it does not ask again in this browser for a while.
    await continueFromCompanySite({ kind: 'none' }, d);
    expect(d.handoffPage).toHaveBeenCalledTimes(1);
  });

  it('stays when no such page is configured, or when the question fails', async () => {
    setHint();
    expect(
      await continueFromCompanySite(
        { kind: 'none' },
        deps({ handoffPage: vi.fn(() => Promise.resolve(null)) }),
      ),
    ).toBe('stay');
    window.localStorage.clear();
    expect(
      await continueFromCompanySite(
        { kind: 'none' },
        deps({ handoffPage: vi.fn(() => Promise.reject(new Error('offline'))) }),
      ),
    ).toBe('stay');
    expect(leave).not.toHaveBeenCalled();
  });

  it('stays when the page the api names is not an http(s) address', async () => {
    setHint('iorder_site_hint_');
    const d = deps({ handoffPage: vi.fn(() => Promise.resolve('javascript:alert(1)')) });
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(leave).not.toHaveBeenCalled();
  });

  it('does not start when the tab cannot remember that it tried (storage blocked)', async () => {
    setHint();
    const blocked = (): never => {
      throw new Error('blocked');
    };
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    const d = deps();
    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(d.handoffPage).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });
});

describe('the api client', () => {
  it('exchanges the code on the public route without credentials and keeps the token it gets', async () => {
    setCustomerToken('o'.repeat(43));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 'n'.repeat(43) }), { status: 200 }));
    const publicHttp = createHttpClient({ baseUrl: '/api', fetchImpl });
    const api = createCustomerAuthApi(
      createHttpClient({ baseUrl: '/api', fetchImpl: vi.fn() }),
      publicHttp,
    );

    await api.handoff(CODE);

    const [url, options] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/customer/auth/handoff');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(options?.body as string)).toEqual({ code: CODE });
    expect(new Headers(options?.headers as HeadersInit).get('Authorization')).toBeNull();
    // The session of this site is now the one the code opened.
    expect(readCustomerToken()).toBe('n'.repeat(43));
    expect(window.location.href).not.toContain(CODE);
  });

  it('keeps the earlier session when the code is refused', async () => {
    setCustomerToken('o'.repeat(43));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'x' } }), {
        status: 401,
      }),
    );
    const http = createHttpClient({ baseUrl: '/api', fetchImpl });
    await expect(createCustomerAuthApi(http, http).handoff(CODE)).rejects.toThrow();
    expect(readCustomerToken()).toBe('o'.repeat(43));
  });

  it('reads the handoff page address, and refuses one that is not http(s)', async () => {
    const answer = (url: string | null) =>
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url }), { status: 200 }));
    const client = (fetchImpl: typeof fetch) => {
      const http = createHttpClient({ baseUrl: '/api', fetchImpl });
      return createCustomerAuthApi(http, http);
    };
    const ok = answer(STAFF_PAGE);
    expect(await client(ok).handoffPage()).toBe(STAFF_PAGE);
    expect(ok.mock.calls[0]?.[0]).toBe('/api/customer/auth/handoff');
    expect(await client(answer(null)).handoffPage()).toBeNull();
    await expect(client(answer('javascript:alert(1)')).handoffPage()).rejects.toThrow();
  });
});

describe('the sign-in page after a failed handoff', () => {
  function mountLogin() {
    const services = {
      auth: {
        password: vi.fn().mockResolvedValue(undefined),
        telegram: vi.fn(),
        handoff: vi.fn(),
        handoffPage: vi.fn(),
        credentials: vi.fn(),
        setCredentials: vi.fn(),
        logout: vi.fn(),
      },
      session: { load: vi.fn(), signedOut: vi.fn() },
      cart: { clear: vi.fn() },
    };
    return mount(CustomerLogin, {
      global: { provide: { [customerServicesKey as symbol]: services } },
    });
  }

  it('signing out from the profile holds off the automatic attempt', async () => {
    // The page writes the real time; the start-up below must read it with the same clock.
    clock = Date.now();
    const d = deps();
    setHint();
    const { default: ProfilePage } =
      await import('@/features/customer-app/components/ProfilePage.vue');
    const services = {
      auth: {
        password: vi.fn(),
        telegram: vi.fn(),
        handoff: vi.fn(),
        handoffPage: vi.fn(),
        revokeSession: vi.fn(),
        credentials: vi.fn().mockResolvedValue({ login: null, canEdit: false }),
        setCredentials: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        state: { value: 'ready' },
        me: { value: null },
        staffViewer: { value: null },
        organizationName: { value: null },
        organizationRole: { value: null },
        needsContact: { value: false },
        load: vi.fn(),
        refreshMe: vi.fn(),
        signedOut: vi.fn(),
        markDenied: vi.fn(),
        setContact: vi.fn(),
      },
      cart: { clear: vi.fn(), itemCount: { value: 0 } },
      balanceApi: { get: vi.fn().mockResolvedValue({ amountToPay: '0' }) },
    };
    const wrapper = mount(ProfilePage, {
      global: {
        provide: { [customerServicesKey as symbol]: services },
        stubs: { RouterLink: true },
      },
    });
    await flushPromises();
    const logout = wrapper.findAll('button').find((b) => b.text() === customerUz.auth.logout);
    expect(logout).toBeDefined();
    await logout?.trigger('click');
    await flushPromises();
    expect(services.auth.logout).toHaveBeenCalled();
    wrapper.unmount();

    expect(await continueFromCompanySite({ kind: 'none' }, d)).toBe('stay');
    expect(d.handoffPage).not.toHaveBeenCalled();
  });

  it('shows the normal form with one short note, in the person`s language', async () => {
    markHandoffFailed(true);
    const wrapper = mountLogin();
    const note = wrapper.get('[data-testid="handoff-failed"]');
    expect(note.text()).toBe(customerUz.auth.handoffFailed);
    expect(note.attributes('role')).toBe('status');
    // The form is right there: nothing else changed on the page.
    expect(wrapper.find('input[name="username"]').exists()).toBe(true);
    expect(wrapper.find('input[name="password"]').exists()).toBe(true);
    for (const text of [customerUz, customerRu, customerEn].map((m) => m.auth.handoffFailed)) {
      expect(text.length).toBeGreaterThan(10);
      expect(text.length).toBeLessThan(90);
    }
    wrapper.unmount();
  });

  it('shows no note on an ordinary visit, and drops it once the person signs in by hand', async () => {
    const plain = mountLogin();
    expect(plain.find('[data-testid="handoff-failed"]').exists()).toBe(false);
    plain.unmount();

    markHandoffFailed(true);
    const wrapper = mountLogin();
    await wrapper.get('input[name="username"]').setValue('my.shop');
    await wrapper.get('input[name="password"]').setValue('secret');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-testid="handoff-failed"]').exists()).toBe(false);
    expect(handoffFailed.value).toBe(false);
    wrapper.unmount();
  });
});
