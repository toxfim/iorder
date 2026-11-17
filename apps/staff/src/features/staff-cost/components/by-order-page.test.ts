import type { ByOrderProduct, ByOrderProductsResponse } from '@iorder/shared/staff-cost';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { waitFor } from '@core/test-utils/wait';
import { createTestServices } from '@/test-utils/create-test-services';
import { orderId } from '@/test-utils/orders';
import ByOrderPage from './ByOrderPage.vue';

// The staff page "Buyurtma orqali" (owner, 2026-11-09): the staff-added products without a sheet
// id with how many pieces open orders wait for, the products needed now first, and a side panel
// with those orders. Loading, empty, error and denied states; cards on a phone.

const wrappers: VueWrapper[] = [];

/** A desktop unless a test says phone (the table turns into cards below 640px). */
let wide = true;
beforeEach(() => {
  wide = true;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: query.includes('min-width: 640px') ? wide : false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountPage(
  options: {
    identity?: string;
    scenario?: FakeScenario;
    prepare?: (services: Services) => void;
  } = {},
) {
  const test = createTestServices({
    scenario: options.scenario ?? 'ready',
    identityId: options.identity ?? 'manager',
  });
  await test.services.currentUser.ensureLoaded();
  options.prepare?.(test.services);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/by-order', component: ByOrderPage },
      { path: '/orders/:orderId', name: 'staff-order', component: { render: () => h('p') } },
    ],
  });
  await router.push('/by-order');
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: test.services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { ...test, router, wrapper };
}

const body = (): HTMLElement => document.body;
const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** The text nodes joined by a space: what is read where only CSS gaps separate the parts. */
function spaced(el: Element | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    if (value) parts.push(value);
  }
  return parts.join(' ');
}
const rows = (): HTMLElement[] =>
  Array.from(body().querySelectorAll<HTMLElement>('tbody .dt__row'));
const cells = (row: Element): string[] => Array.from(row.querySelectorAll('td')).map(spaced);
const cards = (): HTMLElement[] => Array.from(body().querySelectorAll<HTMLElement>('.dt__card'));
const panel = (): HTMLElement | null => body().querySelector('[data-testid="by-order-panel"]');
const panelOrders = (): HTMLElement[] =>
  Array.from(body().querySelectorAll<HTMLElement>('[data-testid="by-order-order"]'));
