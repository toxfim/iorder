import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { ApiConflictError, NetworkError } from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { createTestServices } from '@/test-utils/create-test-services';
import StockPage from './StockPage.vue';

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

async function mountStock(
  identity: string,
  options: {
    scenario?: FakeScenario;
    prepare?: (services: Services) => void;
    path?: string;
  } = {},
) {
  const test = createTestServices({ scenario: options.scenario ?? 'ready', identityId: identity });
  await test.services.currentUser.ensureLoaded();
  options.prepare?.(test.services);
  // The page keeps category and search in the address, so it needs a router.
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/stock', component: StockPage },
      { path: '/prices', name: 'staff-prices', component: { render: () => h('p') } },
    ],
  });
  await router.push(options.path ?? '/stock');
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
const buttons = (): HTMLButtonElement[] => Array.from(body().querySelectorAll('button'));
function button(label: string, root: ParentNode = body()): HTMLButtonElement {
  const all = Array.from(root.querySelectorAll('button'));
  const found = all.find((b) => text(b) === label || b.getAttribute('aria-label') === label);
  if (!found) throw new Error(`No button "${label}". Have: ${all.map((b) => text(b)).join(' | ')}`);
  return found;
}
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
  if (categoryTrigger().getAttribute('aria-expanded') !== 'true') await click(categoryTrigger());
}
/** "Label count" of every option, in menu order. */
async function categoryMenu(): Promise<string[]> {
  await openCategories();
  const labels = categoryOptions().map((o) => text(o));
  await click(categoryTrigger());
  return labels;
}
async function pickCategory(label: string): Promise<void> {
  await openCategories();
  const option = categoryOptions().find((o) => text(o.querySelector('.catdd__label')) === label);
  if (!option) throw new Error(`No category "${label}"`);
  await click(option);
}
const statusButton = (value: string): HTMLButtonElement => {
  const el = body().querySelector<HTMLButtonElement>(`.status [data-filter="${value}"]`);
  if (!el) throw new Error(`no status filter ${value}`);
  return el;
};
const rows = (): HTMLElement[] =>
  Array.from(body().querySelectorAll<HTMLElement>('.stock tbody tr'));
