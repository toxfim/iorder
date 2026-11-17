import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import type { PriceImportPreviewResponse, PriceImportPreviewRow } from '@iorder/shared/staff-cost';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { ApiConflictError, ApiValidationError } from '@core/lib/api-errors';
import { saveFile } from '@core/lib/save-file';
import { createTestServices } from '@/test-utils/create-test-services';
import PricesPage from './PricesPage.vue';

// Staff-added products without a sheet «Товар_ID» [C, 2026-11-09] on Narxlar, as the design canvas
// "Narxlar · qo'lda qo'shilgan tovarlar" draws them: the "+ Yangi tovar" menu, the add form with
// its name check, the Excel import (template kinds, check, errors first, CSV of the errors,
// publish) and the merge into a sheet product with the server's preview, over the in-memory fake.

vi.mock('@core/lib/save-file', () => ({ saveFile: vi.fn() }));

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
  vi.mocked(saveFile).mockClear();
});

async function mountPrices(
  identity: string,
  prepare?: (services: Services) => void | Promise<void>,
) {
  const test = createTestServices({ identityId: identity });
  await test.services.currentUser.ensureLoaded();
  await prepare?.(test.services);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/prices', component: PricesPage },
      { path: '/stock', name: 'staff-stock', component: { render: () => h('p') } },
      { path: '/versions', name: 'staff-price-versions', component: { render: () => h('p') } },
      { path: '/products', name: 'staff-products', component: { render: () => h('p') } },
      { path: '/newer-models', name: 'staff-newer-models', component: { render: () => h('p') } },
    ],
  });
  await router.push('/prices');
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: test.services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { ...test, router };
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
const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = body().querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`No element with data-testid="${id}"`);
  return el;
};
const allByTestId = (id: string): HTMLElement[] =>
  Array.from(body().querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
const dialog = (): HTMLElement | null =>
  body().querySelector('[data-testid="modal"]:not(.modal--closing) [role="dialog"]');
const rows = (): HTMLElement[] =>
  Array.from(body().querySelectorAll<HTMLElement>('.surface tbody tr'));
const rowFor = (code: string): HTMLElement => {
  const found = rows().find((r) => r.textContent?.includes(code));
  if (!found) throw new Error(`No row ${code}`);
  return found;
};
const subtitle = (): string => text(body().querySelector('.head__subtitle'));
const toastText = (): string => useToast().toast.value?.message ?? '';
const tabs = (): HTMLElement[] => Array.from(body().querySelectorAll<HTMLElement>('[role="tab"]'));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function click(el: HTMLElement): Promise<void> {
  el.click();
  await flushPromises();
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
const fieldIn = (dialogEl: HTMLElement | null, marker: string): HTMLInputElement => {
  const input = dialogEl?.querySelector<HTMLInputElement>(`[${marker}] input`);
  if (!input) throw new Error(`No ${marker} input in the dialog`);
  return input;
};
async function openRow(code: string): Promise<void> {
  const trigger = rowFor(code).querySelector<HTMLElement>('.dt__link') ?? rowFor(code);
  await click(trigger);
}
/** The "+ Yangi tovar" menu, then one of its two items. */
async function openMenuItem(item: 'add-manual-product' | 'import-prices'): Promise<void> {
  await click(byTestId('new-product-menu'));
  await click(byTestId(item));
}
/** What a file picker does: hands the chosen file to the hidden input and fires `change`. */
async function chooseFile(name: string, size = 10): Promise<void> {
  const input = byTestId<HTMLInputElement>('import-file');
  const file = new File(['x'.repeat(size)], name);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}
/** The CSV handed to the browser by the last saveFile call. */
async function savedText(): Promise<string> {
  const call = vi.mocked(saveFile).mock.calls.at(-1);
  if (!call) throw new Error('saveFile was not called');
  return call[0].text();
}

async function addManualProduct(
  services: Services,
  name: string,
  price: string,
  brandName: string | null = null,
): Promise<void> {
  const current = await services.pricingApi.getCurrent();
  const brands = (await services.brandsApi.listBrands()).items;
  await services.pricingApi.createManualProduct({
    baseVersionNumber: current.version.number,
    name,
    brandId: brands.find((b) => b.name === brandName)?.id ?? null,
    category: null,
    basePrice: price,
    deferredPrice: null,
  });
}

describe("Narxlar: the '+ Yangi tovar' menu", () => {
  it('opens the add form and the Excel import from its two items, and closes on Escape', async () => {
    await mountPrices('manager');
    const trigger = byTestId('new-product-menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(body().querySelectorAll('[role="menuitem"]')).map(spaced);
    expect(items).toEqual([
      "Bittalab qo'shish Forma orqali bitta tovar",
      "Excel orqali yuklash Ko'p tovar, avval tekshiriladi",
    ]);
    body()
      .querySelector('[role="menu"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(body().querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await openMenuItem('add-manual-product');
    expect(text(dialog())).toContain("Yangi tovar qo'shish");
    await click(dialog()?.querySelector('button.btn--secondary') as HTMLElement);
    await openMenuItem('import-prices');
    expect(byTestId('import-step-file')).toBeTruthy();
  });

  it('is not offered to a role that may not change prices', async () => {
    await mountPrices('accountant');
    expect(body().querySelector('[data-testid="new-product-menu"]')).toBeNull();
  });
});

describe("Narxlar: 'Yangi tovar qo'shish'", () => {
  it('creates the product with a generated code and category, publishes at once and marks the row', async () => {
    const { services } = await mountPrices('manager');
    const create = vi.spyOn(services.pricingApi, 'createManualProduct');
    await openMenuItem('add-manual-product');
    expect(byTestId<HTMLButtonElement>('manual-save').disabled).toBe(true);
    // The design's two grey cards: the id the system gives, and the stock card, which names the
    // type in the staff's word ("by order", stock not tracked).
    expect(text(dialog())).toContain('IO-······');
    expect(text(dialog())).toContain('Buyurtma orqali');
    expect(text(dialog())).toContain('kuzatilmaydi');

    await type(fieldIn(dialog(), 'data-manual-name'), '  Demo powerbank  ');
    await type(fieldIn(dialog(), 'data-manual-category'), 'Quloqchinlar');
    await type(fieldIn(dialog(), 'data-price-input'), '18,5');
    await type(fieldIn(dialog(), 'data-deferred-price-input'), '12.345');
    expect(text(dialog())).toContain("Narx noto'g'ri");
    expect(byTestId<HTMLButtonElement>('manual-save').disabled).toBe(true);
    await type(fieldIn(dialog(), 'data-deferred-price-input'), '');
    await click(byTestId('manual-save'));

    expect(create).toHaveBeenCalledWith({
      baseVersionNumber: 14,
      name: 'Demo powerbank',
      brandId: null,
      category: 'Quloqchinlar',
      basePrice: '18.5',
      deferredPrice: null,
    });
    expect(dialog()).toBeNull();
    expect(toastText()).toMatch(/^Demo powerbank qo'shildi · kod IO-000001 · v15/);
    // 17 again: the fake's one inactive product leaves the list as the new one enters.
    expect(subtitle()).toBe("Narx ro'yxati v15 · 17 ta tovar · 1 tasi buyurtma orqali");
    const row = rowFor('IO-000001');
    expect(text(row.querySelector('[data-testid="manual-badge"]'))).toBe('Buyurtma orqali');
    expect(spaced(row.querySelector('.meta'))).toBe('IO-000001 · Quloqchinlar');
    // No stock, cost or markup is ever shown for a product the sheet does not know.
    expect(row.querySelector('.stock-cell')).toBeNull();
    const cells = row.querySelectorAll('td');
    // Stock, cost and markup (after the three price groups); no wholesale price yet.
    expect([text(cells[1]), text(cells[2]), text(cells[9])]).toEqual(['—', '—', '—']);
    // No Alif price: Alif factoring customers are not offered it.
    expect(text(cells[7])).toBe("ko'rinmaydi");
    expect(text(cells[5])).toBe('standartdan');
  });

  it("filters the list with the 'Buyurtma orqali' tab, kept in the address", async () => {
    const { router } = await mountPrices('manager', (s) => addManualProduct(s, 'Demo', '5'));
    expect(tabs().map(text)).toEqual([
      'Barcha mahsulotlar17',
      'Buyurtma orqali1',
      // The new product has none; the inactive one it replaced had none either.
      "Ulgurji narxi yo'q9",
      'Narxlar tarixi',
    ]);
    await click(tabs()[1] as HTMLElement);
    expect(router.currentRoute.value.query.tab).toBe('manual');
    expect(rows().map((r) => text(r.querySelector('.code')))).toEqual(['IO-000001']);
    expect(text(byTestId('list-footer'))).toBe(
      '1 ta buyurtma orqali tovar · qoldiq va tannarx kuzatilmaydi · narxlar dollarda',
    );
    await click(tabs()[0] as HTMLElement);
    expect(rows()).toHaveLength(17);
    expect(text(byTestId('list-footer'))).toBe('17 ta tovar · narxlar dollarda');
  });

  it('has no such tab and no manual count while every product comes from the sheet', async () => {
    await mountPrices('manager');
    expect(tabs().map(text)).toEqual([
      'Barcha mahsulotlar17',
      "Ulgurji narxi yo'q9",
      'Narxlar tarixi',
    ]);
    expect(subtitle()).toBe("Narx ro'yxati v14 · 17 ta tovar");
  });

  it('warns about a similar name and preselects the brand found in the name, until a brand is chosen', async () => {
    const { services } = await mountPrices('admin');
    const check = vi.spyOn(services.pricingApi, 'checkManualProduct');
    const create = vi.spyOn(services.pricingApi, 'createManualProduct');
    await openMenuItem('add-manual-product');
    const brandTrigger = () => byTestId('manual-brand').querySelector<HTMLButtonElement>('button');
    expect(text(brandTrigger())).toBe('Brendsiz');

    await type(fieldIn(dialog(), 'data-manual-name'), 'Anker PowerCore 20000');
    // Debounced: nothing is asked while the person is still typing.
    expect(check).not.toHaveBeenCalled();
    await wait(350);
    await flushPromises();
    expect(check).toHaveBeenCalledWith('Anker PowerCore 20000');
    expect(text(byTestId('similar-hint'))).toBe("O'xshash nom bor: Anker PowerCore 20000 · 10485");
    expect(text(brandTrigger())).toBe('Anker');
    expect(text(byTestId('brand-found'))).toBe('Nomdan topildi');
    // Not blocking: the save stays possible with the hint on screen.
    await type(fieldIn(dialog(), 'data-price-input'), '99');
    expect(byTestId<HTMLButtonElement>('manual-save').disabled).toBe(false);

    // A brand chosen by hand wins over the finder from then on.
    await click(brandTrigger() as HTMLElement);
    const option = Array.from(body().querySelectorAll<HTMLElement>('[role="option"]')).find(
      (o) => text(o) === 'Samsung',
    );
    await click(option as HTMLElement);
    expect(body().querySelector('[data-testid="brand-found"]')).toBeNull();
    await type(fieldIn(dialog(), 'data-manual-name'), 'Anker PowerCore 20000 Pro');
    await wait(350);
    await flushPromises();
    expect(text(brandTrigger())).toBe('Samsung');
    await click(byTestId('manual-save'));
    const brands = (await services.brandsApi.listBrands()).items;
    expect(create.mock.calls[0]?.[0].brandId).toBe(brands.find((b) => b.name === 'Samsung')?.id);
  });

  it('explains that the list changed meanwhile, reloads it and saves on the new base', async () => {
    const { services } = await mountPrices('manager');
    await openMenuItem('add-manual-product');
    await type(fieldIn(dialog(), 'data-manual-name'), 'Demo');
    await type(fieldIn(dialog(), 'data-price-input'), '5');
    // A colleague publishes v15 while the dialog is open.
    const other = (await services.pricingApi.getCurrent()).items[0];
    if (!other) throw new Error('no items');
    await services.pricingApi.publishChanges({
      baseVersionNumber: 14,
      upserts: [{ productId: other.productId, basePrice: '9500', deferredPrice: null, rrp: null }],
      removedProductIds: [],
    });
    await click(byTestId('manual-save'));
    expect(dialog()).not.toBeNull();
    expect(text(dialog()?.querySelector('.notice--error'))).toContain('boshqa xodim tomonidan');
    expect(subtitle()).toContain("Narx ro'yxati v15");
    await click(byTestId('manual-save'));
    expect(dialog()).toBeNull();
    expect(subtitle()).toContain("Narx ro'yxati v16");
  });
});

describe("Narxlar: 'Excel orqali yuklash'", () => {
  it('downloads the empty or the filled template, the latter named with the manual count', async () => {
    const { services } = await mountPrices('manager', (s) => addManualProduct(s, 'Demo', '5'));
    const download = vi.spyOn(services.pricingApi, 'downloadImportTemplate');
    await openMenuItem('import-prices');
    expect(spaced(byTestId('import-template-filled'))).toBe(
      "To'ldirilgan shablon 1 ta qo'lda qo'shilgan tovar bilan",
    );
    await click(byTestId('import-template-empty'));
    expect(download).toHaveBeenLastCalledWith('empty');
    await click(byTestId('import-template-filled'));
    expect(download).toHaveBeenLastCalledWith('filled');
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(2);
    // The template's columns are listed under the two cards.
    expect(spaced(dialog()?.querySelector('.cols'))).toBe(
      'Товар_ID Nomi * Brend Kategoriya Цена $ Отсрочка $ RRP $ Оптовик/Партнер $ Оптовик/Партнер Отсрочка $ Alif $ Alif Отсрочка $',
    );
  });

  it('refuses a wrong file before the upload, checks a good one (errors first) and publishes only the importable rows', async () => {
    const { services } = await mountPrices('manager');
    const previewSpy = vi.spyOn(services.pricingApi, 'importPreview');
    const confirm = vi.spyOn(services.pricingApi, 'importConfirm');
    await openMenuItem('import-prices');
    expect(byTestId<HTMLButtonElement>('import-check').disabled).toBe(true);

    await chooseFile('narxlar.csv');
    expect(text(dialog()?.querySelector('[role="alert"]'))).toContain('.xlsx');
    expect(body().querySelector('[data-testid="import-file-row"]')).toBeNull();

    await chooseFile('qolda-tovarlar.xlsx');
    expect(text(byTestId('import-file-row'))).toContain('qolda-tovarlar.xlsx');
    expect(previewSpy).not.toHaveBeenCalled();
    await click(byTestId('import-check'));
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(byTestId('import-step-preview')).toBeTruthy();
    expect(text(dialog())).toContain('qolda-tovarlar.xlsx · 6 qator · hali saqlanmagan');

    const cards = Array.from(body().querySelectorAll('[data-summary]')).map(spaced);
    expect(cards).toEqual([
      'Yangi tovar 2',
      'Narxi yangilanadi 1',
      "O'zgarishsiz 1",
      'Xato qator 2',
    ]);
    // The rows the import will skip come first, then the file's order.
    const statuses = Array.from(body().querySelectorAll('[data-row-status]')).map((r) =>
      r.getAttribute('data-row-status'),
    );
    expect(statuses).toEqual(['ERROR', 'ERROR', 'PRICE_CHANGED', 'UNCHANGED', 'NEW', 'NEW']);
    const errorRows = Array.from(body().querySelectorAll('.row--error')).map(text);
    expect(errorRows[0]).toContain("Bunday Товар_ID yo'q");
    expect(errorRows[1]).toContain("Цена bo'sh: narx majburiy");
    // A price change shows the old price struck through before the new one.
    const changed = body().querySelector('[data-row-status="PRICE_CHANGED"]');
    expect(changed?.querySelector('s')).not.toBeNull();
    // The two columns of the owner's request [C, 2026-11-09]: the category and the RRP.
    const headers = Array.from(body().querySelectorAll('table.rows thead th')).map(text);
    expect(headers).toEqual([
      'Qator',
      'Natija',
      'Tovar',
      'Kategoriya',
      'Цена',
      'Отсрочка',
      'RRP',
      'Ulgurji Цена',
      'Ulgurji Отсрочка',
    ]);
    // The file has the «Оптовик/Партнер» columns: a changed wholesale price shows "was -> becomes".
    expect(changed?.querySelector('[data-row-wholesale] s.was')).not.toBeNull();
    const cell = (row: Element | null | undefined, name: string): string =>
      text(row?.querySelector(`[data-row-${name}]`));
    // A new product shows the category it will get and its RRP.
    const powerbank = body().querySelector('[data-row-status="NEW"]');
    expect([cell(powerbank, 'category'), cell(powerbank, 'rrp')]).toEqual([
      'Powerbanklar',
      '$24,90',
    ]);
    // An existing product keeps its category (none is shown); it had no RRP, so nothing is struck.
    expect(cell(changed, 'category')).toBe('—');
    expect(cell(changed, 'rrp')).toMatch(/^\$\d/);
    expect(changed?.querySelector('[data-row-rrp] s')).toBeNull();
    expect(cell(body().querySelector('[data-row-status="UNCHANGED"]'), 'rrp')).toBe('—');
    // A new row says where its id and brand come from; a same-name row is flagged in red.
    const fresh = Array.from(body().querySelectorAll('[data-row-status="NEW"]'));
    expect(text(fresh[0])).toContain('Yangi ID: tizim beradi · brend Anker');
    expect(fresh[1]?.querySelector('.row__note--warn')?.textContent).toBe('Shu nomli tovar bor');
    expect(text(byTestId('import-errors'))).toContain("2 ta xato qator o'tkazib yuboriladi");
    expect(text(dialog())).toContain("4 qator bitta versiya (v15) bo'lib nashr qilinadi");

    await click(byTestId('import-confirm'));
    expect(confirm).toHaveBeenCalledTimes(1);
    const sent = confirm.mock.calls[0]?.[0];
    expect(sent?.baseVersionNumber).toBe(14);
    expect(sent?.rows).toHaveLength(4);
    expect(sent?.rows.map((r) => r.productCode)).toEqual(['10482', '10483', null, null]);
    // The category and the RRP travel with the rows; a row without an RRP sends none.
    expect(sent?.rows.map((r) => [r.category, r.rrp])).toEqual([
      [null, expect.stringMatching(/^\d+\.\d{2}$/)],
      [null, null],
      ['Powerbanklar', '24.90'],
      [null, null],
    ]);
    expect(byTestId('import-step-done')).toBeTruthy();
    expect(text(dialog())).toContain('v15');
    await click(byTestId('import-close'));
    expect(dialog()).toBeNull();
    expect(subtitle()).toContain("Narx ro'yxati v15");
    expect(rowFor('IO-000001')).toBeTruthy();
  });

  it('downloads the error rows as a semicolon CSV with a byte order mark and the translated issue', async () => {
    await mountPrices('manager');
    await openMenuItem('import-prices');
    await chooseFile('narxlar.xlsx');
    await click(byTestId('import-check'));
    await click(byTestId('import-download-errors'));
    expect(vi.mocked(saveFile).mock.calls[0]?.[1]).toBe('xato-qatorlar.csv');
    const blob = vi.mocked(saveFile).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8');
    // The UTF-8 byte order mark Excel needs (Blob.text() would swallow it).
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect((await savedText()).split('\r\n')).toEqual([
      'Qator;Товар_ID;Nomi;Brend;Kategoriya;Цена $;Отсрочка $;RRP $;Xato',
      "6;99999;Demo quloqchin;;;12.00;;;Bunday Товар_ID yo'q: sheet tovari sinxronizatsiya orqali keladi",
      "7;;Demo adapter 65W;;;;;;Цена bo'sh: narx majburiy",
      '',
    ]);
  });

  it('shows seven rows of a long file and the rest on request', async () => {
    const { services } = await mountPrices('manager');
    const canned = await services.pricingApi.importPreview(new File(['x'], 'a.xlsx'));
    const template = canned.rows.find((r) => r.status === 'NEW') as PriceImportPreviewRow;
    const many: PriceImportPreviewRow[] = Array.from({ length: 9 }, (_, i) => ({
      ...template,
      rowNumber: i + 2,
      name: `Yangi ${i + 2}`,
      warnings: [],
    }));
    many.push({
      ...template,
      rowNumber: 11,
      name: 'Oxirgi',
      basePrice: null,
      status: 'ERROR',
      issues: ['PRICE_MISSING'],
      warnings: [],
    });
    const long: PriceImportPreviewResponse = {
      baseVersionNumber: 14,
      rows: many,
      summary: { newCount: 9, priceChangedCount: 0, unchangedCount: 0, errorCount: 1 },
    };
    vi.spyOn(services.pricingApi, 'importPreview').mockResolvedValueOnce(long);
    await openMenuItem('import-prices');
    await chooseFile('narxlar.xlsx');
    await click(byTestId('import-check'));
    const shown = () => Array.from(body().querySelectorAll('[data-row-status]'));
    expect(shown()).toHaveLength(7);
    // The error row (last in the file) heads the list.
    expect(text(shown()[0]?.querySelector('td'))).toBe('11');
    expect(text(dialog())).toContain("7 / 10 qator ko'rsatilgan · xatolar birinchi");
    await click(byTestId('import-show-all'));
    expect(shown()).toHaveLength(10);
  });

  it('marks the rows a confirm refused, first in the list, and keeps the check open', async () => {
    const { services } = await mountPrices('manager');
    vi.spyOn(services.pricingApi, 'importConfirm').mockRejectedValueOnce(
      new ApiValidationError('x', 'IMPORT_ROWS_INVALID', [], {
        rows: [{ index: 2, issues: ['UNKNOWN_BRAND'] }],
      }),
    );
    await openMenuItem('import-prices');
    await chooseFile('narxlar.xlsx');
    await click(byTestId('import-check'));
    await click(byTestId('import-confirm'));
    expect(byTestId('import-step-preview')).toBeTruthy();
    expect(text(dialog()?.querySelector('.notice--error'))).toContain('1 ta qator qabul qilinmadi');
    // The third importable row is the file's row 4 (the first NEW one); it now heads the errors.
    const refused = Array.from(body().querySelectorAll('.row--error')).map((r) =>
      text(r.querySelector('td')),
    );
    expect(refused).toEqual(['4', '6', '7']);
    expect(text(body().querySelectorAll('.row--error')[0])).toContain("«Anker» brendi yo'q");
  });

  it('asks to redo the check when the list changed meanwhile', async () => {
    const { services } = await mountPrices('manager');
    const previewSpy = vi.spyOn(services.pricingApi, 'importPreview');
    vi.spyOn(services.pricingApi, 'importConfirm').mockRejectedValueOnce(
      new ApiConflictError('x', 'CONFLICT', undefined, 'PRICE_LIST_CHANGED'),
    );
    await openMenuItem('import-prices');
    await chooseFile('narxlar.xlsx');
    await click(byTestId('import-check'));
    await click(byTestId('import-confirm'));
    expect(text(dialog()?.querySelector('.notice--error'))).toContain('qayta tekshiring');
    expect(body().querySelector('[data-testid="import-confirm"]')).toBeNull();
    await click(byTestId('import-recheck'));
    expect(previewSpy).toHaveBeenCalledTimes(2);
    expect(byTestId('import-confirm')).toBeTruthy();
  });

  it('shows the reason when the server refuses the whole file, back on the file step', async () => {
    const { services } = await mountPrices('manager');
    vi.spyOn(services.pricingApi, 'importPreview').mockRejectedValueOnce(
      new ApiValidationError('x', 'PRICE_IMPORT_FILE_INVALID', [], {
        reason: 'FILE_HEADERS_INVALID',
      }),
    );
    await openMenuItem('import-prices');
    await chooseFile('narxlar.xlsx');
    await click(byTestId('import-check'));
    expect(byTestId('import-step-file')).toBeTruthy();
    expect(text(dialog()?.querySelector('[role="alert"]'))).toContain('Ustun sarlavhalari');
  });
});

describe("Narxlar: 'Sheet tovari bilan birlashtirish'", () => {
  it('is offered only for a generated-code product, previews the merge and performs it', async () => {
    const { services } = await mountPrices('manager', (s) =>
      addManualProduct(s, "Tab A9 (qo'lda)", '150', 'Anker'),
    );
    const merge = vi.spyOn(services.pricingApi, 'mergeProduct');
    const preview = vi.spyOn(services.pricingApi, 'mergePreview');
    await openRow('10491');
    expect(body().querySelector('[data-testid="merge-product"]')).toBeNull();
    await click(
      Array.from(dialog()?.querySelectorAll('button') ?? []).find(
        (b) => text(b) === 'Bekor qilish',
      ) as HTMLElement,
    );

    await openRow('IO-000001');
    await click(byTestId('merge-product'));
    expect(text(dialog())).toContain('Sheet tovari bilan birlashtirish');
    expect(spaced(byTestId('merge-source'))).toContain(
      "Buyurtma orqali nofaol bo'ladi Tab A9 (qo'lda) IO-000001",
    );
    expect(byTestId<HTMLButtonElement>('merge-confirm').disabled).toBe(true);
    const candidates = () => allByTestId('merge-candidate');
    expect(candidates().length).toBeGreaterThan(0);
    // Only sheet products are offered: never the generated-code product itself.
    expect(candidates().some((c) => text(c).includes('IO-000001'))).toBe(false);

    const search = byTestId('merge-search').querySelector<HTMLInputElement>('input');
    await type(search as HTMLInputElement, '10494');
    await wait(300);
    await flushPromises();
    expect(candidates().map(text).join(' ')).toContain('10494');
    await click(candidates()[0] as HTMLElement);
    expect(preview).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    const target = spaced(byTestId('merge-target'));
    expect(target).toContain('Sheet qoladi Samsung Galaxy Tab A9 64GB 10494');
    expect(target).toContain('Mavjud 25 dona · tannarx $175,00');
    expect(target).toContain("Narx hali yo'q");
    expect(text(byTestId('merge-source'))).toContain('Narx $150,00');
    const effects = Array.from(byTestId('merge-effects').querySelectorAll('li')).map(text);
    expect(effects).toEqual([
      "Narxlar ($150,00) 10494 ga o'tadi",
      "Brend, nom o'tadi",
      'Qoldiq va tannarx endi sheetdan keladi',
      "Eski buyurtmalar o'zgarmaydi: ularda IO-000001 va o'sha narx qoladi",
    ]);
    expect(text(dialog())).toContain("Ortga qaytarib bo'lmaydi · v16 nashr qilinadi");

    await click(byTestId('merge-confirm'));
    const tablet = (await services.catalogApi.listProducts()).items.find(
      (p) => p.productCode === '10494',
    );
    expect(merge).toHaveBeenCalledWith(expect.any(String), {
      baseVersionNumber: 15,
      targetProductId: tablet?.id,
    });
    expect(dialog()).toBeNull();
    expect(toastText()).toBe('IO-000001 → 10494 ga birlashtirildi · v16');
    expect(rows().some((r) => r.textContent?.includes('IO-000001'))).toBe(false);
    expect(text(rowFor('10494').querySelectorAll('td')[3])).toBe('$150,00');
  });

  it("opens pre-filled from the 'Sheetda bor' badge of a row whose name the sheet knows", async () => {
    const { services } = await mountPrices('manager', (s) =>
      addManualProduct(s, 'samsung galaxy tab a9 64gb', '150'),
    );
    const preview = vi.spyOn(services.pricingApi, 'mergePreview');
    const badge = rowFor('IO-000001').querySelector<HTMLElement>(
      '[data-testid="sheet-match-badge"]',
    );
    expect(text(badge)).toBe('Sheetda bor');
    expect(badge?.getAttribute('title')).toContain('Samsung Galaxy Tab A9 64GB · 10494');
    // A row the sheet does not know has no such badge.
    expect(rowFor('10491').querySelector('[data-testid="sheet-match-badge"]')).toBeNull();

    await click(badge as HTMLElement);
    expect(text(dialog())).toContain('Sheet tovari bilan birlashtirish');
    expect(preview).toHaveBeenCalledTimes(1);
    expect(spaced(byTestId('merge-target'))).toContain('Samsung Galaxy Tab A9 64GB 10494');
    expect(byTestId<HTMLButtonElement>('merge-confirm').disabled).toBe(false);
    // The row behind stays closed: the badge did not open the price dialog.
    expect(body().querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('shows the reason the preview refuses and keeps the confirm off', async () => {
    const { services } = await mountPrices('manager', (s) => addManualProduct(s, 'Demo', '1'));
    vi.spyOn(services.pricingApi, 'mergePreview').mockRejectedValueOnce(
      new ApiConflictError('x', 'CONFLICT', undefined, 'TARGET_IS_GENERATED'),
    );
    await openRow('IO-000001');
    await click(byTestId('merge-product'));
    await click(allByTestId('merge-candidate')[0] as HTMLElement);
    expect(text(byTestId('merge-preview-error'))).toContain('sheet tovarini tanlang');
    expect(byTestId<HTMLButtonElement>('merge-confirm').disabled).toBe(true);
  });

  it('shows the refusal of a merge and stays open', async () => {
    const { services } = await mountPrices('manager', (s) => addManualProduct(s, 'Demo', '1'));
    vi.spyOn(services.pricingApi, 'mergeProduct').mockRejectedValueOnce(
      new ApiConflictError('x', 'CONFLICT', undefined, 'PRODUCT_ALREADY_MERGED'),
    );
    await openRow('IO-000001');
    await click(byTestId('merge-product'));
    await click(allByTestId('merge-candidate')[0] as HTMLElement);
    await click(byTestId('merge-confirm'));
    expect(dialog()).not.toBeNull();
    expect(text(dialog()?.querySelector('[role="alert"]'))).toContain('allaqachon birlashtirilgan');
  });
});
