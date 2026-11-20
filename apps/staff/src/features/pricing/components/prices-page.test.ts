import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import PricesPage from '@/features/pricing/components/PricesPage.vue';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { createTestServices } from '@/test-utils/create-test-services';

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

async function mountPrices(
  identity: string,
  options: {
    scenario?: FakeScenario;
    prepare?: (services: Services) => void | Promise<void>;
    path?: string;
  } = {},
) {
  const test = createTestServices({ scenario: options.scenario ?? 'ready', identityId: identity });
  // The route guard loads the session before any staff page; this test router has no guard.
  await test.services.currentUser.ensureLoaded();
  await options.prepare?.(test.services);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/prices', component: PricesPage },
      { path: '/versions', name: 'staff-price-versions', component: { render: () => h('p') } },
      { path: '/products', name: 'staff-products', component: { render: () => h('p') } },
      { path: '/newer-models', name: 'staff-newer-models', component: { render: () => h('p') } },
      { path: '/stock', name: 'staff-stock', component: { render: () => h('p', 'stock') } },
    ],
  });
  await router.push(options.path ?? '/prices');
  const host = defineComponent({ render: () => h(RouterView) });
  const wrapper = mount(host, {
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
/** Like `text`, but separates the text of neighbouring elements with a space. */
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
const RETRY = 'Qayta urinish';
const buttons = (): HTMLButtonElement[] => Array.from(body().querySelectorAll('button'));
function button(label: string, exact = true): HTMLButtonElement {
  const found = buttons().find((b) =>
    exact ? text(b) === label || b.getAttribute('aria-label') === label : text(b).includes(label),
  );
  if (!found) {
    throw new Error(
      `No button "${label}". Have: ${buttons()
        .map((b) => text(b))
        .join(' | ')}`,
    );
  }
  return found;
}
const hasButton = (label: string): boolean => buttons().some((b) => text(b).includes(label));
/** A ready view («Tayyor ko'rinishlar») by its key. */
const view = (key: string): HTMLButtonElement => {
  const found = body().querySelector<HTMLButtonElement>(`[data-preset="${key}"]`);
  if (!found) throw new Error(`No view "${key}"`);
  return found;
};
/** The side panel ("Tarix") while it is open. */
const panel = (): HTMLElement | null =>
  body().querySelector('[data-testid="drawer"]:not(.drawer--closing)');
// The v8 category dropdown: one trigger, a popup with a search field and the options.
const categoryTrigger = (): HTMLButtonElement => {
  const el = body().querySelector<HTMLButtonElement>(
    '[data-testid="category-filter"] button[aria-haspopup="listbox"]',
  );
  if (!el) throw new Error('no category filter');
  return el;
};
const categoryValue = (): string => text(categoryTrigger().querySelector('.catdd__value'));
const categoryOptions = (): HTMLElement[] =>
  Array.from(body().querySelectorAll<HTMLElement>('.catdd__pop [role="option"]'));
async function openCategories(): Promise<void> {
  if (categoryTrigger().getAttribute('aria-expanded') !== 'true') {
    categoryTrigger().click();
    await flushPromises();
  }
}
/** "Label count" of every option, in menu order. */
async function categoryMenu(): Promise<string[]> {
  await openCategories();
  const labels = categoryOptions().map((o) => text(o));
  categoryTrigger().click();
  await flushPromises();
  return labels;
}
async function pickCategory(label: string): Promise<void> {
  await openCategories();
  const option = categoryOptions().find((o) => text(o.querySelector('.catdd__label')) === label);
  if (!option) throw new Error(`No category "${label}"`);
  option.click();
  await flushPromises();
}
const rows = (): HTMLElement[] => Array.from(body().querySelectorAll<HTMLElement>('tbody tr'));
const rowFor = (code: string): HTMLElement => {
  const found = rows().find((r) => r.textContent?.includes(code));
  if (!found) throw new Error(`No row ${code}`);
  return found;
};
const codes = (): string[] => rows().map((r) => text(r.querySelector('.code')));
async function click(el: HTMLElement): Promise<void> {
  el.click();
  await flushPromises();
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
const dialog = (): HTMLElement | null =>
  body().querySelector('[data-testid="modal"]:not(.modal--closing) [role="dialog"]');
const rate = (): HTMLElement => {
  const el = body().querySelector<HTMLElement>('[data-testid="usd-rate"]');
  if (!el) throw new Error('no rate control');
  return el;
};

describe('Narxlar: cost columns by role', () => {
  it('shows the manager the columns of the design: stock under the name, the markup with its cost', async () => {
    await mountPrices('manager');
    const headers = Array.from(body().querySelectorAll('thead th')).map((h) => text(h));
    expect(headers).toEqual([
      'Tovar',
      "Standart · keyin to'lash",
      'Ulgurji / Hamkor',
      'Alif factoring',
      'Ustama',
      "O'zgargan",
      'Amallar',
    ]);
    const row = rowFor('10491');
    expect(text(row.querySelector('[data-sale]'))).toBe('$133,60');
    // 34 + 25 pieces in stock, green; the colour is never the only signal (the figure is text).
    expect(text(row.querySelector('.pt__stock--ok'))).toBe('59 dona');
    // Markup of the USD price over the USD cost ($128.50), the full text on hover.
    const markup = row.querySelector('[data-markup]');
    expect(markup?.getAttribute('title')).toBe('Ustama +4,0%');
    expect(text(markup).startsWith('+4,0%')).toBe(true);
    // Below 20 pieces amber; no deliveries at all: no stock figure and no markup.
    expect(rowFor('10484').querySelector('.pt__stock--low')).not.toBeNull();
    expect(rowFor('10499').querySelector('.pt__stock')).toBeNull();
    expect(rowFor('10499').querySelector('[data-markup]')).toBeNull();
    // When the prices last changed, and by whom.
    expect(text(row.querySelector('.pt__changed'))).not.toBe('—');
  });

  it('folds Alif and "O\'zgargan" below 1280px and the wholesale column below 1024px', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 1024px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await mountPrices('manager');
    expect(Array.from(body().querySelectorAll('thead th')).map((h) => text(h))).toEqual([
      'Tovar',
      "Standart · keyin to'lash",
      'Ulgurji / Hamkor',
      'Ustama',
      'Amallar',
    ]);
    vi.unstubAllGlobals();
  });

  // The rate with its source and notices grew to three lines inside the actions and threw the
  // buttons beside it off their line (owner 2026-11-09): it is a bar of its own under the header.
  it('keeps the rate in its own bar, out of the row of page actions', async () => {
    await mountPrices('manager');
    const rate = body().querySelector('[data-testid="usd-rate"]');
    expect(rate).not.toBeNull();
    expect(rate?.closest('.head')).toBeNull();
    expect(body().querySelector('.head__actions [data-testid="download-excel"]')).not.toBeNull();
  });

  it('shows the accountant the same columns, read only: no edit controls, no rate editor', async () => {
    const publish = { spy: null as ReturnType<typeof vi.spyOn> | null };
    await mountPrices('accountant', {
      prepare: (services) => {
        publish.spy = vi.spyOn(services.pricingApi, 'publishChanges');
      },
    });
    expect(text(rowFor('10491').querySelector('[data-sale]'))).toBe('$133,60');
    expect(rowFor('10491').querySelector('[data-markup]')).not.toBeNull();
    expect(rowFor('10491').querySelector('[data-action="edit"]')).toBeNull();
    expect(body().querySelector('[data-testid="add-from-stock"]')).toBeNull();
    expect(body().querySelector('a[href="/products"]')).toBeNull();
    // The rate is shown but cannot be edited or re-pointed at the bank.
    expect(text(body().querySelector('[data-testid="usd-rate-readonly"]'))).toContain('12 650');
    expect(hasButton('Avtomatik kursga qaytish')).toBe(false);
    expect(hasButton("Kursni o'zgartirish")).toBe(false);
    // Nothing is ever published from a read-only page.
    expect(publish.spy).not.toHaveBeenCalled();
  });

  it('shows no cost, no stock and no rate to a role that may not view it, and never asks for them', async () => {
    // A warehouse person cannot reach this page (route guard); this proves the component alone
    // would still not render or request cost, so hiding does not depend on the router.
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    await mountPrices('warehouse', {
      prepare: (services) => {
        spies.push(
          vi.spyOn(services.costApi, 'getPriceListCosts'),
          vi.spyOn(services.costApi, 'getUsdRate'),
          vi.spyOn(services.stockApi, 'listUnpriced'),
          vi.spyOn(services.stockApi, 'listStock'),
        );
      },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const content = text(body());
    // Neither the "Tannarxdan past" view nor the markup sort: both need the cost.
    expect(content).not.toContain('Tannarx');
    expect(body().querySelector('[data-preset="belowCost"]')).toBeNull();
    expect(content).not.toContain('dona');
    expect(content).not.toContain('Ustama');
    expect(content).not.toContain('$128');
    expect(body().querySelector('[data-testid="usd-rate"]')).toBeNull();
    expect(body().querySelector('[data-markup]')).toBeNull();
  });
});

describe('Narxlar: the side panel ("Tarix")', () => {
  it('opens from a row click and from "Tarix", with the price and supply history', async () => {
    await mountPrices('manager');
    rowFor('10491').querySelector('td')?.click();
    await flushPromises();
    expect(text(panel()?.querySelector('.product__code'))).toBe('10491');
    expect(text(panel())).toContain('Postavka tarixi');
    expect(text(panel())).toContain('keyingi buyurtmalarga');
    expect(text(panel())).toContain("Narxni o'zgartirish");
    await click(button('Yopish'));
    await click(
      rowFor('10484').querySelector<HTMLElement>('[data-action="history"]') as HTMLElement,
    );
    expect(text(panel()?.querySelector('.product__code'))).toBe('10484');
  });

  it('says so, with a retry, when the cost cannot be loaded, and keeps the prices', async () => {
    await mountPrices('manager', {
      prepare: (services) => {
        vi.spyOn(services.costApi, 'getPriceListCosts').mockRejectedValueOnce(new Error('boom'));
      },
    });
    expect(text(body().querySelector('.inline-error'))).toContain('Qoldiq va tannarxni yuklab');
    expect(text(rowFor('10491').querySelector('[data-sale]'))).toBe('$133,60');
    expect(rowFor('10491').querySelector('[data-markup]')).toBeNull();
    await click(button(RETRY));
    expect(body().querySelector('.inline-error')).toBeNull();
    expect(rowFor('10491').querySelector('[data-markup]')).not.toBeNull();
  });
});

describe('Narxlar: category filter', () => {
  it('lists all categories with counts in the dropdown, empty ones last, and filters the table', async () => {
    await mountPrices('manager');
    expect(await categoryMenu()).toEqual([
      'Barcha kategoriyalar17',
      'Aksessuarlar6',
      'Audio3',
      'Telefonlar6',
      'Televizorlar1',
      'Kategoriyasiz1',
    ]);
    await pickCategory('Televizorlar');
    expect(codes()).toEqual(['10498']);
    expect(categoryValue()).toBe('Televizorlar');
    await pickCategory('Kategoriyasiz');
    expect(codes()).toEqual(['10499']);
    await pickCategory('Barcha kategoriyalar');
    expect(codes()).toHaveLength(17);
  });
});

describe('Narxlar: USD rate control', () => {
  it('shows the rate, its source and date', async () => {
    await mountPrices('manager');
    expect(text(rate())).toContain("Kurs $1 = 12 650 so'm");
    expect(text(rate())).toContain("Markaziy bank + 40 so'm, 19.10.2026");
  });

  it("lets the manager edit it inline, with the api's own validation", async () => {
    const { services } = await mountPrices('manager');
    await click(button("Kursni o'zgartirish", false));
    const input = rate().querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('no rate input');
    expect(input.value).toBe('12650');
    await type(input, 'abc');
    await click(button('Saqlash'));
    expect(text(rate().querySelector('[role="alert"]'))).toContain('Kurs musbat son');
    expect((await services.costApi.getUsdRate()).rate).toBe('12650.0000');

    await type(input, '12 700.5');
    await click(button('Saqlash'));
    expect(text(rate())).toContain('12 700,5');
    expect(text(rate())).toContain("qo'lda, Aziza Yusupova, 19.10.2026");
    expect((await services.costApi.getUsdRate()).rate).toBe('12700.5000');
    expect(rate().querySelector('input')).toBeNull();
  });

  it('rejects an ambiguous comma and saves 12,650 as twelve thousand', async () => {
    const { services } = await mountPrices('manager');
    await click(button("Kursni o'zgartirish", false));
    const input = rate().querySelector<HTMLInputElement>('input') as HTMLInputElement;
    await type(input, '12,65');
    await click(button('Saqlash'));
    expect(text(rate().querySelector('[role="alert"]'))).toContain('Vergul noaniq');
    expect((await services.costApi.getUsdRate()).rate).toBe('12650.0000');
    await type(input, '12,700');
    await click(button('Saqlash'));
    expect((await services.costApi.getUsdRate()).rate).toBe('12700.0000');
  });

  it('asks for a confirmation with the old and new rate side by side for an unusual rate', async () => {
    const { services } = await mountPrices('manager');
    await click(button("Kursni o'zgartirish", false));
    const input = rate().querySelector<HTMLInputElement>('input') as HTMLInputElement;
    await type(input, '12.65');
    await click(button('Saqlash'));
    expect(text(dialog())).toContain('Kursni tasdiqlang');
    expect(text(dialog()?.querySelector('[data-testid="rate-compare"]'))).toContain('12 650');
    expect(text(dialog()?.querySelector('[data-testid="rate-compare"]'))).toContain('12,65');
    expect((await services.costApi.getUsdRate()).rate).toBe('12650.0000');
    const cancelInDialog = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
      (b) => text(b) === 'Bekor qilish',
    );
    await click(cancelInDialog as HTMLElement);
    expect(dialog()).toBeNull();
    expect((await services.costApi.getUsdRate()).rate).toBe('12650.0000');

    // More than 25 percent away from the current rate (still inside the band).
    await type(input, '17000');
    await click(button('Saqlash'));
    expect(text(dialog())).toContain('25 foizdan');
    await click(button('Baribir saqlash'));
    expect((await services.costApi.getUsdRate()).rate).toBe('17000.0000');
  });

  it('cancels with Escape without saving', async () => {
    const { services } = await mountPrices('admin');
    await click(button("Kursni o'zgartirish", false));
    const input = rate().querySelector<HTMLInputElement>('input');
    await type(input as HTMLInputElement, '99999');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect((await services.costApi.getUsdRate()).rate).toBe('12650.0000');
    expect(rate().querySelector('input')).toBeNull();
  });

  it('ends a manual rate early, and warns when the last refresh failed', async () => {
    const { cost } = await mountPrices('manager');
    await click(button("Kursni o'zgartirish", false));
    await type(rate().querySelector('input') as HTMLInputElement, '12700');
    await click(button('Saqlash'));
    expect(text(rate())).toContain("qo'lda");
    expect(text(rate().querySelector('[data-testid="rate-manual-until"]'))).toContain(
      'amal qiladi',
    );

    cost.controls.setCentralBankDown(true);
    await click(button('Avtomatik kursga qaytish'));
    expect(text(rate())).toContain('12 700'); // the manual value stays while the bank is down
    expect(text(rate().querySelector('.rate__warn'))).toContain(
      "Markaziy bankdan kursni yangilab bo'lmadi",
    );

    cost.controls.setCentralBankDown(false);
    await click(button('Avtomatik kursga qaytish'));
    expect(text(rate())).toContain('12 650');
    expect(text(rate())).toContain('Markaziy bank');
    expect(rate().querySelector('.rate__warn')).toBeNull();
    // Following the bank, there is nothing to switch back to.
    expect(hasButton('Avtomatik kursga qaytish')).toBe(false);
  });
});

const priceInput = (): HTMLInputElement => {
  const input = dialog()?.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error('no price input in the dialog');
  return input;
};
/** Natively disabled, or closed with a reason (aria-disabled, still focusable). */
const closed = (button: HTMLButtonElement): boolean =>
  button.disabled || button.getAttribute('aria-disabled') === 'true';
const dialogButton = (label: string): HTMLButtonElement => {
  const modal = dialog()?.closest('[data-testid="modal"]');
  const found = Array.from(modal?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((b) =>
    text(b).includes(label),
  );
  if (!found) throw new Error(`No dialog button "${label}"`);
  return found;
};
/** The row's "Tahrirlash" (the price dialog); a read-only role has none, so its row is clicked. */
async function openRow(code: string): Promise<void> {
  const trigger = rowFor(code).querySelector<HTMLElement>('[data-action="edit"]') ?? rowFor(code);
  await click(trigger);
}

describe('Narxlar: the v8 list', () => {
  it('shows the version, the ready views and the versions link, with no edit mode or draft', async () => {
    await mountPrices('manager');
    expect(text(body().querySelector('[data-testid="list-version"]'))).toBe("v14 · e'lon qilingan");
    expect(
      Array.from(body().querySelectorAll('[data-preset]')).map((v) =>
        text(v.querySelector('.view__top')),
      ),
    ).toEqual(['Hammasi17', 'Buyurtma orqali0', 'Ulgurji narxsiz9', 'Tannarxdan past0']);
    expect(view('all').getAttribute('aria-pressed')).toBe('true');
    expect(body().querySelector<HTMLAnchorElement>('a[href="/versions"]')).not.toBeNull();
    expect(text(body())).not.toContain('Qoralama');
    expect(body().querySelector('input[data-price-input]')).toBeNull();
    expect(text(body().querySelector('[data-testid="list-footer"]'))).toBe('17 ta tovar');
  });

  it("shows the prices in USD, the wholesale and Alif ones in USD in the so'm view too", async () => {
    const { router } = await mountPrices('manager');
    const row = rowFor('10491');
    // Prices are kept in USD [owner 2026-10-29]; the fake keeps 1 690 000 so'm as $133.60.
    expect(text(row.querySelector('[data-sale]'))).toBe('$133,60');
    // No deferred-payment price in the fixtures: nothing under the price.
    expect(row.querySelector('[data-deferred]')).toBeNull();
    // No wholesale price: that tier sees the standard one.
    expect(text(row.querySelector('[data-from-standard]'))).toBe('standart narx');
    expect(text(row.querySelector('[data-alif-price]'))).toBe('$140,28');

    // The so'm view: the standard prices at the current rate (12 650), in the address too; the
    // other tiers stay in USD (the api sends no so'm figure for them) and the page says so.
    await click(button("so'm"));
    expect(text(rowFor('10491').querySelector('[data-sale]'))).toBe('1 690 040');
    expect(text(rowFor('10491').querySelector('[data-alif-price]'))).toBe('$140,28');
    expect(text(body().querySelector('[data-testid="list-footer"]'))).toBe(
      "17 ta tovar · narxlar so'mda · Ulgurji va Alif narxlari dollarda",
    );
    expect(router.currentRoute.value.query.currency).toBe('UZS');
  });

  it('searches by code from the address', async () => {
    await mountPrices('manager', { path: '/prices?q=10491' });
    expect(codes()).toEqual(['10491']);
  });

  it('shows the empty state before the first publish, pointing to Ostatok', async () => {
    const { router } = await mountPrices('manager', { scenario: 'empty' });
    expect(text(body())).toContain("Narx ro'yxati hali nashr qilinmagan");
    await click(button("Qoldiqdan qo'shish"));
    expect(router.currentRoute.value.name).toBe('staff-stock');
  });
});

describe("Narxlar: 'Qoldiqdan qo'shish'", () => {
  it('counts the active stock products without a price and opens Ostatok filtered to them', async () => {
    const { router } = await mountPrices('manager');
    const add = body().querySelector<HTMLButtonElement>('[data-testid="add-from-stock"]');
    if (!add) throw new Error('no add-from-stock button');
    expect(spaced(add)).toBe("Qoldiqdan qo'shish 5");
    await click(add);
    expect(router.currentRoute.value.name).toBe('staff-stock');
    expect(router.currentRoute.value.query).toEqual({ preset: 'unpriced' });
  });
});

describe('Narxlar: changing one price publishes at once', () => {
  it('lists what a save changes and closes the save while an error is left (design T3)', async () => {
    await mountPrices('manager');
    await openRow('10491');
    const diff = (): string => text(body().querySelector('[data-testid="price-diff"]'));
    expect(diff()).toBe("Hali hech narsa o'zgarmadi");
    expect(closed(dialogButton('Saqlash · v15'))).toBe(true);
    await type(priceInput(), '139');
    expect(diff()).toContain('Standart narx');
    expect(diff()).toContain('$133,60');
    expect(diff()).toContain('$139,00');
    expect(body().querySelector('[data-diff="markup"]')).not.toBeNull();
    expect(closed(dialogButton('Saqlash · v15'))).toBe(false);
    const wholesaleDeferred = dialog()?.querySelector<HTMLInputElement>(
      '[data-wholesale-deferred-price-input] input',
    );
    if (!wholesaleDeferred) throw new Error('no wholesale deferred input');
    await type(wholesaleDeferred, '135');
    expect(text(body().querySelector('[data-testid="price-errors"]'))).toBe(
      "1 ta xato: Ulgurji / Hamkor keyin to'lash narxi ulgurji narxsiz bo'lmaydi.",
    );
    expect(closed(dialogButton('Saqlash · v15'))).toBe(true);
    expect(dialogButton('Saqlash · v15').title).toBe('1 ta xato tuzatilmagan');
    // Still focusable for its reason, but a press saves nothing.
    await click(dialogButton('Saqlash · v15'));
    expect(dialog()).not.toBeNull();
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v14 ');
  });

  it('opens the dialog from a row with the current price and cost', async () => {
    await mountPrices('manager');
    await openRow('10491');
    expect(text(dialog())).toContain("Narxni o'zgartirish");
    // The header names the product and its USD cost (design T3).
    expect(text(body().querySelector('[data-testid="price-dialog-sub"]'))).toBe(
      '10491 · Samsung Galaxy A15 4/128GB · tannarx $128,50',
    );
    // The input uses the language's decimal separator.
    expect(priceInput().value).toBe('133,6');
    // Same price: nothing to save.
    expect(closed(dialogButton('Saqlash'))).toBe(true);
  });

  it('publishes a new version with this one change, toasts it and shows the new price', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await openRow('10483');
    await type(priceInput(), '17');
    await click(dialogButton('Saqlash'));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual({
      baseVersionNumber: 14,
      upserts: [
        {
          productId: expect.any(String),
          basePrice: '17',
          deferredPrice: null,
          rrp: null,
          // The dialog owns the wholesale tier: it always sends what it shows (none here).
          wholesalePrice: null,
          wholesaleDeferredPrice: null,
          alifPrice: null,
          alifDeferredPrice: null,
        },
      ],
      removedProductIds: [],
    });
    expect(dialog()).toBeNull();
    // The published list still held the deactivated 10493: the publish drops it and says so.
    expect(useToast().toast.value?.message).toMatch(
      /^Narxlar saqlandi · v15 · .+, 1 ta nofaol tovar ro'yxatdan chiqarildi$/,
    );
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v15 ');
    expect(text(rowFor('10483').querySelector('[data-sale]'))).toBe('$17,00');
    expect(services.priceVersionStore.version.value?.number).toBe(15);
  });

  it('saves an optional deferred-payment price, shows it in its column and clears it again', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    const cashInput = (): HTMLInputElement => {
      const input = dialog()?.querySelector<HTMLInputElement>('[data-deferred-price-input] input');
      if (!input) throw new Error('no deferred price input in the dialog');
      return input;
    };
    await openRow('10491');
    expect(cashInput().value).toBe('');
    await type(cashInput(), '12,5x');
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    await type(cashInput(), '137.5');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[0]?.[0].upserts).toEqual([
      {
        productId: expect.any(String),
        basePrice: '133.6',
        deferredPrice: '137.5',
        rrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        alifPrice: '140.28',
        alifDeferredPrice: '146.96',
      },
    ]);
    expect(text(rowFor('10491').querySelector('[data-deferred]'))).toBe('keyin $137,50');

    await openRow('10491');
    expect(cashInput().value).toBe('137,5');
    await type(cashInput(), '');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[1]?.[0].upserts[0]?.deferredPrice).toBeNull();
    expect(rowFor('10491').querySelector('[data-deferred]')).toBeNull();
  });

  it('shows and edits the Alif factoring prices [C, owner 2026-11-12]; none = not offered', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    const input = (attribute: string): HTMLInputElement => {
      const found = dialog()?.querySelector<HTMLInputElement>(`[${attribute}] input`);
      if (!found) throw new Error(`no ${attribute} in the dialog`);
      return found;
    };
    // The fake gives 10491 an Alif price; 10483 has none and says it is not offered.
    expect(text(rowFor('10491').querySelector('[data-alif-price]'))).toBe('$140,28');
    expect(rowFor('10483').querySelector('[data-not-offered-alif]')).not.toBeNull();
    await openRow('10491');
    expect(input('data-alif-price-input').value).toBe('140,28');
    // A deferred Alif price without the sale price is refused before any request.
    await type(input('data-alif-price-input'), '');
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    await type(input('data-alif-deferred-price-input'), '');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[0]?.[0].upserts[0]).toMatchObject({
      alifPrice: null,
      alifDeferredPrice: null,
    });
    expect(rowFor('10491').querySelector('[data-not-offered-alif]')).not.toBeNull();
  });

  it('saves an optional recommended price (RRP), keeps it when the price changes and clears it again', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    const rrpInput = (): HTMLInputElement => {
      const input = dialog()?.querySelector<HTMLInputElement>('[data-rrp-input] input');
      if (!input) throw new Error('no RRP input in the dialog');
      return input;
    };
    await openRow('10491');
    expect(text(dialog())).toContain('RRP');
    expect(rrpInput().value).toBe('');
    expect(dialog()?.querySelector('[data-current-rrp]')).toBeNull();
    await type(rrpInput(), '15x');
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    await type(rrpInput(), '159.9');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[0]?.[0].upserts).toEqual([
      {
        productId: expect.any(String),
        basePrice: '133.6',
        deferredPrice: null,
        rrp: '159.9',
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        alifPrice: '140.28',
        alifDeferredPrice: '146.96',
      },
    ]);

    // The dialog shows the saved RRP; with nothing changed there is nothing to save.
    await openRow('10491');
    expect(rrpInput().value).toBe('159,9');
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    // A save replaces the whole item, so changing only the price sends the RRP along.
    await type(priceInput(), '140');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[1]?.[0].upserts[0]).toMatchObject({ basePrice: '140', rrp: '159.9' });

    await openRow('10491');
    await type(rrpInput(), '');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[2]?.[0].upserts[0]?.rrp).toBeNull();
    await openRow('10491');
    expect(rrpInput().value).toBe('');
    expect(dialog()?.querySelector('[data-current-rrp]')).toBeNull();
  });

  it('refuses an invalid price without a request and warns, without blocking, below cost', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await openRow('10491');
    await type(priceInput(), '12.345');
    expect(text(dialog())).toContain("Narx noto'g'ri");
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    await type(priceInput(), '100');
    expect(text(dialog())).toContain('Narx oxirgi tannarxdan past');
    expect(closed(dialogButton('Saqlash'))).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('removes a product from the list after a confirmation', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await openRow('10483');
    await click(dialogButton('Price listdan olib tashlash'));
    expect(text(dialog())).toContain('olib tashlansinmi');
    expect(publish).not.toHaveBeenCalled();
    const confirm = Array.from(
      dialog()?.querySelectorAll<HTMLButtonElement>('.remove button') ?? [],
    ).find((b) => text(b) === 'Olib tashlash');
    if (!confirm) throw new Error('no confirm button');
    await click(confirm);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ upserts: [], baseVersionNumber: 14 });
    expect(publish.mock.calls[0]?.[0].removedProductIds).toHaveLength(1);
    expect(rows().some((r) => r.textContent?.includes('10483'))).toBe(false);
  });

  it('explains that the list changed meanwhile, reloads it and saves on the new base', async () => {
    const { services } = await mountPrices('manager');
    await openRow('10483');
    // A colleague publishes v15 while the dialog is open.
    const current = await services.pricingApi.getCurrent();
    const other = current.items.find((i) => i.productCode === '10486');
    if (!other) throw new Error('no 10486');
    await services.pricingApi.publishChanges({
      baseVersionNumber: 14,
      upserts: [{ productId: other.productId, basePrice: '9500', deferredPrice: null, rrp: null }],
      removedProductIds: [],
    });
    await type(priceInput(), '215000');
    await click(dialogButton('Saqlash'));
    expect(dialog()).not.toBeNull();
    expect(text(dialog()?.querySelector('.note--bad'))).not.toBe('');
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v15 ');
    await click(dialogButton('Saqlash'));
    expect(dialog()).toBeNull();
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v16 ');
  });

  it("keeps a colleague's change of the same product after a refused save (the fields merge)", async () => {
    const { services } = await mountPrices('manager');
    await openRow('10483');
    // A colleague sets this product's RRP while the dialog is open.
    const current = await services.pricingApi.getCurrent();
    const same = current.items.find((i) => i.productCode === '10483');
    if (!same) throw new Error('no 10483');
    await services.pricingApi.publishChanges({
      baseVersionNumber: 14,
      upserts: [
        {
          productId: same.productId,
          basePrice: same.basePrice,
          deferredPrice: same.deferredPrice,
          rrp: '777',
          wholesalePrice: same.wholesalePrice,
          wholesaleDeferredPrice: same.wholesaleDeferredPrice,
          alifPrice: same.alifPrice,
          alifDeferredPrice: same.alifDeferredPrice,
        },
      ],
      removedProductIds: [],
    });
    await type(priceInput(), '215000');
    await click(dialogButton('Saqlash'));
    expect(dialog()).not.toBeNull();
    // the untouched RRP field took the colleague's value; the typed price stayed
    const rrp = body().querySelector<HTMLInputElement>('[data-rrp-input] input');
    expect(rrp?.value).toBe('777');
    expect(priceInput().value).toBe('215000');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await click(dialogButton('Saqlash'));
    expect(dialog()).toBeNull();
    expect(publish.mock.calls[0]?.[0].upserts[0]).toMatchObject({
      basePrice: '215000',
      rrp: '777',
    });
  });
});

