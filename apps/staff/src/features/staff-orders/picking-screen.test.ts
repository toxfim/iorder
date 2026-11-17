import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { ApiConflictError } from '@core/lib/api-errors';
import { isLocked } from '@/test-utils/locked';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { orderId, summaryByNumber } from '@/test-utils/orders';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { waitFor } from '@core/test-utils/wait';
import { demoImei } from './api/fake-picking';

// The warehouse scanner screen on the order page: a hardware scanner types a code and presses
// Enter; the cursor moves on by itself; refused scans stay listed; the release waits for the codes.

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

async function mountOrder(identity: string, number: string) {
  await preloadRouteComponents();
  const made = createTestServices({
    identityId: identity,
    clock: { now: () => TEST_NOW },
    pickingDemo: true,
  });
  await made.services.currentUser.ensureLoaded();
  const router = createAppRouter(made.services.currentUser, createMemoryHistory());
  await router.push(`/staff/orders/${orderId(number)}`);
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: made.services } },
  });
  wrappers.push(wrapper);
  await made.services.ordersStore.load();
  await waitFor(() => expect(document.body.querySelector('.head__org')).not.toBeNull());
  await flushPromises();
  return made;
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
const inputs = (): HTMLInputElement[] =>
  Array.from(document.body.querySelectorAll<HTMLInputElement>('.slot__input'));
const labelOf = (input: Element | null): string =>
  squash(input?.closest('.slot')?.querySelector('.slot__label')?.textContent);
const unitOf = (input: Element | null): string | null =>
  input?.closest('.unit')?.getAttribute('data-unit') ?? null;
const releaseButton = (): HTMLButtonElement =>
  document.body.querySelector('[data-testid="release-button"]') as HTMLButtonElement;

/** What a keyboard-wedge scanner does: type the code into the focused field, then Enter. */
async function scan(value: string): Promise<void> {
  const field = document.activeElement as HTMLInputElement;
  expect(field.classList.contains('slot__input')).toBe(true);
  field.value = value;
  field.dispatchEvent(new Event('input'));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flushPromises();
}

async function pickDriver(): Promise<void> {
  (document.body.querySelector('.actions .driver__radio') as HTMLElement).click();
  await flushPromises();
}

/** The selected line shows one unit at a time; its chip opens another one. */
async function openUnit(no: number): Promise<void> {
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.unit-chip'))
    .find((b) => squash(b.textContent) === `${no}-dona`)
    ?.click();
  await flushPromises();
}

