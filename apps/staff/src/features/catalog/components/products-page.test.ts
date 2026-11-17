import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { servicesKey } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { createTestServices } from '@/test-utils/create-test-services';
import ProductsPage from './ProductsPage.vue';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
  dismissToast();
});

async function mountPage() {
  const { services } = createTestServices({ identityId: 'manager' });
  await services.currentUser.ensureLoaded();
  wrapper = mount(ProductsPage, {
    attachTo: document.body,
    global: { provide: { [servicesKey as symbol]: services } },
  });
  await flushPromises();
}

const body = (): HTMLElement => document.body;
const btn = (label: string): HTMLButtonElement => {
  const found = Array.from(body().querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
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
async function click(el: HTMLElement): Promise<void> {
  el.click();
  await flushPromises();
}

describe('ProductsPage', () => {
  it('lists products with the product code in monospace, unit and an inactive badge', async () => {
    await mountPage();
    expect(body().textContent).toContain('10483');
    expect(body().querySelector('.row__code')?.classList.contains('mono')).toBe(true);
    expect(body().textContent).toContain('Faol emas');
  });

  it('creates a product with the code as entered (no upper-casing) and shows it in the list', async () => {
    await mountPage();
    await click(btn("Tovar qo'shish"));
    expect(modal()?.textContent).toContain('Yangi tovar');
    // The hint comes from the shared rule and says nothing about upper case.
    expect(modal()?.textContent).toContain("ko'pi bilan 64 ta");
    expect(modal()?.textContent).toContain('. _ / -');
    expect(modal()?.textContent).not.toMatch(/katta harf/i);

    await type('input[id$="-productCode"]', '  New-Code-9 ');
    expect(body().querySelector<HTMLInputElement>('input[id$="-productCode"]')?.value).toBe(
      '  New-Code-9 ',
    );
    // One common name, no unit (pieces only) and no per-language names.
    expect(body().querySelector('input[id$="-unit"]')).toBeNull();
    expect(body().querySelector('input[id$="-name-UZ"]')).toBeNull();
    await type('input[id$="-name"]', 'Yangi tovar');
    await click(btn("Qo'shish"));

    expect(useToast().toast.value?.message).toBe("Tovar qo'shildi");
    expect(body().textContent).toContain('New-Code-9');
    expect(modal()).toBeNull();
  });

  it('validates with the shared schema and reports a duplicate product code on the field', async () => {
    await mountPage();
    await click(btn("Tovar qo'shish"));
    await click(btn("Qo'shish"));
    expect(modal()?.textContent).toContain("Tovar ID noto'g'ri");
    expect(modal()?.textContent).toContain("Nomini kiriting (ko'pi bilan 200 belgi)");

    // Same code as an existing one, with stray spaces: a duplicate.
    await type('input[id$="-productCode"]', ' 10490 ');
    await type('input[id$="-name"]', 'x');
    await click(btn("Qo'shish"));
    expect(modal()?.textContent).toContain('Bu Tovar ID allaqachon mavjud');
  });

  it('edits the common name but keeps the product code read-only', async () => {
    await mountPage();
    await click(btn('Tahrirlash: 10490'));
    const productCode = body().querySelector<HTMLInputElement>('input[id$="-productCode"]');
    expect(productCode?.readOnly).toBe(true);
    expect(productCode?.value).toBe('10490');

    await type('input[id$="-name"]', 'Cordless mouse');
    await click(btn('Saqlash'));
    expect(useToast().toast.value?.message).toBe('Tovar yangilandi');
    expect(body().textContent).toContain('10490');
  });

  it('asks before deactivating and activates directly', async () => {
    await mountPage();
    await click(btn('Nofaol qilish: 10490'));
    expect(modal()?.textContent).toContain('Tovar nofaol qilinsinmi?');
    await click(modal()?.querySelector<HTMLButtonElement>('.btn--danger') as HTMLButtonElement);
    expect(useToast().toast.value?.message).toBe('Tovar nofaol qilindi');

    await click(btn('Faollashtirish: 10490'));
    expect(useToast().toast.value?.message).toBe('Tovar faollashtirildi');
  });
});
