import { fifoPlanOf } from '@/features/staff-orders/api/fake-allocation';
import { config, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocked } from '@/test-utils/locked';
import { nextTick, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { orderId, summaryByNumber } from '@/test-utils/orders';
import { MANAGER_SCOPE } from '@/features/staff-orders/domain/order-scopes';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { effectScope } from 'vue';
import DashboardPage from './components/DashboardPage.vue';
import { useCountUp } from './composables/use-count-up';
import { bucketLabel, buildSalesChart } from './domain/sales-chart';
import { dateLineParts, firstName, greetingPeriod } from './domain/greeting';

const wrappers: VueWrapper[] = [];
const mockMotion = (reduce: boolean): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: reduce }) as MediaQueryList,
  });
};
beforeEach(() => mockMotion(true));
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

async function mountHome(
  options: {
    identity?: string;
    scenario?: 'empty' | 'error' | 'denied';
    skipLoad?: boolean;
    now?: Date;
  } = {},
) {
  await preloadRouteComponents();
  const clock = { now: () => options.now ?? TEST_NOW };
  const { services, back, orders } = createTestServices({
    identityId: options.identity ?? 'manager',
    scenario: options.scenario,
    clock,
  });
  await services.currentUser.ensureLoaded();
  await services.priceVersionStore.refresh();
  await services.activityStore.refresh();
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push('/staff/dashboard');
  const wrapper = mount(DashboardPage, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  // What the shell reads for a manager: the queue, the debt counts and the summary.
  if (!options.skipLoad) {
    await services.ordersStore.loadBase(MANAGER_SCOPE);
    await services.orderDebtStore.refresh();
    await services.dashboardSummaryStore.refresh();
  }
  await flushPromises();
  return { wrapper, services, router, back, orders };
}

const text = (selector: string): string =>
  document.body.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const WHITESPACE = /\s+/g;
const sq = (s: string): string => s.replace(WHITESPACE, '');
const dialogButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('.modal button')).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
/** The approval needs a payment method: nothing is preselected. */
const chooseMethod = async (method: 'CASH' | 'OFFICIAL' = 'CASH'): Promise<void> => {
  (
    document.body.querySelector(
      `.modal [data-testid="payment-method-${method}"]`,
    ) as HTMLInputElement
  ).click();
  await flushPromises();
};
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

