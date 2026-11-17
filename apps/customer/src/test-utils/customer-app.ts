import type { PaymentPlan } from '@iorder/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { dismissToast } from '@core/composables/use-toast';
import { createFakeCustomerBackend } from '@/features/customer-app/api/fake-customer-backend';
import { assembleCustomerServices } from '@/features/customer-app/assemble-services';
import CustomerApp from '@/features/customer-app/components/CustomerApp.vue';
import { createCustomerRouter } from '@/features/customer-app/router';
import { customerServicesKey } from '@/features/customer-app/services';
import { INIT_DATA_STORAGE_KEY, forgetInitData, readInitData } from '@core/telegram/launch';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { fakeUuid } from '@core/lib/fake-ids';
import { customerUz } from '@/features/customer-app/messages/uz';

export const CUSTOMER_TEST_NOW = new Date('2026-10-19T04:30:00.000Z');

const wrappers: VueWrapper[] = [];

/** Call once at the top of a customer screens test file. */
export function useCustomerTestLifecycle(): void {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: true }) as MediaQueryList,
    });
    forgetInitData();
  });
  afterEach(() => {
    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';
    dismissToast();
    forgetInitData();
    window.sessionStorage.clear();
  });
}

export interface MountOptions {
  readonly pageSize?: number;
  readonly seedProblemCart?: boolean;
  readonly seedReceivedGoods?: boolean;
  readonly scenario?: FakeScenario;
  /**
   * The cart's plan at the start. The flows tested here are about other things, so they start with
   * one chosen; a test of the choice itself passes null, which is what a real customer starts with.
   */
  readonly plan?: PaymentPlan | null;
  /** Wraps or spies on the fake backend before the stores are built around it. */
  readonly decorate?: (backend: ReturnType<typeof createFakeCustomerBackend>) => void;
}

/** The whole customer app over the fake backend; `initData` null means "not opened from Telegram". */
export async function mountCustomerApp(
  initData: string | null,
  path: string,
  options: MountOptions = {},
) {
  if (initData !== null) window.sessionStorage.setItem(INIT_DATA_STORAGE_KEY, initData);
  const backend = createFakeCustomerBackend({
    clock: { now: () => CUSTOMER_TEST_NOW },
    initData: readInitData,
    pageSize: options.pageSize,
    seedReceivedGoods: options.seedReceivedGoods,
    seedProblemCart: options.seedProblemCart ?? false,
    scenario: options.scenario === undefined ? undefined : () => options.scenario as FakeScenario,
  });
  options.decorate?.(backend);
  const services = assembleCustomerServices(backend);
  const plan = options.plan === undefined ? 'FULL' : options.plan;
  if (plan !== null) services.cart.choosePlan(plan);
  const router = createCustomerRouter(createMemoryHistory());
  await router.push(path);
  const wrapper = mount(CustomerApp, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [customerServicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, backend, services, router };
}

/** The id the fake gives to a seeded order. */
export const seededOrderId = (number: number): string => fakeUuid(`customer-order:IO-${number}`);

export const bodyText = (): string => document.body.textContent ?? '';

export function findButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`No button containing "${label}"`);
  return found;
}

/** A button inside the open dialog (the page behind it may have a button with the same label). */
export function findModalButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('.modal button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`No dialog button containing "${label}"`);
  return found as HTMLButtonElement;
}

export async function click(element: Element): Promise<void> {
  (element as HTMLElement).click();
  await flushPromises();
}

/** Explicit second step used by the existing submission/contact flow tests. */
export async function confirmCartSubmission(): Promise<void> {
  await flushPromises();
  await click(findModalButton(customerUz.cart.confirmAction));
}

export async function typeInto(element: Element, value: string): Promise<void> {
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}
