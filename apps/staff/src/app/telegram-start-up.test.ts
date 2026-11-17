import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createWebHistory, type Router } from 'vue-router';
import TelegramRefusedPage from '@/features/auth/components/TelegramRefusedPage.vue';
import { createStaffSessionStore } from '@/features/staff-auth/session-store';
import { uz } from '@/i18n/messages/uz';
import { createAppRouter } from '@/router';
import { reevaluateCurrentRoute } from '@/router/guards';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { forgetLaunch, readInitData } from '@core/telegram/launch';
import { disableTelegramBackButton } from '@core/telegram/use-back-button';
import { waitFor } from '@core/test-utils/wait';
import { createRealServices } from './create-real-services';
import { servicesKey, type Services } from './services';
import { prepareTelegramLaunch } from './telegram-launch';

// The staff app as a Telegram Mini App, start to first page, through the real launch reader, the
// real http clients, stores, router and guards; only the server is a fake that implements the
// api contract for `GET /auth/session`.

const TOKEN = 'B'.repeat(43);
const ORDER_ID = '019a3f2e-7c11-7a44-9b0d-5e6f708192a3';
const INIT_DATA =
  'query_id=AAH&user=%7B%22id%22%3A7000000042%2C%22first_name%22%3A%22Aziza%22%7D&auth_date=1&hash=abc';
const ME = {
  userId: '8f0c8f6a-2d33-4f5a-9d2e-3d2f4a1b9c11',
  fullName: 'Aziza Manager',
  locale: 'UZ',
  staffRoles: ['MANAGER'],
  membership: null,
  contact: null,
  needsContact: false,
};
const SESSION = {
  expiresAt: '2026-11-30T10:00:00.000Z',
  idleExpiresAt: '2026-11-29T22:00:00.000Z',
};

type ProxyWindow = { TelegramWebviewProxy?: { postEvent: (a: string, b: string) => void } };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** What the server makes of Telegram's init data: a staff member, a customer, or nobody (401). */
type TelegramAnswer = 'staff' | 'customer' | 'refused';

function createServer(telegram: TelegramAnswer) {
  const state = { telegram, bearerValid: true };
  const sessionCalls: string[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    const path = url.replace(/^\/api/, '');
    const unauthorized = json(401, { error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } });
    if (path === '/auth/password-login') {
      return Promise.resolve(json(200, { token: TOKEN, session: SESSION, me: ME }));
    }
    if (path === '/auth/session') sessionCalls.push(authorization.split(' ')[0] ?? '');
    if (authorization === `Bearer ${TOKEN}`) {
      if (!state.bearerValid) return Promise.resolve(unauthorized);
      if (path === '/auth/session') return Promise.resolve(json(200, { session: SESSION, me: ME }));
      if (path === '/staff/drivers') return Promise.resolve(json(200, { items: [] }));
    }
    if (authorization.startsWith(`tma ${INIT_DATA}`) && path === '/auth/session') {
      if (state.telegram === 'staff') return Promise.resolve(json(200, { session: null, me: ME }));
      if (state.telegram === 'customer') {
        const me = {
          ...ME,
          staffRoles: [],
          membership: { organizationId: ME.userId, role: 'SELLER' },
        };
        return Promise.resolve(json(200, { session: null, me }));
      }
    }
    if (path === '/staff/drivers' && authorization.startsWith(`tma ${INIT_DATA}`)) {
      return Promise.resolve(state.telegram === 'staff' ? json(200, { items: [] }) : unauthorized);
    }
    return Promise.resolve(unauthorized);
  };
  return { state, sessionCalls, fetchImpl: fetchImpl as typeof fetch };
}

/** Telegram opens the registered address and appends the launch parameters as a fragment. */
function telegramOpens(path: string, startParam?: string): void {
  const fragment =
    `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=8.0&tgWebAppPlatform=ios` +
    (startParam === undefined ? '' : `&tgWebAppStartParam=${startParam}`);
  window.history.replaceState(null, '', `${path}${fragment}`);
}