describe('home page (v1 "Bosh sahifa")', () => {
  it('shows the greeting, the date line and the price list pill', async () => {
    await mountHome();
    expect(text('.head__title')).toBe('Xayrli tong, Aziza');
    expect(text('.head__date')).toBe('Dushanba, 19-oktyabr · Menejer');
    // The summary hands its unpriced count to the store, so the pill has it from the first load.
    expect(text('.pill > span:not(.pill__chip)')).toBe("Narx ro'yxati v14 · 19.10.2026, 08:30");
    expect(text('.pill__chip')).toBe('6 ta narxsiz');
    // The pill leads to the price list, like the design.
    expect(document.body.querySelector('.pill')?.getAttribute('href')).toBe('/staff/prices');
  });

  it('puts the summary in the v8 "Xulosa" card without repeating the today KPI', async () => {
    await mountHome();
    expect(text('.summary--card .summary__title')).toBe('Xulosa');
    expect(text('.summary--card .summary__time')).toBe(
      'Har 60 soniyada yangilanadi · Yangilangan: 09:30',
    );
    expect(document.body.querySelector('[data-testid="summary-AWAITING_MANAGER"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="summary-today"]')).toBeNull();
  });

  it('adds the number of products still without a price to the price list pill (managers only)', async () => {
    const { services } = await mountHome();
    expect(text('.pill')).toContain('6 ta narxsiz');
    services.unpricedCountStore.set(0);
    await flushPromises();
    expect(text('.pill')).not.toContain('narxsiz');
  });

  it('keeps the unpriced number off the pill for a role that does not set prices', async () => {
    const { services } = await mountHome({ identity: 'accountant' });
    await services.unpricedCountStore.refresh();
    await flushPromises();
    expect(text('.pill')).not.toContain('narxsiz');
  });

  it('shows the debt from the server counts, a dash until they are read', async () => {
    const { services } = await mountHome({ skipLoad: true });
    await services.ordersStore.loadBase(MANAGER_SCOPE);
    await flushPromises();
    expect(text('[data-testid="debt-sum"]')).toContain('–');
    await services.orderDebtStore.refresh();
    await flushPromises();
    // 20 720 000 so'm at the fake rate of 12 650, gross unpaid orders in USD.
    expect(text('[data-testid="debt-sum"]')).toContain('$1 637,94');
    expect(services.orderDebtStore.sumUzs.value).toBe('20720000.00');
  });

  it('shows the three KPI cards with the v8 numbers', async () => {
    await mountHome();
    const cards = Array.from(document.body.querySelectorAll('.kpi')).map((c) =>
      c.textContent?.replace(WHITESPACE, ''),
    );
    expect(cards[0]).toBe(sq('Tasdiq kutmoqda 3 Eng uzoq kutayotgani: 14 soat Navbatni ochish →'));
    expect(cards[1]).toBe(sq("Bugungi buyurtmalar 2 100 595 000 so'm · rad/bekorsiz Ko'rish →"));
    expect(cards[2]).toBe(
      sq(
        "Qabul qilingan, to'lanmagan buyurtmalar $1 637,94 ≈ 20 720 000 so'm · 1 ta buyurtma · 1 ta mijoz Ko'rish →",
      ),
    );
    expect(document.body.querySelector('.kpi--sand')).not.toBeNull();
  });

  it('lists the queue (oldest id first) with Ochish and, for a manager, Tasdiqlash', async () => {
    await mountHome();
    const rows = Array.from(document.body.querySelectorAll('.row')).slice(0, 3);
    expect(rows.map((r) => r.querySelector('.row__org')?.textContent)).toEqual([
      'Click Store',
      'Mobile Center Samarqand',
      'Orion Mobile',
    ]);
    expect(rows[2]?.querySelector('.row__id')?.textContent).toBe('IO-10491');
    expect(rows[2]?.querySelector('.row__when')?.textContent).toBe('19.10 · 09:12');
    expect(rows[2]?.querySelector('.row__meta')?.textContent?.replace(WHITESPACE, ' ').trim()).toBe(
      'Jasur Karimov · 4 pozitsiya',
    );
    expect(rows[2]?.textContent).toContain('23 570 000');
    // TEST_NOW is 09:30: the order has waited 18 minutes, under the two-hour highlight.
    expect(rows[2]?.querySelector('.row__age')?.textContent?.trim()).toBe('Kutmoqda 18 daqiqa');
    expect(rows[2]?.querySelector('.row__age--long')).toBeNull();
    expect(text('.card__sub')).toBe('3 ta · eng eskisi oldin');
    expect(rows[2]?.querySelectorAll('button')).toHaveLength(3);
    expect(buttonByText('Tasdiqlash')).toBeDefined();
  });

  it('gives an admin no approve button: approving is the manager step (docs over design)', async () => {
    await mountHome({ identity: 'admin' });
    expect(buttonByText('Tasdiqlash')).toBeUndefined();
    expect(buttonByText('Ochish')).toBeDefined();
    expect(buttonByText("To'langan deb belgilash")).toBeUndefined(); // admin may set payment status
  });

  it('Tasdiqlash opens a confirmation with number, customer, items and total; nothing is approved yet', async () => {
    const { services } = await mountHome();
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    expect(text('.modal__title')).toBe('Buyurtmani tasdiqlaysizmi?');
    expect(text('[data-testid="approve-summary"]')).toContain('IO-10487');
    const body = text('.modal__panel');
    expect(body).toContain('Click Store');
    expect(body).toContain('Buyurtma bergan:');
    expect(body).toMatch(/× \d+/);
    expect(body).toContain('dona');
    expect(body).toContain("so'm");
    expect(body).toContain("Buxgalteriya tasdig'isiz davom etish");
    expect((document.body.querySelector('.skip__box') as HTMLInputElement).checked).toBe(false);
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('SUBMITTED');
    // Bekor qilish closes it without approving
    dialogButton("Yo'q, ortga")?.click();
    await flushPromises();
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('SUBMITTED');
  });

  it('offers a call link to the person who placed the order inside the confirmation', async () => {
    await mountHome();
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    const link = document.body.querySelector('.who__call') as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe("Qo'ng'iroq qilish");
    expect(link.getAttribute('href')).toMatch(/^tel:\+?\d+$/);
  });

  it('approves from the confirmation: the order leaves the queue, the numbers and the feed update, no undo', async () => {
    const { services } = await mountHome();
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    await chooseMethod();
    dialogButton('Ha, tasdiqlash')?.click();
    await flushPromises();
    expect(useToast().toast.value?.message).toBe('IO-10487 tasdiqlandi');
    expect(useToast().toast.value?.onUndo).toBeUndefined();
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('MANAGER_APPROVED');
    expect(document.body.querySelectorAll('.row:not(.row--debt)')).toHaveLength(2);
    expect(text('.kpi--sand .kpi__big')).toBe('2');
    expect(text('.feed__list li')).toContain('IO-10487 · Menejer tasdiqladi');
  });

  it('can skip accounting from the confirmation (manager only) and the box starts unticked each time', async () => {
    const { services } = await mountHome();
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    (document.body.querySelector('.skip__box') as HTMLInputElement).click();
    await chooseMethod();
    dialogButton('Ha, tasdiqlash')?.click();
    await flushPromises();
    // Skipping accounting cannot be undone: like the order page, it needs a second, deliberate tap.
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('SUBMITTED');
    expect(document.body.querySelector('[data-testid="approve-skip-confirm"]')).not.toBeNull();
    dialogButton('Orqaga')?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="approve-skip-confirm"]')).toBeNull();
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('SUBMITTED');
    dialogButton('Ha, tasdiqlash')?.click();
    await flushPromises();
    dialogButton('Ha, buxgalteriyasiz tasdiqlash')?.click();
    await flushPromises();
    expect(summaryByNumber(services, 'IO-10487')).toMatchObject({
      status: 'ACCOUNTING_CLEARED',
      accounting: { mode: 'SKIPPED_BY_MANAGER' },
    });
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    expect((document.body.querySelector('.skip__box') as HTMLInputElement).checked).toBe(false);
  });

  it('asks for a payment method on every opening and sends the one chosen', async () => {
    const { services, orders } = await mountHome();
    const approve = vi.spyOn(orders.ordersApi, 'approve');
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    const confirm = dialogButton('Ha, tasdiqlash') as HTMLButtonElement;
    // nothing is preselected: the confirm stays locked until the manager picks one
    expect(
      Array.from(document.body.querySelectorAll<HTMLInputElement>('.modal [type="radio"]')).map(
        (r) => r.checked,
      ),
    ).toEqual([false, false]);
    expect(isLocked(confirm)).toBe(true);
    expect(text('.modal .method__hint')).toBe('Tasdiqlash uchun savdo turini tanlang');
    await chooseMethod('OFFICIAL');
    expect(isLocked(confirm)).toBe(false);
    dialogButton("Yo'q, ortga")?.click();
    await flushPromises();
    // a new opening starts empty again
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    expect(isLocked(dialogButton('Ha, tasdiqlash'))).toBe(true);
    await chooseMethod('OFFICIAL');
    dialogButton('Ha, tasdiqlash')?.click();
    await flushPromises();
    expect(approve).toHaveBeenCalledWith(
      orderId('IO-10487'),
      expect.objectContaining({ paymentMethod: 'OFFICIAL' }),
    );
    const approved = await orders.ordersApi.getOrder(orderId('IO-10487'));
    expect(approved.detail === 'FULL' && approved.paymentMethod).toBe('OFFICIAL');
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('MANAGER_APPROVED');
  });

  it('says why the confirm is locked when it is tapped, and sends nothing', async () => {
    const { orders } = await mountHome();
    const approve = vi.spyOn(orders.ordersApi, 'approve');
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    const confirm = dialogButton('Ha, tasdiqlash') as HTMLButtonElement;
    await waitFor(() =>
      expect(text('.modal [data-testid="approve-reason"]')).toBe(
        'Savdo turini tanlang: Naqd yoki Official.',
      ),
    );
    expect(isLocked(confirm)).toBe(true);
    confirm.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    confirm.click();
    await flushPromises();
    // A second, small dialog over the approval one names the reason.
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(
      Array.from(document.body.querySelectorAll('[data-testid="blocked-reasons"] li')).map((li) =>
        li.textContent?.trim(),
      ),
    ).toEqual(['Savdo turini tanlang: Naqd yoki Official.']);
    expect(approve).not.toHaveBeenCalled();
    (document.body.querySelector('[data-testid="blocked-ok"]') as HTMLElement).click();
    await waitFor(() => expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1));
    // The approval dialog is still there, with the order in it.
    expect(dialogButton('Ha, tasdiqlash')).toBeDefined();
  });

  it('ignores a second click on the confirm button while the approval is running', async () => {
    const { services, orders } = await mountHome();
    const original = orders.ordersApi.approve.bind(orders.ordersApi);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const approve = vi.fn(async (...args: Parameters<typeof original>) => {
      await gate;
      return original(...args);
    });
    orders.ordersApi.approve = approve;
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    await chooseMethod();
    const confirm = dialogButton('Ha, tasdiqlash') as HTMLButtonElement;
    confirm.click();
    await flushPromises();
    expect(isLocked(confirm)).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    confirm.click();
    await flushPromises();
    release();
    await flushPromises();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(summaryByNumber(services, 'IO-10487')?.status).toBe('MANAGER_APPROVED');
  });

  it('gives the queue buttons accessible names with the order number', async () => {
    await mountHome();
    const row = document.body.querySelector('.row') as HTMLElement;
    expect(
      Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')),
    ).toEqual([null, 'IO-10487: ochish', 'IO-10487: tasdiqlash']);
  });

  it('lists the debts without a manual "mark paid" action (PAID is derived by the server)', async () => {
    await mountHome();
    expect(text('.column .card__sub')).toBe('$1 637,94 · 1 ta buyurtma');
    expect(document.body.querySelectorAll('.row--debt')).toHaveLength(1);
    expect(buttonByText("To'langan deb belgilash")).toBeUndefined();
    expect(document.body.querySelector('.row--debt button:not(.row__main)')).toBeNull();
  });

  it('turns a server conflict into a toast and re-reads the queue', async () => {
    const { services, orders } = await mountHome();
    // someone else approved it a moment ago
    const current = await orders.ordersApi.getOrder(orderId('IO-10487'));
    await orders.ordersApi.approve(current.id, {
      ...(await fifoPlanOf(orders.ordersApi, current.id)),
      paymentMethod: 'CASH',
      expectedRowVersion: current.rowVersion,
    });
    buttonByText('Tasdiqlash')?.click();
    await flushPromises();
    await chooseMethod();
    dialogButton('Ha, tasdiqlash')?.click();
    await flushPromises();
    expect(useToast().toast.value?.message).toContain("Buyurtmani boshqa xodim o'zgartirgan");
    // The queue is read again: the order approved elsewhere is no longer in it.
    await waitFor(() => expect(summaryByNumber(services, 'IO-10487')).toBeUndefined());
    expect(services.ordersStore.pending.value.map((o) => o.orderNumber)).not.toContain('IO-10487');
  });

  it('shows the stage distribution and the recent actions', async () => {
    await mountHome();
    const rows = Array.from(document.body.querySelectorAll('.dist__row')).map((r) =>
      r.textContent?.replace(WHITESPACE, ''),
    );
    expect(rows).toEqual(
      [
        'Menejerda 3',
        'Buxgalteriyada 2',
        'Omborda 1',
        'Ombordan chiqdi 2',
        'Yetkazildi 2',
        'Yakunlandi 2',
        'Rad etilgan / bekor 0',
      ].map(sq),
    );
    expect(text('.dist__active')).toBe('10 faol');
    expect(
      Array.from(document.body.querySelectorAll('.feed__item')).map((r) =>
        r.textContent?.replace(WHITESPACE, ''),
      ),
    ).toEqual(
      [
        '09:20 IO-10489 · Menejer tasdiqladi',
        '09:12 IO-10491 · yangi buyurtma, Orion Mobile',
        '09:02 IO-10486 · Menejer tasdiqladi',
        '08:55 IO-10490 · yangi buyurtma, Mobile Center Samarqand',
        '08:40 IO-10488 · ombordan chiqdi, Bekzod Tursunov',
      ].map(sq),
    );
  });

  it('navigates from the KPI cards, the lists and the stage rows', async () => {
    const { router } = await mountHome();
    const go = async (el: Element | null | undefined) => {
      (el as HTMLElement).click();
      await waitFor(() =>
        expect(router.currentRoute.value.fullPath).not.toBe('/staff/dashboard'),
      ).catch(() => undefined);
      const { name, query } = router.currentRoute.value;
      await router.push('/staff/dashboard');
      return { name, query };
    };
    expect(await go(document.querySelector('.kpi--sand'))).toEqual({
      name: 'staff-orders',
      query: { stage: 'SUBMITTED' },
    });
    expect(await go(document.querySelectorAll('.kpi--link')[0])).toEqual({
      name: 'staff-orders',
      query: { period: 'today' },
    });
    expect(await go(document.querySelectorAll('.kpi--link')[1])).toEqual({
      name: 'staff-orders',
      query: { period: 'debt' },
    });
    expect(await go(document.querySelectorAll('.dist__row')[3])).toEqual({
      name: 'staff-orders',
      query: { stage: 'RELEASED' },
    });
    // The design's "Rad/bekor" bar opens the list's closed filter.
    expect(await go(document.querySelectorAll('.dist__row')[6])).toEqual({
      name: 'staff-orders',
      query: { stage: 'CLOSED' },
    });
    (document.querySelector('.row .row__buttons button') as HTMLElement).click();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-order'));
    expect(router.currentRoute.value.params.orderId).toBe(orderId('IO-10487'));
  });
});

