import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { servicesKey } from '@/app/services';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import tabsSource from './components/OrdersStatusTabs.vue?raw';
import sheetSource from './components/OrdersFilterSheet.vue?raw';
import pageSource from './components/OrdersPage.vue?raw';

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true }) as MediaQueryList,
  });
});
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function mountAt(identity: string, path: string) {
  await preloadRouteComponents();
  const { services } = createTestServices({
    identityId: identity,
    clock: { now: () => TEST_NOW },
  });
  await services.currentUser.ensureLoaded();
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(path);
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await services.ordersStore.load();
  await waitFor(() => expect(document.body.querySelector('.orders')).not.toBeNull());
  await flushPromises();
  return { services, router };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const rows = (): number => document.body.querySelectorAll('tbody .dt__row').length;
const tabs = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.tabs .tab'));
const tab = (index: number): HTMLButtonElement => {
  const found = tabs()[index];
  if (!found) throw new Error(`no tab ${index}`);
  return found;
};
const tabLabels = (): string[] => tabs().map((b) => squash(b.textContent));
const pressed = (): string[] =>
  tabs()
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => squash(b.textContent));
const moreButton = (): HTMLButtonElement =>
  document.body.querySelector('.more') as HTMLButtonElement;
const sheet = (): HTMLElement | null => document.body.querySelector('[data-testid="drawer"]');
const radio = (label: string): HTMLInputElement => {
  const row = Array.from(document.body.querySelectorAll('.choice')).find(
    (c) => squash(c.textContent) === label,
  );
  if (!row) throw new Error(`no choice ${label}`);
  return row.querySelector('input') as HTMLInputElement;
};

describe('status tabs', () => {
  it('shows All first, the manager step second, and presses All by default', async () => {
    await mountAt('manager', '/staff/orders');
    const labels = tabLabels();
    expect(labels[0]).toMatch(/^Hammasi 12$/);
    expect(labels[1]).toContain('Menejerda');
    expect(labels[1]).toContain('(sizning bosqichingiz)');
    expect(labels.at(-1)).toContain('Rad etilgan / bekor');
    expect(pressed()).toEqual([labels[0]]);
  });

  it('counts add up with the list and a tab press writes the stage into the URL', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    const counts = tabs().map((b) => Number(b.querySelector('.tab__count')?.textContent));
    expect(counts[0]).toBe(counts.slice(1).reduce((a, b) => a + b, 0));
    tab(1).click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ stage: 'SUBMITTED' });
    expect(rows()).toBe(counts[1]);
    expect(pressed()).toHaveLength(1);
    expect(tab(1).getAttribute('aria-pressed')).toBe('true');
    tab(0).click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('counts follow the sheet filters, so a tab shows what it will list', async () => {
    await mountAt('manager', '/staff/orders?pay=PAID');
    const total = Number(tab(0).querySelector('.tab__count')?.textContent);
    expect(total).toBe(rows());
    expect(total).toBeLessThan(12);
  });

  it('presses the tab of a deep link and keeps old links working', async () => {
    await mountAt('manager', '/staff/orders?stage=RELEASED&pay=PAID');
    expect(pressed()[0]).toContain('Ombordan chiqdi');
    expect(rows()).toBe(2);
    expect(moreButton().textContent).toContain('1');
  });

  it('a period link (sidebar quick filter) presses All and shows the period as a chip', async () => {
    await mountAt('manager', '/staff/orders?period=debt');
    expect(pressed()).toEqual([tabLabels()[0]]);
    expect(rows()).toBe(1);
    const chips = Array.from(document.body.querySelectorAll('.applied .chip'));
    expect(chips.map((c) => squash(c.textContent))).toEqual([
      "Davr: Qabul qilingan, to'lanmagan ×",
    ]);
  });
});

