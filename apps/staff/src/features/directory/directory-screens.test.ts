import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { dismissToast, undoToast, useToast } from '@core/composables/use-toast';
import { forgetCustomersList } from './composables/customers-list-memory';
import { createAppRouter } from '@/router';
import { fakeUuid } from '@core/lib/fake-ids';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { orderId, summaryByNumber } from '@/test-utils/orders';

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
  forgetCustomersList();
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function mountAt(identity: string, path: string, scenario?: 'error') {
  const { services, back } = createTestServices({
    identityId: identity,
    scenario,
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
  await services.ordersStore.load();
  await services.directoryStore.load();
  await vi.waitFor(() =>
    expect(
      document.body.querySelector(
        '.page, [class$="s"][class*="customers"], .customers, [data-state]',
      ),
    ).not.toBeNull(),
  );
  await flushPromises();
  return { services, router, back };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
// Rows of the orders card, not of the members card or the payment history.
const orderRows = (): Element[] =>
  Array.from(document.body.querySelectorAll('[data-testid="org-orders"] tbody tr'));
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => squash(b.textContent) === label);
const names = (selector: string): string[] =>
  Array.from(document.body.querySelectorAll(selector)).map((e) => squash(e.textContent));
const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
};

describe('customers list: people, not organizations [owner 2026-11-13]', () => {
  const personNames = (): string[] => names('tbody .name');
  const orgFilter = (): HTMLInputElement =>
    document.body.querySelector('[data-testid="organization-filter"] input') as HTMLInputElement;
  // The picker's own listbox (it stays in the DOM, hidden, while closed).
  const options = (): HTMLElement[] =>
    Array.from(
      document
        .getElementById(orgFilter().getAttribute('aria-controls') ?? '')
        ?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );

  it('lists the people with their organization, role and status, sorted by name', async () => {
    await mountAt('manager', '/staff/customers');
    // The directory fake's people plus the active members of the Tashkilotlar fake.
    expect(text('[data-testid="customers-info"]')).toBe('18 ta mijoz · 12 ta tashkilot');
    const all = personNames();
    expect(all).toHaveLength(18);
    expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b)));
    expect(all).toContain('Dilshod Rakhimov');
    // A member who LEFT (Chilonzor's former seller) is no customer any more.
    expect(all).not.toContain('Ulugbek Sodiqov');
    const jasur = squash(
      Array.from(document.body.querySelectorAll('tbody .dt__row')).find((r) =>
        r.textContent?.includes('Jasur Karimov'),
      )?.textContent,
    );
    expect(jasur).toContain('Orion Mobile');
    expect(jasur).toContain("Do'kon egasi");
    expect(jasur).toContain('Faol');
    expect(jasur).toContain('+998 90 351');
    const kamola = Array.from(document.body.querySelectorAll('tbody .dt__row')).find((r) =>
      r.textContent?.includes('Kamola Ergasheva'),
    );
    expect(squash(kamola?.textContent)).toContain('Bloklangan');
    expect(squash(kamola?.textContent)).toContain('Sotuvchi');
  });

  it('marks a PERSON customer with the person badge and shows no shop-owner role', async () => {
    await mountAt('manager', '/staff/customers');
    const badges = Array.from(document.body.querySelectorAll('[data-testid="person-badge"]'));
    expect(
      badges.map((b) => squash(b.closest('.dt__row')?.querySelector('.name')?.textContent)),
    ).toEqual(['Alisher Karimov', 'Nodir Qosimov']);
    expect(squash(badges[0]?.textContent)).toBe('Shaxs');
    expect(squash(badges[0]?.closest('.dt__row')?.textContent)).not.toContain("Do'kon egasi");
  });

  it('drops the people of an organization archived on Tashkilotlar, also after an undo', async () => {
    const { router } = await mountAt('admin', `/staff/organizations/${fakeUuid('org:chilonzor')}`);
    (document.body.querySelector('[data-testid="archive"]') as HTMLButtonElement).click();
    await flushPromises();
    buttonByText("Ha, o'chirish")!.click();
    await flushPromises();
    await router.push('/staff/customers');
    await vi.waitFor(() => expect(personNames()).toHaveLength(16));
    expect(personNames()).not.toContain('Dilshod Rakhimov');
    expect(personNames()).not.toContain('Feruza Nazarova');
    expect(text('[data-testid="customers-info"]')).toBe('16 ta mijoz · 11 ta tashkilot');
    // The restore brings the organization back unlinked: its former members stay former.
    undoToast();
    await flushPromises();
    await vi.waitFor(() =>
      expect(text('[data-testid="customers-info"]')).toBe('16 ta mijoz · 11 ta tashkilot'),
    );
  });

  it('returns from a person to the list with its filters; a PERSON back link says Mijozlar', async () => {
    const { router } = await mountAt('manager', '/staff/customers?kind=persons');
    expect(personNames()).toEqual(['Alisher Karimov', 'Nodir Qosimov']);
    await router.push(
      `/staff/customers/${fakeUuid('org-person-nodir')}/members/${fakeUuid('u-161')}`,
    );
    await flushPromises();
    const back = document.body.querySelector('.page a') as HTMLAnchorElement;
    expect(squash(back.textContent)).toContain('Mijozlar');
    expect(back.getAttribute('href')).toBe('/staff/customers?kind=persons');
  });

  it('a person opened from the organization card goes back to that card', async () => {
    const { router } = await mountAt('manager', `/staff/customers/${fakeUuid('org-orion-mobile')}`);
    await router.push(
      `/staff/customers/${fakeUuid('org-orion-mobile')}/members/${fakeUuid('u-101')}`,
    );
    await flushPromises();
    const back = document.body.querySelector('.page a') as HTMLAnchorElement;
    expect(squash(back.textContent)).toContain('Orion Mobile');
    expect(back.getAttribute('href')).toBe(`/staff/customers/${fakeUuid('org-orion-mobile')}`);
  });

  it('links each person to their member page', async () => {
    await mountAt('manager', '/staff/customers');
    const link = document.body.querySelector('tbody a.dt__link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      `/staff/customers/${fakeUuid('org-mobile-center')}/members/${fakeUuid('u-111')}`,
    );
  });

  it('searches by name, phone and organization name and shows the empty text', async () => {
    await mountAt('manager', '/staff/customers');
    const input = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    await type(input, 'lola');
    expect(personNames()).toEqual(['Lola Saidova']);
    await type(input, '97 715');
    expect(personNames()).toEqual(['Javlon Sobirov']);
    await type(input, 'gsm plus');
    expect(personNames()).toEqual(['Javlon Sobirov', 'Kamola Ergasheva']);
    await type(input, 'zzz');
    expect(text('.dt__empty')).toBe('Filtrga mos mijoz topilmadi');
  });

  it('filters by organization through the searchable picker, keeps it in the URL and clears it', async () => {
    const { router } = await mountAt('manager', '/staff/customers');
    // Tab focus alone does not open the list.
    orgFilter().focus();
    await flushPromises();
    expect(orgFilter().getAttribute('aria-expanded')).toBe('false');
    orgFilter().click();
    await flushPromises();
    expect(squash(options()[0]?.textContent)).toBe('Barcha tashkilotlar');
    // The count is read with its unit.
    expect(
      squash(options().find((o) => o.textContent?.includes('Orion Mobile'))?.textContent),
    ).toBe('Orion Mobile33 kishi');
    await type(orgFilter(), 'mobile c');
    expect(options().map((o) => squash(o.textContent))).toEqual([
      'Mobile Center Samarqand22 kishi',
    ]);
    options()[0]!.click();
    await flushPromises();
    expect(personNames()).toEqual(['Akmal Nurmatov', 'Lola Saidova']);
    expect(router.currentRoute.value.query).toMatchObject({ org: fakeUuid('org-mobile-center') });
    expect(orgFilter().value).toBe('Mobile Center Samarqand');

    const clear = document.body.querySelector(
      '[data-testid="filter-combobox-clear"]',
    ) as HTMLElement;
    expect(clear.getAttribute('aria-label')).toBe('Tashkilot filtrini tozalash');
    clear.click();
    await flushPromises();
    expect(personNames()).toHaveLength(18);
    expect(router.currentRoute.value.query.org).toBeUndefined();
  });

  it('opens filtered by organization from the URL (the link of an organization page)', async () => {
    await mountAt('manager', `/staff/customers?org=${fakeUuid('org-orion-mobile')}`);
    expect(personNames()).toEqual(['Bobur Aliyev', 'Dilnoza Rahimova', 'Jasur Karimov']);
    expect(orgFilter().value).toBe('Orion Mobile');
  });

  it('names an organization of the URL that is not among the options, never "all"', async () => {
    await mountAt('manager', `/staff/customers?org=${fakeUuid('org-nope')}`);
    expect(orgFilter().value).toBe("Noma'lum tashkilot");
    expect(text('.dt__empty')).toBe('Filtrga mos mijoz topilmadi');
  });

  it('keyboard: ArrowDown opens, Home/End jump, Escape closes, leaving the field closes', async () => {
    await mountAt('manager', '/staff/customers');
    const key = async (k: string): Promise<void> => {
      orgFilter().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await flushPromises();
    };
    orgFilter().focus();
    await key('ArrowDown');
    expect(orgFilter().getAttribute('aria-expanded')).toBe('true');
    await key('End');
    const last = options().length - 1;
    expect(orgFilter().getAttribute('aria-activedescendant')).toBe(options()[last]?.id);
    await key('Home');
    expect(orgFilter().getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    await key('Escape');
    expect(orgFilter().getAttribute('aria-expanded')).toBe('false');
    await key('ArrowDown');
    const search = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    orgFilter().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: search }));
    await flushPromises();
    expect(orgFilter().getAttribute('aria-expanded')).toBe('false');
  });

  it('filters persons apart from organization members, and by status', async () => {
    await mountAt('manager', '/staff/customers?kind=persons');
    expect(personNames()).toEqual(['Alisher Karimov', 'Nodir Qosimov']);
    document.body.innerHTML = '';
    await mountAt('manager', '/staff/customers?kind=members&status=blocked');
    expect(personNames()).toEqual(['Kamola Ergasheva', 'Ulugʻbek Haydarov']);
  });

  it('links an organization page to its people', async () => {
    await mountAt('manager', `/staff/customers/${fakeUuid('org-orion-mobile')}`);
    const link = document.body.querySelector(
      '[data-testid="org-people-link"]',
    ) as HTMLAnchorElement;
    expect(squash(link.textContent)).toBe("Mijozlarini ko'rish");
    expect(link.getAttribute('href')).toBe(`/staff/customers?org=${fakeUuid('org-orion-mobile')}`);
  });

  it('shows the error state', async () => {
    await mountAt('manager', '/staff/customers', 'error');
    expect(document.body.querySelector('[data-state="error"]')).not.toBeNull();
  });
});

