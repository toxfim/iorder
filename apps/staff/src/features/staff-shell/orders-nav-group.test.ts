import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, watch } from 'vue';
import { createMemoryHistory, RouterView } from 'vue-router';
import { STAFF_ROLES, type StaffRole } from '@iorder/shared';
import { servicesKey } from '@/app/services';
import { createAppRouter } from '@/router';
import { createTestServices } from '@/test-utils/create-test-services';
import { navGroupsFor, ordersNavFor, staffRouteName, STAFF_PAGES } from './nav-config';
import { activeOrdersChild, isOrdersGroupActive } from './orders-nav-state';

const wrappers: VueWrapper[] = [];
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountShell(identity: string, path: string) {
  const { services } = createTestServices({ identityId: identity });
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(path);
  // A plain object, as orders-routes.ts does, keeps the one-component-per-file rule happy.
  const host = { render: () => h(RouterView) };
  const wrapper = mount(host, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  await flushPromises();
  return { services, router, wrapper };
}

const sidebar = (): HTMLElement => document.body.querySelector('.shell__sidebar') as HTMLElement;
const byId = (id: string): HTMLElement | null =>
  sidebar().querySelector<HTMLElement>(`[data-testid="${id}"]`);
const label = (): HTMLButtonElement => byId('orders-group-label') as HTMLButtonElement;
const toggle = (): HTMLButtonElement => byId('orders-group-toggle') as HTMLButtonElement;
const childKeys = (): string[] =>
  Array.from(sidebar().querySelectorAll('[data-testid^="orders-nav-"]')).map((e) =>
    (e.getAttribute('data-testid') ?? '').replace('orders-nav-', ''),
  );
const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('orders nav definition', () => {
  const keys = (roles: StaffRole[]): string[] => ordersNavFor(roles).map((c) => c.key);

  it('gives each role its own step; the admin only gets All orders', () => {
    expect(keys(['ADMIN'])).toEqual(['all']);
    expect(keys(['MANAGER'])).toEqual(['all', 'awaitingManager']);
    expect(keys(['ACCOUNTANT'])).toEqual(['awaitingAccounting']);
    expect(keys(['WAREHOUSE_MANAGER'])).toEqual(['toRelease']);
    expect(keys(['DRIVER'])).toEqual(['toDeliver']);
    expect(keys([])).toEqual([]);
  });

  it('every child points at a real route its role may open, and the plain list has no duplicate', async () => {
    const { router } = await mountShell('admin', '/staff/dashboard');
    for (const role of STAFF_ROLES) {
      for (const child of ordersNavFor([role])) {
        const resolved = router.resolve({ name: child.routeName, query: child.query });
        expect(resolved.meta.staffRoles).toContain(role);
      }
      const plain = navGroupsFor([role]).flatMap((g) => g.pages.map((p) => p.key));
      for (const page of STAFF_PAGES.filter((p) => p.inOrdersGroup)) {
        expect(plain).not.toContain(page.key);
      }
    }
  });

  it('only the general section carries the Orders group (design v8)', () => {
    const groups = navGroupsFor(['MANAGER']);
    expect(groups.filter((g) => g.ordersChildren.length > 0).map((g) => g.group)).toEqual([
      'general',
    ]);
    expect(staffRouteName(STAFF_PAGES.find((p) => p.key === 'orders')!)).toBe('staff-orders');
  });
});

describe('orders nav active state (pure)', () => {
  const manager = ordersNavFor(['MANAGER']);
  const admin = ordersNavFor(['ADMIN']);
  const at = (name: string, stage: string | null = null, period: string | null = null) => ({
    name,
    stage,
    period,
  });

  it('highlights All orders on the plain list and on other filters', () => {
    expect(activeOrdersChild(manager, at('staff-orders'))?.key).toBe('all');
    expect(activeOrdersChild(manager, at('staff-orders', 'MANAGER_APPROVED'))?.key).toBe('all');
    expect(activeOrdersChild(manager, at('staff-orders', 'SUBMITTED', 'today'))?.key).toBe('all');
  });

  it('highlights only the filtered child on stage=SUBMITTED', () => {
    expect(activeOrdersChild(manager, at('staff-orders', 'SUBMITTED'))?.key).toBe(
      'awaitingManager',
    );
  });

  it('keeps All orders for the admin, who has no filtered child', () => {
    expect(activeOrdersChild(admin, at('staff-orders', 'SUBMITTED'))?.key).toBe('all');
  });

  it('highlights no child on the order page, but the group', () => {
    expect(activeOrdersChild(manager, at('staff-order'))).toBeNull();
    expect(isOrdersGroupActive(manager, 'staff-order')).toBe(true);
    expect(isOrdersGroupActive(manager, 'staff-prices')).toBe(false);
    expect(isOrdersGroupActive(manager, 'staff-orders')).toBe(true);
  });
});

describe('Orders group in the sidebar', () => {
  it.each([
    ['admin', '/staff/orders', ['all']],
    ['manager', '/staff/orders', ['all', 'awaitingManager']],
    ['accountant', '/staff/accounting', ['awaitingAccounting']],
    ['warehouse', '/staff/warehouse', ['toRelease']],
    ['driver', '/staff/deliveries', ['toDeliver']],
  ])('%s sees the group with its children', async (identity, path, expected) => {
    await mountShell(identity, path);
    expect(text(label())).toContain('Buyurtmalar');
    expect(childKeys()).toEqual(expected);
    // The old separate entries are gone: no second way to the same page.
    const items = Array.from(sidebar().querySelectorAll('.item')).map((e) => text(e));
    expect(items.join('|')).not.toMatch(/Buyurtmalar|Buxgalteriya|Ombor|Yetkazish/);
  });

  it('names the children in the status vocabulary', async () => {
    await mountShell('manager', '/staff/orders');
    expect(text(byId('orders-nav-all'))).toBe('Barcha buyurtmalar');
    expect(text(byId('orders-nav-awaitingManager'))).toContain('Tasdiq kutmoqda');
  });

  it('opens the default child, and unfolds the group, when the label is clicked', async () => {
    const { router } = await mountShell('manager', '/staff/dashboard');
    toggle().click();
    await flushPromises();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    label().click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('staff-orders'));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(byId('orders-nav-all')?.getAttribute('aria-current')).toBe('page');
  });

  it('opens the queue page when an accountant clicks the label', async () => {
    const { router } = await mountShell('accountant', '/staff/prices');
    label().click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('staff-accounting'));
  });

  it('the manager own-step child opens the list filtered to SUBMITTED, and All orders lets go', async () => {
    const { router } = await mountShell('manager', '/staff/orders');
    expect(byId('orders-nav-all')?.getAttribute('aria-current')).toBe('page');
    byId('orders-nav-awaitingManager')?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ stage: 'SUBMITTED' }));
    await flushPromises();
    expect(byId('orders-nav-awaitingManager')?.getAttribute('aria-current')).toBe('page');
    expect(byId('orders-nav-all')?.getAttribute('aria-current')).toBeNull();
    expect(label().closest('.og__head')?.classList.contains('og__head--active')).toBe(true);
  });

  it('highlights the group but no child on the order page', async () => {
    const { services, router } = await mountShell('manager', '/staff/orders');
    const id = services.ordersStore.orders.value[0]?.id;
    expect(id).toBeDefined();
    await router.push(`/staff/orders/${id}`);
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('staff-order');
    const heads = document.body.querySelectorAll('.og__head--active');
    expect(heads.length).toBeGreaterThan(0);
    expect(document.body.querySelector('.og__item--active')).toBeNull();
  });

  it('shows the awaiting count from the single source, and a queue count when the summary has it', async () => {
    const { services } = await mountShell('manager', '/staff/orders');
    // The demo data holds three orders awaiting the manager's decision.
    expect(services.awaitingApproval.count.value).toBe(3);
    expect(text(byId('orders-nav-awaitingManager'))).toMatch(/^Tasdiq kutmoqdas*3$/);
    expect(
      byId('orders-nav-awaitingManager')?.querySelector('[aria-label]')?.getAttribute('aria-label'),
    ).toBe('3 ta buyurtma kutmoqda');
  });

  it('shows a queue count from the dashboard summary store once it has answered', async () => {
    const { services } = await mountShell('accountant', '/staff/accounting');
    await services.dashboardSummaryStore.refresh();
    await flushPromises();
    const queue = services.dashboardSummaryStore.summary.value?.queues.find(
      (q) => q.key === 'AWAITING_ACCOUNTING',
    );
    expect(queue?.count).toBeGreaterThan(0);
    expect(text(byId('orders-nav-awaitingAccounting'))).toContain(String(queue?.count));
  });

  it('shows no badge, and does not wait, while the counts have not answered', async () => {
    const { services } = await mountShell('warehouse', '/staff/warehouse');
    services.dashboardSummaryStore.reset();
    await flushPromises();
    expect(text(byId('orders-nav-toRelease'))).toBe('Ombordan chiqarish kutilmoqda');
  });

  it('keeps the own-step count on the label while the group is collapsed', async () => {
    const { services } = await mountShell('manager', '/staff/orders');
    const waiting = services.awaitingApproval.count.value;
    expect(waiting).toBeGreaterThan(0);
    expect(byId('orders-group-badge')).toBeNull();
    toggle().click();
    await flushPromises();
    expect(byId('orders-group-badge')?.textContent?.trim()).toBe(String(waiting));
    expect(byId('orders-group-badge')?.getAttribute('aria-label')).toBe(
      `${waiting} ta buyurtma kutmoqda`,
    );
  });

  it('remembers the fold state for the session and survives broken storage', async () => {
    await mountShell('manager', '/staff/orders');
    toggle().click();
    await flushPromises();
    expect(sessionStorage.getItem('iorder.nav.ordersGroupOpen')).toBe('0');
    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';
    await mountShell('manager', '/staff/orders');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mountShell('manager', '/staff/orders');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    toggle().click();
    await flushPromises();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('is keyboard operable: real buttons, aria-expanded points at the list, children are links', async () => {
    await mountShell('manager', '/staff/orders');
    expect(label().tagName).toBe('BUTTON');
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().getAttribute('aria-label')).toBe("Buyurtmalar bo'limini yig'ish yoki ochish");
    const listId = toggle().getAttribute('aria-controls') ?? '';
    expect(listId).not.toBe('');
    const list = sidebar().querySelector(`[id="${listId}"]`) as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.style.display).not.toBe('none');
    toggle().click();
    await flushPromises();
    expect(list.style.display).toBe('none');
    // Focus order: label, toggle, then the children.
    toggle().click();
    await flushPromises();
    const order = Array.from(
      sidebar().querySelectorAll<HTMLElement>('.og button, .og a[href]'),
    ).map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual([
      'orders-group-label',
      'orders-group-toggle',
      'orders-nav-all',
      'orders-nav-awaitingManager',
    ]);
  });

  it('closes the mobile drawer when a child or the label is chosen', async () => {
    const { services } = createTestServices({ identityId: 'manager' });
    const router = createAppRouter(services.currentUser, createMemoryHistory());
    await router.push('/staff/dashboard');
    await router.isReady();
    const { default: SidebarContent } = await import('./components/SidebarContent.vue');
    const side = mount(SidebarContent, {
      global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
    });
    wrappers.push(side);
    byOn(side, 'orders-nav-awaitingManager').click();
    byOn(side, 'orders-group-label').click();
    expect(side.emitted('navigate')).toHaveLength(2);
  });
});