describe('Narxlar: the history side panel', () => {
  it('opens a product from the ?history= link of the search and drops the parameter', async () => {
    const probe = createTestServices({ identityId: 'manager' });
    const list = await probe.services.pricingApi.getCurrent();
    const item = list.items.find((i) => i.productCode === '10491');
    const { router } = await mountPrices('manager', { path: `/prices?history=${item?.productId}` });
    expect(router.currentRoute.value.query).toEqual({});
    expect(text(panel()?.querySelector('.product__code'))).toBe('10491');
  });

  it('drops an older ?tab=history link and shows the list', async () => {
    const { router } = await mountPrices('manager', { path: '/prices?tab=history' });
    expect(router.currentRoute.value.query).toEqual({});
    expect(rows()).toHaveLength(17);
  });

  it('gives the accountant the supply history, no price history and no edit button', async () => {
    await mountPrices('accountant');
    await openRow('10491');
    expect(dialog()).toBeNull();
    expect(text(panel())).toContain('Postavka tarixi');
    expect(text(panel())).not.toContain("Narxni o'zgartirish");
    expect(text(panel())).not.toContain("Narx o'zgarishlari");
  });
});

describe('Narxlar: the «Оптовик/Партнер» tier [C, owner 2026-11-11]', () => {
  const wholesaleInput = (): HTMLInputElement => {
    const input = dialog()?.querySelector<HTMLInputElement>('[data-wholesale-price-input] input');
    if (!input) throw new Error('no wholesale price input');
    return input;
  };
  const wholesaleDeferredInput = (): HTMLInputElement => {
    const input = dialog()?.querySelector<HTMLInputElement>(
      '[data-wholesale-deferred-price-input] input',
    );
    if (!input) throw new Error('no wholesale deferred input');
    return input;
  };

  it('shows the wholesale price where there is one, "standart narx" where there is none', async () => {
    await mountPrices('manager');
    expect(text(rowFor('10482').querySelector('[data-wholesale-price]'))).toMatch(/^\$\d+,\d\d$/);
    expect(rowFor('10482').querySelector('[data-from-standard]')).toBeNull();
    expect(text(rowFor('10483').querySelector('[data-from-standard]'))).toBe('standart narx');
  });

  it('lists the products without a wholesale price in their own ready view', async () => {
    const { router } = await mountPrices('manager');
    await click(view('noWholesale'));
    expect(router.currentRoute.value.query.preset).toBe('noWholesale');
    expect(codes()).toContain('10483');
    expect(codes()).not.toContain('10482');
    expect(text(body().querySelector('[data-testid="list-footer"]'))).toBe('9 ta tovar');
  });

  it('keeps an older ?tab=nowholesale link on the same list', async () => {
    const { router } = await mountPrices('manager', { path: '/prices?tab=nowholesale' });
    expect(router.currentRoute.value.query).toEqual({ preset: 'noWholesale' });
    expect(codes()).toHaveLength(9);
  });

  it('sets, checks and clears the wholesale prices in the same one publish', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await openRow('10483');
    expect(text(dialog())).toContain('Standart');
    expect(text(dialog())).toContain('Ulgurji / Hamkor');
    expect(wholesaleInput().value).toBe('');
    // A deferred wholesale price needs the wholesale sale price.
    await type(wholesaleDeferredInput(), '10');
    expect(text(dialog())).toContain("Keyin to'lash narxi uchun avval ulgurji narxni kiriting");
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    await type(wholesaleInput(), '9,5');
    await click(dialogButton('Saqlash'));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].upserts[0]).toMatchObject({
      wholesalePrice: '9.5',
      wholesaleDeferredPrice: '10',
    });
    expect(text(rowFor('10483').querySelector('[data-wholesale-price]'))).toBe('$9,50');

    await openRow('10483');
    expect(wholesaleInput().value).toBe('9,5');
    expect(closed(dialogButton('Saqlash'))).toBe(true);
    await type(wholesaleDeferredInput(), '');
    await type(wholesaleInput(), '');
    await click(dialogButton('Saqlash'));
    expect(publish.mock.calls[1]?.[0].upserts[0]).toMatchObject({
      wholesalePrice: null,
      wholesaleDeferredPrice: null,
    });
    expect(text(rowFor('10483').querySelector('[data-from-standard]'))).toBe('standart narx');
  });
});