interface Started {
  readonly router: Router;
  readonly services: Services;
  readonly server: ReturnType<typeof createServer>;
  readonly inTelegram: boolean;
}

/** The steps of main.ts, with the fake server behind the real services. */
async function start(telegram: TelegramAnswer): Promise<Started> {
  const server = createServer(telegram);
  const inTelegram = await prepareTelegramLaunch();
  let router: Router | null = null;
  const services = createRealServices({
    baseUrl: '/api',
    fetchImpl: server.fetchImpl,
    session: createStaffSessionStore(),
    onSessionExpired: () => {
      if (router) void reevaluateCurrentRoute(router);
    },
  });
  router = createAppRouter(services.currentUser, createWebHistory(), undefined, {
    viaTelegram: () => readInitData() !== null,
  });
  // What `app.use(router)` does first: go to the address the tab is on.
  await router.push(window.location.pathname + window.location.search);
  await router.isReady();
  return { router, services, server, inTelegram };
}

function mountRefused(started: Started) {
  return mount(TelegramRefusedPage, {
    global: {
      plugins: [started.router],
      provide: { [servicesKey as symbol]: started.services },
    },
  });
}

describe('the staff app opened inside Telegram', () => {
  let postEvent: Mock<(eventType: string, eventData: string) => void>;

  beforeEach(async () => {
    window.sessionStorage.clear();
    forgetLaunch();
    postEvent = vi.fn<(eventType: string, eventData: string) => void>();
    (window as unknown as ProxyWindow).TelegramWebviewProxy = { postEvent };
    await preloadRouteComponents();
  });
  afterEach(() => {
    delete (window as unknown as ProxyWindow).TelegramWebviewProxy;
    document.documentElement.removeAttribute('data-telegram');
    disableTelegramBackButton();
    forgetLaunch();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('signs a linked staff member in with no form and lands on their first page', async () => {
    telegramOpens('/');
    const { router, server, inTelegram } = await start('staff');

    expect(inTelegram).toBe(true);
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
    // One question to the server, answered with Telegram's init data; no session token exists.
    expect(server.sessionCalls).toEqual(['tma']);
    expect(window.sessionStorage.getItem('iorder.staff.session')).toBeNull();
    // The launch fragment is gone from the address (it must not end up in copied links).
    expect(window.location.hash).toBe('');
  });

  it('tells Telegram the app is ready, expands it and asks for the safe areas', async () => {
    telegramOpens('/');
    await start('staff');
    const sent = postEvent.mock.calls.map((call) => call[0]);
    expect(sent.slice(0, 2)).toEqual(['web_app_ready', 'web_app_expand']);
    expect(sent).toContain('web_app_request_safe_area');
    expect(sent).toContain('web_app_request_content_safe_area');
    expect(document.documentElement.hasAttribute('data-telegram')).toBe(true);
  });

  it('opens the order a notification button named (start parameter of the direct link)', async () => {
    telegramOpens('/', `order_${ORDER_ID}`);
    const { router, server } = await start('staff');

    expect(router.currentRoute.value.name).toBe('staff-order');
    expect(router.currentRoute.value.params.orderId).toBe(ORDER_ID);
    expect(server.sessionCalls).toEqual(['tma']);
  });

  it('reads the start parameter the way a direct link delivers it (query string and init data)', async () => {
    // t.me/<bot>/<app>?startapp=... opens `<url>?tgWebAppStartParam=...` and repeats the value as
    // `start_param` inside the signed init data.
    const initData = `${INIT_DATA}&start_param=order_${ORDER_ID}`;
    window.history.replaceState(
      null,
      '',
      `/?tgWebAppStartParam=order_${ORDER_ID}#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0`,
    );
    const { router } = await start('staff');

    expect(router.currentRoute.value.name).toBe('staff-order');
    expect(router.currentRoute.value.params.orderId).toBe(ORDER_ID);
    expect(window.location.search).toBe('');
  });

  it('opens the page of a web_app button (the order address itself)', async () => {
    telegramOpens(`/staff/orders/${ORDER_ID}`);
    const { router } = await start('staff');
    expect(router.currentRoute.value.name).toBe('staff-order');
    expect(router.currentRoute.value.params.orderId).toBe(ORDER_ID);
  });

  it.each(['prices', 'order_123', `order_${ORDER_ID}x`, 'order_..%2F..%2Flogin'])(
    'ignores the start parameter %s and opens the first page',
    async (param) => {
      telegramOpens('/', param);
      const { router } = await start('staff');
      expect(router.currentRoute.value.name).toBe('staff-dashboard');
    },
  );

  it('on return (a reload in the same Telegram tab) signs in again without a form', async () => {
    telegramOpens('/');
    await start('staff');
    // The fragment is gone; the init data of the tab is still there.
    window.history.replaceState(null, '', '/staff/orders');
    const again = await start('staff');
    expect(again.inTelegram).toBe(true);
    expect(again.router.currentRoute.value.name).toBe('staff-orders');
    expect(again.server.sessionCalls).toEqual(['tma']);
  });

  // Security review, 2026-11-10: a token found in storage is never tried before Telegram's own
  // credential, so a website sign-in made earlier on the device cannot speak for this person.
  it('a stored website token gives way to the Telegram identity of the tab, untried', async () => {
    window.localStorage.setItem('iorder.staff.session', TOKEN);
    telegramOpens('/');
    const server = createServer('staff');
    server.state.bearerValid = false;
    await prepareTelegramLaunch();
    const services = createRealServices({
      baseUrl: '/api',
      fetchImpl: server.fetchImpl,
      session: createStaffSessionStore(),
    });
    const router = createAppRouter(services.currentUser, createWebHistory(), undefined, {
      viaTelegram: () => readInitData() !== null,
    });
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
    // Telegram answered the only question; the stored token (maybe another tab's) is untouched.
    expect(server.sessionCalls).toEqual(['tma']);
    expect(window.localStorage.getItem('iorder.staff.session')).toBe(TOKEN);
  });

  it('a session that ends while the app is open falls back to Telegram, not to the login form', async () => {
    telegramOpens('/');
    const started = await start('staff');
    const { router, services, server } = started;
    await services.currentUser.signInWithPassword({ login: 'aziza', password: 'a long secret 1' });
    await router.push('/staff/orders');

    server.state.bearerValid = false;
    await expect(services.driversApi.listActiveDrivers()).rejects.toBeDefined();
    await waitFor(() => expect(services.currentUser.user.value).not.toBeNull());
    expect(router.currentRoute.value.name).toBe('staff-orders');
    expect(server.sessionCalls.at(-1)).toBe('tma');
  });

  describe('Telegram could not sign the person in', () => {
    it('shows what to do instead of a login form, and keeps the page that was asked for', async () => {
      telegramOpens('/', `order_${ORDER_ID}`);
      const started = await start('refused');
      const route = started.router.currentRoute.value;

      expect(route.name).toBe('telegram-refused');
      expect(route.query.redirect).toBe(`/staff/orders/${ORDER_ID}`);

      const page = mountRefused(started);
      expect(page.find('form').exists()).toBe(false);
      expect(page.find('input').exists()).toBe(false);
      expect(page.text()).toContain(uz.auth.telegram.unknown.title);
      expect(page.findAll('li').map((item) => item.attributes('data-step'))).toEqual([
        'reopen',
        'link',
        'password',
      ]);
      // The id the person passes to whoever links the account (their own, from the launch).
      expect(page.get('[data-testid="telegram-id"]').text()).toBe('7000000042');
    });

    it('"try again" signs the person in once the account is linked, and opens the asked page', async () => {
      telegramOpens('/', `order_${ORDER_ID}`);
      const started = await start('refused');
      const page = mountRefused(started);

      await page.get('[data-testid="telegram-retry"]').trigger('click');
      await flushPromises();
      expect(started.router.currentRoute.value.name).toBe('telegram-refused');
      expect(page.text()).toContain(uz.auth.telegram.stillRefused);

      started.server.state.telegram = 'staff';
      await page.get('[data-testid="telegram-retry"]').trigger('click');
      await waitFor(() => expect(started.router.currentRoute.value.name).toBe('staff-order'));
      expect(started.router.currentRoute.value.params.orderId).toBe(ORDER_ID);
    });

    it('"sign in with login and password" opens the form and drops the Telegram identity', async () => {
      telegramOpens('/staff/orders');
      const started = await start('refused');
      const page = mountRefused(started);

      await page.get('[data-testid="telegram-use-password"]').trigger('click');
      await waitFor(() => expect(started.router.currentRoute.value.name).toBe('login'));
      expect(started.router.currentRoute.value.query.redirect).toBe('/staff/orders');
      expect(readInitData()).toBeNull();

      // From here on the tab behaves like the website: a protected page asks for the form.
      await started.router.push('/staff/warehouse');
      expect(started.router.currentRoute.value.name).toBe('login');
    });

    it('someone signed in without a staff role is told the app is for staff, on the same screen', async () => {
      telegramOpens('/');
      const started = await start('customer');
      expect(started.router.currentRoute.value.name).toBe('telegram-refused');

      const page = mountRefused(started);
      expect(page.text()).toContain(uz.auth.telegram.notStaff.title);
      expect(page.findAll('li').map((item) => item.attributes('data-step'))).toEqual([
        'staffButton',
        'customerApp',
        'password',
      ]);
      expect(page.find('[data-testid="telegram-id"]').exists()).toBe(false);
      // Neither the login form nor the plain "no access" page is a way around the explanation.
      for (const path of ['/login', '/forbidden', '/staff/orders']) {
        await started.router.push(path);
        expect(started.router.currentRoute.value.name).toBe('telegram-refused');
      }
    });

    it('a session lost while the app is open leads to the same screen when Telegram refuses too', async () => {
      telegramOpens('/');
      const started = await start('staff');
      const { router, services, server } = started;
      await router.push('/staff/orders');

      server.state.telegram = 'refused';
      await expect(services.driversApi.listActiveDrivers()).rejects.toBeDefined();
      await waitFor(() => expect(router.currentRoute.value.name).toBe('telegram-refused'));
      expect(router.currentRoute.value.query.redirect).toBe('/staff/orders');
    });
  });
});

describe('the staff app opened in an ordinary browser tab', () => {
  beforeEach(async () => {
    window.sessionStorage.clear();
    forgetLaunch();
    window.history.replaceState(null, '', '/');
    await preloadRouteComponents();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('is unchanged: no Telegram calls, no request without credentials, the login form', async () => {
    const postEvent = vi.fn();
    (window as unknown as ProxyWindow).TelegramWebviewProxy = { postEvent };
    try {
      window.history.replaceState(null, '', `/staff/orders/${ORDER_ID}`);
      const { router, server, inTelegram } = await start('staff');

      expect(inTelegram).toBe(false);
      expect(postEvent).not.toHaveBeenCalled();
      expect(document.documentElement.hasAttribute('data-telegram')).toBe(false);
      expect(server.sessionCalls).toEqual([]);
      expect(router.currentRoute.value.name).toBe('login');
      expect(router.currentRoute.value.query.redirect).toBe(`/staff/orders/${ORDER_ID}`);
    } finally {
      delete (window as unknown as ProxyWindow).TelegramWebviewProxy;
    }
  });

  it('a start parameter in the address of a browser tab moves nobody', async () => {
    window.history.replaceState(null, '', `/?tgWebAppStartParam=order_${ORDER_ID}`);
    const { router } = await start('staff');
    expect(router.currentRoute.value.name).toBe('login');
    expect(String(router.currentRoute.value.query.redirect)).not.toContain('/staff/orders');
  });

  it('a signed-out person never sees the Telegram screen as the way in', async () => {
    const { router } = await start('refused');
    await router.push('/staff/orders');
    expect(router.currentRoute.value.name).toBe('login');
  });
});