const rowFor = (code: string): HTMLElement => {
  const found = rows().find((r) => r.querySelector('.code')?.textContent === code);
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

describe('Qoldiq page: the table', () => {
  it('lists products with stock or deliveries in the v8 columns of real data', async () => {
    await mountStock('manager');
    expect(text(body().querySelector('h1'))).toBe('Qoldiq');
    expect(text(body().querySelector('.list-count'))).toBe(
      '21 ta tovar · 5 tasi narxlarga chiqmagan',
    );
    const headers = Array.from(body().querySelectorAll('.stock thead th')).map((h) =>
      text(h).replace(/ [↕↑↓]$/, ''),
    );
    expect(headers).toEqual([
      'Tovar',
      'Jami',
      'Band',
      'Mavjud',
      'Tannarx',
      'Цена $',
      'Oxirgi postavka',
      'Postavkalar soni',
      'Narxlar',
    ]);
    expect(rows()).toHaveLength(21);
    const priced = spaced(rowFor('10491'));
    expect(priced).toContain('Samsung Galaxy A15 4/128GB');
    // v8 "SKU · category" under the name.
    expect(spaced(rowFor('10491').querySelector('.meta'))).toBe('10491 · Telefonlar');
    expect(priced).toContain('59');
    expect(priced).toContain('Narxlarda');
    expect(priced).toContain('16.10.2026');
    expect(rowFor('10491').querySelector('.deliveries')?.textContent?.trim()).toBe('6');
    expect(text(rowFor('10521'))).toContain("Narx qo'yish");
    // Priced without a single delivery, or never in the sheet: not in the stock list.
    expect(codes()).not.toContain('10499');
    expect(codes()).not.toContain('10525');
    // The note that stock is indicative, not a reservation (hard rule 10).
    expect(text(body().querySelector('.note'))).toContain('Mavjud: jami minus band');
  });

  it('shows a coloured dot with spoken text for each level', async () => {
    await mountStock('manager');
    expect(rowFor('10482').querySelector('.stock-cell__dot--ok')).not.toBeNull(); // 600
    // The amount and its unit read as one phrase with a space, on one line.
    expect(text(rowFor('10482').querySelector('.stock-cell__value'))).toBe('600 dona');
    expect(rowFor('10484').querySelector('.stock-cell__dot--low')).not.toBeNull(); // 12
    expect(rowFor('10487').querySelector('.stock-cell__dot--out')).not.toBeNull(); // 0
    expect(text(rowFor('10487').querySelector('.sr-only'))).toBe('Qolmagan');
  });

  it('has a category dropdown with counts from the endpoint and filters the table', async () => {
    await mountStock('manager');
    expect(categoryValue()).toBe('Barcha kategoriyalar');
    expect(await categoryMenu()).toEqual([
      'Barcha kategoriyalar21',
      'Aksessuarlar7',
      'Audio4',
      'Planshetlar2',
      'Telefonlar7',
      'Televizorlar1',
    ]);
    await pickCategory('Planshetlar');
    expect(codes()).toEqual(['10494', '10521']);
    expect(categoryValue()).toBe('Planshetlar');
    await pickCategory('Barcha kategoriyalar');
    expect(codes()).toHaveLength(21);
  });

  it('searches by product id or a name in any language, and the tab counts follow', async () => {
    await mountStock('manager');
    const search = body().querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('no search');
    await type(search, 'зарядное');
    // Russian names of 10483 (Samsung charger), 10493 (old charger) and 10522 (Baseus).
    expect(codes()).toEqual(['10483', '10493', '10522']);
    expect((await categoryMenu())[0]).toBe('Barcha kategoriyalar3');
    await type(search, 'zzz');
    expect(codes()).toEqual([]);
    expect(text(body().querySelector('.dt__empty'))).toBe("Filtrga mos tovar yo'q");
  });

  it('"Omborda bor" asks the server for products with stock and updates the counts', async () => {
    const { services } = await mountStock('manager');
    const spy = vi.spyOn(services.stockApi, 'listStock');
    const box = body().querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(spy).toHaveBeenCalledWith({ inStock: true });
    expect(codes()).toHaveLength(17);
    expect(codes()).not.toContain('10487');
    const menu = await categoryMenu();
    expect(menu[0]).toBe('Barcha kategoriyalar17');
    // The only TV is out of stock, so it is gone (the server counts only what matches).
    expect(menu.some((label) => label.startsWith('Televizorlar'))).toBe(false);
  });

  it('keeps the table on screen while "Omborda bor" reloads (no skeleton flash)', async () => {
    const { services } = await mountStock('manager');
    let release: () => void = () => undefined;
    const original = services.stockApi.listStock.bind(services.stockApi);
    vi.spyOn(services.stockApi, 'listStock').mockImplementation(async (query) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(query);
    });
    const table = body().querySelector('.surface');
    const box = body().querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!table || !box) throw new Error('no table or checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    // The request is still running: the old rows stay, the list says it is busy.
    expect(body().querySelector('[data-state="loading"]')).toBeNull();
    expect(body().querySelector('.surface')).toBe(table);
    expect(codes().length).toBeGreaterThan(17);
    expect(body().querySelector('.list')?.getAttribute('aria-busy')).toBe('true');
    release();
    await flushPromises();
    expect(body().querySelector('.surface')).toBe(table);
    expect(codes()).toHaveLength(17);
    expect(body().querySelector('.list')?.getAttribute('aria-busy')).toBe('false');
  });

  it('falls back to all categories when the selected one disappears from the answer', async () => {
    await mountStock('manager');
    await pickCategory('Televizorlar');
    expect(codes()).toEqual(['10498']);
    const box = body().querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(categoryValue()).toBe('Barcha kategoriyalar');
    expect(codes()).toHaveLength(17);
  });
});

describe('Qoldiq page: the side panel', () => {
  it('opens on a row click with price history first and the supply history at the end', async () => {
    await mountStock('manager');
    await click(rowFor('10491'));
    const drawer = body().querySelector('[data-testid="drawer"]');
    expect(drawer).not.toBeNull();
    expect(text(drawer?.querySelector('.product__name'))).toBe('Samsung Galaxy A15 4/128GB');
    const headings = Array.from(drawer?.querySelectorAll('h3') ?? []).map((h) => text(h));
    expect(headings[headings.length - 1]).toBe('Postavka tarixi');
    expect(headings).toContain("Narx o'zgarishlari");
    expect(drawer?.querySelectorAll('.supply .line')).toHaveLength(6);
  });

  it('opens from the product name button too (keyboard)', async () => {
    await mountStock('manager');
    await click(button('10491 Samsung Galaxy A15 4/128GB: tovar tarixini ochish'));
    expect(body().querySelector('[data-testid="drawer"]')).not.toBeNull();
  });

  it('shows the accountant the supply history only', async () => {
    await mountStock('accountant');
    await click(rowFor('10491'));
    const drawer = body().querySelector('[data-testid="drawer"]');
    expect(drawer?.querySelector('.supply')).not.toBeNull();
    expect(text(drawer)).not.toContain("Narx o'zgarishlari");
  });
});