describe('Narxlar: the row context menu [owner 2026-11-12]', () => {
  const menuItems = (): HTMLElement[] =>
    Array.from(body().querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'));
  async function rightClick(code: string): Promise<void> {
    const cell = rowFor(code).querySelector('td') ?? rowFor(code);
    cell.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
    await flushPromises();
  }
  async function choose(code: string, label: string): Promise<void> {
    await rightClick(code);
    const item = menuItems().find((el) => text(el) === label);
    if (!item) {
      throw new Error(`No menu item "${label}". Have: ${menuItems().map(text).join(' | ')}`);
    }
    await click(item);
  }
  const EDITOR_ITEMS = [
    "Narxni o'zgartirish",
    'Narxlar tarixi',
    "Rasmlarni o'zgartirish",
    "Qoldiqda ko'rish",
    'Tovar ID ni nusxalash',
    'Price listdan olib tashlash',
  ];
  const READ_ONLY_ITEMS = ['Narxlar tarixi', "Qoldiqda ko'rish", 'Tovar ID ni nusxalash'];

  it.each([
    ['manager', EDITOR_ITEMS],
    ['admin', EDITOR_ITEMS],
    ['accountant', READ_ONLY_ITEMS],
    ['purchasing', READ_ONLY_ITEMS],
  ])('offers the %s only what the role may do', async (identity, expected) => {
    await mountPrices(identity);
    await rightClick('10491');
    expect(body().querySelector('[role="menu"]')?.getAttribute('aria-label')).toContain('10491');
    expect(menuItems().map(text)).toEqual(expected);
    // The touch "⋯" button reaches the same menu.
    expect(rowFor('10491').querySelector('[data-testid="row-menu-button"]')).not.toBeNull();
  });

  it('offers the merge, not Ostatok, for a staff-added product', async () => {
    await mountPrices('manager', {
      prepare: async (services) => {
        const current = await services.pricingApi.getCurrent();
        await services.pricingApi.createManualProduct({
          baseVersionNumber: current.version.number,
          name: 'Demo powerbank',
          brandId: null,
          category: null,
          basePrice: '20',
          deferredPrice: null,
        });
      },
    });
    await rightClick('IO-000001');
    const labels = menuItems().map(text);
    expect(labels).toContain('Sheet tovari bilan birlashtirish');
    expect(labels).not.toContain("Qoldiqda ko'rish");
    const merge = menuItems().find((el) => text(el) === 'Sheet tovari bilan birlashtirish');
    if (!merge) throw new Error('no merge item');
    await click(merge);
    expect(text(dialog())).toContain('IO-000001');
  });

  it('opens the price dialog and the history from the menu', async () => {
    const { router } = await mountPrices('manager');
    await choose('10491', "Narxni o'zgartirish");
    expect(text(dialog())).toContain('10491');
    await click(dialogButton('Bekor'));
    await choose('10491', 'Narxlar tarixi');
    expect(router.currentRoute.value.name).toBeUndefined();
    expect(text(panel()?.querySelector('.product__code'))).toBe('10491');
  });

  it('opens Ostatok searched by the product code', async () => {
    const { router } = await mountPrices('accountant');
    await choose('10491', "Qoldiqda ko'rish");
    expect(router.currentRoute.value.name).toBe('staff-stock');
    expect(router.currentRoute.value.query).toEqual({ q: '10491' });
  });

  it('copies the product code, and shows it when the clipboard refuses', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mountPrices('purchasing');
    await choose('10491', 'Tovar ID ni nusxalash');
    expect(writeText).toHaveBeenCalledWith('10491');
    expect(useToast().toast.value?.message).toBe('Tovar ID nusxalandi: 10491');
    writeText.mockRejectedValueOnce(new Error('denied'));
    await choose('10491', 'Tovar ID ni nusxalash');
    expect(useToast().toast.value?.message).toBe("Nusxalab bo'lmadi. Tovar ID: 10491");
  });

  it("opens the product's photos in their own dialog", async () => {
    const { services } = await mountPrices('manager');
    const getProduct = vi.spyOn(services.productImagesApi, 'getProduct');
    await choose('10491', "Rasmlarni o'zgartirish");
    expect(text(dialog()?.querySelector('h2'))).toBe('Tovar rasmlari');
    expect(text(dialog())).toContain('10491');
    expect(getProduct).toHaveBeenCalledWith('10491');
    expect(dialog()?.querySelector('[data-testid="photo-upload"]')).not.toBeNull();
    await click(dialogButton('Yopish'));
    expect(dialog()).toBeNull();
  });

  it('removes a product only after a confirmation, on the base version', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await choose('10483', 'Price listdan olib tashlash');
    expect(text(dialog())).toContain('olib tashlansinmi');
    expect(text(dialog()?.querySelector('[data-testid="remove-target"]'))).toContain('10483');
    await click(dialogButton('Bekor qilish'));
    expect(dialog()).toBeNull();
    expect(publish).not.toHaveBeenCalled();

    await choose('10483', 'Price listdan olib tashlash');
    await click(dialogButton('Olib tashlash'));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ upserts: [], baseVersionNumber: 14 });
    expect(publish.mock.calls[0]?.[0].removedProductIds).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(useToast().toast.value?.message).toMatch(/v15/);
    expect(rows().some((r) => r.textContent?.includes('10483'))).toBe(false);
  });

  it('says that the list changed meanwhile, reloads it and removes on the new base', async () => {
    const { services } = await mountPrices('manager');
    await choose('10483', 'Price listdan olib tashlash');
    // A colleague publishes v15 while the confirmation is open.
    const current = await services.pricingApi.getCurrent();
    const other = current.items.find((i) => i.productCode === '10486');
    if (!other) throw new Error('no 10486');
    await services.pricingApi.publishChanges({
      baseVersionNumber: 14,
      upserts: [{ productId: other.productId, basePrice: '9500', deferredPrice: null, rrp: null }],
      removedProductIds: [],
    });
    await click(dialogButton('Olib tashlash'));
    expect(dialog()).not.toBeNull();
    expect(text(dialog()?.querySelector('[role="alert"]'))).not.toBe('');
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v15 ');
    await click(dialogButton('Olib tashlash'));
    expect(dialog()).toBeNull();
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v16 ');
    expect(rows().some((r) => r.textContent?.includes('10483'))).toBe(false);
  });

  it('closes with a toast, and publishes nothing more, when a colleague removed it meanwhile', async () => {
    const { services } = await mountPrices('manager');
    await choose('10483', 'Price listdan olib tashlash');
    const current = await services.pricingApi.getCurrent();
    const target = current.items.find((i) => i.productCode === '10483');
    if (!target) throw new Error('no 10483');
    await services.pricingApi.publishChanges({
      baseVersionNumber: 14,
      upserts: [],
      removedProductIds: [target.productId],
    });
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await click(dialogButton('Olib tashlash'));
    // The one refused try (409), then nothing: no empty version is published.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(useToast().toast.value?.message).toMatch(/allaqachon price listdan olib tashlangan$/);
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v15 ');
    expect(rows().some((r) => r.textContent?.includes('10483'))).toBe(false);
  });

  it('publishes once when the confirmation is pressed twice', async () => {
    const { services } = await mountPrices('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    await choose('10483', 'Price listdan olib tashlash');
    const confirm = dialogButton('Olib tashlash');
    confirm.click();
    confirm.click();
    await flushPromises();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(text(body().querySelector('[data-testid="list-version"]'))).toContain('v15 ');
  });

  it.each(['accountant', 'purchasing'])(
    'gives the %s a read-only menu: nothing in it changes or publishes anything',
    async (identity) => {
      const { services } = await mountPrices(identity);
      const publish = vi.spyOn(services.pricingApi, 'publishChanges');
      await rightClick('10491');
      expect(body().querySelector('.rowmenu__item--danger')).toBeNull();
      expect(menuItems().map(text)).not.toContain("Narxni o'zgartirish");
      expect(menuItems().map(text)).not.toContain("Rasmlarni o'zgartirish");
      expect(menuItems().map(text)).not.toContain('Price listdan olib tashlash');
      // The "⋯" button opens the same read-only menu.
      await click(rowFor('10491').querySelector<HTMLElement>('[data-testid="row-menu-button"]')!);
      expect(menuItems().map(text)).toEqual([
        'Narxlar tarixi',
        "Qoldiqda ko'rish",
        'Tovar ID ni nusxalash',
      ]);
      await click(menuItems()[0]!);
      expect(dialog()).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    },
  );
});

