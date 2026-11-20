import { fifoPlanOf } from './api/fake-allocation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocked } from '@/test-utils/locked';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { detailByNumber, orderId, summaryByNumber } from '@/test-utils/orders';
import { ApiConflictError } from '@core/lib/api-errors';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';

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

async function mountAt(
  identity: string,
  path: string,
  scenario?: 'error' | 'denied',
  prepare?: (services: Services) => void,
) {
  await preloadRouteComponents();
  const { services, orders } = createTestServices({
    identityId: identity,
    scenario,
    clock: { now: () => TEST_NOW },
  });
  await services.currentUser.ensureLoaded();
  prepare?.(services);
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(path);
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await services.ordersStore.load();
  await services.directoryStore.load();
  await waitFor(() =>
    expect(document.body.querySelector('.orders, .page, [data-state]')).not.toBeNull(),
  );
  await flushPromises();
  return { services, router, orders };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
const rows = (): string[] =>
  Array.from(document.body.querySelectorAll('[data-testid="order-row"]')).map((r) =>
    squash(r.textContent),
  );
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => squash(b.textContent) === label);
const byLabel = (label: string): HTMLElement =>
  document.body.querySelector(`[aria-label="${label}"]`) as HTMLElement;
// The first quantity change on an order asks once (the customer will be notified).
const confirmItemEdit = async (): Promise<void> => {
  await waitFor(() => expect(text('.modal__title')).toBe("Buyurtma miqdorini o'zgartirasizmi?"));
  buttonByText("Ha, o'zgartirish")?.click();
  await waitFor(() => expect(document.body.querySelector('.modal__title')).toBeNull());
};
// The approval needs a payment method; nothing is preselected.
const chooseMethod = async (method: 'CASH' | 'OFFICIAL' = 'CASH'): Promise<void> => {
  (document.body.querySelector(`[data-testid="payment-method-${method}"]`) as HTMLElement).click();
  await flushPromises();
};
// The manager's step sits in the page header: «Tasdiqlash» opens the approval dialog, which reads
// the order and its supply plan and asks for the sale type.
const openApproval = async (): Promise<void> => {
  (document.body.querySelector('[data-testid="approve-button"]') as HTMLButtonElement).click();
  await waitFor(() => expect(text('.modal__title')).toBe('Buyurtmani tasdiqlaysizmi?'));
  await waitFor(() =>
    expect(document.body.querySelector('[data-testid="payment-method-CASH"]')).not.toBeNull(),
  );
};
const confirmApproval = (): void =>
  (document.body.querySelector('[data-testid="approve-confirm"]') as HTMLButtonElement).click();
const detailReady = async (head: string): Promise<void> => {
  await waitFor(() => expect(text('.client__name')).toBe(head));
};

