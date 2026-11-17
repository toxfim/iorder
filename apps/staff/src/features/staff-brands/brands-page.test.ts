import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import BrandsPage from '@/features/staff-brands/components/BrandsPage.vue';
import { uz } from '@/i18n/messages/uz';
import { createTestServices } from '@/test-utils/create-test-services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { ApiConflictError } from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

async function mountBrands(
  identity: string,
  options: { scenario?: FakeScenario; prepare?: (services: Services) => void } = {},
) {
  const test = createTestServices({ scenario: options.scenario ?? 'ready', identityId: identity });
  await test.services.currentUser.ensureLoaded();
  options.prepare?.(test.services);
  const wrapper = mount(BrandsPage, {
    attachTo: document.body,
    global: { provide: { [servicesKey as symbol]: test.services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return test;
}

const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const rows = (): HTMLElement[] => Array.from(document.body.querySelectorAll('tbody tr'));
const rowFor = (name: string): HTMLElement => {
  const found = rows().find((row) => text(row).includes(name));
  if (!found) throw new Error(`No row ${name}. Have: ${rows().map(text).join(' | ')}`);
  return found;
};
const pickerOf = (name: string): HTMLInputElement => {
  const input = rowFor(name).querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!input) throw new Error(`No picker in ${name}`);
  return input;
};
/** The options of the open list (each picker teleports its own list to <body>). */
function optionsOf(input: HTMLInputElement): HTMLElement[] {
  const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
}
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function choose(input: HTMLInputElement, label: string): Promise<void> {
  const option = optionsOf(input).find((o) => text(o) === label);
  if (!option)
    throw new Error(`No option "${label}". Have: ${optionsOf(input).map(text).join(' | ')}`);
  option.click();
  await flushPromises();
}
const toastText = (): string => useToast().toast.value?.message ?? '';

describe('Brendlar page', () => {
  it('explains the rule and lists the products, priced ones first with a marker', async () => {
    await mountBrands('manager');
    expect(document.body.textContent).toContain(uz.brands.explanation);
    const names = rows().map((row) => text(row.querySelector('.name')));
    expect(names.slice(0, 2)).toEqual(['FreeBuds 6i Black', 'Mi Wi-Fi Range Extender Pro CE']);
    expect(text(rowFor('FreeBuds 6i Black'))).toContain(uz.brands.inPriceList);
    expect(text(rowFor('Echo Buds 2 White'))).not.toContain(uz.brands.inPriceList);
    expect(text(rowFor('MagGo Power Bank'))).toContain(uz.brands.noCategory);
  });

  it('searches the brands, saves the picked one and drops the row', async () => {
    const test = await mountBrands('admin');
    const set = vi.spyOn(test.services.brandsApi, 'setProductBrand');
    const input = pickerOf('FreeBuds 6i Black');
    expect(input.getAttribute('aria-label')).toBe('FreeBuds 6i Black: brend');

    await typeInto(input, 'hua');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // "Hua" names no brand exactly, so creating it is offered after the match.
    expect(optionsOf(input).map(text)).toEqual(['Huawei', 'Yangi brend yaratish: «hua»']);

    await choose(input, 'Huawei');
    expect(set).toHaveBeenCalledTimes(1);
    expect(rows().some((row) => text(row).includes('FreeBuds 6i Black'))).toBe(false);
    expect(toastText()).toBe('FreeBuds 6i Black: brend «Huawei»');
  });

  it('keyboard: arrows and Enter pick, an exact name offers no creation', async () => {
    await mountBrands('manager');
    const input = pickerOf('Echo Buds 2 White');
    await typeInto(input, 'XIAOMI');
    expect(optionsOf(input).map(text)).toEqual(['Xiaomi']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect(toastText()).toBe('Echo Buds 2 White: brend «Xiaomi»');
  });

  it('creates a typed brand, assigns it and offers it in the other rows', async () => {
    const test = await mountBrands('manager');
    const create = vi.spyOn(test.services.brandsApi, 'createBrand');
    await typeInto(pickerOf('Redmi 15C'), ' Redmi ');
    await choose(pickerOf('Redmi 15C'), 'Yangi brend yaratish: «Redmi»');
    expect(create).toHaveBeenCalledWith('Redmi');
    expect(rows().some((row) => text(row).includes('Redmi 15C'))).toBe(false);
    expect(toastText()).toBe('Redmi 15C 8/256GB Midnight Black: brend «Redmi»');

    const other = pickerOf('Echo Buds 2 White');
    await typeInto(other, 'red');
    expect(optionsOf(other).map(text)).toEqual(['Redmi', 'Yangi brend yaratish: «red»']);
  });

  it('409 DUPLICATE_BRAND_NAME: reads the brands again and uses the existing one', async () => {
    const test = await mountBrands('manager');
    const api = test.services.brandsApi;
    const original = api.createBrand.bind(api);
    // Someone else creates "Redmi" between this page's read and its create.
    vi.spyOn(api, 'createBrand').mockImplementation(async (name) => {
      await original(name);
      throw new ApiConflictError('exists', 'CONFLICT', undefined, 'DUPLICATE_BRAND_NAME');
    });
    const set = vi.spyOn(api, 'setProductBrand');
    await typeInto(pickerOf('Echo Buds 2 White'), 'redmi');
    await choose(pickerOf('Echo Buds 2 White'), 'Yangi brend yaratish: «redmi»');
    expect(set).toHaveBeenCalledTimes(1);
    expect(rows().some((row) => text(row).includes('Echo Buds 2 White'))).toBe(false);
    expect(toastText()).toBe('Echo Buds 2 White: brend «redmi»');
  });

  it('a failed save keeps the row and says why', async () => {
    const test = await mountBrands('manager');
    vi.spyOn(test.services.brandsApi, 'setProductBrand').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT', undefined, 'DUPLICATE_BRAND_NAME'),
    );
    await typeInto(pickerOf('Echo Buds 2 White'), 'jbl');
    await choose(pickerOf('Echo Buds 2 White'), 'JBL');
    expect(rowFor('Echo Buds 2 White')).toBeTruthy();
    expect(pickerOf('Echo Buds 2 White').disabled).toBe(false);
    expect(toastText()).toBe(
      'Bunday nomli brend allaqachon bor (harf registri hisobga olinmaydi).',
    );
  });

  it('shows the empty, error and permission-denied states', async () => {
    await mountBrands('manager', { scenario: 'empty' });
    expect(document.body.textContent).toContain(uz.brands.empty.title);
    wrappers.splice(0).forEach((w) => w.unmount());

    await mountBrands('manager', { scenario: 'error' });
    expect(document.body.textContent).toContain('Qayta urinish');
    wrappers.splice(0).forEach((w) => w.unmount());

    // The accountant reaches no brand call: the server (the fake, like the api) refuses it.
    await mountBrands('accountant');
    expect(document.body.querySelector('table')).toBeNull();
    expect(document.body.textContent).toContain('Bu sahifa sizning rolingiz uchun yopiq.');
    expect(document.body.textContent).not.toContain('FreeBuds 6i Black');
  });
});
