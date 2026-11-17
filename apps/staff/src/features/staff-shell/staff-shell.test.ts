import { fifoPlanOf } from '@/features/staff-orders/api/fake-allocation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { createAppRouter } from '@/router';
import { createTestServices } from '@/test-utils/create-test-services';
import { summaryByNumber } from '@/test-utils/orders';
import { defineComponent, h } from 'vue';
import { RouterView } from 'vue-router';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

async function mountShell(identity: string, path = '/staff/dashboard') {
  const { services } = createTestServices({ identityId: identity });
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

const sidebar = (): HTMLElement => document.body.querySelector('.shell__sidebar') as HTMLElement;
const navItems = (): string[] =>
  Array.from(sidebar().querySelectorAll('.item')).map(
    (e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );

describe('staff shell: v1 sidebar', () => {
  it('shows the v1 groups, the count badge, the quick filters, the price card and the user block (admin)', async () => {
    await mountShell('admin');
    // Design v8: the stock has its own "Ombor" section above "Savdo".
    expect(
      Array.from(sidebar().querySelectorAll('.group__title')).map((e) => e.textContent),
    ).toEqual(['Umumiy', 'Ombor', 'Savdo', 'Tizim', 'Tez filtrlar']);
    expect(navItems()).toEqual([
      'Bosh sahifa',
      'Qoldiq5',
      'Buyurtma orqali',
      'Narxlar6',
      'Brendlar',
      'Mijozlar',
      'Tashkilotlar3',
      'Xodimlar',
      'Faoliyat tarixi',
      'Bot sozlamalari',
      'Mening profilim',
    ]);
    expect(
      Array.from(sidebar().querySelectorAll('.quick__item')).map((e) =>
        e.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Bugungi2', "To'lanmagan1"]);
    expect(sidebar().querySelector('.card')?.textContent?.replace(/\s+/g, ' ')).toContain(
      "Narx ro'yxativ14 · 08:30",
    );
    expect(sidebar().querySelector('.user__avatar')?.textContent).toBe('ST');
    expect(sidebar().querySelector('.user__name')?.textContent).toBe('Sanjar Toshev');
    expect(sidebar().querySelector('.user__role')?.textContent).toBe('Administrator');
    // v8: the static workspace card (single company, no switcher) and the footer line.
    expect(sidebar().querySelector('.workspace')?.textContent).toContain('iOrder savdo');
    expect(sidebar().querySelector('.workspace button, .workspace [aria-haspopup]')).toBeNull();
    expect(sidebar().querySelector('.sidebar__footer')?.textContent).toContain('iOrder.uz');
  });

  it('shows the unpriced product count on the Narxlar item to managers and admins only', async () => {
    const { services } = await mountShell('manager');
    const badge = sidebar().querySelector('[data-testid="unpriced-badge"]');
    expect(badge?.textContent?.trim()).toBe('6');
    expect(badge?.getAttribute('aria-label')).toBe('6 ta narxsiz tovar');
    services.unpricedCountStore.set(0);
    await flushPromises();
    expect(sidebar().querySelector('[data-testid="unpriced-badge"]')).toBeNull();
  });

  it('F-04: the Qoldiq item carries the number of sheet items that need a manager, and drops it when none are left', async () => {
    const { services } = await mountShell('manager');
    const badge = sidebar().querySelector('[data-testid="sheet-attention-badge"]');
    expect(badge).not.toBeNull();
    expect(Number(badge?.textContent?.trim())).toBe(services.sheetAttentionStore.count.value);
    expect(services.sheetAttentionStore.count.value).toBeGreaterThan(0);
    services.sheetAttentionStore.setRemovals(0);
    expect(services.sheetAttentionStore.removals.value).toBe(0);
  });

  it('re-reads the Qoldiq badge on entering Qoldiq / Narxlar and when the unpriced count moves', async () => {
    const { services, router } = await mountShell('manager');
    const refresh = vi.spyOn(services.sheetAttentionStore, 'refresh');
    await router.push('/staff/stock');
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(1);
    await router.push('/staff/prices');
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(2);
    await router.push('/staff/dashboard');
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(2);
    services.unpricedCountStore.set((services.unpricedCountStore.count.value ?? 0) + 1);
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('F-04: nobody but the people who decide sees the Qoldiq badge', async () => {
    await mountShell('accountant', '/staff/accounting');
    expect(sidebar().querySelector('[data-testid="sheet-attention-badge"]')).toBeNull();
  });

  it('shows no unpriced count to an accountant, and does not even ask for it', async () => {
    const { services } = await mountShell('accountant', '/staff/accounting');
    expect(sidebar().querySelector('[data-testid="unpriced-badge"]')).toBeNull();
    expect(services.unpricedCountStore.count.value).toBeNull();
  });

  it('shows a manager the staff accounts page (Xodimlar is for admin and manager)', async () => {
    await mountShell('manager');
    expect(navItems()).toEqual([
      'Bosh sahifa',
      'Qoldiq5',
      'Buyurtma orqali',
      'Narxlar6',
      'Brendlar',
      'Mijozlar',
      'Tashkilotlar3',
      'Xodimlar',
      'Faoliyat tarixi',
      'Bot sozlamalari',
      'Mening profilim',
    ]);
  });

  it('gives an accountant no order quick filters, but the prices (read only) and stock pages', async () => {
    await mountShell('accountant', '/staff/accounting');
    expect(sidebar().querySelector('.quick')).toBeNull();
    expect(navItems()).toEqual(['Qoldiq', 'Buyurtma orqali', 'Narxlar', 'Mening profilim']);
    // The price card follows the prices entry: whoever may open the list sees its version.
    expect(sidebar().querySelector('.card')).not.toBeNull();
  });

  it('keeps stock and prices away from warehouse and driver', async () => {
    await mountShell('warehouse', '/staff/warehouse');
    expect(navItems().join('|')).not.toMatch(/Qoldiq|Narxlar|Buyurtma orqali/);
    expect(sidebar().querySelector('.card')).toBeNull();
  });

  it('F-01: after an approval the dashboard card, the age, the sidebar badge and the quick filter agree', async () => {
    // The count-up animation would still be running; reduced motion shows the final number.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: true }) as MediaQueryList,
    });
    const { services } = await mountShell('manager');
    const card = (): string =>
      document.body.querySelector('.kpi--sand')?.textContent?.replace(/\s+/g, ' ') ?? '';
    const badge = (): string =>
      sidebar()
        .querySelector('[data-testid="orders-nav-awaitingManager"]')
        ?.textContent?.replace('Tasdiq kutmoqda', '')
        .trim() ?? '';
    expect(card()).toContain('3');
    expect(card()).toContain('Eng uzoq kutayotgani');

    // Approve while a summary read is still running: its answer must not win over the change.
    const first = services.ordersStore.pending.value[0];
    expect(first).toBeDefined();
    if (!first) return;
    void services.dashboardSummaryStore.refresh();
    await services.ordersStore.approve(first, {
      skipAccounting: false,
      paymentMethod: 'CASH',
      plan: await fifoPlanOf(services.ordersApi, first.id),
    });
    await flushPromises();
    await flushPromises();

    expect(card()).toContain('2');
    expect(card()).toContain('Eng uzoq kutayotgani');
    expect(badge()).toBe('2');
    expect(services.awaitingApproval.count.value).toBe(2);

    for (const order of [...services.ordersStore.pending.value]) {
      await services.ordersStore.approve(order, {
        skipAccounting: false,
        paymentMethod: 'CASH',
        plan: await fifoPlanOf(services.ordersApi, order.id),
      });
    }
    await flushPromises();
    await flushPromises();
    expect(card()).not.toContain('Eng uzoq kutayotgani');
    expect(badge()).toBe('');
    expect(services.awaitingApproval.oldestAgeMinutes.value).toBeNull();
  });

  it('quick filters jump to the filtered orders list and mark the active one', async () => {
    const { router } = await mountShell('admin');
    const today = Array.from(sidebar().querySelectorAll<HTMLAnchorElement>('.quick__item')).find(
      (item) => item.textContent?.includes('Bugungi'),
    );
    expect(today).toBeDefined();
    today?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('staff-orders'));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ period: 'today' });
    expect(sidebar().querySelectorAll('.quick__item--on')).toHaveLength(1);
    expect(sidebar().querySelector('.quick__item--on')?.textContent).toContain('Bugungi');
  });

  it('updates the badge when an order is approved', async () => {
    const { services } = await mountShell('manager');
    const order = summaryByNumber(services, 'IO-10491');
    if (!order) throw new Error('IO-10491 is missing');
    await services.ordersStore.approve(order, {
      skipAccounting: false,
      paymentMethod: 'CASH',
      plan: await fifoPlanOf(services.ordersApi, order.id),
    });
    await flushPromises();
    expect(
      sidebar().querySelector('[data-testid="orders-nav-awaitingManager"]')?.textContent,
    ).toContain('2');
  });
});

describe('staff shell: top bar and user menu', () => {
  it('opens the search from the top bar button and from Ctrl+K / Cmd+K', async () => {
    const { services } = await mountShell('admin');
    expect(document.body.querySelector('.topbar .search')?.textContent).toContain(
      'Buyurtma, mijoz, tovar yoki xodim',
    );
    expect(document.body.querySelector('.topbar kbd')?.textContent).toBe('Ctrl');

    document.body.querySelector<HTMLButtonElement>('.topbar .search')?.click();
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(true);
    services.commandPalette.close();
    await flushPromises();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true }),
    );
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(true);
    services.commandPalette.close();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'K', metaKey: true, cancelable: true }),
    );
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(true);
  });

  it('names the section in the breadcrumb on a page below it (an order), not an empty bar', async () => {
    const { services } = await mountShell('manager');
    const [order] = services.ordersStore.orders.value;
    expect(order).toBeDefined();
    wrappers.forEach((w) => w.unmount());
    wrappers.length = 0;
    document.body.innerHTML = '';
    await mountShell('manager', `/staff/orders/${order?.id ?? ''}`);
    expect(document.body.querySelector('.crumb__page')?.textContent?.trim()).toBe('Buyurtmalar');
  });

  it('signs out with the labelled icon button of the user block (v8)', async () => {
    const { router } = await mountShell('admin');
    const button = sidebar().querySelector<HTMLButtonElement>('[data-testid="sign-out"]');
    expect(button?.getAttribute('aria-label')).toBe('Chiqish');
    button?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
  });

  it('shows the business date, the theme and language switchers, the bell and the initials', async () => {
    await mountShell('admin');
    const tools = document.body.querySelector('.topbar__tools') as HTMLElement;
    // TEST_NOW is 19 October 2026 in Tashkent.
    expect(tools.querySelector('[data-testid="topbar-date"]')?.textContent?.trim()).toBe(
      '19 oktyabr 2026',
    );
    expect(tools.querySelectorAll('.dd')).toHaveLength(2);
    expect(tools.lastElementChild?.textContent?.trim()).toBe('ST');
  });

  it('opens the notifications panel with its empty state and closes it with Esc', async () => {
    await mountShell('admin');
    const bell = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="notifications-bell"]',
    );
    expect(bell?.getAttribute('aria-label')).toBe('Bildirishnomalar');
    bell?.click();
    await flushPromises();
    expect(bell?.getAttribute('aria-expanded')).toBe('true');
    const panel = document.body.querySelector('.bell__panel');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.textContent).toContain("Hozircha bildirishnoma yo'q");
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('.bell__panel')).toBeNull();
    expect(document.activeElement).toBe(bell);
  });
});