describe('organization card', () => {
  it('shows the header facts, two tiles, the server balance and the members card', async () => {
    await mountAt('manager', `/staff/customers/${fakeUuid('org-orion-mobile')}`);
    expect(text('.head__title')).toBe('Orion Mobile');
    expect(text('.head__meta')).toBe('Telegram guruhi: @idealmobile_opt · 03.2026 dan beri');
    expect(names('.tile')).toEqual(["A'zolar3", 'Buyurtmalar4']);
    // The debt is the server's balance (received orders minus payments), not a sum in the page.
    expect(text('[data-testid="balance-due"]')).toBe("Qarzdorlik yo'q");
    expect(document.body.querySelector('.notice')).toBeNull();
    expect(names('.row__name')).toEqual(['Jasur Karimov', 'Dilnoza Rahimova', 'Bobur Aliyev']);
    expect(squash(document.body.querySelector('tbody tr')?.textContent)).toContain("Do'kon egasi");
  });

  it('shows member phones grouped in the table column', async () => {
    await mountAt('manager', `/staff/customers/${fakeUuid('org-orion-mobile')}`);
    expect(squash(document.body.querySelector('tbody tr')?.textContent)).toContain(
      '+998 90 351 2210',
    );
  });

  it('lists the orders in their own card with links to the order page', async () => {
    await mountAt('manager', `/staff/customers/${fakeUuid('org-orion-mobile')}`);
    const rows = orderRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]?.querySelector('a.dt__link')?.getAttribute('href')).toBe(
      `/staff/orders/${orderId('IO-10491')}`,
    );
  });

  it('hides the UNPAID badge on rejected and cancelled orders, keeps it on open ones', async () => {
    const { services } = await mountAt(
      'manager',
      `/staff/customers/${fakeUuid('org-orion-mobile')}`,
    );
    const order = summaryByNumber(services, 'IO-10491');
    if (!order) throw new Error('IO-10491 is missing');
    await services.ordersStore.reject(order, 'Narx eskirgan');
    await flushPromises();
    const rows = orderRows();
    const badges = (id: string): string[] =>
      Array.from(
        rows.find((r) => r.textContent?.includes(id))?.querySelectorAll('.badge') ?? [],
      ).map((b) => squash(b.textContent));
    expect(badges('IO-10491')).toEqual(['Rad etildi']);
    const open = rows.find((r) => !r.textContent?.includes('IO-10491'));
    expect(open?.textContent).toMatch(/To'lanmagan|To'langan/);
  });

  it('warns when the organization has no active shop owner', async () => {
    await mountAt('manager', `/staff/customers/${fakeUuid('org-smart-zone')}`);
    expect(text('.notice')).toContain("Do'kon egasi tayinlanmagan");
  });

  it('blocks and re-activates with a toast and an undo', async () => {
    const { services } = await mountAt(
      'manager',
      `/staff/customers/${fakeUuid('org-orion-mobile')}`,
    );
    buttonByText('Bloklash')?.click();
    await vi.waitFor(() =>
      expect(services.directoryStore.organization(fakeUuid('org-orion-mobile'))?.isActive).toBe(
        false,
      ),
    );
    expect(useToast().toast.value?.message).toBe('Orion Mobile bloklandi');
    await vi.waitFor(() => expect(buttonByText('Faollashtirish')).toBeDefined());
    useToast().toast.value?.onUndo?.();
    await vi.waitFor(() =>
      expect(services.directoryStore.organization(fakeUuid('org-orion-mobile'))?.isActive).toBe(
        true,
      ),
    );
  });

  it('ignores a second block click while the first request runs (disabled + aria-busy)', async () => {
    const { services, back } = await mountAt(
      'manager',
      `/staff/customers/${fakeUuid('org-orion-mobile')}`,
    );
    const original = back.directoryApi.setOrganizationActive.bind(back.directoryApi);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async (...args: Parameters<typeof original>) => {
      await gate;
      return original(...args);
    });
    back.directoryApi.setOrganizationActive = slow;
    const button = buttonByText('Bloklash') as HTMLButtonElement;
    button.click();
    await flushPromises();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    button.click();
    release();
    await vi.waitFor(() =>
      expect(services.directoryStore.organization(fakeUuid('org-orion-mobile'))?.isActive).toBe(
        false,
      ),
    );
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('says so when the organization does not exist', async () => {
    await mountAt('manager', '/staff/customers/nope');
    await vi.waitFor(() => expect(text('[data-state="empty"]')).toContain('Tashkilot topilmadi'));
  });
});

