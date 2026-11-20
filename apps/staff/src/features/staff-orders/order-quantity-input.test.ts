import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast } from '@core/composables/use-toast';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { detailByNumber, orderId } from '@/test-utils/orders';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { freeStockByItem, shortOf } from './domain/free-stock';

// Owner 2026-11-09: on the order page the manager could change a quantity only one click at a time.
// The quantity is now a field (with the same minus and plus), and the free stock is shown beside it.

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
  dismissToast();
  vi.restoreAllMocks();
});

const Shell = defineComponent({ render: () => h(RouterView) });
const PHONE = 'Samsung Galaxy A15 4/128GB';
const CHARGER = 'Samsung 25W zaryadlovchi';

async function openOrder(identity = 'manager', prepare?: (services: Services) => void) {
  await preloadRouteComponents();
  const { services } = createTestServices({ identityId: identity, clock: { now: () => TEST_NOW } });
  await services.currentUser.ensureLoaded();
  prepare?.(services);
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(`/staff/orders/${orderId('IO-10491')}`);
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await services.ordersStore.load();
  await services.directoryStore.load();
  await waitFor(() => expect(text('.client__name')).toBe('Orion Mobile'));
  await flushPromises();
  return { services };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
const byLabel = <T extends HTMLElement = HTMLElement>(label: string): T =>
  document.body.querySelector(`[aria-label="${label}"]`) as T;
const field = (name: string): HTMLInputElement => byLabel<HTMLInputElement>(`${name}: miqdor`);
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => squash(b.textContent) === label);
const lineOf = (name: string): HTMLElement => field(name).closest('.line') as HTMLElement;
const stockOf = (name: string): HTMLElement | null =>
  lineOf(name).querySelector('[data-testid="item-stock"]');

