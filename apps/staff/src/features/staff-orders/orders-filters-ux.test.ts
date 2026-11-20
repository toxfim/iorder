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
import barSource from './components/OrdersFilterBar.vue?raw';
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
const rows = (): number => document.body.querySelectorAll('[data-testid="order-row"]').length;
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
  document.body.querySelector('[data-testid="filters-toggle"]') as HTMLButtonElement;
const bar = (): HTMLElement | null => document.body.querySelector('.fbar');
const lists = (): string[] =>
  Array.from(document.body.querySelectorAll('.fbar .dd__trigger')).map(
    (b) => b.getAttribute('aria-label') ?? '',
  );
/** Opens a filter list and picks the option with this label. */
async function choose(list: 'payment' | 'period' | 'plan' | 'stage', label: string): Promise<void> {
  (
    document.body.querySelector(`[data-testid="filter-${list}"] .dd__trigger`) as HTMLButtonElement
  ).click();
  await flushPromises();
  const option = Array.from(document.body.querySelectorAll('[role="option"]')).find(
    (o) => squash(o.querySelector('span')?.textContent) === label,
  ) as HTMLElement | undefined;
  if (!option) throw new Error(`no option ${label}`);
  option.click();
  await flushPromises();
}
const options = async (list: 'payment' | 'period' | 'plan' | 'stage'): Promise<string[]> => {
  (
    document.body.querySelector(`[data-testid="filter-${list}"] .dd__trigger`) as HTMLButtonElement
  ).click();
  await flushPromises();
  return Array.from(document.body.querySelectorAll('[role="option"]')).map((o) =>
    squash(o.textContent),
  );
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

  it('a period link (sidebar quick filter) presses All and opens the filter row with it', async () => {
    await mountAt('manager', '/staff/orders?period=debt');
    expect(pressed()).toEqual([tabLabels()[0]]);
    expect(rows()).toBe(1);
    expect(squash(document.body.querySelector('[data-testid="filter-period"]')?.textContent)).toBe(
      "SanaQabul qilingan, to'lanmagan",
    );
  });
});

describe('filter row', () => {
  it('opens from the Filters button, applies at once and shows the active count', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    expect(moreButton().textContent).toContain('Filtrlar');
    expect(moreButton().querySelector('.fbtn__badge')).toBeNull();
    expect(bar()).toBeNull();
    moreButton().click();
    await flushPromises();
    expect(moreButton().getAttribute('aria-expanded')).toBe('true');
    expect(lists()).toEqual(["To'lov turi", 'Sana', "To'lov holati"]);
    await choose('payment', "To'lanmagan");
    await choose('period', 'Bugun');
    await choose('plan', "Bittada to'lash");
    expect(router.currentRoute.value.query).toEqual({
      pay: 'UNPAID',
      period: 'today',
      plan: 'FULL',
    });
    expect(moreButton().querySelector('.fbtn__badge')?.textContent).toBe('3');
    expect(moreButton().getAttribute('aria-label')).toBe('Filtrlar, 3 ta faol');
    // "Hammasi" takes a filter off again
    await choose('payment', 'Hammasi');
    expect(router.currentRoute.value.query).toEqual({ period: 'today', plan: 'FULL' });
  });

  it('"Tozalash" clears every filter: the lists, the pressed tab and the search', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=RELEASED&pay=PAID&q=a');
    expect(bar()).not.toBeNull();
    (document.body.querySelector('.fbar__clear') as HTMLButtonElement).click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
  });
});

describe('phones (below 600px)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) =>
        ({ matches: !query.includes('min-width: 600px') }) as MediaQueryList,
    });
  });

  it('draws three pills and moves every status into Filtrlar → Holat', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    expect(tabs()).toHaveLength(3);
    expect(tabLabels()[1]).toContain('Menejerda');
    moreButton().click();
    await flushPromises();
    expect(lists()[0]).toBe('Holat');
    await choose('stage', 'Omborda');
    expect(router.currentRoute.value.query).toEqual({ stage: 'ACCOUNTING_CLEARED' });
    // a status without its own pill keeps the row open, so the choice stays visible
    expect(bar()).not.toBeNull();
    expect(pressed()).toEqual([]);
  });
});

describe('applied filters and the empty result', () => {
  it('an empty result explains itself and offers Clear filters', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=CLOSED&pay=PAID');
    expect(rows()).toBe(0);
    expect(squash(document.body.querySelector('.empty')?.textContent)).toBe(
      "Filtrga mos buyurtma yo'q",
    );
    const button = document.body.querySelector('.empty-clear') as HTMLButtonElement;
    expect(squash(button.textContent)).toBe('Filtrlarni tozalash');
    button.click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(document.body.querySelector('.empty-clear')).toBeNull();
  });

  it('keeps the money filters that emptied the list, so each can be changed on its own', async () => {
    await mountAt('manager', '/staff/orders?stage=CLOSED&pay=PAID&plan=DEFERRED');
    expect(rows()).toBe(0);
    expect(lists()).toEqual(["To'lov turi", 'Sana', "To'lov holati"]);
  });
});

describe('what each role sees', () => {
  async function mountPageAs(identity: string, path = '/staff/orders') {
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
    await router.push(path);
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
    expect(lists()).toEqual(["To'lov turi", 'Sana', "To'lov holati"]);
    expect(await options('period')).toContain("Qabul qilingan, to'lanmagan");
  });

  it('a list without money fields (driver, warehouse view) has no payment or debt filter', async () => {
    await mountPageAs('driver');
    expect(rows()).toBeGreaterThanOrEqual(0);
    moreButton().click();
    await flushPromises();
    expect(lists()).toEqual(['Sana']);
    expect(await options('period')).not.toContain("Qabul qilingan, to'lanmagan");
    // no own-step highlight outside the manager role
    expect(document.body.querySelector('.tab--own')).toBeNull();
  });

  it.each(['driver', 'warehouse'])(
    'a money filter in a link opens the plain list for the %s, not a refusal',
    async (who) => {
      await mountPageAs(who, '/staff/orders?plan=FULL&pay=PAID&period=debt');
      expect(document.body.querySelector('[data-state="denied"]')).toBeNull();
      expect(document.body.querySelector('[data-state="error"]')).toBeNull();
    },
  );
});

describe('mobile layout (source checks)', () => {
  it('the tabs scroll sideways instead of wrapping and keep 44px targets on touch', () => {
    expect(tabsSource).toMatch(/\.tabs\s*\{[^}]*overflow-x:\s*auto/);
    expect(tabsSource).toMatch(/white-space:\s*nowrap/);
    expect(tabsSource).toMatch(
      /@media \(pointer: coarse\)[^{]*\{\s*\.tab\s*\{\s*min-height:\s*44px/,
    );
  });

  it('the filter row folds into two columns on a phone; the page uses tokens only', () => {
    expect(barSource).toMatch(
      /@media \(max-width: 599px\)[^{]*\{\s*\.fbar\s*\{[^}]*grid-template-columns/,
    );
    expect(pageSource).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(pageSource).toContain('var(--');
  });
});