describe('orders list', () => {
  it('lists every order newest first with customer, contact, total, payment plan and status', async () => {
    await mountAt('manager', '/staff/orders');
    expect(text('.head__title')).toBe('Buyurtmalar');
    const list = rows();
    expect(list).toHaveLength(12);
    expect(list[0]).toContain('IO-10491');
    expect(list[0]).toContain('Orion Mobile');
    expect(list[0]).toContain('Jasur Karimov');
    expect(list[0]).toContain('+998 90 351 2210');
    expect(list[0]).toContain("23 570 000 so'm");
    expect(list[0]).toContain("Bittada to'lash");
    expect(list[0]).toContain('Menejerda');
    expect(list[1]).toContain('IO-10490');
    expect(list[2]).toContain('IO-10487');
  });

  it('tags each row with the organization type, and the label only for roles that see money', async () => {
    await mountAt('manager', '/staff/orders');
    const first = document.body.querySelector('[data-testid="order-row"]');
    expect(squash(first?.querySelector('[data-testid="org-type-tag"]')?.textContent)).toBe('Guruh');
    // Orion Mobile is a partner in the fake.
    expect(squash(first?.querySelector('[data-testid="org-label-tag"]')?.textContent)).toBe(
      'Hamkor',
    );
    for (const w of wrappers.splice(0)) w.unmount();
    // The warehouse reads orders on the order page (its list is the queue): type yes, label no.
    await mountAt('warehouse', `/staff/orders/${orderId('IO-10484')}`);
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="org-type-tag"]')).not.toBeNull(),
    );
    expect(document.body.querySelector('[data-testid="org-label-tag"]')).toBeNull();
  });

  it('offers the quick approve on SUBMITTED rows only, and only to the manager', async () => {
    await mountAt('manager', '/staff/orders');
    const approvable = Array.from(document.body.querySelectorAll('[data-testid="order-row"]'))
      .filter((r) => r.querySelector('[data-testid="row-approve"]'))
      .map((r) => r.querySelector('.row-link')?.textContent?.trim());
    expect(approvable).toEqual(['IO-10491', 'IO-10490', 'IO-10487']);
    for (const w of wrappers.splice(0)) w.unmount();
    await mountAt('accountant', '/staff/orders');
    expect(document.body.querySelector('[data-testid="row-approve"]')).toBeNull();
  });

  it('approves from the row through the approval dialog; nothing happens before the confirm', async () => {
    const { services } = await mountAt('manager', '/staff/orders?stage=SUBMITTED');
    (document.body.querySelector('[data-testid="row-approve"]') as HTMLButtonElement).click();
    await waitFor(() => expect(text('.modal__title')).toBe('Buyurtmani tasdiqlaysizmi?'));
    await waitFor(() =>
      expect(text('[data-testid="approve-summary"]')).toBe(
        "IO-1049123 570 000 so'mOrion Mobile · Jasur KarimovBittada to'lash",
      ),
    );
    expect(summaryByNumber(services, 'IO-10491')?.status).toBe('SUBMITTED');
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="payment-method-CASH"]')).not.toBeNull(),
    );
    await chooseMethod();
    await waitFor(() =>
      expect(
        (
          document.body.querySelector('[data-testid="approve-confirm"]') as HTMLElement
        ).getAttribute('aria-disabled'),
      ).not.toBe('true'),
    );
    (document.body.querySelector('[data-testid="approve-confirm"]') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(summaryByNumber(services, 'IO-10491')?.status).toBe('MANAGER_APPROVED'),
    );
  });

  it('shows no payment plan on rejected and cancelled rows', async () => {
    const { services } = await mountAt('manager', '/staff/orders');
    const rejected = summaryByNumber(services, 'IO-10487');
    if (!rejected) throw new Error('IO-10487 is missing');
    await services.ordersStore.reject(rejected, 'Narx eskirgan');
    await flushPromises();
    const plan = (id: string): string => {
      const row = Array.from(document.body.querySelectorAll('[data-testid="order-row"]')).find(
        (r) => r.textContent?.includes(id),
      );
      return squash(row?.querySelector('[data-testid="order-plan"]')?.textContent);
    };
    await waitFor(() => expect(plan('IO-10487')).toBe(''));
    expect(plan('IO-10491')).toBe("Bittada to'lash");
  });

  it('filters from the URL query', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=RELEASED&pay=PAID');
    expect(rows()).toHaveLength(2);
    await router.replace({ query: { period: 'debt' } });
    await flushPromises();
    expect(rows()).toHaveLength(1);
    await router.replace({ query: { period: 'today' } });
    await flushPromises();
    expect(rows()).toHaveLength(2);
  });

  it('ignores unknown filter values and shows the empty text when nothing matches', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=NOPE');
    expect(rows()).toHaveLength(12);
    await router.replace({ query: { stage: 'CLOSED', pay: 'PAID' } });
    await flushPromises();
    expect(rows()).toHaveLength(0);
    expect(text('.empty')).toBe("Filtrga mos buyurtma yo'q");
  });

  it('clears the filters', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=CLOSED&pay=PAID');
    buttonByText('Filtrlarni tozalash')?.click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(rows()).toHaveLength(12);
  });

  it('rows are links to the order page; back returns to the list with its filters', async () => {
    const { router } = await mountAt('manager', '/staff/orders?stage=SUBMITTED');
    const link = document.body.querySelector('a.row-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/staff/orders/${orderId('IO-10491')}`);
    link.click();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-order'));
    await detailReady('Orion Mobile');
    const crumb = document.body.querySelector('a.back') as HTMLAnchorElement;
    expect(crumb.getAttribute('href')).toBe('/staff/orders?stage=SUBMITTED');
    router.back();
    await waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/staff/orders?stage=SUBMITTED'),
    );
  });

  it('says how long ago every order was placed, in one unit, closed ones too', async () => {
    const { services } = await mountAt('manager', '/staff/orders');
    const when = (id: string): string => {
      const row = Array.from(document.body.querySelectorAll('[data-testid="order-row"]')).find(
        (r) => r.textContent?.includes(id),
      );
      return squash(row?.querySelector('[data-testid="order-when"]')?.textContent);
    };
    expect(when('IO-10491')).toMatch(/(daqiqa|soat|kun) oldin$/);
    const rejected = summaryByNumber(services, 'IO-10487');
    if (!rejected) throw new Error('IO-10487 is missing');
    await services.ordersStore.reject(rejected, 'Narx eskirgan');
    // a rejected order still says when it was placed: the design shows «x oldin» on every row
    await waitFor(() => expect(when('IO-10487')).toMatch(/^\d+ (daqiqa|soat|kun) oldin$/));
  });

  it('shows the error and denied states', async () => {
    await mountAt('manager', '/staff/orders', 'error');
    expect(document.body.querySelector('[data-state="error"]')).not.toBeNull();
  });
});