describe('Narxlar: brand, price type, sort and cards (design approved 2026-11-19)', () => {
  const brandTrigger = (): HTMLButtonElement => {
    const el = body().querySelector<HTMLButtonElement>('[data-testid="brand-filter"] button');
    if (!el) throw new Error('no brand filter');
    return el;
  };

  it('filters by the brand of the price list rule and finds a brand by search, kept in the address', async () => {
    const { router } = await mountPrices('manager');
    await click(brandTrigger());
    const options = Array.from(body().querySelectorAll('[role="option"]')).map((o) => text(o));
    expect(options[0]).toBe('Hammasi');
    expect(options.some((o) => o.startsWith('Samsung'))).toBe(true);
    await router.replace('/prices?brand=Samsung');
    await flushPromises();
    const samsung = codes();
    expect(samsung).toContain('10491');
    expect(samsung.length).toBeLessThan(17);
    expect(text(body().querySelector('[data-chip="brand"]'))).toContain('Brend: Samsung');
    // Search finds the brand too; "Tozalash" clears it all.
    await router.replace('/prices?q=samsung');
    await flushPromises();
    expect(codes().sort()).toEqual([...samsung].sort());
    await click(button('Tozalash'));
    expect(rows()).toHaveLength(17);
    expect(body().querySelector('[data-chip]')).toBeNull();
    // The search reaches the address after its 300 ms pause.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('keeps only the products of one price type', async () => {
    const { router } = await mountPrices('manager');
    await router.replace('/prices?type=hasAlif');
    await flushPromises();
    for (const code of codes()) {
      expect(rowFor(code).querySelector('[data-alif-price]')).not.toBeNull();
    }
    await router.replace('/prices?type=standardOnly');
    await flushPromises();
    for (const code of codes()) {
      expect(rowFor(code).querySelector('[data-alif-price]')).toBeNull();
      expect(rowFor(code).querySelector('[data-from-standard]')).not.toBeNull();
    }
    expect(text(body().querySelector('[data-chip="type"]'))).toContain('Faqat standart');
  });

  it('sorts by name and by price, kept in the address', async () => {
    const { router } = await mountPrices('manager', { path: '/prices?sort=price' });
    const prices = rows().map((r) =>
      Number(
        text(r.querySelector('[data-sale]')).replace('$', '').replace(/\s/g, '').replace(',', '.'),
      ),
    );
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
    await router.replace('/prices?sort=name');
    await flushPromises();
    const names = rows().map((r) => text(r.querySelector('.pt__name')));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ru')));
  });

  it('shows the C3·a cards on request, with the same actions', async () => {
    const { router } = await mountPrices('manager');
    await click(body().querySelector<HTMLElement>('[data-layout="cards"]') as HTMLElement);
    expect(router.currentRoute.value.query.layout).toBe('cards');
    expect(body().querySelector('table')).toBeNull();
    const card = body().querySelector<HTMLElement>('.pc[data-product="10491"]');
    expect(text(card?.querySelector('.pc__sale'))).toBe('$133,60');
    await click(card?.querySelector<HTMLElement>('[data-action="edit"]') as HTMLElement);
    expect(text(dialog())).toContain("Narxni o'zgartirish");
  });

  it('opens the row menu on a right click of a card', async () => {
    await mountPrices('manager');
    await click(body().querySelector<HTMLElement>('[data-layout="cards"]') as HTMLElement);
    const card = body().querySelector<HTMLElement>('.pc[data-product="10491"]');
    expect(card?.querySelector('[data-action="history"]')).toBeNull();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });
    card?.querySelector('.pc__name')?.dispatchEvent(event);
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('pages the list: 10 per page, the range and the next page', async () => {
    await mountPrices('manager');
    const size = body().querySelector<HTMLElement>('[data-testid="page-size"] button');
    if (!size) throw new Error('no page size');
    await click(size);
    const ten = Array.from(body().querySelectorAll<HTMLElement>('[role="option"]')).find(
      (o) => text(o) === '10 ta',
    );
    await click(ten as HTMLElement);
    expect(rows()).toHaveLength(10);
    expect(text(body().querySelector('[data-testid="page-range"]'))).toBe('1–10 / 17');
    await click(button('Keyingi sahifa'));
    expect(rows()).toHaveLength(7);
  });
});