async function type(name: string, value: string, end: 'blur' | 'enter' | 'none' = 'blur') {
  const input = field(name);
  input.focus();
  await flushPromises();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
  if (end === 'blur') input.blur();
  if (end === 'enter') {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await flushPromises();
}
// The first quantity change on an order asks once (the customer will be notified).
async function confirmItemEdit(): Promise<void> {
  await waitFor(() => expect(text('.modal__title')).toBe("Buyurtma miqdorini o'zgartirasizmi?"));
  buttonByText("Ha, o'zgartirish")?.click();
  await waitFor(() => expect(document.body.querySelector('.modal__title')).toBeNull());
}

describe('order page: typing a quantity', () => {
  it('shows each quantity in a field with its unit; other roles and later stages get plain text', async () => {
    await openOrder();
    expect(field(PHONE).tagName).toBe('INPUT');
    expect(field(PHONE).value).toBe('10');
    expect(field(PHONE).getAttribute('inputmode')).toBe('numeric');
    expect(squash(lineOf(PHONE).querySelector('.stepper__unit')?.textContent)).toBe('dona');
    expect(text('.items__note')).toBe("Miqdorni yozing yoki −, + bilan o'zgartiring");

    document.body.innerHTML = '';
    await openOrder('accountant');
    expect(document.body.querySelector('.stepper__input')).toBeNull();
    expect(text('.line__qty')).toBe('10 dona');
  });

  it('stages a typed quantity when the field is left, and the totals follow', async () => {
    const { services } = await openOrder();
    await type(PHONE, '200');
    await confirmItemEdit();
    expect(field(PHONE).value).toBe('200');
    expect(text('.draft')).toContain(`${PHONE}: 10 → 200 dona`);
    expect(text('.items__sub')).toBe('4 pozitsiya · 320 dona');
    // nothing is sent until the save
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe('10');
  });

  it('Enter stages it too, and the saved order holds the typed quantity', async () => {
    const { services } = await openOrder();
    await type(PHONE, '25', 'enter');
    await confirmItemEdit();
    expect(text('.draft')).toContain(`${PHONE}: 10 → 25 dona`);
    buttonByText('Saqlash')?.click();
    await waitFor(() => expect(document.body.querySelector('.draft')).toBeNull());
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe('25');
    expect(field(PHONE).value).toBe('25');
  });

  it('reads a pasted "1 000" as one thousand and shows large numbers grouped when not editing', async () => {
    await openOrder();
    await type(PHONE, '1 000');
    await confirmItemEdit();
    expect(text('.draft')).toContain(`${PHONE}: 10 → 1 000 dona`);
    expect(squash(field(PHONE).value)).toBe('1 000');
    // editing starts from plain digits, selected
    field(PHONE).focus();
    await flushPromises();
    expect(field(PHONE).value).toBe('1000');
  });

  it.each(['abc', '2.5', '2,5', '-3', '1000000'])(
    'marks %j as not a quantity while typing and changes nothing when the field is left',
    async (typed) => {
      await openOrder();
      await type(PHONE, typed, 'none');
      expect(field(PHONE).getAttribute('aria-invalid')).toBe('true');
      const error = lineOf(PHONE).querySelector('[role="alert"]');
      expect(squash(error?.textContent)).toBe('Butun son kiriting, 1 dan 999 999 gacha');
      expect(field(PHONE).getAttribute('aria-describedby')).toContain(error?.id);

      field(PHONE).blur();
      await flushPromises();
      expect(field(PHONE).value).toBe('10');
      expect(field(PHONE).getAttribute('aria-invalid')).toBeNull();
      expect(document.body.querySelector('.modal__title')).toBeNull();
      expect(document.body.querySelector('.draft')).toBeNull();
    },
  );

  it('an emptied field is not an error and keeps the quantity', async () => {
    await openOrder();
    await type(PHONE, '', 'none');
    expect(field(PHONE).getAttribute('aria-invalid')).toBeNull();
    field(PHONE).blur();
    await flushPromises();
    expect(field(PHONE).value).toBe('10');
    expect(document.body.querySelector('.draft')).toBeNull();
  });

  it('typing the saved quantity again is no change (no question, no draft)', async () => {
    await openOrder();
    await type(PHONE, '10');
    expect(document.body.querySelector('.modal__title')).toBeNull();
    expect(document.body.querySelector('.draft')).toBeNull();
  });

  it('declining the first-edit question leaves the old quantity in the field', async () => {
    await openOrder();
    await type(PHONE, '77');
    await waitFor(() => expect(text('.modal__title')).toBe("Buyurtma miqdorini o'zgartirasizmi?"));
    buttonByText('Ortga')?.click();
    await waitFor(() => expect(document.body.querySelector('.modal__title')).toBeNull());
    expect(field(PHONE).value).toBe('10');
    expect(document.body.querySelector('.draft')).toBeNull();
  });

  it('a typed zero removes the line, and the removed line can be put back', async () => {
    await openOrder();
    await type(CHARGER, '0');
    await confirmItemEdit();
    expect(lineOf(CHARGER).classList.contains('line--removed')).toBe(true);
    expect(text('.draft')).toContain('olib tashlandi');
    expect(byLabel(`${CHARGER}: olib tashlash`)).toBeNull();

    byLabel(`${CHARGER}: qaytarish`).click();
    await flushPromises();
    expect(lineOf(CHARGER).classList.contains('line--removed')).toBe(false);
    expect(document.body.querySelector('.draft')).toBeNull();
    expect(byLabel(`${CHARGER}: olib tashlash`)).not.toBeNull();
  });

  it('plus on a removed line brings it back with one piece; a number typed into it restores it', async () => {
    await openOrder();
    byLabel(`${CHARGER}: olib tashlash`).click();
    await confirmItemEdit();
    byLabel(`${CHARGER}: oshirish`).click();
    await flushPromises();
    expect(field(CHARGER).value).toBe('1');

    byLabel(`${CHARGER}: olib tashlash`).click();
    await flushPromises();
    await type(CHARGER, '7');
    expect(field(CHARGER).value).toBe('7');
    expect(lineOf(CHARGER).classList.contains('line--removed')).toBe(false);
  });

  it('minus and plus count from the number typed in the focused field, as ONE change', async () => {
    await openOrder();
    await type(PHONE, '50', 'none');
    byLabel(`${PHONE}: oshirish`).click();
    await confirmItemEdit();
    expect(text('.draft')).toContain(`${PHONE}: 10 → 51 dona`);
    expect(squash(field(PHONE).value)).toBe('51');
  });

  it('the arrow keys step the quantity', async () => {
    await openOrder();
    field(PHONE).focus();
    await flushPromises();
    field(PHONE).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await confirmItemEdit();
    field(PHONE).focus();
    await flushPromises();
    field(PHONE).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    field(PHONE).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    field(PHONE).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await flushPromises();
    expect(text('.draft')).toContain(`${PHONE}: 10 → 12 dona`);
  });

  it('plus stops at the largest quantity an order line may hold', async () => {
    await openOrder();
    await type(PHONE, '999999');
    await confirmItemEdit();
    byLabel(`${PHONE}: oshirish`).click();
    await flushPromises();
    expect(text('.draft')).toContain(`${PHONE}: 10 → 999 999 dona`);
  });

  it('Escape drops what was typed', async () => {
    await openOrder();
    await type(PHONE, '300', 'none');
    field(PHONE).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(field(PHONE).value).toBe('10');
    expect(document.body.querySelector('.modal__title')).toBeNull();
    expect(document.body.querySelector('.draft')).toBeNull();
  });
});

describe('order page: free stock beside the quantity', () => {
  async function freeOf(services: Services, name: string): Promise<string> {
    const preview = await services.ordersApi.getAllocationPreview(orderId('IO-10491'));
    const item = preview.items.find((i) => i.name === name);
    const free = item && freeStockByItem(preview).get(item.orderItemId);
    if (free === undefined) throw new Error(`no free stock for ${name}`);
    return free;
  }

  it('shows what the stock can still give, and warns when the quantity is more', async () => {
    const { services } = await openOrder();
    const free = Number(await freeOf(services, PHONE));
    expect(free).toBeGreaterThanOrEqual(10);
    expect(squash(stockOf(PHONE)?.textContent)).toBe(`Mavjud: ${free} dona`);
    expect(stockOf(PHONE)?.classList.contains('qty__stock--short')).toBe(false);
    expect(field(PHONE).getAttribute('aria-describedby')).toBe(stockOf(PHONE)?.id);

    // the warning follows the typing, before anything is staged
    await type(PHONE, String(free + 5), 'none');
    expect(squash(stockOf(PHONE)?.textContent)).toBe(`Mavjud ${free} dona, 5 dona yetmaydi`);
    expect(stockOf(PHONE)?.classList.contains('qty__stock--short')).toBe(true);

    // more than the stock is only a warning: it is staged and can be saved
    field(PHONE).blur();
    await flushPromises();
    await confirmItemEdit();
    expect(text('.draft')).toContain(`${PHONE}: 10 → ${free + 5} dona`);
    expect(stockOf(PHONE)?.classList.contains('qty__stock--short')).toBe(true);
    buttonByText('Saqlash')?.click();
    await waitFor(() => expect(document.body.querySelector('.draft')).toBeNull());
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe(String(free + 5));
  });

  it('a removed line shows no stock line', async () => {
    await openOrder();
    byLabel(`${CHARGER}: olib tashlash`).click();
    await confirmItemEdit();
    expect(stockOf(CHARGER)).toBeNull();
  });

  it('the editor works without the figures when they cannot be read', async () => {
    await openOrder('manager', (services) => {
      vi.spyOn(services.ordersApi, 'getAllocationPreview').mockRejectedValue(new Error('offline'));
    });
    expect(document.body.querySelector('[data-testid="item-stock"]')).toBeNull();
    await type(PHONE, '15');
    await confirmItemEdit();
    expect(text('.draft')).toContain(`${PHONE}: 10 → 15 dona`);
  });

  it('roles that cannot edit do not ask for the figures', async () => {
    const calls: string[] = [];
    await openOrder('accountant', (services) => {
      vi.spyOn(services.ordersApi, 'getAllocationPreview').mockImplementation((id) => {
        calls.push(id);
        return Promise.reject(new Error('not expected'));
      });
    });
    expect(calls).toEqual([]);
  });
});

describe('free stock per order line', () => {
  const line = (free: string) => ({
    supplyLineId: '00000000-0000-4000-8000-000000000001',
    deliveryRef: 'Z-1',
    deliveredAt: '2026-10-16T00:00:00.000Z',
    availableQuantity: '100.000',
    heldQuantity: '0.000',
    freeQuantity: free,
  });
  const item = (id: string, stockTracked: boolean, lines: ReturnType<typeof line>[]) => ({
    orderItemId: id,
    productId: id,
    productCode: '1',
    name: 'x',
    quantity: '1',
    stockTracked,
    lines,
    fifo: [],
    shortQuantity: '0.000',
    earlierDemand: { orders: 0, quantity: '0.000' },
    current: [],
  });

  it('sums the free quantity over the delivery lines and skips untracked products', () => {
    const free = freeStockByItem({
      orderId: 'o',
      status: 'SUBMITTED',
      rowVersion: 1,
      feasible: true,
      attention: false,
      notAllocated: false,
      lastSheetChangeAt: null,
      items: [
        item('a', true, [line('12.000'), line('3.500')]),
        item('b', true, []),
        item('c', false, []),
      ],
    });
    expect([...free]).toEqual([
      ['a', '15.5'],
      ['b', '0'],
    ]);
  });

  it('says how much is missing, or nothing when the stock covers the quantity', () => {
    expect(shortOf('20', '15')).toBe('5');
    expect(shortOf('15', '15.000')).toBeNull();
    expect(shortOf('1', '0')).toBe('1');
    expect(shortOf('3', '100')).toBeNull();
  });
});