describe('member profile', () => {
  it('shows contact facts, role picker, status and the orders placed', async () => {
    await mountAt(
      'manager',
      `/staff/customers/${fakeUuid('org-orion-mobile')}/members/${fakeUuid('u-101')}`,
    );
    expect(text('.who__name')).toBe('Jasur Karimov');
    expect(names('.tile')).toEqual([
      'Telefon+998 90 351 2210',
      'Telegram@jasur_k',
      "Qo'shilgan12.03.2026",
      'Buyurtmalar2',
    ]);
    expect(document.body.querySelector('.seg__item--on')?.textContent?.trim()).toBe("Do'kon egasi");
    expect(document.body.querySelectorAll('.card--list a.row')).toHaveLength(2);
  });

  it('changes the role (with undo) and blocks the member', async () => {
    const { services } = await mountAt(
      'manager',
      `/staff/customers/${fakeUuid('org-orion-mobile')}/members/${fakeUuid('u-101')}`,
    );
    buttonByText('Sotuvchi')?.click();
    await vi.waitFor(() =>
      expect(services.directoryStore.member(fakeUuid('u-101'))?.role).toBe('SELLER'),
    );
    expect(useToast().toast.value?.message).toBe('Jasur Karimov endi Sotuvchi');
    useToast().toast.value?.onUndo?.();
    await vi.waitFor(() =>
      expect(services.directoryStore.member(fakeUuid('u-101'))?.role).toBe('SHOP_OWNER'),
    );
    // Blocking opens the confirmation dialog first; nothing changes until it is confirmed.
    buttonByText('Bloklash')?.click();
    await flushPromises();
    expect(services.directoryStore.member(fakeUuid('u-101'))?.isActive).toBe(true);
    (document.body.querySelector('[data-testid="block-confirm"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(services.directoryStore.member(fakeUuid('u-101'))?.isActive).toBe(false),
    );
  });
});