describe('Qoldiq page: the sheet sync report', () => {
  it('shows the last run: time, status, counts, rejected rows, skipped suppliers, new products, mismatches', async () => {
    await mountStock('manager');
    const panel = body().querySelector('[data-testid="sync-panel"]');
    expect(text(panel?.querySelector('.sync__summary'))).toContain('Muvaffaqiyatli');
    // 04:00:09 UTC is 09:00 in Tashkent.
    expect(text(panel?.querySelector('.sync__summary'))).toContain('Oxirgi: 19.10.2026 09:00');
    expect(text(panel?.querySelector('.sync__summary'))).toContain("Qo'lda ishga tushirilgan");

    const counts = spaced(panel?.querySelector('.sync__counts'));
    expect(counts).toContain("O'qilgan qatorlar 212");
    expect(counts).toContain('Rad etilgan qatorlar 2');
    expect(counts).toContain('Yangi tovarlar 3');
    expect(counts).toContain("O'chirish so'rovlari 2");

    // Rejected rows name the sheet header and a reason, never a cell's contents.
    const rejected = spaced(panel?.querySelectorAll('.block')[0]);
    expect(rejected).toContain('Цена закупа $');
    expect(rejected).toContain('Son emas yoki manfiy');
    expect(rejected).not.toContain('NOT_A_NUMBER');
    expect(rejected).toContain('Tovar ID kiritilmagan');
    expect(rejected).toContain('10523');

    const skipped = panel?.querySelectorAll('.block')[1];
    expect(text(skipped)).toContain('Beta system tm fbs');
    expect(text(skipped)).toContain('sana chegarasidan oldin');
    expect(text(skipped)).toContain('12 ta qator');
    // The near miss: a name that only differs by a hidden character is flagged, and the
    // character is made visible.
    expect(text(skipped)).toContain('alpha trade import<U+200B>');
    expect(text(skipped)).toContain("Ko'rinmas belgi bor");
    expect(text(panel?.querySelector('.sync__warn'))).toContain("ko'rinmas belgi bor");

    expect(spaced(panel?.querySelectorAll('.block')[2])).toContain('10521 10522 10525');
    expect(spaced(panel?.querySelectorAll('.block')[3])).toContain('10482 Z-20413 farq 0.80%');
  });

  it('shows an empty state when the sync never ran', async () => {
    await mountStock('manager', {
      prepare: (services) => {
        vi.spyOn(services.stockApi, 'getLastSyncRun').mockResolvedValue(null);
      },
    });
    expect(text(body().querySelector('[data-testid="sync-panel"]'))).toContain(
      "Sinxronizatsiya hali bo'lmagan",
    );
  });

  it('shows a failed run with its error code', async () => {
    const { services } = await mountStock('manager');
    const runs = await services.stockApi.listSyncRuns();
    const failed = runs.items.find((r) => r.status === 'FAILED');
    if (!failed) throw new Error('fixture has no failed run');
    document.body.innerHTML = '';
    await mountStock('manager', {
      prepare: (s) => {
        vi.spyOn(s.stockApi, 'getLastSyncRun').mockResolvedValue(failed);
      },
    });
    const panel = body().querySelector('[data-testid="sync-panel"]');
    expect(text(panel?.querySelector('[role="alert"]'))).toContain('SHEET_UNREACHABLE');
    expect(text(panel)).toContain('Xato bilan tugadi');
  });
});

