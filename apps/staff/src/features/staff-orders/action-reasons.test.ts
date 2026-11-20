import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast } from '@core/composables/use-toast';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { isLocked } from '@/test-utils/locked';
import { orderId, summaryByNumber } from '@/test-utils/orders';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { waitFor } from '@core/test-utils/wait';

// Owner, 2026-11-09: "sometimes the approve button is disabled; on hover the reason must be shown,
// on mobile a modal window must say why". The order page says the first thing to do under the
// button, lists every reason in the button's tooltip (mouse, keyboard) and in a dialog (touch),
// and a locked button never performs its action.

const wrappers: VueWrapper[] = [];

/** What `(hover: none)` answers: a phone unless a test says desktop. */
let hoverless = true;
beforeEach(() => {
  hoverless = true;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({ matches: query.includes('hover: none') ? hoverless : true }) as MediaQueryList,
  });
});
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function openOrder(
  number: string,
  head: string,
  identity = 'manager',
  prepare?: (services: Services) => void,
) {
  await preloadRouteComponents();
  const { services, orders } = createTestServices({
    identityId: identity,
    clock: { now: () => TEST_NOW },
  });
  await services.currentUser.ensureLoaded();
  prepare?.(services);
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(`/staff/orders/${orderId(number)}`);
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await services.ordersStore.load();
  await services.directoryStore.load();
  await waitFor(() => expect(text('.client__name')).toBe(head));
  await flushPromises();
  return { services, orders };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.body.querySelector(`[data-testid="${id}"]`) as T;
const byLabel = (label: string): HTMLElement =>
  document.body.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => squash(b.textContent) === label);
const texts = (selector: string): string[] =>
  Array.from(document.body.querySelectorAll(selector)).map((el) => squash(el.textContent));
// The manager's «Tasdiqlash» in the page header opens the approval dialog; the locks live there.
const openApproval = async (): Promise<void> => {
  byTestId('approve-button').click();
  await waitFor(() => expect(texts('.modal__title')).toContain('Buyurtmani tasdiqlaysizmi?'));
};
const planReady = async (): Promise<void> => {
  await waitFor(() => expect(byTestId('allocation-mode')).not.toBeNull());
};
const chooseMethod = async (): Promise<void> => {
  byTestId('payment-method-CASH').click();
  await flushPromises();
};
const hover = async (target: Element): Promise<void> => {
  target.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  await flushPromises();
};
const tap = async (target: HTMLElement): Promise<void> => {
  target.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  target.click();
  await flushPromises();
};
const closeWhy = async (): Promise<void> => {
  byTestId('blocked-ok').click();
  await waitFor(() => expect(byTestId('blocked-reasons')).toBeNull());
};

const NO_METHOD = 'Savdo turini tanlang: Naqd yoki Official.';
const UNSAVED = "Tarkibdagi o'zgarishlar saqlanmagan. Avval ularni saqlang yoki bekor qiling.";
const PHONE = 'Samsung Galaxy A15 4/128GB';