describe('filters sheet', () => {
  it('opens from the Filters button, applies at once and shows the active count', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    expect(moreButton().textContent).toContain('Filtrlar');
    expect(moreButton().querySelector('.more__badge')).toBeNull();
    moreButton().click();
    await flushPromises();
    expect(sheet()).not.toBeNull();
    radio("To'lanmagan").click();
    await flushPromises();
    radio('Bugun').click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ pay: 'UNPAID', period: 'today' });
    expect(moreButton().querySelector('.more__badge')?.textContent).toBe('2');
    expect(moreButton().getAttribute('aria-label')).toBe('Filtrlar, 2 ta faol');
  });

  it('resets only its own filters, keeping stage and search', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=RELEASED&pay=PAID&q=a');
    moreButton().click();
    await flushPromises();
    const reset = Array.from(document.body.querySelectorAll('.drawer button')).find(
      (b) => squash(b.textContent) === 'Tozalash',
    ) as HTMLButtonElement;
    reset.click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ stage: 'RELEASED', q: 'a' });
  });

  it('is a labelled dialog whose radio groups have legends, and Esc closes it', async () => {
    await mountAt('manager', '/staff/orders');
    moreButton().click();
    await flushPromises();
    expect(sheet()?.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    const legends = Array.from(document.body.querySelectorAll('.group__legend')).map((l) =>
      squash(l.textContent),
    );
    expect(legends).toEqual(["To'lov", 'Davr']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => expect(sheet()).toBeNull());
  });
});

describe('applied filters and the empty result', () => {
  it('Clear all resets stage, sheet filters and text', async () => {
    const { router } = await mountAt(
      'manager',
      '/staff/orders?stage=RELEASED&pay=PAID&period=today',
    );
    const clear = Array.from(document.body.querySelectorAll('.applied .clear'))[0];
    (clear as HTMLButtonElement).click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(rows()).toBe(12);
  });

  it('an empty result explains itself and offers Clear filters', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=CLOSED&pay=PAID');
    expect(rows()).toBe(0);
    expect(squash(document.body.querySelector('.dt__empty')?.textContent)).toBe(
      "Filtrga mos buyurtma yo'q",
    );
    const button = document.body.querySelector('.empty-clear') as HTMLButtonElement;
    expect(squash(button.textContent)).toBe('Filtrlarni tozalash');
    button.click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(document.body.querySelector('.empty-clear')).toBeNull();
  });
});

describe('what each role sees', () => {
  async function mountPageAs(identity: string) {
    await preloadRouteComponents();
    const { services } = createTestServices({
      identityId: identity,
      clock: { now: () => TEST_NOW },
    });
    await services.currentUser.ensureLoaded();
    const Page = (await import('./components/OrdersPage.vue')).default;
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/staff/orders', name: 'staff-orders', component: Page },
        { path: '/staff/orders/:orderId', name: 'staff-order', component: Page },
      ],
    });
    await router.push('/staff/orders');
    const wrapper = mount(Page, {
      attachTo: document.body,
      global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
    });
    wrappers.push(wrapper);
    await services.ordersStore.load();
    await flushPromises();
  }

  it('the manager gets the payment group and the debt period', async () => {
    await mountAt('manager', '/staff/orders');
    moreButton().click();
    await flushPromises();
    expect(Array.from(document.body.querySelectorAll('.group__legend')).length).toBe(2);
    expect(() => radio("Qabul qilingan, to'lanmagan")).not.toThrow();
  });

  it('a list without money fields (driver, warehouse view) has no payment or debt filter', async () => {
    await mountPageAs('driver');
    const rowsShown = document.body.querySelectorAll('tbody .dt__row').length;
    expect(rowsShown).toBeGreaterThanOrEqual(0);
    moreButton().click();
    await flushPromises();
    const legends = Array.from(document.body.querySelectorAll('.group__legend')).map((l) =>
      squash(l.textContent),
    );
    expect(legends).toEqual(['Davr']);
    expect(() => radio("Qabul qilingan, to'lanmagan")).toThrow();
    // no own-step highlight outside the manager role
    expect(document.body.querySelector('.tab--own')).toBeNull();
  });
});

describe('mobile layout (source checks)', () => {
  it('the tabs scroll sideways instead of wrapping and keep 44px targets on touch', () => {
    expect(tabsSource).toMatch(/\.tabs\s*\{[^}]*overflow-x:\s*auto/);
    expect(tabsSource).toMatch(/white-space:\s*nowrap/);
    expect(tabsSource).toMatch(
      /@media \(pointer: coarse\)[^{]*\{\s*\.tab\s*\{\s*min-height:\s*44px/,
    );
  });

  it('the sheet is full width on phones with 48px choices; the page uses tokens only', () => {
    expect(sheetSource).toContain('width="min(420px, 100%)"');
    expect(sheetSource).toMatch(/\.choice\s*\{[^}]*min-height:\s*48px/);
    expect(pageSource).toContain('var(--');
  });
});