describe('order page', () => {
  it('shows header, creator, progress, items and the first timeline entry', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    expect(text('.head__id')).toBe('IO-10491');
    // the design's header: number, the read-only status pill, how long ago it was placed
    expect(text('.head__badges')).toBe('Menejerda');
    expect(text('[data-testid="order-age"]')).toBe('18 daqiqa oldin');
    // the «Mijoz» card: the organization, then the placer (also the shop owner) with the phone
    expect(text('.client__name')).toBe('Orion Mobile');
    expect(text('.client')).toContain('Jasur Karimov');
    expect(text('.client')).toContain("Buyurtma bergan · Do'kon egasi");
    expect(text('.client')).toContain('+998 90 351 2210');
    expect(text('.client')).toContain("Qo'ng'iroq qilish");
    expect(document.body.querySelector('.crumbs')).toBeNull();
    expect(document.body.querySelectorAll('a.back')).toHaveLength(1);
    // the design has no stepper: the manager's view leaves it out, the step is in the header
    expect(document.body.querySelector('.progress')).toBeNull();
    expect(text('.hact')).toContain('Rad etish');
    expect(text('.hact')).toContain('Tasdiqlash');
    expect(document.body.querySelector('.panel--actions')).toBeNull();
    expect(document.body.querySelectorAll('.line')).toHaveLength(4);
    expect(text('.items__sub')).toBe('4 pozitsiya · 130 dona');
    expect(text('.total')).toBe("Buyurtma summasi23 570 000 so'm");
    expect(text('.comment__text')).toBe('Iltimos, ertaga ertalab yetkazib bering.');
    const events = Array.from(document.body.querySelectorAll('.event'));
    expect(events).toHaveLength(1);
    expect(squash(events[0]?.textContent)).toContain('Buyurtma yuborildi');
    expect(squash(events[0]?.textContent)).toContain("Jasur Karimov · Do'kon egasi");
    expect(squash(events[0]?.textContent)).toContain('Xabar yuborildi: Menejer');
  });

  it('shows the whole history of a delivered order: who, role, from -> to, accounting, driver, sent', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10477')}`);
    await detailReady('Mobile Center Samarqand');
    const events = Array.from(document.body.querySelectorAll('.event')).map((e) =>
      squash(e.textContent),
    );
    // newest first (v8 "Yangi → eski")
    expect(events).toHaveLength(5);
    expect(events[4]).toContain('Buyurtma yuborildi');
    expect(events[3]).toContain('Menejer tasdiqladi');
    expect(events[3]).toContain('Aziza Yusupova · Menejer');
    expect(events[3]).toContain('Holat: Menejerda → Buxgalteriyada');
    expect(events[2]).toContain('Buxgalteriya tasdiqladi');
    expect(events[2]).toContain('Buxgalteriya: buxgalter tasdiqladi');
    expect(events[1]).toContain('Ombordan chiqdi');
    expect(events[1]).toContain('Haydovchi: Bekzod Tursunov');
    expect(events[1]).toContain(
      'Xabar yuborildi: Bekzod Tursunov, mijoz guruhi: Mobile Center Samarqand',
    );
    expect(events[0]).toContain('Yetkazildi');
    expect(document.body.textContent).toContain('Bekzod Tursunov');
  });

  it('marks a manager-skipped accounting step on the progress, apart from a real clearance', async () => {
    const barStates = (): string[] =>
      Array.from(document.body.querySelectorAll('.progress__dot')).map((b) =>
        b.className.replace(/.*--/, ''),
      );
    // the other roles keep the stepper (the manager's view follows the design and has none)
    await mountAt('admin', `/staff/orders/${orderId('IO-10484')}`);
    await detailReady('Click Store');
    expect(barStates()).toEqual(['done', 'done', 'skipped', 'next', 'todo', 'todo']);
    expect(text('.progress')).toContain("BuxgalteriyaO'tkazib yuborildi");
    document.body.innerHTML = '';
    await mountAt('admin', `/staff/orders/${orderId('IO-10477')}`);
    await detailReady('Mobile Center Samarqand');
    expect(barStates()).toEqual(['done', 'done', 'done', 'done', 'done', 'next']);
    expect(text('.progress')).not.toContain("O'tkazib");
  });

  it('records the skip of accounting by the manager', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10484')}`);
    await detailReady('Click Store');
    const events = Array.from(document.body.querySelectorAll('.event')).map((e) =>
      squash(e.textContent),
    );
    expect(events.join('|')).toContain('Menejer buxgalteriyasiz davom ettirdi');
    expect(events.join('|')).toContain("Buxgalteriya: menejer o'tkazib yubordi");
  });

  it('stages quantity edits locally: totals and the change list update, nothing is sent yet', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    byLabel('Samsung Galaxy A15 4/128GB: oshirish').click();
    await confirmItemEdit();
    byLabel('Samsung Galaxy A15 4/128GB: oshirish').click();
    await flushPromises();
    expect(text('.items__sub')).toBe('4 pozitsiya · 132 dona');
    expect(text('.total')).toBe("Buyurtma summasi26 950 000 so'm");
    expect(text('.draft')).toContain('Samsung Galaxy A15 4/128GB: 10 → 12 dona');
    expect(text('.draft__totals')).toBe("23 570 000 → 26 950 000, +3 380 000 so'm");
    expect(buttonByText('Saqlash')).toBeDefined();
    expect(buttonByText('Bekor qilish')).toBeDefined();
    // the order and its history are untouched until the save
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe('10');
    expect(document.body.querySelectorAll('.event')).toHaveLength(1);
    // a staged removal keeps the row (so it can be restored) and shows a negative difference
    byLabel('Samsung 25W zaryadlovchi: olib tashlash').click();
    await flushPromises();
    expect(document.body.querySelectorAll('.line')).toHaveLength(4);
    expect(text('.draft')).toContain('olib tashlandi');
    expect(text('.draft__totals')).toContain('→');
    // putting the old quantity back leaves no change for that line
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await flushPromises();
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await flushPromises();
    expect(text('.draft')).not.toContain('Samsung Galaxy A15 4/128GB: 10');
  });

  it('saves the whole draft as ONE history event with ONE customer notification', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await confirmItemEdit();
    byLabel('Samsung 25W zaryadlovchi: olib tashlash').click();
    await flushPromises();
    // already confirmed on the first change: the save itself does not ask again
    buttonByText('Saqlash')?.click();
    await waitFor(() => expect(document.body.querySelector('.draft')).toBeNull());
    expect(document.body.querySelector('.modal__title')).toBeNull();
    const order = await detailByNumber(services, 'IO-10491');
    expect(order.items[0]?.quantity).toBe('9');
    expect(order.items).toHaveLength(3);
    await waitFor(() => expect(document.body.querySelectorAll('.event')).toHaveLength(2));
    // newest first: the save is the top entry
    const last = squash(Array.from(document.body.querySelectorAll('.event'))[0]?.textContent);
    expect(last).toContain("Tarkib o'zgartirildi");
    expect(last).toContain('Samsung Galaxy A15 4/128GB: 10 → 9 dona');
    expect(last).toContain('Samsung 25W zaryadlovchi: olib tashlandi');
    expect(last).toContain('Xabar yuborildi: mijoz guruhi: Orion Mobile');
    expect(document.body.querySelectorAll('.line')).toHaveLength(3);
    // the server priced the saved edit: old and new total sit in the timeline entry
    expect(last).toContain("Jami: 23 570 000 → 17 530 000 so'm");
    expect(useToast().toast.value?.message).toBe('IO-10491 tarkibi saqlandi');
  });

  it('asks once, on the first quantity change, with the customer-notification note', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await waitFor(() => expect(text('.modal__title')).toBe("Buyurtma miqdorini o'zgartirasizmi?"));
    expect(text('.modal')).toContain(
      "Buyurtma miqdorining o'zgarishi mijozga bildirishnoma yuboradi.",
    );
    // back: the clicked change is not applied and nothing is sent
    buttonByText('Ortga')?.click();
    await waitFor(() => expect(document.body.querySelector('.modal__title')).toBeNull());
    expect(document.body.querySelector('.draft')).toBeNull();
    expect(text('.total')).toBe("Buyurtma summasi23 570 000 so'm");
    // yes: the clicked change is applied, and later −/+/× do not ask again
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await confirmItemEdit();
    expect(text('.total')).toBe("Buyurtma summasi21 880 000 so'm");
    byLabel('Samsung Galaxy A15 4/128GB: oshirish').click();
    await flushPromises();
    byLabel('Samsung 25W zaryadlovchi: olib tashlash').click();
    await flushPromises();
    expect(document.body.querySelector('.modal__title')).toBeNull();
    expect(text('.draft')).toContain('olib tashlandi');
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe('10');
    expect(document.body.querySelectorAll('.event')).toHaveLength(1);
  });

  it('discards the draft without any request', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await confirmItemEdit();
    expect(text('.total')).toBe("Buyurtma summasi21 880 000 so'm");
    buttonByText('Bekor qilish')?.click();
    await flushPromises();
    expect(document.body.querySelector('.draft')).toBeNull();
    expect(text('.total')).toBe("Buyurtma summasi23 570 000 so'm");
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe('10');
    expect(document.body.querySelectorAll('.event')).toHaveLength(1);
  });

  it('asks before leaving the page with unsaved edits; staying keeps them, leaving drops them', async () => {
    const { router, services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    byLabel('Samsung Galaxy A15 4/128GB: kamaytirish').click();
    await confirmItemEdit();
    const leaving = router.push('/staff/orders');
    await waitFor(() => expect(text('.modal__title')).toBe("Saqlanmagan o'zgarishlar bor"));
    buttonByText('Qolish')?.click();
    await leaving;
    expect(router.currentRoute.value.path).toBe(`/staff/orders/${orderId('IO-10491')}`);
    expect(document.body.querySelector('.draft')).not.toBeNull();
    const again = router.push('/staff/orders');
    await waitFor(() => expect(buttonByText('Saqlamasdan chiqish')).toBeDefined());
    buttonByText('Saqlamasdan chiqish')?.click();
    await again;
    expect(router.currentRoute.value.path).toBe('/staff/orders');
    expect((await detailByNumber(services, 'IO-10491')).items[0]?.quantity).toBe('10');
  });

  it('does not ask when nothing is staged, and blocks approval until the draft is saved', async () => {
    const { router } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    byLabel('Samsung Galaxy A15 4/128GB: oshirish').click();
    await confirmItemEdit();
    const approve = document.body.querySelector('[data-testid="approve-button"]') as HTMLElement;
    expect(isLocked(approve)).toBe(true);
    expect(isLocked(document.body.querySelector('[data-testid="reject-button"]'))).toBe(true);
    // a new order is refused, never cancelled: the header has no cancel (owner 2026-11-20)
    expect(document.body.querySelector('[data-testid="header-cancel"]')).toBeNull();
    // the button explains itself (tooltip, or a dialog on a tap) with the thing to do first
    const reasons = document.getElementById(approve.getAttribute('aria-describedby') ?? '');
    expect(reasons?.textContent).toContain(
      "Tarkibdagi o'zgarishlar saqlanmagan. Avval ularni saqlang yoki bekor qiling.",
    );
    buttonByText('Bekor qilish')?.click();
    await flushPromises();
    expect(isLocked(approve)).toBe(false);
    await router.push('/staff/orders');
    expect(router.currentRoute.value.path).toBe('/staff/orders');
  });

  it('gives the admin read-only items, no workflow step, no cancel and no payment action', async () => {
    await mountAt('admin', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    expect(document.body.querySelector('.stepper')).toBeNull();
    expect(text('.items__note')).toBe("Miqdorni faqat menejer o'zgartiradi.");
    expect(buttonByText('Tasdiqlash')).toBeUndefined();
    expect(buttonByText('Rad etish')).toBeUndefined();
    expect(text('.note')).toContain('Administrator ish jarayoni qadamlarini bajarmaydi.');
    expect(buttonByText("To'langan deb belgilash")).toBeUndefined();
    expect(buttonByText('Buyurtmani bekor qilish')).toBeUndefined();
  });

  it('shows the cancel action to the manager', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(buttonByText('Buyurtmani bekor qilish')).toBeDefined();
  });

  it('shows the accountant no cancel action', async () => {
    await mountAt('accountant', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(buttonByText('Buyurtmani bekor qilish')).toBeUndefined();
  });

  it('keeps approve locked until the manager picks a payment method; nothing is preselected', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    await openApproval();
    const radios = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('.modal .method [type="radio"]'),
    );
    expect(radios.map((radio) => radio.checked)).toEqual([false, false]);
    expect(text('.modal .method__options')).toBe('Naqd Official');
    const approve = document.body.querySelector(
      '[data-testid="approve-confirm"]',
    ) as HTMLButtonElement;
    expect(isLocked(approve)).toBe(true);
    approve.click();
    await flushPromises();
    expect(summaryByNumber(services, 'IO-10491')?.status).toBe('SUBMITTED');
    await chooseMethod();
    expect(isLocked(approve)).toBe(false);
    // before the approval there is no payment method card yet: the choice sits in the dialog
    expect(document.body.querySelector('[data-testid="payment-method-card"]')).toBeNull();
  });

  it('lets the manager change the payment method of an approved order, with a history entry', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    const card = '[data-testid="payment-method-card"]';
    const official = document.body.querySelector(
      `${card} [data-testid="payment-method-OFFICIAL"]`,
    ) as HTMLInputElement;
    expect(official.checked).toBe(true);
    // nothing to save while the method is unchanged
    expect(document.body.querySelector('[data-testid="payment-method-save"]')).toBeNull();
    (
      document.body.querySelector(`${card} [data-testid="payment-method-CASH"]`) as HTMLElement
    ).click();
    await flushPromises();
    (document.body.querySelector('[data-testid="payment-method-save"]') as HTMLElement).click();
    await waitFor(() => expect(useToast().toast.value?.message).toBe('IO-10489 · Naqd'));
    await waitFor(() => expect(text('.timeline')).toContain('Savdo turi: Official → Naqd'));
    expect(text('.timeline')).toContain("Savdo turi o'zgardi");
    expect(document.body.querySelector('[data-testid="payment-method-save"]')).toBeNull();
  });

  it('shows the accountant the payment method without a way to change it', async () => {
    await mountAt('accountant', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(text('[data-testid="payment-method-value"]')).toBe('Official');
    expect(
      document.body.querySelector('[data-testid="payment-method-card"] [type="radio"]'),
    ).toBeNull();
    expect(document.body.querySelector('[data-testid="payment-method-save"]')).toBeNull();
    expect(text('.timeline')).toContain('Savdo turi: Official');
  });

  it('shows the admin no payment method anywhere', async () => {
    await mountAt('admin', `/staff/orders/${orderId('IO-10486')}`);
    await detailReady('GSM Plus');
    expect(document.body.querySelector('[data-testid="payment-method-card"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="timeline-payment-method"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Savdo turi');
  });

  it('lets the manager change the payment plan while SUBMITTED, after a confirmation', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10490')}`);
    await detailReady('Mobile Center Samarqand');
    expect(text('[data-testid="payment-plan-value"]')).toBe("Bittada to'lash");
    (
      document.body.querySelector('[data-testid="payment-plan-change-DEFERRED"]') as HTMLElement
    ).click();
    await flushPromises();
    await waitFor(() => expect(text('.modal')).toContain("Yangi to'lov turi: Bo'lib to'lash"));
    buttonByText("O'zgartirish")?.click();
    await waitFor(() => expect(text('[data-testid="payment-plan-value"]')).toBe("Bo'lib to'lash"));
    await waitFor(() =>
      expect(text('[data-testid="timeline-payment-plan"]')).toBe(
        "To'lov turi: Bittada to'lash → Bo'lib to'lash",
      ),
    );
  });

  it('disables the plan change and says why when a line has no deferred price', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    const change = document.body.querySelector(
      '[data-testid="payment-plan-change-DEFERRED"]',
    ) as HTMLButtonElement;
    expect(change.disabled).toBe(true);
    expect(text('[data-testid="payment-plan-reason"]')).toContain("Bo'lib to'lash mumkin emas");
  });

  it('shows the order\u2019s USD total at its frozen rate, to full-detail roles only', async () => {
    await mountAt('accountant', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    expect(text('[data-testid="order-total-usd"]')).toMatch(/\$[\d ,]+, kurs 12 650$/);
  });

  it('offers no plan change after approval, and none to the accountant', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(text('[data-testid="payment-plan-value"]')).toBe("Bittada to'lash");
    expect(document.body.querySelector('[data-testid^="payment-plan-change"]')).toBeNull();
  });

  it('shows the accountant the plan without a way to change it', async () => {
    await mountAt('accountant', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    expect(text('[data-testid="payment-plan-value"]')).toBe("Bittada to'lash");
    expect(document.body.querySelector('[data-testid^="payment-plan-change"]')).toBeNull();
  });

  it('locks the items once approved and explains why', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(document.body.querySelector('.stepper')).toBeNull();
    expect(text('.table__note')).toBe(
      "Buyurtma tasdiqlangandan keyin tarkibni o'zgartirib bo'lmaydi.",
    );
    expect(buttonByText('Tasdiqlash')).toBeUndefined();
    expect(text('.note')).toContain('Keyingi qadam: Buxgalter tasdiqlaydi');
  });

  it('approves, stays on the page and shows the new status and event; skip box skips accounting', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    await openApproval();
    await chooseMethod('OFFICIAL');
    confirmApproval();
    await waitFor(() => expect(text('.head__badges')).toBe('Buxgalteriyada'));
    expect(summaryByNumber(services, 'IO-10491')?.status).toBe('MANAGER_APPROVED');
    expect(useToast().toast.value?.message).toBe('IO-10491 tasdiqlandi');
    expect(document.body.querySelector('[data-testid="approve-button"]')).toBeNull();
    expect(document.body.querySelectorAll('.event')).toHaveLength(2);
    await waitFor(() =>
      expect(text('[data-testid="timeline-payment-method"]')).toBe('Savdo turi: Official'),
    );
  });

  it('skips accounting when the manager ticks the box', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10490')}`);
    await detailReady('Mobile Center Samarqand');
    await openApproval();
    await chooseMethod();
    (document.body.querySelector('.skip__box') as HTMLInputElement).click();
    await flushPromises();
    // The box says what it does.
    expect(text('.skip')).toContain("darhol omborga o'tadi");
    confirmApproval();
    await flushPromises();
    // Skipping cannot be undone: the first tap only asks, nothing is sent yet.
    expect(summaryByNumber(services, 'IO-10490')?.status).toBe('SUBMITTED');
    expect(text('[data-testid="approve-skip-confirm"]')).toContain("Buni bekor qilib bo'lmaydi");
    buttonByText('Orqaga')?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="approve-skip-confirm"]')).toBeNull();
    expect(summaryByNumber(services, 'IO-10490')?.status).toBe('SUBMITTED');
    confirmApproval();
    await flushPromises();
    confirmApproval();
    await waitFor(() =>
      expect(summaryByNumber(services, 'IO-10490')?.status).toBe('ACCOUNTING_CLEARED'),
    );
    const skipped = summaryByNumber(services, 'IO-10490');
    expect(skipped?.detail === 'FULL' && skipped.accounting.mode).toBe('SKIPPED_BY_MANAGER');
    await waitFor(() => expect(text('.timeline')).toContain("menejer o'tkazib yubordi"));
  });

  it('requires a reason to reject and shows it on the closed order', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10487')}`);
    await detailReady('Click Store');
    buttonByText('Rad etish')?.click();
    await flushPromises();
    // the design's question, with the grey summary of what is rejected
    expect(text('.modal__title')).toBe('Buyurtmani rad etasizmi?');
    expect(text('[data-testid="reason-summary"]')).toContain('IO-10487');
    expect(text('[data-testid="reason-summary"]')).toContain('Click Store');
    const confirm = Array.from(document.body.querySelectorAll('.modal button')).find(
      (b) => squash(b.textContent) === 'Ha, rad etish',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Payment never blocks ordering (hard rule 11): no "debt" quick reason.
    const chips = Array.from(document.body.querySelectorAll('.chip')).map((c) =>
      squash(c.textContent),
    );
    expect(chips).toEqual(['Tovar qolmagan', 'Narx eskirgan', "Mijoz so'rovi bilan"]);
    (
      Array.from(document.body.querySelectorAll('.chip')).find(
        (c) => squash(c.textContent) === 'Narx eskirgan',
      ) as HTMLElement
    ).click();
    await flushPromises();
    confirm.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10487')?.status).toBe('REJECTED'));
    await waitFor(() => expect(text('.banner')).toBe('Rad etildi · sabab: Narx eskirgan'));
    expect(text('.note')).toBe('Buyurtma yopilgan');
    expect(text('.timeline')).toContain('Sabab: Narx eskirgan');
    expect(text('.timeline')).toContain('Xabar yuborildi: mijoz guruhi: Click Store');
  });

  it('requires a reason to cancel too and hides the link once released', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10484')}`);
    await detailReady('Click Store');
    buttonByText('Buyurtmani bekor qilish')?.click();
    await flushPromises();
    expect(text('.modal__description')).toContain('Sabab majburiy');
    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input'));
    await flushPromises();
    const confirm = Array.from(document.body.querySelectorAll('.modal button')).find(
      (b) => squash(b.textContent) === 'Ha, bekor qilish',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    textarea.value = 'Mijoz bekor qildi';
    textarea.dispatchEvent(new Event('input'));
    await flushPromises();
    confirm.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10484')?.status).toBe('CANCELLED'));
  });

  it('narrows the list with the text box and writes the text to the address', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    const rows = (): number => document.body.querySelectorAll('[data-testid="order-row"]').length;
    const all = rows();
    expect(all).toBeGreaterThan(1);
    const box = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    box.value = 'IO-10490';
    box.dispatchEvent(new Event('input'));
    await waitFor(() => expect(rows()).toBe(1));
    expect(router.currentRoute.value.query.q).toBe('IO-10490');
    box.value = '';
    box.dispatchEvent(new Event('input'));
    await waitFor(() => expect(rows()).toBe(all));
    expect(router.currentRoute.value.query.q).toBeUndefined();
  });

  it('shows an event of an unknown type with a generic label and keeps the rest of the timeline', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`, undefined, (services) => {
      const real = services.ordersApi.getTimeline.bind(services.ordersApi);
      services.ordersApi.getTimeline = async (id) => {
        const timeline = await real(id);
        const [first] = timeline.events;
        if (!first) throw new Error('fixture has no event');
        return {
          ...timeline,
          events: [...timeline.events, { ...first, type: 'UNKNOWN' as const }],
        };
      };
    });
    await detailReady('Orion Mobile');
    await waitFor(() => expect(text('.timeline')).toContain("Noma'lum hodisa"));
    expect(text('.timeline')).toContain('Buyurtma yuborildi');
  });

  it('puts only reject and approve of a SUBMITTED order in the header; a reason stays required', async () => {
    const { services } = await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    const header = document.body.querySelector('.head .hact') as HTMLElement;
    // a new order is refused, never cancelled (owner 2026-11-20)
    expect(squash(header.textContent)).toBe('Rad etish Tasdiqlash');
    expect(buttonByText('Buyurtmani bekor qilish')).toBeUndefined();
    // no big actions card for the manager's own step
    expect(document.body.querySelector('.panel--actions')).toBeNull();
    (document.body.querySelector('[data-testid="reject-button"]') as HTMLElement).click();
    await flushPromises();
    const confirm = Array.from(document.body.querySelectorAll('.modal button')).find(
      (b) => squash(b.textContent) === 'Ha, rad etish',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = "Mijoz so'radi";
    textarea.dispatchEvent(new Event('input'));
    await flushPromises();
    confirm.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10491')?.status).toBe('REJECTED'));
  });

  it('from MANAGER_APPROVED on only cancel exists, with no reject and no group', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(buttonByText('Rad etish')).toBeUndefined();
    expect(buttonByText('Boshqa amallar')).toBeUndefined();
    expect(buttonByText('Buyurtmani bekor qilish')).toBeDefined();
  });

  it('offers no cancel link after release', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10488')}`);
    await detailReady('Orion Mobile');
    expect(buttonByText('Buyurtmani bekor qilish')).toBeUndefined();
    expect(text('.note')).toContain('Keyingi qadam: Haydovchi yetkazadi');
  });

  it('shows the derived payment badge but no manual payment action to the manager', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`);
    await detailReady('Orion Mobile');
    expect(text('[data-testid="payment-status"]')).toBe("To'lanmagan");
    expect(buttonByText("To'langan deb belgilash")).toBeUndefined();
    expect(buttonByText("To'lanmagan deb belgilash")).toBeUndefined();
    expect(document.body.querySelector('.pay__btn')).toBeNull();
  });

  it('lets the accountant approve or reject the accounting step only', async () => {
    const { services } = await mountAt('accountant', `/staff/orders/${orderId('IO-10489')}`);
    await detailReady('Texno Market Andijon');
    expect(buttonByText('Tasdiqlash')).toBeUndefined();
    expect(buttonByText("To'langan deb belgilash")).toBeUndefined();
    buttonByText("Buxgalteriya tasdig'i")?.click();
    await waitFor(() =>
      expect(summaryByNumber(services, 'IO-10489')?.status).toBe('ACCOUNTING_CLEARED'),
    );
    await waitFor(() => expect(text('.timeline')).toContain('Nodira Xasanova · Buxgalter'));
  });

  it('lets the warehouse release with a chosen driver and the driver mark it delivered', async () => {
    const { services } = await mountAt('warehouse', `/staff/orders/${orderId('IO-10484')}`);
    await detailReady('Click Store');
    expect(isLocked(buttonByText('Ombordan chiqarish'))).toBe(true);
    (document.body.querySelector('.actions .driver__radio') as HTMLElement).click();
    await flushPromises();
    buttonByText('Ombordan chiqarish')?.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10484')?.status).toBe('RELEASED'));
    await waitFor(() => expect(document.body.textContent).toContain('Bekzod Tursunov'));
  });

  it('lets the driver mark a released order delivered', async () => {
    const { services } = await mountAt('driver', `/staff/orders/${orderId('IO-10488')}`);
    await detailReady('Orion Mobile');
    buttonByText('Yetkazildi')?.click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10488')?.status).toBe('DELIVERED'));
  });

  it('shows a not-found state for an unknown order with a way back', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-99999')}`);
    await waitFor(() => expect(text('[data-state="empty"]')).toContain('Buyurtma topilmadi'));
    expect(document.body.querySelector('a.back')).not.toBeNull();
  });

  it('shows the error state with a retry', async () => {
    await mountAt('manager', `/staff/orders/${orderId('IO-10491')}`, 'error');
    await waitFor(() => expect(document.body.querySelector('[data-state="error"]')).not.toBeNull());
  });
});

