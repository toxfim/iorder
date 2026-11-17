import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { uz } from '@/i18n/messages/uz';
import { createTestServices } from '@/test-utils/create-test-services';
import { arrivedAt } from '@core/test-utils/wait';
import { createAppRouter } from '@/router';
import { ApiRateLimitedError, NetworkError, UnauthenticatedError } from '@core/lib/api-errors';
import type { AuthApi, CurrentUser } from '../api/auth-api';
import { createCurrentUserStore } from '../composables/current-user-store';
import LoginPage from './LoginPage.vue';

const manager: CurrentUser = {
  id: 'm',
  displayName: 'Test Manager',
  staffRoles: ['MANAGER'],
  organization: null,
};

function setup(
  signInWithPassword: NonNullable<AuthApi['signInWithPassword']>,
  extra: Partial<AuthApi> = {},
) {
  const api: AuthApi = {
    getCurrentUser: () => Promise.resolve(null),
    signInWithPassword,
    signOut: () => Promise.resolve(),
    ...extra,
  };
  const currentUser = createCurrentUserStore(api);
  const services: Services = { ...createTestServices().services, authApi: api, currentUser };
  const router = createAppRouter(currentUser, createMemoryHistory());
  return {
    currentUser,
    router,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  };
}

async function fillAndSubmit(wrapper: VueWrapper, login = 'aziza', password = 'a long secret 123') {
  await wrapper.get('input[name="username"]').setValue(login);
  await wrapper.get('input[name="password"]').setValue(password);
  await wrapper.get('form').trigger('submit');
}

describe('staff login page: password method', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers demo users only when the adapter lists them (the fake adapter), never otherwise', async () => {
    const real = setup(() => Promise.resolve(manager));
    await real.router.push('/login');
    const without = mount(LoginPage, { global: real.global });
    expect(without.find('.login__identities').exists()).toBe(false);
    expect(without.text()).not.toContain('Demo');

    const fake = setup(() => Promise.resolve(manager), {
      listDemoIdentities: () => [
        { id: 'm', displayName: 'Test Manager', staffRoles: ['MANAGER'], organizationRole: null },
      ],
    });
    await fake.router.push('/login');
    const withDemo = mount(LoginPage, { global: fake.global });
    expect(withDemo.get('.login__identities-title').text()).toBe('Demo foydalanuvchilar');
  });

  it('has the right autocomplete attributes and no widget when none is configured', async () => {
    const { router, global } = setup(() => Promise.resolve(manager));
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    expect(wrapper.get('input[name="username"]').attributes('autocomplete')).toBe('username');
    expect(wrapper.get('input[name="password"]').attributes('autocomplete')).toBe(
      'current-password',
    );
    expect(wrapper.get('input[name="password"]').attributes('type')).toBe('password');
    expect(document.querySelector('script[src*="telegram"]')).toBeNull();
  });

  it('success: goes to the role first page and clears the typed password before the answer', async () => {
    let seen: { login: string; password: string } | null = null;
    let release: (user: CurrentUser) => void = () => undefined;
    const { router, global } = setup((credentials) => {
      seen = credentials;
      return new Promise<CurrentUser>((resolve) => {
        release = resolve;
      });
    });
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    await fillAndSubmit(wrapper);
    // Still waiting for the server: the password is already out of the form.
    expect((wrapper.get('input[name="password"]').element as HTMLInputElement).value).toBe('');
    expect(seen).toEqual({ login: 'aziza', password: 'a long secret 123' });

    release(manager);
    await flushPromises();
    await arrivedAt(router, '/staff/dashboard');
  });

  it('success: returns to the remembered internal page', async () => {
    const { router, global } = setup(() => Promise.resolve(manager));
    await router.push('/login?redirect=/staff/orders');
    const wrapper = mount(LoginPage, { global });

    await fillAndSubmit(wrapper);
    await flushPromises();

    await arrivedAt(router, '/staff/orders');
  });

  it.each(['//evil.com', 'https://x.test/staff', '\\\\evil', '/\\evil.com'])(
    'success: ignores the unsafe return path %s',
    async (bad) => {
      const { router, global } = setup(() => Promise.resolve(manager));
      await router.push({ path: '/login', query: { redirect: bad } });
      const wrapper = mount(LoginPage, { global });

      await fillAndSubmit(wrapper);
      await flushPromises();

      await arrivedAt(router, '/staff/dashboard');
    },
  );

  it.each([
    ['a refused sign-in', new UnauthenticatedError()],
    ['a server failure', new Error('boom')],
    ['a network failure', new NetworkError()],
  ])('%s shows the one generic message and stays on the page', async (_name, error) => {
    const { router, global } = setup(() => Promise.reject(error));
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    await fillAndSubmit(wrapper);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(uz.auth.login.failed);
    expect(router.currentRoute.value.name).toBe('login');
    // The form is usable again.
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  it('does not submit twice while a request is in flight', async () => {
    const signIn = vi.fn(() => new Promise<CurrentUser>(() => undefined));
    const { router, global } = setup(signIn);
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    await fillAndSubmit(wrapper);
    await wrapper.get('input[name="password"]').setValue('another one');
    await wrapper.get('form').trigger('submit');

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('does not submit empty fields', async () => {
    const signIn = vi.fn(() => Promise.resolve(manager));
    const { router, global } = setup(signIn);
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    await wrapper.get('form').trigger('submit');

    expect(signIn).not.toHaveBeenCalled();
  });

  it('429: shows the rate-limit text, counts down the Retry-After seconds, then allows a retry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const signIn = vi
      .fn<NonNullable<AuthApi['signInWithPassword']>>()
      .mockRejectedValueOnce(new ApiRateLimitedError('slow', 'RATE_LIMITED', 3))
      .mockResolvedValue(manager);
    const { router, global } = setup(signIn);
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    await fillAndSubmit(wrapper);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain(uz.auth.login.rateLimited);
    const button = wrapper.get('button[type="submit"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toBe('Kuting: 3 s');

    // While waiting, a submit is dropped.
    await wrapper.get('input[name="password"]').setValue('again');
    await wrapper.get('form').trigger('submit');
    expect(signIn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('button[type="submit"]').text()).toBe('Kuting: 2 s');
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    await fillAndSubmit(wrapper);
    await flushPromises();
    expect(signIn).toHaveBeenCalledTimes(2);
    await arrivedAt(router, '/staff/dashboard');
  });

  it('stops the countdown timer when the page is left', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { router, global } = setup(() =>
      Promise.reject(new ApiRateLimitedError('slow', 'RATE_LIMITED', 30)),
    );
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });
    await fillAndSubmit(wrapper);
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    wrapper.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

beforeEach(() => {
  document.head.querySelectorAll('script').forEach((node) => node.remove());
});
