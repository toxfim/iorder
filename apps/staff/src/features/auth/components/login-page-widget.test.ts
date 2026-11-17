import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { uz } from '@/i18n/messages/uz';
import { createTestServices } from '@/test-utils/create-test-services';
import { arrivedAt } from '@core/test-utils/wait';
import { createAppRouter } from '@/router';
import { ApiRateLimitedError, UnauthenticatedError } from '@core/lib/api-errors';
import {
  TELEGRAM_WIDGET_CALLBACK,
  TELEGRAM_WIDGET_SRC,
} from '@/features/staff-auth/telegram-widget';
import type { AuthApi, CurrentUser } from '../api/auth-api';
import { createCurrentUserStore } from '../composables/current-user-store';
import LoginPage from './LoginPage.vue';

// The bot is configured for this whole file; login-page.test.ts covers "not configured".
vi.mock('@/features/staff-auth/staff-login-bot', () => ({
  STAFF_TELEGRAM_BOT_USERNAME: 'iorder_staff_bot',
}));

const manager: CurrentUser = {
  id: 'm',
  displayName: 'Test Manager',
  staffRoles: ['MANAGER'],
  organization: null,
};

// What the widget's JavaScript callback hands over (numbers for id and auth_date).
const WIDGET_USER = {
  id: 123456789,
  first_name: 'Aziza',
  username: 'aziza',
  auth_date: 1_790_000_000,
  hash: 'a'.repeat(64),
};

function setup(signInWithTelegramWidget: NonNullable<AuthApi['signInWithTelegramWidget']>) {
  const api: AuthApi = {
    getCurrentUser: () => Promise.resolve(null),
    signInWithTelegramWidget,
    signOut: () => Promise.resolve(),
  };
  const currentUser = createCurrentUserStore(api);
  const services: Services = { ...createTestServices().services, authApi: api, currentUser };
  const router = createAppRouter(currentUser, createMemoryHistory());
  return { router, global: { plugins: [router], provide: { [servicesKey as symbol]: services } } };
}

const callbacks = (): Record<string, unknown> => window as unknown as Record<string, unknown>;
const widgetScript = (): HTMLScriptElement | null =>
  document.querySelector(`script[src="${TELEGRAM_WIDGET_SRC}"]`);

describe('staff login page: Telegram Login Widget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads the widget script at runtime with the configured bot and a registered callback', async () => {
    const { router, global } = setup(() => Promise.resolve(manager));
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });

    const script = widgetScript();
    expect(script).not.toBeNull();
    expect(script?.getAttribute('data-telegram-login')).toBe('iorder_staff_bot');
    expect(script?.getAttribute('data-onauth')).toBe(`${TELEGRAM_WIDGET_CALLBACK}(user)`);
    expect(typeof callbacks()[TELEGRAM_WIDGET_CALLBACK]).toBe('function');

    wrapper.unmount();
  });

  it('asks the browser to send only the origin, so a login URL with ?redirect= never reaches telegram.org', async () => {
    const { router, global } = setup(() => Promise.resolve(manager));
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });

    expect(widgetScript()?.referrerPolicy).toBe('origin');

    wrapper.unmount();
  });

  it('removes the script and the global callback when the page is left', async () => {
    const { router, global } = setup(() => Promise.resolve(manager));
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });
    expect(widgetScript()).not.toBeNull();

    wrapper.unmount();

    expect(widgetScript()).toBeNull();
    expect(callbacks()[TELEGRAM_WIDGET_CALLBACK]).toBeUndefined();
  });

  it('sends the widget payload to the sign-in untouched and goes to the first page', async () => {
    const signIn = vi.fn<NonNullable<AuthApi['signInWithTelegramWidget']>>(() =>
      Promise.resolve(manager),
    );
    const { router, global } = setup(signIn);
    await router.push('/login');
    mount(LoginPage, { global, attachTo: document.body });

    (callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void)(WIDGET_USER);
    await flushPromises();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn.mock.calls[0]?.[0]).toBe(WIDGET_USER);
    await arrivedAt(router, '/staff/dashboard');
  });

  it('ignores a callback value that is not an object', async () => {
    const signIn = vi.fn(() => Promise.resolve(manager));
    const { router, global } = setup(signIn);
    await router.push('/login');
    mount(LoginPage, { global, attachTo: document.body });

    (callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void)('nope');
    (callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void)(null);
    await flushPromises();

    expect(signIn).not.toHaveBeenCalled();
  });

  it('shows the same generic error as the password form for a refusal', async () => {
    const { router, global } = setup(() => Promise.reject(new UnauthenticatedError()));
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });

    (callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void)(WIDGET_USER);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(uz.auth.login.failed);
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('shows the rate-limit message for a 429', async () => {
    const { router, global } = setup(() =>
      Promise.reject(new ApiRateLimitedError('slow', 'RATE_LIMITED', 30)),
    );
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });

    (callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void)(WIDGET_USER);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain(uz.auth.login.rateLimited);
    wrapper.unmount();
  });

  it('tells the person when a widget callback is dropped because a sign-in is running', async () => {
    const signIn = vi.fn(() => new Promise<CurrentUser>(() => undefined));
    const { router, global } = setup(signIn);
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });

    const call = callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void;
    call(WIDGET_USER);
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    call(WIDGET_USER);
    await flushPromises();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[role="status"]').text()).toBe(uz.auth.login.telegram.ignored);
  });

  it('tells the person when a widget callback arrives during a 429 wait', async () => {
    const signIn = vi.fn(() => Promise.reject(new ApiRateLimitedError('slow', 'RATE_LIMITED', 30)));
    const { router, global } = setup(signIn);
    await router.push('/login');
    const wrapper = mount(LoginPage, { global, attachTo: document.body });

    const call = callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void;
    call(WIDGET_USER);
    await flushPromises();
    call(WIDGET_USER);
    await flushPromises();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[role="status"]').text()).toBe(uz.auth.login.telegram.ignored);
    wrapper.unmount();
  });

  it('ignores a second widget callback while one sign-in is running', async () => {
    const signIn = vi.fn(() => new Promise<CurrentUser>(() => undefined));
    const { router, global } = setup(signIn);
    await router.push('/login');
    mount(LoginPage, { global, attachTo: document.body });

    const call = callbacks()[TELEGRAM_WIDGET_CALLBACK] as (user: unknown) => void;
    call(WIDGET_USER);
    call(WIDGET_USER);

    expect(signIn).toHaveBeenCalledTimes(1);
  });
});
