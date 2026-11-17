import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { createTestServices } from '@/test-utils/create-test-services';
import { coreUz as uz } from '@core/i18n/messages/uz';
import { createAppRouter } from '@/router';
import type { AuthApi, CurrentUser } from '../api/auth-api';
import { createCurrentUserStore } from '../composables/current-user-store';
import LoginPage from './LoginPage.vue';
import UserBlock from './UserBlock.vue';

const manager: CurrentUser = {
  id: 'm',
  displayName: 'Test Manager',
  staffRoles: ['MANAGER'],
  organization: null,
};

function setup(api: AuthApi) {
  const currentUser = createCurrentUserStore(api);
  const services: Services = { ...createTestServices().services, authApi: api, currentUser };
  const router = createAppRouter(currentUser, createMemoryHistory());
  return {
    currentUser,
    router,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  };
}

describe('sign-in and sign-out failures', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dismissToast();
    vi.restoreAllMocks();
  });

  it('login: a failing sign-in shows an alert and leaves the buttons usable', async () => {
    const api: AuthApi = {
      getCurrentUser: () => Promise.resolve(null),
      signIn: () => Promise.reject(new Error('down')),
      signOut: () => Promise.resolve(),
      listDemoIdentities: () => [
        { id: 'x', displayName: 'Someone', staffRoles: ['MANAGER'], organizationRole: null },
      ],
    };
    const { router, global } = setup(api);
    await router.push('/login');
    const wrapper = mount(LoginPage, { global });

    await wrapper.get('button.btn--secondary').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain(uz.state.error.title);
    expect(wrapper.get('button.btn--secondary').attributes('disabled')).toBeUndefined();
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('user block: a failing sign-out toasts, keeps the user and does not navigate', async () => {
    const api: AuthApi = {
      getCurrentUser: () => Promise.resolve(manager),
      signIn: () => Promise.resolve(manager),
      signOut: () => Promise.reject(new Error('down')),
    };
    const { currentUser, router, global } = setup(api);
    await router.push('/staff/dashboard');
    const wrapper = mount(UserBlock, { global });

    // Design v8: the sign-out icon button sits right in the user block.
    await wrapper.get('[data-testid="sign-out"]').trigger('click');
    await flushPromises();

    expect(useToast().toast.value?.message).toBe(uz.state.error.title);
    expect(currentUser.user.value?.id).toBe('m');
    expect(wrapper.text()).toContain('Test Manager');
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
  });

  it('user block: a successful sign-out goes to login', async () => {
    let signedOut = false;
    const api: AuthApi = {
      getCurrentUser: () => Promise.resolve(signedOut ? null : manager),
      signIn: () => Promise.resolve(manager),
      signOut: () => {
        signedOut = true;
        return Promise.resolve();
      },
    };
    const { router, global } = setup(api);
    await router.push('/staff/dashboard');
    const wrapper = mount(UserBlock, { global });
    await wrapper.get('[data-testid="sign-out"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('login');
  });
});