describe('warehouse picking screen', () => {
  it('starts in the first IMEI field and moves IMEI 1 -> marking -> next unit, skipping IMEI 2', async () => {
    await mountOrder('warehouse', 'IO-10500');
    await waitFor(() => expect(text('[data-testid="picking-progress"]')).toBe('Tayyor: 0/3 dona'));
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('IMEI 1'));
    expect(unitOf(document.activeElement)).toBe('1');

    await scan(demoImei(501));
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('Asl belgisi (marking)'));
    expect(unitOf(document.activeElement)).toBe('1');
    await waitFor(() => expect(text('[data-testid="picking-panel"]')).toContain(demoImei(501)));

    await scan('0104600000000501215ABC\u001d93Zz');
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('IMEI 1'));
    expect(unitOf(document.activeElement)).toBe('2');
    await waitFor(() => expect(text('[data-testid="picking-progress"]')).toBe('Tayyor: 1/3 dona'));
    expect(text('[data-testid="picking-announce"]')).toContain('Saqlandi');
    // IMEI 2 of the first phone is still offered, just never an auto-advance target.
    await openUnit(1);
    expect(inputs().some((i) => labelOf(i) === 'IMEI 2 (ixtiyoriy)' && unitOf(i) === '1')).toBe(
      true,
    );
  });

  it('keeps refused scans on screen with the reason and leaves the cursor for the rescan', async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    const { orders } = await mountOrder('warehouse', 'IO-10500');
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('IMEI 1'));
    const record = vi.spyOn(orders.ordersApi, 'recordUnitCode');

    await scan('123456789012345');
    expect(record).not.toHaveBeenCalled();
    expect(labelOf(document.activeElement)).toBe('IMEI 1');
    expect(unitOf(document.activeElement)).toBe('1');
    expect(text('[data-testid="picking-rejected"]')).toContain(
      "IMEI noto'g'ri (nazorat raqami mos emas). Qayta skanerlang.",
    );
    expect(text('[data-testid="picking-rejected"]')).toContain('123456789012345');
    expect(document.body.querySelector('.slot--error')).not.toBeNull();
    expect(vibrate).toHaveBeenLastCalledWith([120, 60, 120]);

    // The same IMEI on a second unit: refused at once, before the server.
    await scan(demoImei(502));
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('Asl belgisi (marking)'));
    await openUnit(2);
    expect(labelOf(document.activeElement)).toBe('IMEI 1');
    expect(unitOf(document.activeElement)).toBe('2');
    await scan(demoImei(502));
    expect(text('[data-testid="picking-rejected"]')).toContain(
      'Bu kod shu buyurtmada allaqachon bor',
    );
    expect(document.body.querySelectorAll('.rejected__item')).toHaveLength(2);
    expect(vibrate).toHaveBeenCalledWith(40);

    // The list stays until the person clears it.
    Array.from(document.body.querySelectorAll('button'))
      .find((b) => squash(b.textContent) === "Ro'yxatni tozalash")
      ?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="picking-rejected"]')).toBeNull();
  });

  it('keeps the release button disabled until every code is scanned, then releases', async () => {
    const { services } = await mountOrder('warehouse', 'IO-10500');
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('IMEI 1'));
    await pickDriver();
    expect(isLocked(releaseButton())).toBe(true);
    expect(text('[data-testid="release-codes-missing"]')).toContain('Tayyor: 0/3');

    // Choosing the driver took the focus; a tap puts it back into the first field.
    inputs()[0]?.focus();
    await scan(demoImei(601));
    await scan('0104600000000601215AAA\u001d93Zz');
    await scan(demoImei(602));
    await scan('0104600000000602215BBB\u001d93Zz');
    expect(isLocked(releaseButton())).toBe(true);
    await waitFor(() => expect(labelOf(document.activeElement)).toBe('Seriya raqami (SN)'));
    await scan('TV-0000601');
    await waitFor(() => expect(text('[data-testid="picking-progress"]')).toBe('Tayyor: 3/3 dona'));
    await waitFor(() => expect(isLocked(releaseButton())).toBe(false));
    expect(document.body.querySelector('[data-testid="release-codes-missing"]')).toBeNull();

    releaseButton().click();
    await waitFor(() => expect(summaryByNumber(services, 'IO-10500')?.status).toBe('RELEASED'));
  });

  it('re-reads the codes and names the missing lines when the server refuses the release', async () => {
    const { orders } = await mountOrder('warehouse', 'IO-10484');
    await pickDriver();
    await waitFor(() => expect(isLocked(releaseButton())).toBe(false));
    const getPicking = vi.spyOn(orders.ordersApi, 'getPicking');
    orders.ordersApi.release = () =>
      Promise.reject(
        new ApiConflictError(
          'Unit codes are missing',
          'CONFLICT',
          { items: [{ itemId: 'x', productCode: '10489', incompleteUnits: 3 }] },
          'UNIT_CODES_INCOMPLETE',
        ),
      );
    releaseButton().click();
    await waitFor(() =>
      expect(useToast().toast.value?.message).toBe(
        "Ombordan chiqarib bo'lmadi: kodlar yetishmaydi (10489).",
      ),
    );
    await waitFor(() => expect(getPicking).toHaveBeenCalled());
  });

  it('shows the codes read-only to the manager and hides them from the driver', async () => {
    await mountOrder('manager', 'IO-10500');
    await waitFor(() =>
      expect(text('[data-testid="picking-read-only"]')).toContain('faqat omborchi'),
    );
    expect(inputs()).toHaveLength(0);
    expect(text('[data-testid="picking-panel"]')).toContain('Skanerlanmagan');
    expect(document.body.querySelector('[data-testid="release-button"]')).toBeNull();
    document.body.innerHTML = '';
    // A released seed order: the driver sees his order, never its codes.
    await mountOrder('driver', 'IO-10488');
    expect(document.body.querySelector('[data-testid="picking-panel"]')).toBeNull();
  });
});