const rowOf = (name: string): HTMLElement => {
  const row = rows().find((candidate) => text(candidate).includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};
async function openRow(name: string): Promise<void> {
  (rowOf(name).querySelector('.dt__link') as HTMLElement).click();
  await flushPromises();
}
async function type(value: string): Promise<void> {
  const input = body().querySelector('input[type="search"]') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

const UGREEN = 'Ugreen HiTune T6 quloqchin';
const BASEUS = 'Baseus Bowie 30 Max naushnik';
const YESIDO = 'Yesido avtomobil ushlagichi C192';
const REMAX = 'Remax simsiz zaryadlovchi 15W';

const product = (over: Partial<ByOrderProduct>): ByOrderProduct => ({
  productId: orderId('p-1'),
  productCode: 'IO-000001',
  name: 'Quloqchin',
  brandName: null,
  category: null,
  isActive: true,
  basePrice: '2.00',
  deferredPrice: null,
  currency: 'USD',
  openQuantity: '0.000',
  openOrderCount: 0,
  orders: [],
  ...over,
});
const answering = (response: ByOrderProductsResponse) => (services: Services) => {
  vi.spyOn(services.byOrderApi, 'list').mockResolvedValue(response);
};

describe('by-order page: the list', () => {
  it('shows the products needed now first, with the pieces and the orders that wait', async () => {
    await mountPage();
    expect(text(body().querySelector('.head__title'))).toBe('Buyurtma orqali');
    expect(text(body().querySelector('.head__subtitle'))).toBe(
      'Olib kelish kerak: 3 ta tovar · 15 dona · 4 ta buyurtma',
    );
    expect(text(body().querySelector('.note'))).toContain("Mijoz bu belgini ko'rmaydi.");

    const names = rows().map((row) => text(row.querySelector('.name')));
    expect(names).toHaveLength(4);
    // The idle product is last; the three an order waits for are above it.
    expect(names[3]).toBe(YESIDO);
    expect([...names.slice(0, 3)].sort()).toEqual([BASEUS, REMAX, UGREEN].sort());

    // Tovar | Brend | Narx | Olib kelish kerak | Buyurtmalar. The released order is not counted.
    expect(cells(rowOf(UGREEN))).toEqual([
      `${UGREEN} IO-900001 · Quloqchinlar`,
      'Ugreen',
      '$18,50 Отсрочка $19,40',
      '10 dona',
      '2 ta',
    ]);
    expect(cells(rowOf(BASEUS)).slice(2)).toEqual(['$32,00', '2 dona', '1 ta']);
    expect(cells(rowOf(YESIDO))).toEqual([
      `${YESIDO} IO-900003`,
      'Brendsiz',
      '$4,20 Отсрочка $4,50',
      '—',
      '—',
    ]);
    // A product out of sale stays while an order waits for it, and says so.
    expect(text(rowOf(REMAX).querySelector('[data-testid="by-order-inactive"]'))).toBe(
      'Sotuvdan olingan',
    );
    expect(cells(rowOf(REMAX))[2]).toBe("Narxlarda yo'q");
    // The rows an order waits for carry the accent edge.
    expect(rowOf(UGREEN).classList.contains('dt__row--accent')).toBe(true);
    expect(rowOf(YESIDO).classList.contains('dt__row--accent')).toBe(false);
    expect(text(body().querySelector('.list-count'))).toBe('4 ta tovar');
  });

  it('finds a product by a part of its name or its code, and says when nothing matches', async () => {
    await mountPage();
    await type('  bowie ');
    expect(rows().map((row) => text(row.querySelector('.name')))).toEqual([BASEUS]);
    await type('io-900003');
    expect(rows().map((row) => text(row.querySelector('.name')))).toEqual([YESIDO]);
    // The summary speaks of everything to bring, never of the search result.
    expect(text(body().querySelector('.head__subtitle'))).toContain('3 ta tovar');
    await type('nokia');
    expect(rows()).toHaveLength(0);
    expect(text(body())).toContain("Qidiruvga mos tovar yo'q.");
    expect(text(body().querySelector('.list-count'))).toBe('0 ta tovar');
  });

  it('carries no cost and no stock figure', async () => {
    await mountPage();
    expect(text(body())).not.toMatch(/Tannarx|Qoldiq:|Mavjud/);
  });

  it('says so when nothing has to be brought', async () => {
    await mountPage({ prepare: answering({ items: [product({}), product({ name: 'Kabel' })] }) });
    expect(text(body().querySelector('.head__subtitle'))).toBe(
      "Hozir olib kelinadigan tovar yo'q · jami 2 ta tovar",
    );
    expect(body().querySelector('.dt__row--accent')).toBeNull();
  });
});

describe('by-order page: the orders of one product', () => {
  it('opens the orders that wait: number, customer, pieces, status and a link to the order', async () => {
    await mountPage();
    await openRow(UGREEN);
    expect(text(body().querySelector('.drawer__title'))).toBe(UGREEN);
    expect(text(body().querySelector('[data-testid="by-order-total"]'))).toBe(
      'Jami 10 dona · 2 ta buyurtma',
    );
    const orders = panelOrders();
    expect(orders).toHaveLength(2);
    const byNumber = (number: string): HTMLElement => {
      const found = orders.find((order) => text(order).includes(number));
      if (!found) throw new Error(`no order ${number}`);
      return found;
    };
    const first = byNumber('IO-10491');
    expect(text(first.querySelector('.order__customer'))).toBe('Orion Mobile');
    expect(text(first.querySelector('.order__qty'))).toBe('6 dona');
    expect(text(first.querySelector('.badge'))).toBe('Menejerda');
    const link = first.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/orders/${orderId('IO-10491')}`);
    expect(link.getAttribute('aria-label')).toBe('IO-10491 buyurtmasini ochish');
    const second = byNumber('IO-10489');
    expect(text(second.querySelector('.order__customer'))).toBe('Texno Market Andijon');
    expect(text(second.querySelector('.order__qty'))).toBe('4 dona');
    expect(text(second.querySelector('.badge'))).toBe('Buxgalteriyada');
    // The released order of the fixture is not among them.
    expect(text(panel())).not.toContain('IO-10488');
    // The facts of the product, label and value on one row.
    expect(Array.from(body().querySelectorAll('.facts__row')).map((row) => spaced(row))).toEqual([
      'Tovar ID IO-900001',
      'Brend Ugreen',
      'Kategoriya Quloqchinlar',
      'Цена $18,50',
      'Отсрочка $19,40',
    ]);
  });

  it('says that no order waits for an idle product', async () => {
    await mountPage();
    await openRow(YESIDO);
    expect(text(body().querySelector('[data-testid="by-order-none"]'))).toBe(
      'Bu tovarni hozir hech bir buyurtma kutmayapti.',
    );
    expect(panelOrders()).toHaveLength(0);
    expect(body().querySelector('[data-testid="by-order-total"]')).toBeNull();
  });

  it('explains a product out of sale in its panel', async () => {
    await mountPage();
    await openRow(REMAX);
    expect(text(body().querySelector('.panel__note'))).toContain(
      'Ochiq buyurtma kutayotgani uchun',
    );
    expect(panelOrders()).toHaveLength(1);
    expect(text(panelOrders()[0]?.querySelector('.badge'))).toBe('Omborda');
  });

  it('goes to the order page from the link', async () => {
    const { router } = await mountPage();
    await openRow(BASEUS);
    (panelOrders()[0]?.querySelector('a') as HTMLElement).click();
    await waitFor(() => expect(router.currentRoute.value.params.orderId).toBe(orderId('IO-10490')));
  });
});

describe('by-order page: states', () => {
  it('shows the loading state while the list is read', async () => {
    await mountPage({ scenario: 'loading' });
    expect(body().querySelector('[data-state="loading"]')).not.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('shows the empty state with what to do when there is no such product', async () => {
    await mountPage({ scenario: 'empty' });
    expect(text(body().querySelector('[data-state="empty"]'))).toContain(
      "Buyurtma orqali tovar hali yo'q",
    );
    expect(text(body())).toContain('«Yangi tovar»');
    expect(text(body())).toContain("«Tovar ID» bo'sh qator");
    expect(body().querySelector('input[type="search"]')).toBeNull();
  });

  it('shows the error state and reads again on retry', async () => {
    let fail = true;
    const { services } = await mountPage({
      prepare: (s) => {
        const real = s.byOrderApi.list.bind(s.byOrderApi);
        vi.spyOn(s.byOrderApi, 'list').mockImplementation(() =>
          fail ? Promise.reject(new Error('offline')) : real(),
        );
      },
    });
    expect(body().querySelector('[data-state="error"]')).not.toBeNull();
    expect(rows()).toHaveLength(0);
    fail = false;
    const retry = Array.from(body().querySelectorAll('button')).find(
      (button) => text(button) === 'Qayta urinish',
    );
    retry?.click();
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(services.byOrderApi.list).toHaveBeenCalledTimes(2);
  });

  it('shows the denied state to a role the server refuses, without a retry', async () => {
    await mountPage({
      prepare: (s) => {
        vi.spyOn(s.byOrderApi, 'list').mockRejectedValue(new PermissionDeniedError());
      },
    });
    expect(body().querySelector('[data-state="denied"]')).not.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('the fake refuses the warehouse and the driver, like the server', async () => {
    for (const identity of ['warehouse', 'driver']) {
      const { services } = createTestServices({ identityId: identity });
      await services.currentUser.ensureLoaded();
      await expect(services.byOrderApi.list()).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });
});

describe('by-order page: on a phone', () => {
  it('shows each product as a card with the three figures, and a tap opens its orders', async () => {
    wide = false;
    await mountPage();
    expect(body().querySelector('table')).toBeNull();
    expect(cards()).toHaveLength(4);
    const card = cards().find((candidate) => text(candidate).includes(UGREEN)) as HTMLElement;
    expect(text(card.querySelector('.name'))).toBe(UGREEN);
    expect(spaced(card.querySelector('.meta'))).toBe('IO-900001 · Ugreen · Quloqchinlar');
    expect(Array.from(card.querySelectorAll('.card__cell')).map(spaced)).toEqual([
      'Olib kelish kerak 10 dona',
      'Buyurtmalar 2 ta',
      'Narx $18,50',
    ]);
    // Three equal columns: the figures of every card line up under one another.
    expect(card.querySelectorAll('.card__grid > .card__cell')).toHaveLength(3);
    expect(card.tagName).toBe('BUTTON');
    card.click();
    await flushPromises();
    expect(panelOrders()).toHaveLength(2);
  });
});

describe('by-order fake: follows the orders', () => {
  it('stops counting an order once it is rejected', async () => {
    const { services } = createTestServices({ identityId: 'manager' });
    await services.currentUser.ensureLoaded();
    const before = await services.byOrderApi.list();
    expect(before.items.find((item) => item.name === BASEUS)).toMatchObject({
      openQuantity: '2.000',
      openOrderCount: 1,
    });
    const order = await services.ordersApi.getOrder(orderId('IO-10490'));
    await services.ordersApi.reject(order.id, {
      reason: 'Narx eskirgan',
      expectedRowVersion: order.rowVersion,
    });
    const after = await services.byOrderApi.list();
    const baseus = after.items.find((item) => item.name === BASEUS);
    expect(baseus).toMatchObject({ openQuantity: '0.000', openOrderCount: 0, orders: [] });
    // An idle product sorts under the ones still needed.
    expect(after.items.indexOf(baseus as ByOrderProduct)).toBeGreaterThan(1);
  });
});

// Owner, 2026-11-10: products are added on this page too, one at a time or with the Excel
// template (a row without «Tovar ID» becomes a by-order product), with the same dialogs as Narxlar.
describe('by-order page: adding products', () => {
  const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = body().querySelector<T>(`[data-testid="${id}"]`);
    if (!el) throw new Error(`No element with data-testid="${id}"`);
    return el;
  };
  const dialog = (): HTMLElement | null =>
    body().querySelector('[data-testid="modal"]:not(.modal--closing) [role="dialog"]');
  async function click(el: HTMLElement): Promise<void> {
    el.click();
    await flushPromises();
  }
  async function fill(marker: string, value: string): Promise<void> {
    const input = dialog()?.querySelector<HTMLInputElement>(`[${marker}] input`);
    if (!input) throw new Error(`No ${marker} input in the dialog`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
  }

  it('adds one product on the published version and reads the list again', async () => {
    const { services } = await mountPage();
    const create = vi.spyOn(services.pricingApi, 'createManualProduct');
    const list = vi.spyOn(services.byOrderApi, 'list');
    await click(byTestId('new-product-menu'));
    await click(byTestId('add-manual-product'));
    expect(text(dialog())).toContain("Yangi tovar qo'shish");

    await fill('data-manual-name', 'Demo powerbank');
    await fill('data-price-input', '18.5');
    await click(byTestId('manual-save'));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersionNumber: 14, name: 'Demo powerbank', basePrice: '18.5' }),
    );
    expect(dialog()).toBeNull();
    await waitFor(() => expect(list).toHaveBeenCalled());
  });

  it('opens the Excel import with the template', async () => {
    await mountPage();
    await click(byTestId('new-product-menu'));
    await click(byTestId('import-prices'));
    expect(byTestId('import-step-file')).toBeTruthy();
  });

  it('offers both ways in the empty state', async () => {
    await mountPage({ scenario: 'empty' });
    expect(byTestId('by-order-add-single')).toBeTruthy();
    expect(byTestId('by-order-import')).toBeTruthy();
  });

  it('is not offered to a role that may not change prices', async () => {
    await mountPage({ identity: 'accountant' });
    expect(text(body().querySelector('.head__title'))).toBe('Buyurtma orqali');
    expect(body().querySelector('[data-testid="new-product-menu"]')).toBeNull();
  });
});
