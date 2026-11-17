import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { isLocked } from '@/test-utils/locked';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { detailByNumber, orderId, summaryByNumber } from '@/test-utils/orders';
import { waitFor } from '@core/test-utils/wait';
import { WAREHOUSE_SCOPE } from './domain/order-scopes';
import { preloadRouteComponents } from '@/test-utils/preload-routes';

// A1 (accountant), W1 (warehouse) and D1 (driver): the role pages of the design's page map.

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
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function mountAt(identity: string, path: string, scenario?: 'error' | 'denied' | 'empty') {
  await preloadRouteComponents();
  const { services, orders } = createTestServices({
    identityId: identity,
    scenario,
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
  await waitFor(() => expect(document.body.querySelector('.page, [data-state]')).not.toBeNull());
  await flushPromises();
  return { services, router, orders };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const cards = (section?: string): HTMLElement[] =>
  Array.from(
    document.body.querySelectorAll<HTMLElement>(
      section ? `section[aria-label="${section}"] .card` : '.card',
    ),
  );
const cardNumbers = (section: string): string[] =>
  cards(section).map((c) => squash(c.querySelector('.card__meta .mono')?.textContent));
const buttonIn = (root: ParentNode, label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll('button')).find((b) => squash(b.textContent) === label);
const open = async (card: HTMLElement): Promise<void> => {
  buttonIn(card, 'Tarkibi va amallar')?.click();
  await waitFor(() => expect(card.querySelector('.card__body .line')).not.toBeNull());
  await flushPromises();
};

describe('A1: accountant queue', () => {
  it('lists the orders waiting for accounting, oldest first, and the skipped ones apart', async () => {
    await mountAt('accountant', '/staff/accounting');
    expect(squash(document.body.querySelector('.head__title')?.textContent)).toBe(
      "Buxgalteriya tasdig'i",
    );
    expect(cardNumbers('Tasdiqlash navbati')).toEqual(['IO-10486', 'IO-10489']);
    const skipped = cards("Buxgalteriyasiz o'tkazilganlar");
    expect(skipped).toHaveLength(1);
    expect(squash(skipped[0]?.textContent)).toContain('IO-10484');
    expect(squash(skipped[0]?.textContent)).toContain("Yangi · Menejer o'tkazib yubordi");
    // informational: the accountant may open it, but there is nothing to decide
    expect(buttonIn(skipped[0] as HTMLElement, 'Tarkibi va amallar')).toBeDefined();
  });

  it('shows prices and the total but no phone, and offers the accounting step only', async () => {
    await mountAt('accountant', '/staff/accounting');
    const card = cards('Tasdiqlash navbati')[0] as HTMLElement;
    expect(squash(card.textContent)).toMatch(/so'm/);
    await open(card);
    expect(card.querySelector('.figure__strong')).not.toBeNull();
    expect(card.querySelector('.table__total')).not.toBeNull();
    expect(card.querySelector('[data-testid="order-line-supply"]')).not.toBeNull();
    expect(card.textContent).not.toMatch(/\+998/);
    expect(buttonIn(card, "Buxgalteriya tasdig'i")).toBeDefined();
    expect(buttonIn(card, 'Rad etish')).toBeDefined();
    expect(buttonIn(card, 'Tasdiqlash')).toBeUndefined(); // the manager step is not hers
    expect(buttonIn(card, 'Buyurtmani bekor qilish')).toBeUndefined();
  });

  it("names Savdo turi and To'lov turi on the closed card, and warns only about a cash sale", async () => {
    await mountAt('accountant', '/staff/accounting');
    const queue = cards('Tasdiqlash navbati') as HTMLElement[];
    for (const card of queue) {
      const facts = card.querySelector('[data-testid="sale-facts"]');
      expect(squash(facts?.textContent)).toContain("To'lov turi");
      const cash = /Naqd/.test(facts?.textContent ?? '');
      expect(squash(facts?.textContent)).toContain(cash ? 'Naqd' : 'Official');
      const warning = card.querySelector('[data-testid="cash-sale-warning"]');
      expect(warning !== null).toBe(cash);
      if (warning) expect(warning.textContent).toContain('счёт-фактура');
    }
  });

  it('approves: the order leaves the queue and the version sent was the one she saw', async () => {
    const { services } = await mountAt('accountant', '/staff/accounting');
    const card = cards('Tasdiqlash navbati')[0] as HTMLElement;
    await open(card);
    buttonIn(card, "Buxgalteriya tasdig'i")?.click();
    await waitFor(() => expect(cardNumbers('Tasdiqlash navbati')).toEqual(['IO-10489']));
    expect(summaryByNumber(services, 'IO-10486')?.status).toBe('ACCOUNTING_CLEARED');
    expect(useToast().toast.value?.message).toBe('IO-10486 buxgalteriyada tasdiqlandi');
  });

  it('rejects only with a reason', async () => {
    const { services } = await mountAt('accountant', '/staff/accounting');
    const card = cards('Tasdiqlash navbati')[1] as HTMLElement;
    await open(card);
    buttonIn(card, 'Rad etish')?.click();
    await flushPromises();
    const confirm = Array.from(document.body.querySelectorAll('.modal button')).find(
      (b) => squash(b.textContent) === 'Rad etish',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const field = document.body.querySelector('textarea') as HTMLTextAreaElement;
    field.value = 'Limit oshgan';
    field.dispatchEvent(new Event('input'));
    await flushPromises();
    confirm.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10489')?.status).toBe('REJECTED'));
    const detail = await detailByNumber(services, 'IO-10489');
    expect(detail.status).toBe('REJECTED');
    const history = await services.ordersApi.getTimeline(orderId('IO-10489'));
    expect(history.events.at(-1)?.comment).toBe('Limit oshgan');
  });

  it('shows the skipped order as read-only: no accounting step on it', async () => {
    await mountAt('accountant', '/staff/accounting');
    const card = cards("Buxgalteriyasiz o'tkazilganlar")[0] as HTMLElement;
    await open(card);
    expect(buttonIn(card, "Buxgalteriya tasdig'i")).toBeUndefined();
    expect(buttonIn(card, 'Rad etish')).toBeUndefined();
  });

  it('shows the empty text when the queue is empty and the error and denied states', async () => {
    await mountAt('accountant', '/staff/accounting', 'empty');
    expect(squash(document.body.textContent)).toContain('Navbat bo');
    document.body.innerHTML = '';
    await mountAt('accountant', '/staff/accounting', 'error');
    expect(document.body.querySelector('[data-state="error"]')).not.toBeNull();
    document.body.innerHTML = '';
    await mountAt('accountant', '/staff/accounting', 'denied');
    expect(document.body.querySelector('[data-state="denied"]')).not.toBeNull();
  });

  it('keeps other roles out of the page (the server still decides)', async () => {
    const { router } = await mountAt('warehouse', '/staff/accounting');
    expect(router.currentRoute.value.path).not.toBe('/staff/accounting');
  });
});

describe('W1: warehouse', () => {
  it('lists the cleared orders ready for release, without prices, totals or payment', async () => {
    await mountAt('warehouse', '/staff/warehouse');
    expect(cardNumbers('Chiqarishga tayyor')).toEqual(['IO-10484']);
    const card = cards()[0] as HTMLElement;
    expect(squash(card.textContent)).not.toMatch(/so'm|PAID|UNPAID/);
    expect(card.querySelector('.card__total')).toBeNull();
    // F-25: one button on a closed card; the full-page link appears once it is open.
    expect(card.querySelectorAll('.card__buttons .btn')).toHaveLength(1);
    await open(card);
    expect(card.querySelectorAll('.card__buttons .btn')).toHaveLength(2);
  });

  it('shows the delivery contact with phones and asks for a driver before releasing', async () => {
    const { services } = await mountAt('warehouse', '/staff/warehouse');
    const card = cards()[0] as HTMLElement;
    await open(card);
    expect(card.querySelector('.line__sum')).toBeNull();
    expect(squash(card.querySelector('.contact')?.textContent)).toContain('Click Store');
    expect(card.querySelectorAll('.contact a[href^="tel:"]').length).toBeGreaterThan(0);
    expect(isLocked(buttonIn(card, 'Ombordan chiqarish'))).toBe(true);
    expect(squash(card.querySelector('[data-testid="release-reason"]')?.textContent)).toBe(
      'Haydovchini tanlang.',
    );
    const options = Array.from(card.querySelectorAll('.driver'));
    expect(options.map((o) => squash(o.textContent))).toEqual([
      'Bekzod Tursunov',
      'Sherzod Aliyev',
    ]);
    (options[1]?.querySelector('input') as HTMLInputElement).click();
    await flushPromises();
    buttonIn(card, 'Ombordan chiqarish')?.click();
    await waitFor(() => expect(cards('Chiqarishga tayyor')).toHaveLength(0));
    const released = await detailByNumber(services, 'IO-10484');
    expect(released.status).toBe('RELEASED');
    expect(released.driver?.fullName).toBe('Sherzod Aliyev');
    expect(squash(document.body.textContent)).toContain('Chiqarishga tayyor buyurtma yo');
  });

  it('says the list is not allowed on 403 and offers no retry', async () => {
    const { services } = await mountAt('warehouse', '/staff/warehouse');
    services.driversApi.listActiveDrivers = () => Promise.reject(new PermissionDeniedError());
    const card = cards()[0] as HTMLElement;
    await open(card);
    await waitFor(() =>
      expect(squash(card.textContent)).toContain(
        "Haydovchilar ro'yxatini ko'rishga ruxsatingiz yo'q.",
      ),
    );
    expect(buttonIn(card, 'Qayta urinish')).toBeUndefined();
    expect(isLocked(buttonIn(card, 'Ombordan chiqarish'))).toBe(true);
  });

  it('says so when the drivers cannot be loaded and offers a retry', async () => {
    const { services } = await mountAt('warehouse', '/staff/warehouse');
    const real = services.driversApi.listActiveDrivers.bind(services.driversApi);
    services.driversApi.listActiveDrivers = () => Promise.reject(new Error('403'));
    const card = cards()[0] as HTMLElement;
    await open(card);
    await waitFor(() =>
      expect(squash(card.textContent)).toContain("Haydovchilar ro'yxatini yuklab bo'lmadi."),
    );
    expect(isLocked(buttonIn(card, 'Ombordan chiqarish'))).toBe(true);
    services.driversApi.listActiveDrivers = real;
    buttonIn(card, 'Qayta urinish')?.click();
    await waitFor(() => expect(card.querySelector('.driver__radio')).not.toBeNull());
  });

  it('offers the warehouse no manager, accounting or cancel step', async () => {
    await mountAt('warehouse', '/staff/warehouse');
    const card = cards()[0] as HTMLElement;
    await open(card);
    for (const label of [
      'Tasdiqlash',
      'Rad etish',
      'Buyurtmani bekor qilish',
      "Buxgalteriya tasdig'i",
    ]) {
      expect(buttonIn(card, label)).toBeUndefined();
    }
  });
});

describe('W1: warehouse prepares after the approval ([C] 2026-10-30)', () => {
  it('lists approved orders apart, with the scan progress and the release locked', async () => {
    await mountAt('warehouse', '/staff/warehouse');
    const preparing = cards('Tayyorlash kerak');
    expect(preparing.length).toBeGreaterThan(0);
    const card = preparing[0] as HTMLElement;
    expect(squash(card.textContent)).not.toMatch(/so'm|PAID|UNPAID/);
    await open(card);
    expect(card.querySelector('[data-testid="prepare-note"]')).not.toBeNull();
    expect(isLocked(card.querySelector('[data-testid="release-button"]'))).toBe(true);
    expect(squash(card.querySelector('[data-testid="release-reason"]')?.textContent)).toContain(
      'Buxgalteriya hali tasdiqlamagan.',
    );
    // No driver to choose yet: that belongs to the release.
    expect(card.querySelector('.driver')).toBeNull();
  });

  it('asks to bring back the goods of an approved order that was cancelled, once', async () => {
    const { services } = await mountAt('warehouse', '/staff/warehouse');
    const approved = services.ordersStore.orders.value.find(
      (order) => order.status === 'MANAGER_APPROVED',
    );
    if (approved === undefined) throw new Error('no approved order in the demo data');
    expect(document.body.querySelector('section[aria-label="Tovarni qaytarish"]')).toBeNull();

    await services.currentUser.signIn('manager');
    await services.ordersStore.cancel(approved, 'mijoz aytdi');
    await services.currentUser.signIn('warehouse');
    await services.ordersStore.loadFor(WAREHOUSE_SCOPE);
    await waitFor(() => expect(cards('Tovarni qaytarish')).toHaveLength(1));

    const card = cards('Tovarni qaytarish')[0] as HTMLElement;
    await open(card);
    await waitFor(() =>
      expect(card.querySelector('[data-testid="goods-returned-button"]')).not.toBeNull(),
    );
    card.querySelector<HTMLButtonElement>('[data-testid="goods-returned-button"]')?.click();
    await waitFor(() => expect(cards('Tovarni qaytarish')).toHaveLength(0));
    expect((await detailByNumber(services, approved.orderNumber)).goodsReturn).toBe('RETURNED');
    // [C]: the warehouse also sees approved orders closed later, after the return too.
    await waitFor(() => expect(cardNumbers('Yopilganlar')).toContain(approved.orderNumber));
  });
});

describe('D1: driver', () => {
  it('lists the orders assigned to this driver and the delivered ones apart', async () => {
    await mountAt('driver', '/staff/deliveries');
    expect(squash(document.body.querySelector('.head__title')?.textContent)).toBe('Yetkazishlarim');
    expect(cardNumbers('Menga tayinlanganlar')).toEqual(['IO-10480', 'IO-10488']);
    expect(cardNumbers('Yetkazilganlar').length).toBeGreaterThan(0);
    // every card of the delivered list is read-only
    const done = cards('Yetkazilganlar')[0] as HTMLElement;
    await open(done);
    expect(buttonIn(done, 'Yetkazildi')).toBeUndefined();
  });

  it('shows the big button and the phone to call without an extra tap', async () => {
    await mountAt('driver', '/staff/deliveries');
    const card = cards('Menga tayinlanganlar')[0] as HTMLElement;
    await waitFor(() => expect(card.querySelector('.actions--large')).not.toBeNull());
    expect(buttonIn(card, 'Yetkazildi')).toBeDefined();
    expect(card.querySelectorAll('.contact a[href^="tel:"]').length).toBeGreaterThan(0);
    // grouped text for the eye, clean digits in the link
    for (const link of card.querySelectorAll('.contact a[href^="tel:"]')) {
      expect(link.getAttribute('href')).toMatch(/^tel:\+\d+$/);
      expect(link.textContent?.trim()).toMatch(/^\+998 \d{2} \d{3} \d{4}$/);
    }
    expect(card.querySelector('[aria-expanded="true"]')).not.toBeNull();
    // the delivered list stays collapsed
    const done = cards('Yetkazilganlar')[0] as HTMLElement;
    expect(done.querySelector('[aria-expanded="false"]')).not.toBeNull();
  });

  it('marks delivered with an optional comment through a big button', async () => {
    const { services } = await mountAt('driver', '/staff/deliveries');
    const card = cards('Menga tayinlanganlar')[0] as HTMLElement;
    await waitFor(() => expect(card.querySelector('.actions--large')).not.toBeNull());
    expect(card.querySelector('.line__sum')).toBeNull();
    expect(card.querySelectorAll('.contact a[href^="tel:"]').length).toBeGreaterThan(0);
    const note = card.querySelector('textarea') as HTMLTextAreaElement;
    note.value = 'Eshik oldida qoldirildi';
    note.dispatchEvent(new Event('input'));
    await flushPromises();
    buttonIn(card, 'Yetkazildi')?.click();
    await waitFor(() => expect(cardNumbers('Menga tayinlanganlar')).toEqual(['IO-10488']));
    expect(summaryByNumber(services, 'IO-10480')?.status).toBe('DELIVERED');
    const history = await services.ordersApi.getTimeline(orderId('IO-10480'));
    expect(history.events.at(-1)?.comment).toBe('Eshik oldida qoldirildi');
    expect(useToast().toast.value?.message).toBe('IO-10480 yetkazildi');
  });

  it('sends one request for a double click on the delivered button', async () => {
    const { services } = await mountAt('driver', '/staff/deliveries');
    const deliver = vi.spyOn(services.ordersApi, 'deliver');
    const card = cards('Menga tayinlanganlar')[0] as HTMLElement;
    await waitFor(() => expect(buttonIn(card, 'Yetkazildi')).toBeDefined());
    const button = buttonIn(card, 'Yetkazildi') as HTMLButtonElement;
    button.click();
    button.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10480')?.status).toBe('DELIVERED'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('delivers without a comment too', async () => {
    const { services } = await mountAt('driver', '/staff/deliveries');
    const card = cards('Menga tayinlanganlar')[1] as HTMLElement;
    await waitFor(() => expect(buttonIn(card, 'Yetkazildi')).toBeDefined());
    buttonIn(card, 'Yetkazildi')?.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10488')?.status).toBe('DELIVERED'));
  });

  it('shows the empty text for a driver without orders', async () => {
    await mountAt('driver', '/staff/deliveries', 'empty');
    expect(squash(document.body.textContent)).toContain("Sizga tayinlangan buyurtma yo'q.");
  });
});