describe('order page: real-contract behaviour', () => {
  const at = (number: string): string => `/staff/orders/${orderId(number)}`;

  it('tells the manager the order changed, re-reads it and offers the new step (409 ORDER_CHANGED)', async () => {
    const { services, orders } = await mountAt('manager', at('IO-10491'));
    await detailReady('Orion Mobile');
    await openApproval();
    await chooseMethod();
    // a colleague approves the order after the dialog read it
    const current = await orders.ordersApi.getOrder(orderId('IO-10491'));
    await orders.ordersApi.approve(current.id, {
      ...(await fifoPlanOf(orders.ordersApi, current.id)),
      paymentMethod: 'CASH',
      expectedRowVersion: current.rowVersion,
    });
    confirmApproval();
    await waitFor(() =>
      expect(useToast().toast.value?.message).toContain("Buyurtmani boshqa xodim o'zgartirgan"),
    );
    // the page reloaded what the server has: approved by the colleague, no approve button left
    await waitFor(() => expect(text('.head__badges')).toBe('Buxgalteriyada'));
    expect(document.body.querySelector('[data-testid="approve-button"]')).toBeNull();
    // The kept queue was read again: the order is no longer waiting for the manager.
    await waitFor(() => expect(summaryByNumber(services, 'IO-10491')).toBeUndefined());
  });

  it('sends the approve with the version of the loaded page and the skip only when ticked', async () => {
    const { orders } = await mountAt('manager', at('IO-10490'));
    await detailReady('Mobile Center Samarqand');
    const approve = vi.spyOn(orders.ordersApi, 'approve');
    const version = (await orders.ordersApi.getOrder(orderId('IO-10490'))).rowVersion;
    await openApproval();
    await chooseMethod('OFFICIAL');
    confirmApproval();
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith(
      orderId('IO-10490'),
      expect.objectContaining({
        expectedRowVersion: version,
        paymentMethod: 'OFFICIAL',
        allocationMode: 'FIFO',
      }),
    );
  });

  describe('stock holds on the approval', () => {
    const conflict = async (
      orders: Awaited<ReturnType<typeof mountAt>>['orders'],
      id: string,
      reason: 'ALLOCATION_CHANGED' | 'STOCK_INSUFFICIENT',
      feasible: boolean,
    ): Promise<ApiConflictError> =>
      new ApiConflictError(
        reason,
        'CONFLICT',
        { preview: { ...(await orders.ordersApi.getAllocationPreview(id)), feasible } },
        reason,
      );

    it('proposes the FIFO plan and sends it', async () => {
      const { orders } = await mountAt('manager', at('IO-10490'));
      await detailReady('Mobile Center Samarqand');
      await openApproval();
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="allocation-mode"]')).not.toBeNull(),
      );
      expect(text('[data-testid="allocation-mode"]')).toContain('FIFO');
      const approve = vi.spyOn(orders.ordersApi, 'approve');
      await openApproval();
      await chooseMethod();
      confirmApproval();
      await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      const sent = approve.mock.calls[0]?.[1];
      expect(sent?.allocationMode).toBe('FIFO');
      expect(sent?.allocations.length).toBeGreaterThan(0);
    });

    it('on a changed plan stays on the step, says so, and one more click confirms', async () => {
      const { orders } = await mountAt('manager', at('IO-10490'));
      await detailReady('Mobile Center Samarqand');
      await openApproval();
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="allocation-mode"]')).not.toBeNull(),
      );
      const id = orderId('IO-10490');
      const approve = vi
        .spyOn(orders.ordersApi, 'approve')
        .mockRejectedValueOnce(await conflict(orders, id, 'ALLOCATION_CHANGED', true));
      await openApproval();
      await chooseMethod();
      confirmApproval();
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="allocation-changed"]')).not.toBeNull(),
      );
      confirmApproval();
      await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="allocation-plan"]')).toBeNull(),
      );
    });

    it('on too little stock names it and locks the approval', async () => {
      const { orders } = await mountAt('manager', at('IO-10490'));
      await detailReady('Mobile Center Samarqand');
      await openApproval();
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="allocation-mode"]')).not.toBeNull(),
      );
      vi.spyOn(orders.ordersApi, 'approve').mockRejectedValueOnce(
        await conflict(orders, orderId('IO-10490'), 'STOCK_INSUFFICIENT', false),
      );
      await openApproval();
      await chooseMethod();
      confirmApproval();
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="allocation-short"]')).not.toBeNull(),
      );
      await waitFor(() =>
        expect(isLocked(document.body.querySelector('[data-testid="approve-confirm"]'))).toBe(true),
      );
    });

    it('shows an older approved order as not allocated, to the manager only', async () => {
      await mountAt('manager', at('IO-10489'));
      await waitFor(() =>
        expect(document.body.querySelector('.total, .panel--actions')).not.toBeNull(),
      );
      await waitFor(() =>
        expect(document.body.querySelector('[data-testid="not-allocated"]')).not.toBeNull(),
      );
    });

    it('says "Not allocated" on the lines of an older approved order', async () => {
      await mountAt('accountant', at('IO-10489'));
      await waitFor(() =>
        expect(
          document.body.querySelector('[data-testid="order-line-not-allocated"]'),
        ).not.toBeNull(),
      );
      expect(document.body.querySelector('[data-testid="order-line-supply"]')).toBeNull();
    });

    it.each(['accountant', 'warehouse'] as const)('shows no holds to the %s', async (role) => {
      await mountAt(role, at('IO-10489'));
      await waitFor(() =>
        expect(document.body.querySelector('.total, .panel--actions')).not.toBeNull(),
      );
      expect(document.body.querySelector('[data-testid="order-allocation-panel"]')).toBeNull();
    });
  });

  it('shows the accountant prices but no phone number, and says why the contact is missing', async () => {
    await mountAt('accountant', at('IO-10488'));
    await detailReady('Orion Mobile');
    expect(text('.table__total')).toContain("so'm");
    expect(document.body.querySelector('[data-testid="order-line-supply"]')).not.toBeNull();
    expect(document.body.querySelector('.contact')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\+998/);
    expect(document.body.textContent).toContain("Telefon raqamlari bu rol uchun ko'rsatilmaydi.");
    expect(document.body.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('shows the warehouse items and the delivery contact, never prices, totals, payment or names', async () => {
    await mountAt('warehouse', at('IO-10484'));
    await detailReady('Click Store');
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="order-line-supply"]')).not.toBeNull(),
    );
    expect(document.body.querySelector('.line__sum')).toBeNull();
    expect(document.body.querySelector('.total__sum')).toBeNull();
    expect(document.body.querySelector('.table__total, .figure__strong')).toBeNull();
    expect(document.body.querySelector('[data-testid="cash-sale-warning"]')).toBeNull();
    expect(document.body.querySelector('.pay__btn, .head__pay')).toBeNull();
    expect(text('.head__badges')).toBe('Omborda');
    expect(document.body.querySelectorAll('.client .person__phone').length).toBeGreaterThan(0);
    // roles only in the history: no staff names, no accounting mode, no notification markers
    const history = text('.timeline');
    expect(history).toContain('Menejer');
    expect(history).not.toMatch(/Aziza|Nodira|Rustam/);
    expect(history).not.toContain('Xabar yuborildi');
    expect(history).not.toContain('Buxgalteriya:');
    expect(history).not.toContain("To'lov");
  });

  it('shows the driver only his own order, in the fulfilment view', async () => {
    await mountAt('driver', at('IO-10488'));
    await detailReady('Orion Mobile');
    expect(document.body.querySelector('.line__sum')).toBeNull();
    expect(document.body.querySelectorAll('.client .person__phone').length).toBeGreaterThan(0);
    document.body.innerHTML = '';
    await mountAt('driver', at('IO-10491'));
    await waitFor(() => expect(text('[data-state="empty"]')).toContain('Buyurtma topilmadi'));
  });

  it('keeps the order usable when its timeline fails to load, with a retry just for the timeline', async () => {
    const { orders } = await mountAt('manager', at('IO-10491'));
    await detailReady('Orion Mobile');
    const real = orders.ordersApi.getTimeline.bind(orders.ordersApi);
    orders.ordersApi.getTimeline = () => Promise.reject(new Error('down'));
    // a change makes the page re-read the order and its timeline
    await openApproval();
    await chooseMethod();
    confirmApproval();
    await waitFor(() => expect(text('.timeline-box')).toContain("Tarixni yuklab bo'lmadi."));
    expect(text('.head__badges')).toContain('Buxgalteriyada');
    orders.ordersApi.getTimeline = real;
    Array.from(document.body.querySelectorAll('.timeline-box button'))
      .find((b) => squash(b.textContent) === 'Qayta urinish')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => expect(document.body.querySelectorAll('.event').length).toBeGreaterThan(1));
  });
});