describe('Qoldiq page: removal requests', () => {
  const requests = (): HTMLElement[] =>
    Array.from(body().querySelectorAll<HTMLElement>('[data-testid="removal-request"]'));

  it('lists the pending requests with the stored line, oldest first', async () => {
    await mountStock('manager');
    expect(requests()).toHaveLength(2);
    expect(text(body().querySelector('.removals__count'))).toBe('2');
    const first = spaced(requests()[0]);
    expect(first).toContain('10483');
    expect(first).toContain('Aniqlangan: 18.10.2026');
    expect(first).toContain('Yetkazilgan 100');
    expect(first).toContain('$9,40');
  });

  it('gives the accountant the list without the decision buttons', async () => {
    await mountStock('accountant');
    expect(requests()).toHaveLength(2);
    expect(buttons().some((b) => text(b) === 'Tasdiqlash')).toBe(false);
    expect(buttons().some((b) => text(b) === 'Rad etish')).toBe(false);
  });

  it('asks for a confirmation that explains what confirming does, then removes the line', async () => {
    const { services } = await mountStock('manager');
    const before = (await services.stockApi.listStock()).items.find(
      (i) => i.productCode === '10483',
    );
    await click(button('Tasdiqlash: 10483 Z-20375'.replace('Z-20375', refOf(requests()[0]))));
    expect(dialog()?.textContent).toContain('qoldiq va tannarx tarixida hisobga olinmaydi');
    expect(dialog()?.textContent).toContain('hisobdan chiqariladi');
    // Nothing is decided before the person agrees.
    expect((await services.stockApi.listSupplyRemovals()).total).toBe(2);

    await click(dialog()?.querySelector<HTMLButtonElement>('.btn--danger') as HTMLButtonElement);
    expect(dialog()).toBeNull();
    expect(requests()).toHaveLength(1);
    expect(useToast().toast.value?.message).toContain('qator hisobdan chiqarildi');
    // The stock table is read again: the line no longer counts.
    const after = rowFor('10483').querySelector('.deliveries')?.textContent?.trim();
    expect(after).toBe(String((before?.deliveryCount ?? 0) - 1));
  });

  it('cancelling the confirmation decides nothing', async () => {
    const { services } = await mountStock('manager');
    await click(button(`Tasdiqlash: 10483 ${refOf(requests()[0])}`));
    await click(button('Bekor qilish', dialog() as HTMLElement));
    expect((await services.stockApi.listSupplyRemovals()).total).toBe(2);
  });

  it('dismissing keeps the line and needs no confirmation', async () => {
    const { services } = await mountStock('admin');
    await click(button(`Rad etish: 10483 ${refOf(requests()[0])}`));
    expect(dialog()).toBeNull();
    expect(requests()).toHaveLength(1);
    expect(useToast().toast.value?.message).toContain('qator saqlab qolindi');
    expect((await services.stockApi.listSupplyRemovals()).total).toBe(1);
  });

  it('explains it when someone else already decided the request', async () => {
    const { services } = await mountStock('manager');
    const [first] = (await services.stockApi.listSupplyRemovals()).items;
    if (!first) throw new Error('expected a request');
    // Another manager confirms it between this page loading and the click.
    await services.stockApi.confirmSupplyRemoval(first.id);
    await click(button(`Tasdiqlash: ${first.productCode} ${first.deliveryRef}`));
    await click(dialog()?.querySelector<HTMLButtonElement>('.btn--danger') as HTMLButtonElement);
    expect(text(dialog()?.querySelector('[role="alert"]'))).toBe(
      "Bu o'chirish so'rovi allaqachon ko'rib chiqilgan.",
    );
    // The list refreshed behind the dialog.
    expect(requests()).toHaveLength(1);
  });

  it('shows the empty state when nothing is pending', async () => {
    await mountStock('manager', {
      prepare: (services) => {
        vi.spyOn(services.stockApi, 'listSupplyRemovals').mockResolvedValue({
          total: 0,
          items: [],
        });
      },
    });
    expect(text(body().querySelector('.removals'))).toContain("Kutilayotgan so'rov yo'q");
  });

  it('keeps a failed decision from disappearing: the conflict reason maps to its own message', async () => {
    const { services } = await mountStock('manager');
    vi.spyOn(services.stockApi, 'dismissSupplyRemoval').mockRejectedValueOnce(
      new ApiConflictError('x', 'CONFLICT', undefined, 'REMOVAL_REQUEST_NOT_PENDING'),
    );
    await click(button(`Rad etish: 10483 ${refOf(requests()[0])}`));
    expect(useToast().toast.value?.message).toBe(
      "Bu o'chirish so'rovi allaqachon ko'rib chiqilgan.",
    );
  });
});

function refOf(request: HTMLElement | undefined): string {
  return text(request?.querySelector('.request__ref'));
}

describe('Qoldiq page: states', () => {
  it('shows the error state with a retry', async () => {
    await mountStock('manager', { scenario: 'error' });
    expect(text(body().querySelector('.stock'))).toContain("Yuklab bo'lmadi");
    expect(button('Qayta urinish')).toBeDefined();
  });

  it('shows the permission-denied state', async () => {
    await mountStock('manager', { scenario: 'denied' });
    expect(text(body().querySelector('.stock'))).toContain("Ruxsat yo'q");
  });

  it('shows the empty state', async () => {
    await mountStock('manager', { scenario: 'empty' });
    expect(text(body().querySelector('.stock'))).toContain("Qoldiq ma'lumoti yo'q");
  });

  it('refuses a role that may not view stock, even if the page were reached', async () => {
    await mountStock('warehouse');
    expect(rows()).toHaveLength(0);
    expect(text(body().querySelector('.stock'))).toContain("Ruxsat yo'q");
  });
});

describe('Qoldiq page: category and search live in the address', () => {
  const selectedCategory = (): string => categoryValue();
  const searchBox = (): HTMLInputElement => {
    const el = body().querySelector<HTMLInputElement>('.search__input');
    if (!el) throw new Error('no search box');
    return el;
  };
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('reads them from the address on load (reload keeps the view)', async () => {
    await mountStock('manager', { path: '/stock?category=c%3ATelefonlar&q=10491' });
    expect(selectedCategory()).toContain('Telefonlar');
    expect(searchBox().value).toBe('10491');
    expect(codes()).toEqual(['10491']);
  });

  it('writes them with replace, keeps other parameters, and drops the defaults', async () => {
    const { router } = await mountStock('manager', { path: '/stock?keep=1' });
    const push = vi.spyOn(router, 'push');
    await pickCategory('Telefonlar');
    expect(router.currentRoute.value.query).toEqual({ keep: '1', category: 'c:Telefonlar' });
    await type(searchBox(), '10491');
    await wait(450);
    await flushPromises();
    expect(router.currentRoute.value.query.q).toBe('10491');
    await pickCategory('Barcha kategoriyalar');
    expect(router.currentRoute.value.query.category).toBeUndefined();
    // replace, not push: Back leaves the page instead of stepping through filters.
    expect(push).not.toHaveBeenCalled();
  });

  it('follows the address when it changes (the Back button)', async () => {
    const { router } = await mountStock('manager', { path: '/stock?category=c%3ATelefonlar' });
    expect(selectedCategory()).toContain('Telefonlar');
    await router.push('/stock');
    await flushPromises();
    expect(selectedCategory()).toBe('Barcha kategoriyalar');
    expect(searchBox().value).toBe('');
  });
});

