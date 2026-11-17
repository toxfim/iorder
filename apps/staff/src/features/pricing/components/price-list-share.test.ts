import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import PricesPage from '@/features/pricing/components/PricesPage.vue';
import { createTestServices } from '@/test-utils/create-test-services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { PermissionDeniedError } from '@core/lib/api-errors';

const wrappers: VueWrapper[] = [];
const saved: { href: string; download: string }[] = [];

beforeEach(() => {
  saved.length = 0;
  // jsdom has no object URLs and does not download: record what would have been saved.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:test/1'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

async function mountPrices(identity: string, prepare?: (services: Services) => void) {
  const test = createTestServices({ identityId: identity });
  await test.services.currentUser.ensureLoaded();
  prepare?.(test.services);
  const stub = { render: () => h('p') };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/prices', component: PricesPage },
      { path: '/versions', name: 'staff-price-versions', component: stub },
      { path: '/products', name: 'staff-products', component: stub },
      { path: '/newer-models', name: 'staff-newer-models', component: stub },
      { path: '/stock', name: 'staff-stock', component: stub },
    ],
  });
  await router.push('/prices');
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: test.services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return test;
}

const byTestId = (id: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const toastText = (): string => useToast().toast.value?.message ?? '';
const dialog = (): HTMLElement | null =>
  document.body.querySelector('[data-testid="modal"]:not(.modal--closing) [role="dialog"]');
async function click(el: HTMLElement | null): Promise<void> {
  if (!el) throw new Error('nothing to click');
  el.click();
  await flushPromises();
}
const dialogButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(dialog()?.querySelectorAll('button') ?? []).find((b) => text(b) === label);

async function downloadTier(tier: 'STANDARD' | 'WHOLESALE_PARTNER'): Promise<void> {
  await click(byTestId('download-excel'));
  await click(byTestId(`download-excel-${tier}`));
}

describe('Narxlar: Excel file and posting to the groups', () => {
  it('the accountant downloads the file of either tier but cannot post it', async () => {
    const test = await mountPrices('accountant');
    const download = vi.spyOn(test.services.priceListShareApi, 'downloadExcel');
    expect(text(byTestId('download-excel'))).toBe('Excel yuklab olish');
    expect(byTestId('post-to-groups')).toBeNull();

    await click(byTestId('download-excel'));
    expect(text(byTestId('download-excel-STANDARD'))).toContain('Standart');
    expect(text(byTestId('download-excel-WHOLESALE_PARTNER'))).toContain('Ulgurji / Hamkor');
    await click(byTestId('download-excel-STANDARD'));
    expect(download).toHaveBeenLastCalledWith('STANDARD');
    // The fake names its demo file; the real api sends the .xlsx name in Content-Disposition.
    expect(saved).toEqual([
      { href: 'blob:test/1', download: expect.stringMatching(/^iorder-narxlar-v\d+-demo\.csv$/) },
    ]);
    expect(toastText()).toMatch(/^Fayl yuklab olindi: iorder-narxlar-v\d+-demo\.csv$/);

    await downloadTier('WHOLESALE_PARTNER');
    expect(download).toHaveBeenLastCalledWith('WHOLESALE_PARTNER');
    expect(saved[1]?.download).toMatch(/^iorder-narxlar-v\d+-ulgurji-demo\.csv$/);
  });

  it('uses iorder-price-<Tashkent date>.xlsx when the server names no file', async () => {
    await mountPrices('manager', (services) => {
      vi.spyOn(services.priceListShareApi, 'downloadExcel').mockResolvedValue({
        blob: new Blob(['x']),
        fileName: null,
      });
    });
    await downloadTier('STANDARD');
    expect(saved.map((s) => s.download)).toEqual(['iorder-price-2026-10-19.xlsx']);
  });

  it('a failed download saves nothing and says why', async () => {
    await mountPrices('manager', (services) => {
      vi.spyOn(services.priceListShareApi, 'downloadExcel').mockRejectedValue(
        new PermissionDeniedError(),
      );
    });
    await downloadTier('WHOLESALE_PARTNER');
    expect(saved).toEqual([]);
    expect(toastText()).toBe("Bu amal uchun ruxsatingiz yo'q.");
  });

  it('the manager sees who gets the file per tier and chat kind, confirms, and the toast counts the chats', async () => {
    const test = await mountPrices('manager');
    const post = vi.spyOn(test.services.priceListShareApi, 'postToGroups');
    const version = (await test.services.pricingApi.getCurrent()).version.number;

    await click(byTestId('post-to-groups'));
    expect(text(dialog())).toContain("Narx ro'yxati yuborilsinmi?");
    expect(text(dialog())).toContain("guruhlarga guruhning o'ziga, shaxslarga bot lichkasiga");
    // The demo organizations: two bound active groups (Standart, Ulgurji) and one bound partner
    // PERSON receive it; two without a chat and three inactive ones are left out.
    expect(text(byTestId('recipients-STANDARD'))).toBe('Standart1');
    expect(text(byTestId('recipients-WHOLESALE_PARTNER'))).toBe('Ulgurji / Hamkor2');
    expect(text(byTestId('recipients-GROUP'))).toBe('Guruhlarga2');
    expect(text(byTestId('recipients-PRIVATE'))).toBe('Shaxslarga (lichka)1');
    expect(text(byTestId('recipients-skipped'))).toBe(
      "O'tkazib yuboriladi: 2 ta ulanmagan, 3 ta nofaol, 0 ta narx yuborish o'chirilgan, 0 ta narxi yo'q turdagi tashkilot.",
    );
    expect(post).not.toHaveBeenCalled();

    await click(dialogButton('Yuborish (3)') ?? null);
    expect(post).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(toastText()).toBe(`Narx ro'yxati v${version} yuborilmoqda: 3 ta chat`);
  });

  it('still lets the manager send when the recipients cannot be counted', async () => {
    const test = await mountPrices('manager', (services) => {
      vi.spyOn(services.priceListShareApi, 'recipients').mockRejectedValue(new Error('down'));
    });
    const post = vi.spyOn(test.services.priceListShareApi, 'postToGroups');
    await click(byTestId('post-to-groups'));
    expect(text(byTestId('post-recipients'))).toContain("Qabul qiluvchilarni sanab bo'lmadi");
    await click(dialogButton('Yuborish') ?? null);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a refused post keeps the dialog open with the reason', async () => {
    await mountPrices('admin', (services) => {
      vi.spyOn(services.priceListShareApi, 'postToGroups').mockRejectedValue(
        new PermissionDeniedError(),
      );
    });
    await click(byTestId('post-to-groups'));
    await click(dialogButton('Yuborish (3)') ?? null);
    expect(text(dialog())).toContain("Bu amal uchun ruxsatingiz yo'q.");
  });

  it('says so when no organization receives the list', async () => {
    await mountPrices('manager', (services) => {
      vi.spyOn(services.priceListShareApi, 'postToGroups').mockResolvedValue({
        versionNumber: 4,
        queuedGroupCount: 0,
        recipients: {
          total: 0,
          byTier: { STANDARD: 0, WHOLESALE_PARTNER: 0, ALIF_FACTORING: 0 },
          byDestination: { GROUP: 0, PRIVATE: 0 },
        },
        skipped: { unbound: 0, inactive: 0, postingOff: 0, noPrices: 0 },
      });
    });
    await click(byTestId('post-to-groups'));
    await click(dialogButton('Yuborish (3)') ?? null);
    expect(toastText()).toBe(
      "Narx ro'yxatini qabul qiladigan tashkilot yo'q: hech narsa yuborilmadi.",
    );
  });
});
