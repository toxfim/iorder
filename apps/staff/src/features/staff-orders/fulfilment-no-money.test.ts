import { config, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import type { AppI18n } from '@core/i18n';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { waitFor } from '@core/test-utils/wait';
import { preloadRouteComponents } from '@/test-utils/preload-routes';

// F-07 / hard rule 7-style check for the fulfilment roles: the warehouse and the driver never see
// an order total, a unit price or the payment status (work-log default; question 29 is still
// open). The text of every page they can open is searched for money, payment words and amounts.

const wrappers: VueWrapper[] = [];
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true }) as MediaQueryList,
  });
});
afterEach(() => {
  (config.global.plugins[0] as AppI18n).global.locale.value = 'uz';
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

const Shell = defineComponent({ render: () => h(RouterView) });

// The exact labels the app prints for money and payment, read from the message catalog of the
// language under test. Broad words ("price", "paid") would collide with product names.
const MONEY_LABEL_KEYS = [
  'common.currency',
  'orders.payment.PAID',
  'orders.payment.UNPAID',
  'orders.detail.items.price',
] as const;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function moneyLabels(i18n: AppI18n): RegExp {
  // A key that does not resolve would turn into its own name and silently weaken the check.
  for (const key of MONEY_LABEL_KEYS) {
    if (!i18n.global.te(key)) throw new Error(`Unknown message key ${key}`);
  }
  const labels = MONEY_LABEL_KEYS.map((key) => i18n.global.t(key));
  // Whole words only, unicode-aware (a plain \b does not work for Cyrillic).
  const body = labels.map(escapeRegExp).join('|');
  return new RegExp(String.raw`(?<![\p{L}\d])(${body})(?![\p{L}\d])`, 'iu');
}
// A grouped amount such as "7 675 000" or "126 001,75".
const GROUPED_AMOUNT = /\d{1,3}(\s\d{3}){2,}/; // \s also matches a no-break space

async function openAndRead(identity: string, path: string): Promise<string> {
  await preloadRouteComponents();
  const { services } = createTestServices({
    identityId: identity,
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
  await services.ordersStore.loadFor({
    queue: ['ACCOUNTING_CLEARED', 'RELEASED'],
    recent: ['DELIVERED', 'RECEIVED'],
  });
  await waitFor(() =>
    expect(document.body.querySelector('.card, .orders, .client__name')).not.toBeNull(),
  );
  // Open every card so the detail (items, contact) is part of the text as well.
  for (const button of Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.card__buttons .btn'),
  )) {
    if (button.getAttribute('aria-expanded') === 'false') button.click();
  }
  await flushPromises();
  await flushPromises();
  const listText = document.body.textContent?.replace(/\s+/g, ' ') ?? '';
  // And the full order page behind the first card's "Ochish".
  const href = document.body.querySelector('a.btn--link')?.getAttribute('href');
  if (!href) return listText;
  await router.push(href);
  await waitFor(() => expect(document.body.querySelector('.client__name')).not.toBeNull());
  await flushPromises();
  return `${listText} ${document.body.textContent?.replace(/\s+/g, ' ') ?? ''}`;
}

describe('warehouse and driver pages show no money and no payment status', () => {
  it.each([
    ['warehouse', '/staff/warehouse', 'uz'],
    ['driver', '/staff/deliveries', 'uz'],
    ['warehouse', '/staff/warehouse', 'ru'],
    ['driver', '/staff/deliveries', 'ru'],
    ['warehouse', '/staff/warehouse', 'en'],
    ['driver', '/staff/deliveries', 'en'],
  ] as const)('%s: %s (%s)', async (identity, path, locale) => {
    const i18n = config.global.plugins[0] as AppI18n;
    i18n.global.locale.value = locale;
    const labels = moneyLabels(i18n);
    const content = await openAndRead(identity, path);
    // the order page behind the last link: its v8 panels were drawn
    expect(document.body.querySelectorAll('.panel').length).toBeGreaterThan(0);
    expect(content).not.toMatch(labels);
    // grouped phones (+998 90 351 2210) look like grouped amounts: they are not money
    expect(content.replace(/\+\d{3}( \d+)+/g, '')).not.toMatch(GROUPED_AMOUNT);
  });
});