describe('home page: sales statistics', () => {
  it('writes the average and the change with the decimal separator of the language (en: dot)', async () => {
    await mountHome();
    const i18n = config.global.plugins[0] as unknown as { global: { locale: { value: string } } };
    try {
      i18n.global.locale.value = 'en';
      await flushPromises();
      expect(text('.sales .badge')).toBe('+8.3%');
      expect(document.body.querySelectorAll('.mini__value')[1]?.textContent).toBe('27.8 mln');
    } finally {
      i18n.global.locale.value = 'uz';
    }
  });

  it('shows 7 days with the v1 figures and switches to 30 days', async () => {
    await mountHome();
    expect(text('.sales__amount')).toBe('639 000 000');
    expect(text('.sales .badge')).toBe('+8,3%');
    expect(text('.sales__vs')).toBe('oldingi 7 kunga nisbatan');
    expect(
      Array.from(document.body.querySelectorAll('.plot__labels span')).map((s) => s.textContent),
    ).toEqual(['13.10', '14.10', '15.10', '16.10', '17.10', '18.10', 'Bugun']);
    expect(document.body.querySelectorAll('.dot')).toHaveLength(7);
    expect(document.body.querySelector('.dot--last')).not.toBeNull();
    expect(
      Array.from(document.body.querySelectorAll('.mini__value')).map((v) => v.textContent),
    ).toEqual(['23 ta', '27,8 mln']);

    buttonByText('30 kun')?.click();
    await flushPromises();
    expect(text('.sales__amount')).toBe('2 220 500 000');
    expect(text('.sales__vs')).toBe('oldingi 30 kunga nisbatan');
    expect(
      Array.from(document.body.querySelectorAll('.plot__labels span')).map((s) => s.textContent),
    ).toEqual(['22–28.09', '29.09–05.10', '06–12.10', '13–19.10']);
    expect(document.body.querySelectorAll('.dot')).toHaveLength(4);
    expect(
      Array.from(document.body.querySelectorAll('.mini__value')).map((v) => v.textContent),
    ).toEqual(['81 ta', '27,4 mln']);
    expect(buttonByText('30 kun')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('exposes the chart numbers as a list for assistive technology and as tooltips', async () => {
    await mountHome();
    const items = Array.from(document.body.querySelectorAll('.sales .sr-only li')).map(
      (li) => li.textContent,
    );
    expect(items[0]).toBe("13.10: 86 400 000 so'm");
    expect(document.body.querySelector('.dot')?.getAttribute('title')).toBe(
      "13.10: 86 400 000 so'm",
    );
    expect(document.body.querySelector('.plot__box')?.getAttribute('role')).toBe('img');
  });
});

describe('home page: states', () => {
  it('shows zeros and the empty-list texts when there are no orders', async () => {
    await mountHome({ scenario: 'empty' });
    expect(text('.kpi--sand')).toContain("bo'sh");
    expect(text('.kpi--sand .kpi__big')).toBe('0');
    expect(document.body.textContent).toContain(
      "Navbat bo'sh. Yangi buyurtmalar shu yerda paydo bo'ladi.",
    );
    expect(document.body.textContent).toContain("Barcha qabul qilingan buyurtmalar to'langan.");
  });

  it.each([
    ['error', 'error'],
    ['denied', 'denied'],
  ] as const)('shows the %s state', async (scenario, state) => {
    await mountHome({ scenario });
    expect(document.body.querySelector(`[data-state="${state}"]`)).not.toBeNull();
    expect(document.body.querySelector('.kpis')).toBeNull();
  });

  it('shows the loading state until the orders arrive', async () => {
    const { wrapper, services } = await mountHome({ skipLoad: true });
    expect(services.ordersStore.state.value).toBe('loading');
    expect(wrapper.find('[data-state="loading"]').exists()).toBe(true);
  });

  it('greets by the time of day in Tashkent', () => {
    expect(greetingPeriod(new Date('2026-10-19T04:30:00Z'))).toBe('morning'); // 09:30
    expect(greetingPeriod(new Date('2026-10-19T08:00:00Z'))).toBe('afternoon'); // 13:00
    expect(greetingPeriod(new Date('2026-10-19T14:00:00Z'))).toBe('evening'); // 19:00
    expect(dateLineParts(TEST_NOW)).toEqual({ weekday: 1, day: 19, month: 9 });
    expect(firstName('Sanjar Toshev')).toBe('Sanjar');
  });
});

describe('sales chart geometry', () => {
  it('uses floats for geometry only: displayed amounts stay the exact decimal strings', () => {
    const huge = ['9007199254740993.00', '9007199254740995.00', '9007199254740997.00'];
    const chart = buildSalesChart(
      huge.map((total) => ({ total })),
      () => '',
    );
    expect(chart.dots.map((d) => d.total)).toEqual(huge);
    expect(
      chart.dots.every((d) => Number.isFinite(d.yPercent) && Number.isFinite(d.xPercent)),
    ).toBe(true);
  });

  it('scales between 85% of the minimum and the maximum like the design', () => {
    const chart = buildSalesChart(
      [{ total: '100000000.00' }, { total: '200000000.00' }, { total: '150000000.00' }],
      (i) => `L${i}`,
    );
    expect(chart.dots.map((d) => d.label)).toEqual(['L0', 'L1', 'L2']);
    expect(chart.dots[1]?.yPercent).toBeCloseTo(6, 5); // the maximum sits 6 units below the top
    expect(chart.dots[0]?.xPercent).toBe(0);
    expect(chart.dots[2]?.xPercent).toBeCloseTo(100, 5);
    expect(chart.dots[2]?.isLast).toBe(true);
    expect(chart.line.split(' ')).toHaveLength(3);
    expect(chart.area.endsWith('300,100 0,100')).toBe(true);
  });

  it('copes with one bucket, equal values and no data', () => {
    expect(buildSalesChart([{ total: '5.00' }], () => '').dots[0]?.xPercent).toBe(50);
    expect(
      buildSalesChart([{ total: '5.00' }, { total: '5.00' }], () => '').dots.every((d) =>
        Number.isFinite(d.yPercent),
      ),
    ).toBe(true);
    expect(buildSalesChart([], () => '')).toEqual({ line: '', area: '', dots: [] });
  });

  it('labels days, "today", same-month weeks and cross-month weeks', () => {
    const clock = { now: () => TEST_NOW };
    const day = (iso: string) => ({ from: iso, to: iso });
    expect(bucketLabel(day('2026-10-13T07:00:00.000Z'), clock, 'Bugun')).toBe('13.10');
    expect(bucketLabel(day('2026-10-19T07:00:00.000Z'), clock, 'Bugun')).toBe('Bugun');
    expect(
      bucketLabel({ from: '2026-10-13T07:00:00.000Z', to: '2026-10-19T07:00:00.000Z' }, clock, ''),
    ).toBe('13–19.10');
    expect(
      bucketLabel({ from: '2026-09-29T07:00:00.000Z', to: '2026-10-05T07:00:00.000Z' }, clock, ''),
    ).toBe('29.09–05.10');
  });
});

describe('count-up', () => {
  it('equals the target at once when the user prefers reduced motion', async () => {
    mockMotion(true);
    const scope = effectScope();
    const target = ref(0);
    const shown = scope.run(() => useCountUp(target));
    target.value = 42;
    await nextTick();
    expect(shown?.value).toBe(42);
    scope.stop();
  });

  it('counts up with animation frames otherwise and lands exactly on the target', async () => {
    mockMotion(false);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const scope = effectScope();
    const target = ref(10);
    const shown = scope.run(() => useCountUp(target));
    const start = performance.now();
    expect(shown?.value).toBe(0);
    frames.shift()?.(start);
    frames.shift()?.(start + 300);
    expect(shown?.value).toBeGreaterThan(0);
    expect(shown?.value).toBeLessThan(10);
    frames.shift()?.(start + 700);
    expect(shown?.value).toBe(10);
    scope.stop();
    vi.unstubAllGlobals();
  });
});