describe('order page: why approve is locked', () => {
  it('says to choose the sale type under the button, in the tooltip and in the dialog', async () => {
    const { services, orders } = await openOrder('IO-10491', 'Orion Mobile');
    await openApproval();
    await planReady();
    const approveCall = vi.spyOn(orders.ordersApi, 'approve');
    const approve = byTestId('approve-confirm');
    expect(isLocked(approve)).toBe(true);
    expect(text('[data-testid="approve-reason"]')).toBe(NO_METHOD);
    // A screen reader hears the reason with the button.
    const describedBy = approve.getAttribute('aria-describedby') ?? '';
    expect(squash(document.getElementById(describedBy)?.textContent)).toBe(NO_METHOD);

    await hover(approve);
    expect(texts('[role="tooltip"] .tip__line')).toEqual([NO_METHOD]);

    await tap(approve);
    expect(texts('.modal__title')).toContain("Nega tasdiqlab bo'lmaydi?");
    expect(texts('[data-testid="blocked-reasons"] li')).toEqual([NO_METHOD]);
    expect(approveCall).not.toHaveBeenCalled();
    expect(summaryByNumber(services, 'IO-10491')?.status).toBe('SUBMITTED');
    await closeWhy();

    // With the sale type chosen the button is a plain button again and approves.
    await chooseMethod();
    expect(isLocked(approve)).toBe(false);
    expect(byTestId('approve-reason')).toBeNull();
    await tap(approve);
    await waitFor(() => expect(approveCall).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(summaryByNumber(services, 'IO-10491')?.status).toBe('MANAGER_APPROVED'),
    );
  });

  it('puts unsaved item edits first and lists every reason in the dialog, in order', async () => {
    const { services, orders } = await openOrder('IO-10491', 'Orion Mobile');
    const approveCall = vi.spyOn(orders.ordersApi, 'approve');
    byLabel(`${PHONE}: oshirish`).click();
    await waitFor(() => expect(text('.modal__title')).toBe("Buyurtma miqdorini o'zgartirasizmi?"));
    buttonByText("Ha, o'zgartirish")?.click();
    await waitFor(() => expect(document.body.querySelector('.modal__title')).toBeNull());

    // the header's «Tasdiqlash» does not open the dialog while edits are unsaved
    await tap(byTestId('approve-button'));
    expect(texts('[data-testid="blocked-reasons"] li')).toEqual([UNSAVED]);
    expect(texts('.modal__title')).not.toContain('Buyurtmani tasdiqlaysizmi?');
    await closeWhy();

    // Reject is locked by the unsaved edits too, with its own dialog; no reason is asked for.
    const reject = byTestId('reject-button');
    expect(isLocked(reject)).toBe(true);
    await tap(reject);
    expect(texts('.modal__title')).toContain("Nega rad etib bo'lmaydi?");
    expect(texts('[data-testid="blocked-reasons"] li')).toEqual([UNSAVED]);
    expect(document.body.querySelector('textarea')).toBeNull();
    await closeWhy();

    expect(approveCall).not.toHaveBeenCalled();
    expect(summaryByNumber(services, 'IO-10491')?.status).toBe('SUBMITTED');
  });

  it('says the supply plan is still loading, then that it could not be loaded', async () => {
    let fail: (error: Error) => void = () => undefined;
    await openOrder('IO-10491', 'Orion Mobile', 'manager', (services) => {
      vi.spyOn(services.ordersApi, 'getAllocationPreview').mockImplementation(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      );
    });
    await openApproval();
    await chooseMethod();
    expect(isLocked(byTestId('approve-confirm'))).toBe(true);
    expect(text('[data-testid="approve-reason"]')).toBe(
      'Partiyalar rejasi yuklanmoqda. Biroz kuting.',
    );
    fail(new Error('offline'));
    await waitFor(() =>
      expect(text('[data-testid="approve-reason"]')).toBe(
        "Partiyalar rejasini yuklab bo'lmadi. «Qayta urinish»ni bosing.",
      ),
    );
    expect(isLocked(byTestId('approve-confirm'))).toBe(true);
  });

  it('names the product the stock is short of', async () => {
    const { services, orders } = await openOrder('IO-10491', 'Orion Mobile', 'manager', (s) => {
      const real = s.ordersApi.getAllocationPreview.bind(s.ordersApi);
      vi.spyOn(s.ordersApi, 'getAllocationPreview').mockImplementation(async (id) => {
        const preview = await real(id);
        return {
          ...preview,
          feasible: false,
          items: preview.items.map((item) =>
            item.name === PHONE ? { ...item, shortQuantity: '4.000' } : item,
          ),
        };
      });
    });
    await openApproval();
    await waitFor(() => expect(byTestId('allocation-short')).not.toBeNull());
    await chooseMethod();
    const approveCall = vi.spyOn(orders.ordersApi, 'approve');
    expect(text('[data-testid="approve-reason"]')).toBe(
      `«${PHONE}» qoldig'i yetmaydi. Miqdorini kamaytiring yoki buyurtmani rad eting.`,
    );
    await tap(byTestId('approve-confirm'));
    expect(texts('[data-testid="blocked-reasons"] li')).toHaveLength(1);
    expect(approveCall).not.toHaveBeenCalled();
    expect(summaryByNumber(services, 'IO-10491')?.status).toBe('SUBMITTED');
  });

  it('names the product whose supplies do not add up to the ordered quantity', async () => {
    await openOrder('IO-10491', 'Orion Mobile');
    await openApproval();
    await planReady();
    await chooseMethod();
    expect(isLocked(byTestId('approve-confirm'))).toBe(false);
    byTestId('allocation-toggle').click();
    await flushPromises();
    const input = document.body.querySelector('.line__input') as HTMLInputElement;
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(isLocked(byTestId('approve-confirm'))).toBe(true);
    expect(text('[data-testid="approve-reason"]')).toMatch(
      /^«.+»: partiyalardagi miqdor buyurtma miqdoriga teng emas\./,
    );
  });

  it('shows the tooltip, not a dialog, to a mouse click on a desktop', async () => {
    hoverless = false;
    const { orders } = await openOrder('IO-10491', 'Orion Mobile');
    await openApproval();
    await planReady();
    const approveCall = vi.spyOn(orders.ordersApi, 'approve');
    const approve = byTestId('approve-confirm');
    approve.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    approve.click();
    await flushPromises();
    expect(texts('[role="tooltip"] .tip__line')).toEqual([NO_METHOD]);
    expect(byTestId('blocked-reasons')).toBeNull();
    expect(approveCall).not.toHaveBeenCalled();
  });
});

describe('order page: why the release is locked', () => {
  it('asks for the driver, explains on a tap and releases nothing until one is chosen', async () => {
    const { services, orders } = await openOrder('IO-10484', 'Click Store', 'warehouse');
    const releaseCall = vi.spyOn(orders.ordersApi, 'release');
    await waitFor(() => expect(document.body.querySelector('.driver__radio')).not.toBeNull());
    const release = byTestId('release-button');
    await waitFor(() =>
      expect(text('[data-testid="release-reason"]')).toBe('Haydovchini tanlang.'),
    );
    expect(isLocked(release)).toBe(true);

    await tap(release);
    expect(text('.modal__title')).toBe("Nega ombordan chiqarib bo'lmaydi?");
    expect(texts('[data-testid="blocked-reasons"] li')).toEqual(['Haydovchini tanlang.']);
    expect(releaseCall).not.toHaveBeenCalled();
    expect((await orders.ordersApi.getOrder(orderId('IO-10484'))).status).toBe(
      'ACCOUNTING_CLEARED',
    );
    await closeWhy();

    (document.body.querySelector('.actions .driver__radio') as HTMLElement).click();
    await flushPromises();
    expect(isLocked(release)).toBe(false);
    expect(byTestId('release-reason')).toBeNull();
    expect(text('.actions .hint')).toContain('bitta qadamda');
    await tap(release);
    await waitFor(() => expect(summaryByNumber(services, 'IO-10484')?.status).toBe('RELEASED'));
  });
});