describe('Qoldiq page: our rules over the v8 design', () => {
  it('has no warehouse or location column and no warehouse filter; "sync now" lives in the source card', async () => {
    await mountStock('manager');
    const headers = text(body().querySelector('.stock thead'));
    for (const word of ['Ombor', 'Joy']) expect(headers).not.toContain(word);
    expect(body().querySelector('select')).toBeNull();
    // Owner request 2026-10-28: the one sync button is the source card's, nowhere else.
    expect(buttons().filter((b) => /sinxron/i.test(text(b)))).toHaveLength(1);
    // The source card names the sheet and says it is only read.
    const card = body().querySelector('[data-testid="sync-panel"]');
    expect(text(card?.querySelector('h2'))).toBe('Google Sheet · «Поставка»');
    expect(text(card)).toContain("Faqat o'qiladi");
  });

  it("shows the selling price in USD and the cost in so'm with dollars below", async () => {
    await mountStock('manager');
    const row = rowFor('10491');
    // Prices are kept in USD [owner 2026-10-29].
    expect(text(row.querySelectorAll('td')[5])).toBe('$133,60');
    expect(text(row.querySelectorAll('td')[4])).toContain('$');
    // Not in the published list: no price.
    expect(text(rowFor('10521').querySelectorAll('td')[5])).toBe('—');
  });

  it('filters by price status with counts, kept in the address', async () => {
    const { router } = await mountStock('manager');
    expect(text(statusButton('all'))).toBe('Hammasi 21');
    expect(text(statusButton('priced'))).toBe('Narxlarda 16');
    expect(text(statusButton('unpriced'))).toBe("Narx qo'yilmagan 5");
    await click(statusButton('unpriced'));
    expect(statusButton('unpriced').getAttribute('aria-pressed')).toBe('true');
    expect(codes()).toHaveLength(5);
    expect(router.currentRoute.value.query.priced).toBe('unpriced');
    // Categories without such a product stay in the menu, dimmed, after the ones with products.
    const menu = await categoryMenu();
    const firstEmpty = menu.findIndex((label) => label.endsWith('0'));
    expect(firstEmpty).toBeGreaterThan(0);
    expect(menu.slice(firstEmpty).every((label) => label.endsWith('0'))).toBe(true);
  });

  it("offers 'Narx qo'yish' to a price editor; its dialog publishes the price at once", async () => {
    const { services } = await mountStock('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    expect(rowFor('10491').querySelector('.setprice')).toBeNull();
    // Zero stock is no reason to refuse a price: 10524 has 0 left.
    expect(rowFor('10524').querySelector('.stock-cell__dot--out')).not.toBeNull();
    const button10524 = rowFor('10524').querySelector<HTMLButtonElement>('.setprice');
    if (!button10524) throw new Error('no set price button');
    await click(button10524);
    // The click did not also open the side panel; the price dialog is open instead.
    expect(body().querySelector('[data-testid="drawer"]')).toBeNull();
    expect(text(dialog())).toContain("Narx qo'yish");
    const input = dialog()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('no price input');
    await type(input, '2 390 000');
    const save = Array.from(
      dialog()?.closest('[data-testid="modal"]')?.querySelectorAll<HTMLButtonElement>('button') ??
        [],
    ).find((b) => text(b) === 'Narxlarga chiqarish');
    if (!save) throw new Error('no save button');
    await click(save);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      baseVersionNumber: 14,
      removedProductIds: [],
      upserts: [{ basePrice: '2390000' }],
    });
    expect(dialog()).toBeNull();
    expect(rowFor('10524').querySelector('.setprice')).toBeNull();
    expect(text(rowFor('10524'))).toContain('2 390 000');
    expect(useToast().toast.value?.message).toMatch(/^Narxlar saqlandi · v15 · /);
  });

  it('prices a product the sheet created without a unit at once (pieces only)', async () => {
    const { services } = await mountStock('manager');
    const publish = vi.spyOn(services.pricingApi, 'publishChanges');
    const button10521 = rowFor('10521').querySelector<HTMLButtonElement>('.setprice');
    if (!button10521) throw new Error('no set price button');
    await click(button10521);
    expect(text(dialog())).not.toContain('Birlik');
    const input = dialog()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('no price input');
    await type(input, '1 500 000');
    const save = Array.from(
      dialog()?.closest('[data-testid="modal"]')?.querySelectorAll<HTMLButtonElement>('button') ??
        [],
    ).find((b) => text(b) === 'Narxlarga chiqarish');
    if (!save) throw new Error('no save button');
    await click(save);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("gives the accountant a read-only 'Narx qo'yilmagan' pill instead of the button", async () => {
    await mountStock('accountant');
    expect(body().querySelector('.setprice')).toBeNull();
    expect(text(rowFor('10521'))).toContain("Narx qo'yilmagan");
  });
});

describe('stock page: "sync now" with the sheet', () => {
  it('shows the button to a manager, queues a run, waits for it and reloads the stock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { services } = await mountStock('manager');
      const request = vi.spyOn(services.stockApi, 'requestSyncRun');
      const list = vi.spyOn(services.stockApi, 'listStock');
      const panel = body().querySelector('[data-testid="sync-panel"]');
      const syncNow = panel?.querySelector<HTMLButtonElement>('[data-testid="sync-now"]');
      if (!syncNow) throw new Error('no sync-now button');
      expect(text(syncNow)).toBe('Jadval bilan sinxronlash');

      syncNow.click();
      await flushPromises();
      expect(request).toHaveBeenCalledTimes(1);
      expect(useToast().toast.value?.message).toContain('navbatga');
      expect(syncNow.disabled).toBe(true);
      expect(text(syncNow)).toBe('Sinxronlanmoqda…');

      // The fake worker finishes, the next poll sees the new run: the stock reloads.
      const listCallsBefore = list.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      await flushPromises();
      expect(text(panel)).toContain("Qo'lda ishga tushirilgan");
      expect(list.mock.calls.length).toBeGreaterThan(listCallsBefore);
      expect(syncNow.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['accountant', 'admin'])(
    'offers the party button only to a manager, not %s',
    async (who) => {
      await mountStock(who);
      expect(body().querySelector('[data-testid="party-open"]')).toBeNull();
    },
  );

  it('opens the party dialog for a manager', async () => {
    await mountStock('manager');
    body().querySelector<HTMLButtonElement>('[data-testid="party-open"]')?.click();
    await flushPromises();
    expect(body().querySelector('input[role="combobox"]')).not.toBeNull();
  });

  it('does not offer the button to the accountant', async () => {
    await mountStock('accountant');
    expect(body().querySelector('[data-testid="sync-panel"]')).not.toBeNull();
    expect(body().querySelector('[data-testid="sync-now"]')).toBeNull();
  });
});

// Owner 2026-11-09: after "sync now" an ordinary employee could not tell whether it had worked.
describe('Qoldiq page: "sync now" says how it ended', () => {
  const dialog = (): HTMLElement | null => body().querySelector<HTMLElement>('[role="dialog"]');
  const syncNow = (): HTMLButtonElement =>
    body().querySelector<HTMLButtonElement>('[data-testid="sync-now"]') as HTMLButtonElement;
  const report = (): HTMLDetailsElement =>
    body().querySelector<HTMLDetailsElement>('.sync__details') as HTMLDetailsElement;

  async function startSync(
    prepare?: (services: Services) => void,
    beforeMount?: (services: Services) => void,
  ) {
    const made = await mountStock('manager', { prepare: beforeMount });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    prepare?.(made.services);
    await click(syncNow());
    await flushPromises();
    expect(text(syncNow())).toBe('Sinxronlanmoqda…');
    expect(dialog()).toBeNull();
    return made;
  }
  async function pass(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flushPromises();
  }
  afterEach(() => vi.useRealTimers());

  it('opens a dialog with what changed and what needs attention', async () => {
    const { services } = await startSync();
    const reload = vi.spyOn(services.stockApi, 'listStock');
    await pass(10_000);

    expect(text(dialog()?.querySelector('h2'))).toBe('Sinxronlash tugadi');
    expect(text(dialog())).toContain("Qoldiq jadvaldagi ma'lumot bilan yangilandi.");
    const counts = spaced(dialog()?.querySelector('.result__counts'));
    expect(counts).toBe('Yangi postavkalar 4 Yangilangan postavkalar 2 Yangi tovarlar 3');
    expect(text(dialog()?.querySelector('[data-testid="sync-result-rejected"]'))).toContain(
      "2 ta qator xato sababli o'qilmadi",
    );
    expect(text(dialog()?.querySelector('[data-testid="sync-result-removals"]'))).toContain(
      "2 ta postavka jadvaldan yo'qolgan",
    );
    // The stock table was read again, and the button is ready for the next run.
    expect(reload).toHaveBeenCalled();
    expect(text(syncNow())).toBe('Jadval bilan sinxronlash');

    await click(button('Yopish', dialog()!));
    await pass(500);
    expect(dialog()).toBeNull();
    expect(report().open).toBe(false);
  });

  it('"view the report" closes the dialog and unfolds the report in the card', async () => {
    await startSync();
    await pass(10_000);
    expect(report().open).toBe(false);
    await click(button("Hisobotni ko'rish", dialog()!));
    await pass(500);
    expect(dialog()).toBeNull();
    expect(report().open).toBe(true);
  });

  it('says so when the sheet had nothing new, without a row of zeros', async () => {
    await startSync((services) => {
      const read = services.stockApi.getLastSyncRun.bind(services.stockApi);
      vi.spyOn(services.stockApi, 'getLastSyncRun').mockImplementation(async () => {
        const run = await read();
        if (!run) return run;
        const counts = { ...run.counts, created: 0, updated: 0, createdProducts: 0, rejected: 0 };
        return { ...run, counts: { ...counts, removalsRequested: 0 } };
      });
    });
    await pass(10_000);
    expect(text(dialog())).toContain("Jadvalda yangi o'zgarish yo'q, qoldiq avvalgidek qoldi.");
    expect(dialog()?.querySelector('.result__counts')).toBeNull();
    expect(dialog()?.querySelector('.result__note')).toBeNull();
  });

  it('a failed run says the stock did not change and shows the error code', async () => {
    await startSync((services) => {
      const read = services.stockApi.getLastSyncRun.bind(services.stockApi);
      vi.spyOn(services.stockApi, 'getLastSyncRun').mockImplementation(async () => {
        const run = await read();
        return run && { ...run, status: 'FAILED' as const, errorCode: 'SHEET_UNREACHABLE' };
      });
    });
    await pass(10_000);
    expect(text(dialog()?.querySelector('h2'))).toBe('Sinxronlash bajarilmadi');
    expect(text(dialog())).toContain("Qoldiq o'zgarmadi.");
    expect(text(dialog()?.querySelector('.result__code'))).toBe('Xato kodi: SHEET_UNREACHABLE');
    expect(dialog()?.querySelector('.result__counts')).toBeNull();
    // A failed run unfolds the report by itself.
    expect(report().open).toBe(true);
  });

  it('does not go quiet when no run appears in time', async () => {
    await startSync((services) => {
      const before = services.stockApi.getLastSyncRun();
      vi.spyOn(services.stockApi, 'getLastSyncRun').mockImplementation(() => before);
    });
    await pass(3 * 60_000 + 5_000);
    expect(text(dialog()?.querySelector('h2'))).toBe('Sinxronlash hali tugamadi');
    expect(dialog()?.querySelector('[data-testid="sync-result"]')).toBeNull();
    expect(text(syncNow())).toBe('Jadval bilan sinxronlash');
  });

  // Found in review: the comparison baseline was whatever the card had loaded, and that is nothing
  // when its first read failed. The run of yesterday then counted as "new".
  it('never presents an older run as the result when the card had failed to load', async () => {
    let calls = 0;
    await startSync(undefined, (services) => {
      const old = services.stockApi.getLastSyncRun();
      vi.spyOn(services.stockApi, 'getLastSyncRun').mockImplementation(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('offline')) : old;
      });
    });
    await pass(15_000);
    expect(dialog()).toBeNull();
    expect(text(syncNow())).toBe('Sinxronlanmoqda…');
  });

  it('does not ask for a sync when it cannot tell which run is the last one', async () => {
    const made = await mountStock('manager');
    const request = vi.spyOn(made.services.stockApi, 'requestSyncRun');
    vi.spyOn(made.services.stockApi, 'getLastSyncRun').mockRejectedValue(new Error('offline'));
    await click(syncNow());
    await flushPromises();
    expect(request).not.toHaveBeenCalled();
    expect(syncNow().disabled).toBe(false);
    expect(text(syncNow())).toBe('Jadval bilan sinxronlash');
  });

  it('stops for good when the page is left while a poll is still in flight', async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    let polls = 0;
    const made = await startSync((services) => {
      const old = services.stockApi.getLastSyncRun();
      vi.spyOn(services.stockApi, 'getLastSyncRun').mockImplementation(async () => {
        // The first read is the comparison baseline taken when the sync is asked for.
        if ((reads += 1) === 1) return old;
        polls += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return old;
      });
    });
    await pass(5_000);
    expect(polls).toBe(1);
    made.wrapper.unmount();
    release?.();
    await pass(60_000);
    expect(polls).toBe(1);
    expect(dialog()).toBeNull();
  });

  it('folds the report again when a good run follows a failed one', async () => {
    const { services } = await mountStock('manager');
    const runs = await services.stockApi.listSyncRuns();
    const failed = runs.items.find((r) => r.status === 'FAILED');
    if (!failed) throw new Error('fixture has no failed run');
    document.body.innerHTML = '';
    let worked = false;
    await startSync(undefined, (s) => {
      const read = s.stockApi.getLastSyncRun.bind(s.stockApi);
      vi.spyOn(s.stockApi, 'getLastSyncRun').mockImplementation(() =>
        worked ? read() : Promise.resolve(failed),
      );
    });
    expect(report().open).toBe(true);
    worked = true;
    await pass(10_000);
    expect(text(dialog()?.querySelector('h2'))).toBe('Sinxronlash tugadi');
    expect(report().open).toBe(false);
  });

  it('"check again" after the waiting time keeps looking for the same run', async () => {
    let finished = false;
    await startSync((services) => {
      const read = services.stockApi.getLastSyncRun.bind(services.stockApi);
      const before = read();
      vi.spyOn(services.stockApi, 'getLastSyncRun').mockImplementation(() =>
        finished ? read() : before,
      );
    });
    await pass(3 * 60_000 + 5_000);
    expect(text(dialog()?.querySelector('h2'))).toBe('Sinxronlash hali tugamadi');

    await click(button('Yana tekshirish', dialog()!));
    await pass(500);
    expect(dialog()).toBeNull();
    expect(text(syncNow())).toBe('Sinxronlanmoqda…');

    finished = true;
    await pass(5_000);
    expect(text(dialog()?.querySelector('h2'))).toBe('Sinxronlash tugadi');
  });

  it('rows the sync could not read are a quiet line, vanished deliveries a warning', async () => {
    await startSync();
    await pass(10_000);
    const rejected = dialog()?.querySelector('[data-testid="sync-result-rejected"]');
    const removals = dialog()?.querySelector('[data-testid="sync-result-removals"]');
    expect(rejected?.classList.contains('result__note--warn')).toBe(false);
    expect(removals?.classList.contains('result__note--warn')).toBe(true);
  });
});