function byOn(wrapper: VueWrapper, id: string): HTMLElement {
  return wrapper.element.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

describe('quick filter highlight next to the Orders group', () => {
  const onQuick = (): string[] =>
    Array.from(sidebar().querySelectorAll('.quick__item--on')).map((e) => text(e));

  it('the awaiting child alone is current on stage=SUBMITTED; "Bugungi" is not lit with it', async () => {
    await mountShell('manager', '/staff/orders?stage=SUBMITTED');
    expect(byId('orders-nav-awaitingManager')?.getAttribute('aria-current')).toBe('page');
    expect(onQuick()).toEqual([]);
  });

  it('with a period as well, the quick filter is lit and the child gives way', async () => {
    await mountShell('manager', '/staff/orders?stage=SUBMITTED&period=today');
    expect(byId('orders-nav-awaitingManager')?.getAttribute('aria-current')).toBeNull();
    expect(onQuick()).toHaveLength(1);
    expect(onQuick()[0]).toContain('Bugungi');
  });
});

describe('sidebar counts stay live', () => {
  const MINUTE = 60_000;

  // Counts how often the store takes in a fresh answer.
  async function watchAnswers(identity: string, path: string) {
    const made = await mountShell(identity, path);
    let answers = 0;
    const stop = watch(made.services.dashboardSummaryStore.summary, () => (answers += 1));
    return { ...made, answers: () => answers, stop };
  }

  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('re-reads every minute on a page without the summary panel', async () => {
    const { services, answers, stop } = await watchAnswers('accountant', '/staff/prices');
    const before = answers();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(answers()).toBe(before + 1);
    expect(services.dashboardSummaryStore.summary.value).not.toBeNull();
    stop();
  });

  it('does not double the reads where the panel is open too', async () => {
    const { answers, stop } = await watchAnswers('warehouse', '/staff/warehouse');
    const before = answers();
    await vi.advanceTimersByTimeAsync(MINUTE * 3);
    expect(answers()).toBe(before + 3);
    stop();
  });

  // The manager's list is read once when the staff area opens. Without a live summary an order
  // that changed behind the manager's back (a customer placed one, a colleague decided one) left
  // "waiting for approval" at its old number until a reload.
  it("keeps the manager's waiting-for-approval number current on any page", async () => {
    const { services, stop } = await watchAnswers('manager', '/staff/prices');
    const waiting = services.ordersStore.pending.value;
    const before = waiting.length;
    expect(before).toBeGreaterThan(0);
    expect(services.awaitingApproval.count.value).toBe(before);

    // Decided through the api alone: the open page's list does not hear of it.
    const order = waiting[0]!;
    await services.ordersApi.reject(order.id, {
      reason: 'decided by a colleague',
      expectedRowVersion: order.rowVersion,
    });
    expect(services.awaitingApproval.count.value).toBe(before);

    await vi.advanceTimersByTimeAsync(MINUTE);
    await flushPromises();
    expect(services.awaitingApproval.count.value).toBe(before - 1);
    stop();
  });

  it('stops after sign-out and the numbers of the last person are gone', async () => {
    const { services, wrapper, answers, stop } = await watchAnswers('driver', '/staff/deliveries');
    await services.currentUser.signOut();
    wrapper.unmount(); // signing out leaves the staff area, so the shell goes away
    await flushPromises();
    expect(services.dashboardSummaryStore.summary.value).toBeNull();
    const before = answers();
    await vi.advanceTimersByTimeAsync(MINUTE * 3);
    expect(answers()).toBe(before);
    stop();
  });
});
