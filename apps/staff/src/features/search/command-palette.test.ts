import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { initialsOf } from '@/features/directory/domain/directory-model';
import { createAppRouter } from '@/router';
import { createTestServices } from '@/test-utils/create-test-services';
import { orderId } from '@/test-utils/orders';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import CommandPalette from './components/CommandPalette.vue';
import { MANAGER_SCOPE } from '@/features/staff-orders/domain/order-scopes';
import {
  buildSearchGroups,
  flattenGroups,
  type SearchLabels,
  type SearchSources,
} from './domain/search-groups';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

async function mountPalette(identity = 'admin') {
  await preloadRouteComponents();
  const { services } = createTestServices({ identityId: identity });
  await services.currentUser.ensureLoaded();
  await services.ordersStore.loadBase(MANAGER_SCOPE);
  await services.directoryStore.load();
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push('/staff/dashboard');
  const wrapper = mount(CommandPalette, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  services.commandPalette.open();
  await flushPromises();
  return { services, router };
}

const input = (): HTMLInputElement =>
  document.body.querySelector('input[role="combobox"]') as HTMLInputElement;
const options = (): HTMLElement[] => Array.from(document.body.querySelectorAll('[role="option"]'));
const titles = (): string[] =>
  Array.from(document.body.querySelectorAll('.cmd__title')).map((e) => e.textContent ?? '');
async function type(value: string): Promise<void> {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  // Orders are searched on the server after a short pause.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await flushPromises();
}
function key(name: string, init: KeyboardEventInit = {}): void {
  input().dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }),
  );
}

describe('CommandPalette (Ctrl+K)', () => {
  it('opens focused with the orders waiting for the manager and the pages (v1 empty query)', async () => {
    await mountPalette();
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(titles()).toEqual(['Tasdiq kutayotganlar', 'Sahifalar']);
    expect(
      options()
        .slice(0, 3)
        .map((o) => o.querySelector('.cmd__name')?.textContent),
    ).toEqual([
      'IO-10491 · Orion Mobile',
      'IO-10490 · Mobile Center Samarqand',
      'IO-10487 · Click Store',
    ]);
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('searches orders, customers, members and products at once', async () => {
    await mountPalette();
    await type('orion');
    expect(titles()).toEqual(['Buyurtmalar', 'Mijozlar']);
    await type('jasur');
    expect(titles()).toEqual(['Buyurtmalar', "A'zolar"]);
    await type('10483');
    expect(titles()).toEqual(['Tovarlar']);
    expect(options()[0]?.textContent).toContain('Samsung 25W zaryadlovchi');
    await type('xodim');
    expect(titles()).toEqual(['Sahifalar']);
  });

  it('moves with the arrow keys, opens with Enter and closes itself', async () => {
    const { services, router } = await mountPalette();
    key('ArrowDown');
    await flushPromises();
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
    key('ArrowUp');
    key('ArrowUp');
    await flushPromises();
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');

    key('ArrowDown');
    await flushPromises();
    key('Enter');
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(false);
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-order'));
    expect(router.currentRoute.value.params.orderId).toBe(orderId('IO-10490'));
  });

  it('ignores the Enter that confirms an IME composition', async () => {
    const { services, router } = await mountPalette();
    key('Enter', { isComposing: true });
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(true);
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
    key('Enter');
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(false);
  });

  it('hover selects the row under the pointer', async () => {
    await mountPalette();
    options()[2]?.dispatchEvent(new MouseEvent('mouseenter'));
    await flushPromises();
    expect(options()[2]?.getAttribute('aria-selected')).toBe('true');
  });

  it('says so when nothing matches, and Esc closes', async () => {
    const { services } = await mountPalette();
    await type('zzzz');
    expect(options()).toHaveLength(0);
    expect(document.body.querySelector('.cmd__empty')?.textContent).toBe(
      "«zzzz» bo'yicha hech narsa topilmadi",
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(services.commandPalette.isOpen.value).toBe(false);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('an accountant sees only the pages of the role', async () => {
    await mountPalette('accountant');
    await type('orion');
    expect(titles()).toEqual([]);
  });

  it('starts empty every time it is opened', async () => {
    const { services } = await mountPalette();
    await type('orion');
    services.commandPalette.close();
    await flushPromises();
    services.commandPalette.open();
    await flushPromises();
    expect(input().value).toBe('');
    expect(titles()).toEqual(['Tasdiq kutayotganlar', 'Sahifalar']);
  });
});

describe('buildSearchGroups', () => {
  const labels: SearchLabels = {
    pageSubtitle: 'page',
    orderSubtitle: (o) => o.id,
    memberSubtitle: (m) => m.name,
    productTitle: (p) => p.productCode,
    productSubtitle: (p) => p.unit ?? '',
  };
  const empty: SearchSources = {
    pages: [],
    orders: null,
    organizations: null,
    members: null,
    products: null,
  };

  it('skips a source the role may not open and offers pages filtered by the query', () => {
    const sources: SearchSources = {
      ...empty,
      pages: [
        { key: 'dashboard', label: 'Bosh sahifa', to: { name: 'staff-dashboard' } },
        { key: 'prices', label: 'Narxlar', to: { name: 'staff-prices' } },
      ],
    };
    expect(buildSearchGroups('', sources, labels).map((g) => g.key)).toEqual(['pages']);
    expect(flattenGroups(buildSearchGroups('narx', sources, labels)).map((i) => i.title)).toEqual([
      'Narxlar',
    ]);
    expect(buildSearchGroups('zzz', sources, labels)).toEqual([]);
  });

  it('finds a member by phone however the number is typed', () => {
    const members = [
      {
        id: 'm1',
        organizationId: 'o1',
        name: 'Jasur Karimov',
        phone: '+998935550147',
        telegramUsername: '@jasur_k',
        role: 'SELLER' as const,
        isActive: true,
        joinedAt: '2026-10-01T09:00:00.000Z',
      },
    ];
    for (const typed of ['+998 93 555 0147', '998935550147', '93 555', '5550147']) {
      const groups = buildSearchGroups(typed, { ...empty, members }, labels);
      expect(flattenGroups(groups).map((i) => i.title)).toEqual(['Jasur Karimov']);
    }
    expect(buildSearchGroups('93 556', { ...empty, members }, labels)).toEqual([]);
  });

  it('limits every group (orders 5, products 5) and uses initials for people', () => {
    expect(initialsOf('Sanjar Toshev')).toBe('ST');
    expect(initialsOf('  madonna ')).toBe('M');
    const products = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      productCode: `CODE-${i}`,
      name: `Product ${i}`,
      unit: 'PIECE',
      category: null,
      categoryId: null,
      trackingType: 'NONE' as const,
      markingRequired: false,
      codeRuleConfigured: false,
      isActive: true,
      codeGenerated: false,
      mergedIntoProductId: null,
      translations: [],
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    }));
    const groups = buildSearchGroups('code', { ...empty, products }, labels);
    expect(groups[0]?.items).toHaveLength(5);
    expect(groups[0]?.items[0]?.to).toEqual({ name: 'staff-prices', query: { history: 'p0' } });
  });
});