describe('Qoldiq page: the mega report', () => {
  function recordDownloads(): { download: string }[] {
    const saved: { download: string }[] = [];
    // jsdom has no object URLs and does not download: record what would have been saved.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test/1'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push({ download: this.download });
    });
    return saved;
  }
  const button = (): HTMLButtonElement | null =>
    body().querySelector<HTMLButtonElement>('[data-testid="mega-report"]');

  it('every role of the page downloads it; the button says it is working meanwhile', async () => {
    for (const identity of ['manager', 'accountant']) {
      const saved = recordDownloads();
      const { services } = await mountStock(identity);
      let release: () => void = () => undefined;
      const real = services.stockApi.downloadMegaReport;
      vi.spyOn(services.stockApi, 'downloadMegaReport').mockImplementation(
        () => new Promise((resolve) => (release = () => resolve(real()))),
      );
      expect(text(button())).toBe('Mega report');
      button()?.click();
      await flushPromises();
      expect(button()?.disabled).toBe(true);
      expect(button()?.getAttribute('aria-busy')).toBe('true');
      expect(text(button())).toBe('Tayyorlanmoqda…');
      release();
      await flushPromises();
      await flushPromises();
      expect(saved).toEqual([{ download: 'Mega_report-demo.csv' }]);
      expect(useToast().toast.value?.message).toBe('Fayl yuklab olindi: Mega_report-demo.csv');
      expect(button()?.disabled).toBe(false);
      expect(text(button())).toBe('Mega report');
      for (const wrapper of wrappers.splice(0)) wrapper.unmount();
      vi.restoreAllMocks();
    }
  });

  it('says why when the download fails and lets the person try again', async () => {
    recordDownloads();
    const { services } = await mountStock('manager');
    vi.spyOn(services.stockApi, 'downloadMegaReport').mockRejectedValueOnce(new NetworkError());
    button()?.click();
    await flushPromises();
    expect(useToast().toast.value?.message).toBe(
      "Internet aloqasi yo'q. Tekshirib, qayta urinib ko'ring.",
    );
    expect(button()?.disabled).toBe(false);
  });
});

describe('Qoldiq page: the supplier filter (owner request 2026-11-13)', () => {
  const supplierOptionsShown = (): string[] =>
    Array.from(body().querySelectorAll('.fcb__list [role="option"]')).map((o) => text(o));

  it('lists every supplier of the answer with its product count', async () => {
    await mountStock('manager');
    expect(supplierOptionsShown()).toEqual([
      'Barcha postavshiklar',
      'Beta system tm fbs1616 mahsulot',
      'alpha trade import1717 mahsulot',
    ]);
  });

  it('reads the supplier from the address, narrows the rows and the other counts', async () => {
    const { router } = await mountStock('manager', {
      path: '/stock?supplier=Beta%20system%20tm%20fbs',
    });
    expect(codes()).toHaveLength(16);
    expect(text(statusButton('all'))).toBe('Hammasi 16');
    const field = body().querySelector<HTMLInputElement>('[data-testid="supplier-filter"] input');
    expect(field?.value).toBe('Beta system tm fbs');
    // Back to the plain address: every row again.
    await router.push('/stock');
    await flushPromises();
    expect(codes()).toHaveLength(21);
  });
});
