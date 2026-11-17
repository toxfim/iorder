import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { safeRedirect } from '@/features/auth/redirect';
import { createAppRouter } from '@/router';
import { reevaluateCurrentRoute } from '@/router/guards';
import { createTestServices } from '@/test-utils/create-test-services';
import { MANAGER_SCOPE } from '@/features/staff-orders/domain/order-scopes';
import { resetPerPersonStores } from './session-reset';

describe('resetPerPersonStores', () => {
  it('empties what one person loaded', async () => {
    const { services } = createTestServices({ identityId: 'manager' });
    await services.currentUser.ensureLoaded();
    await services.ordersStore.loadBase(MANAGER_SCOPE);
    await services.orderDebtStore.refresh();
    await services.directoryStore.load();
    await services.activityStore.refresh();
    await services.dashboardSummaryStore.refresh();
    expect(services.ordersStore.orders.value.length).toBeGreaterThan(0);
    expect(services.directoryStore.organizations.value.length).toBeGreaterThan(0);

    resetPerPersonStores(services);

    expect(services.ordersStore.orders.value).toEqual([]);
    expect(services.ordersStore.state.value).toBe('loading');
    expect(services.orderDebtStore.count.value).toBeNull();
    expect(services.orderDebtStore.newest.value).toEqual([]);
    expect(services.directoryStore.organizations.value).toEqual([]);
    expect(services.activityStore.entries.value).toEqual([]);
    expect(services.dashboardSummaryStore.summary.value).toBeNull();
    expect(services.unpricedCountStore.count.value).toBeNull();
    expect(services.waitingOrganizationsStore.count.value).toBeNull();
    expect(services.sheetAttentionStore.removals.value).toBeNull();
    expect(services.priceVersionStore.version.value).toBeNull();
  });

  it('discards a read that was still running for the previous person', async () => {
    const { services } = createTestServices({ identityId: 'manager' });
    await services.currentUser.ensureLoaded();
    const reading = [
      services.ordersStore.loadBase(MANAGER_SCOPE),
      services.orderDebtStore.refresh(),
      services.directoryStore.load(),
      services.activityStore.refresh(),
    ];

    resetPerPersonStores(services);
    await Promise.all(reading);

    expect(services.ordersStore.orders.value).toEqual([]);
    expect(services.orderDebtStore.count.value).toBeNull();
    expect(services.directoryStore.organizations.value).toEqual([]);
    expect(services.activityStore.entries.value).toEqual([]);
  });
});

describe('a session that ends while a page is open', () => {
  it('expire() drops the person once and runs the session hooks once', async () => {
    const onSignedOut = vi.fn();
    const onSessionChanged = vi.fn();
    const store = createCurrentUserStore(createFakeAuthApi({ initialIdentityId: 'manager' }), {
      onSignedOut,
      onSessionChanged,
    });
    await store.ensureLoaded();

    expect(store.expire()).toBe(true);
    expect(store.expire()).toBe(false);

    expect(store.user.value).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
  });

  it('sends the person to the login with the open page as a safe return path', async () => {
    const store = createCurrentUserStore(createFakeAuthApi({ initialIdentityId: 'manager' }));
    const router = createAppRouter(store, createMemoryHistory());
    await router.push('/staff/orders?stage=SUBMITTED');
    expect(router.currentRoute.value.path).toBe('/staff/orders');

    store.expire();
    await reevaluateCurrentRoute(router);

    expect(router.currentRoute.value.name).toBe('login');
    const redirect = router.currentRoute.value.query.redirect;
    expect(redirect).toBe('/staff/orders?stage=SUBMITTED');
    expect(safeRedirect(redirect)).toBe('/staff/orders?stage=SUBMITTED');
  });

  it('return paths that could leave the site are dropped', () => {
    for (const bad of ['//evil.com', 'https://x', '\\\\evil', '/\\evil', 'http://localhost']) {
      expect(safeRedirect(bad)).toBeNull();
    }
  });
});
