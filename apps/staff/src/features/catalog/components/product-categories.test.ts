import {
  productCategoryListResponseSchema,
  staffProductDetailResponseSchema,
} from '@iorder/shared/staff-cost';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { servicesKey } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import type { ApiConflictError } from '@core/lib/api-errors';
import { createFakePriceBackend } from '@/features/pricing/api/fake-price-backend';
import { createTestServices } from '@/test-utils/create-test-services';
import ProductCategoriesPage from './ProductCategoriesPage.vue';
import ProductsPage from './ProductsPage.vue';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
  dismissToast();
});

const body = (): HTMLElement => document.body;
const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const btn = (label: string): HTMLButtonElement => {
  const found = Array.from(body().querySelectorAll('button')).find(
    (b) => squash(b.textContent) === label || b.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};
const modal = (): HTMLElement | null =>
  body().querySelector('[data-testid="modal"]:not(.modal--closing) [role="dialog"]');
async function type(selector: string, value: string): Promise<void> {
  const input = body().querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`No ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function click(el: HTMLElement | null): Promise<void> {
  el?.click();
  await flushPromises();
}

async function mountPage(component: typeof ProductCategoriesPage | typeof ProductsPage) {
  const made = createTestServices({ identityId: 'manager' });
  await made.services.currentUser.ensureLoaded();
  wrapper = mount(component, {
    attachTo: document.body,
    global: {
      provide: { [servicesKey as symbol]: made.services },
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
  await flushPromises();
  return made;
}

describe('fake catalog: categories and the code rule', () => {
  it('lists the seeded categories with linked product counts, parsed by the shared schema', async () => {
    const { catalogApi } = createFakePriceBackend();
    const list = await catalogApi.listCategories();
    expect(() => productCategoryListResponseSchema.parse(list)).not.toThrow();
    const phones = list.items.find((c) => c.name === 'Telefonlar');
    expect(phones?.productCount).toBeGreaterThan(0);
    expect(list.items.some((c) => !c.isActive)).toBe(true);
  });

  it('adopts unlinked products of the same sheet category without a rule, case-insensitively', async () => {
    const { catalogApi } = createFakePriceBackend();
    const created = await catalogApi.createCategory({
      name: 'AUDIO',
      trackingTypeDefault: 'SERIAL',
      markingRequiredDefault: false,
    });
    expect(created.productCount).toBeGreaterThan(0);
    const audio = (await catalogApi.listProducts()).items.filter((p) => p.category === 'Audio');
    expect(audio.every((p) => p.categoryId === created.id && p.trackingType === 'SERIAL')).toBe(
      true,
    );
    const again = await catalogApi
      .createCategory({
        name: ' audio ',
        trackingTypeDefault: 'NONE',
        markingRequiredDefault: false,
      })
      .catch((e: unknown) => e);
    expect((again as ApiConflictError).reason).toBe('DUPLICATE_CATEGORY_NAME');
  });

  it('keeps linked products when a category changes, refuses an archived one, lets fields win', async () => {
    const { catalogApi, view } = createFakePriceBackend();
    const phones = (await catalogApi.listCategories()).items.find((c) => c.name === 'Telefonlar');
    if (!phones) throw new Error('no phones category');
    await catalogApi.updateCategory(phones.id, { trackingTypeDefault: 'SERIAL' });
    expect(view.productRule('10491')).toEqual({ trackingType: 'IMEI', markingRequired: true });

    const archived = (await catalogApi.listCategories()).items.find((c) => !c.isActive);
    const product = (await catalogApi.listProducts()).items.find((p) => p.productCode === '10482');
    if (!archived || !product) throw new Error('fixtures moved');
    const refused = await catalogApi
      .updateProductTracking(product.id, { categoryId: archived.id })
      .catch((e: unknown) => e);
    expect((refused as ApiConflictError).reason).toBe('CATEGORY_ARCHIVED');

    const linked = await catalogApi.updateProductTracking(product.id, {
      categoryId: phones.id,
      markingRequired: false,
    });
    expect(() => staffProductDetailResponseSchema.parse(linked)).not.toThrow();
    // The category's (new) default identifier, the explicit marking field.
    expect(linked).toMatchObject({
      categoryId: phones.id,
      trackingType: 'SERIAL',
      markingRequired: false,
    });
    expect(view.productRule('10482')).toEqual({ trackingType: 'SERIAL', markingRequired: false });
  });
});

describe('ProductCategoriesPage', () => {
  it('lists categories with their default rule and product count', async () => {
    await mountPage(ProductCategoriesPage);
    const text = squash(body().textContent);
    expect(text).toContain('Tovar kategoriyalari');
    expect(text).toContain('Telefonlar');
    expect(text).toContain('IMEI + asl belgisi');
    expect(text).toContain('Arxivda');
  });

  it('validates the name, creates a category and reports a duplicate name', async () => {
    await mountPage(ProductCategoriesPage);
    await click(btn("Kategoriya qo'shish"));
    expect(modal()?.textContent).toContain('Yangi kategoriya');
    await click(body().querySelector<HTMLButtonElement>('[data-testid="category-submit"]'));
    expect(modal()?.textContent).toContain('Nomini kiriting');

    await type('[data-testid="category-name"]', 'Planshetlar');
    await click(body().querySelector<HTMLElement>('[data-testid="tracking-SERIAL"]'));
    await click(body().querySelector<HTMLButtonElement>('[data-testid="category-submit"]'));
    expect(useToast().toast.value?.message).toBe("Kategoriya qo'shildi");
    expect(modal()).toBeNull();
    expect(squash(body().textContent)).toContain('Planshetlar');

    await click(btn("Kategoriya qo'shish"));
    await type('[data-testid="category-name"]', 'telefonlar');
    await click(body().querySelector<HTMLButtonElement>('[data-testid="category-submit"]'));
    expect(modal()?.textContent).toContain('Bu nomdagi kategoriya allaqachon bor');
  });

  it('archives and restores a category', async () => {
    await mountPage(ProductCategoriesPage);
    await click(btn('Arxivlash: Telefonlar'));
    expect(useToast().toast.value?.message).toBe('Kategoriya arxivlandi');
    await click(btn('Tiklash: Telefonlar'));
    expect(useToast().toast.value?.message).toBe('Kategoriya tiklandi');
  });
});

describe('ProductCategoriesPage: sheet categories without a type', () => {
  const sheetRow = (name: string): HTMLElement => {
    const row = Array.from(
      body().querySelectorAll<HTMLElement>('[data-testid="sheet-category-row"]'),
    ).find((r) => r.textContent?.includes(name));
    if (!row) throw new Error(`No sheet row ${name}`);
    return row;
  };

  it('starts every row with the company rule from the api', async () => {
    await mountPage(ProductCategoriesPage);
    const audio = sheetRow('Audio');
    expect(
      audio.querySelector<HTMLInputElement>('[data-testid="sheet-tracking-SERIAL"]')?.checked,
    ).toBe(true);
    expect(audio.querySelector<HTMLInputElement>('[data-testid="sheet-marking"]')?.checked).toBe(
      false,
    );
    expect(body().querySelector<HTMLButtonElement>('[data-testid="sheet-save"]')?.disabled).toBe(
      false,
    );
  });

  it('saves every row together, with a changed row as chosen; the panel empties', async () => {
    const { price } = await mountPage(ProductCategoriesPage);
    await click(
      sheetRow('Audio').querySelector<HTMLElement>('[data-testid="sheet-tracking-SERIAL"]'),
    );
    await click(sheetRow('Audio').querySelector<HTMLElement>('[data-testid="sheet-marking"]'));
    await click(body().querySelector<HTMLButtonElement>('[data-testid="sheet-save"]'));

    expect(useToast().toast.value?.message).toMatch(/^\d+ ta kategoriya saqlandi$/);
    expect(body().querySelector('[data-testid="sheet-category-row"]')).toBeNull();
    const audio = (await price.catalogApi.listProducts()).items.filter(
      (p) => p.category === 'Audio',
    );
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.every((p) => p.trackingType === 'SERIAL' && p.markingRequired)).toBe(true);
    expect(squash(body().textContent)).toContain('SN + asl belgisi');
  });
});

describe('product dialog: code rule', () => {
  it('shows the rule in the list and saves a changed rule through the tracking route', async () => {
    const { price } = await mountPage(ProductsPage);
    expect(squash(body().textContent)).toContain('IMEI + asl belgisi');
    await click(btn('Tahrirlash: 10482'));
    expect(modal()?.querySelector('[data-testid="code-rule"]')).not.toBeNull();
    await click(modal()?.querySelector<HTMLElement>('[data-testid="tracking-SERIAL"]') ?? null);
    await click(modal()?.querySelector<HTMLElement>('[data-testid="marking-required"]') ?? null);
    await click(btn('Saqlash'));
    expect(modal()).toBeNull();
    expect(price.view.productRule('10482')).toEqual({
      trackingType: 'SERIAL',
      markingRequired: true,
    });
    expect(squash(body().textContent)).toContain('SN + asl belgisi');
  });
});
