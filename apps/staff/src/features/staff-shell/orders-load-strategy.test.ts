import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { readsAllOrders } from './orders-access';

// Nobody downloads the order history: the role pages ask the server for their own statuses, the
// manager's pages keep only the manager's queue, and lists page on the server. A queue page says
// when its queue was cut.

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

async function mountShell(identity: string, path: string) {
  await preloadRouteComponents();
  const { services } = createTestServices({
    identityId: identity,
    clock: { now: () => TEST_NOW },
  });
  const requests: {
    status?: string;
    statuses?: string[];
    limit?: number;
    goodsReturn?: string;
  }[] = [];
  const real = services.ordersApi.listOrders.bind(services.ordersApi);
  services.ordersApi.listOrders = (query) => {
    requests.push({
      status: query?.status,
      statuses: query?.statuses,
      limit: query?.limit,
      goodsReturn: query?.goodsReturn,
    });
    return real(query);
  };
  await services.currentUser.ensureLoaded();
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(path);
  const host = defineComponent({ render: () => h(RouterView) });
  wrappers.push(
    mount(host, {
      attachTo: document.body,
      global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
    }),
  );
  await waitFor(() => expect(services.ordersStore.state.value).not.toBe('loading'));
  await flushPromises();
  return { services, requests };
}

describe('which roles see every order', () => {
  it('is manager and admin only', () => {
    expect(readsAllOrders(['MANAGER'])).toBe(true);
    expect(readsAllOrders(['ADMIN'])).toBe(true);
    expect(readsAllOrders(['ACCOUNTANT', 'MANAGER'])).toBe(true);
    for (const role of ['ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      expect(readsAllOrders([role])).toBe(false);
    }
  });
});

describe('order loading per role (staff shell)', () => {
  it.each([
    [
      'accountant',
      '/staff/accounting',
      ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED'],
    ],
    [
      'warehouse',
      '/staff/warehouse',
      ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'CANCELLED', 'REJECTED'],
    ],
    ['driver', '/staff/deliveries', ['RELEASED', 'DELIVERED', 'RECEIVED']],
  ])('%s never asks for the unfiltered list', async (identity, path, statuses) => {
    const { requests } = await mountShell(identity, path);
    expect(requests.length).toBeGreaterThan(0);
    // A queue is read whole in pages of 100, a "recent" status as one short page; the roles that
    // see money also read the newest few debts (a status set); the warehouse its returns (a filter).
    const byStatus = requests.filter((r) => r.status !== undefined);
    expect(byStatus.every((r) => [100, 25].includes(r.limit ?? 0))).toBe(true);
    expect(
      requests
        .filter((r) => r.status === undefined)
        .every((r) => (r.statuses && r.limit === 4) || r.goodsReturn === 'PENDING'),
    ).toBe(true);
    expect([...new Set(byStatus.map((r) => r.status))].sort()).toEqual([...statuses].sort());
  });

  it('manager keeps only the queue and the newest debts, never the whole list', async () => {
    const { requests, services } = await mountShell('manager', '/staff/dashboard');
    expect(requests.every((r) => r.status !== undefined || r.statuses !== undefined)).toBe(true);
    expect([...new Set(services.ordersStore.orders.value.map((o) => o.status))]).toEqual([
      'SUBMITTED',
    ]);
    expect(services.orderDebtStore.count.value).toBe(1);
  });

  it('the orders list reads one page of 25', async () => {
    const { requests } = await mountShell('manager', '/staff/orders');
    await waitFor(() =>
      expect(requests.filter((r) => r.status === undefined && r.statuses === undefined)).toEqual([
        { limit: 25, status: undefined, statuses: undefined },
      ]),
    );
  });
});

describe('truncation banner', () => {
  const banner = "Ro'yxat to'liq yuklanmadi";

  // Only the pages built on a queue read it whole; the other lists page on the server.
  it('shows on the home page when the queue was cut', async () => {
    const { services } = await mountShell('manager', '/staff/customers');
    services.ordersStore.truncated.value = true;
    const router = (wrappers[0] as VueWrapper).vm.$router;
    await router.push('/staff/dashboard');
    await flushPromises();
    await waitFor(() => expect(document.body.textContent).toContain(banner));
  });

  it('is absent when the list is whole', async () => {
    await mountShell('manager', '/staff/customers');
    expect(document.body.textContent).not.toContain(banner);
  });
});
