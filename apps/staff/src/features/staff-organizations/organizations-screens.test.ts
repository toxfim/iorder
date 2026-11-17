import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { dismissToast, undoToast, useToast } from '@core/composables/use-toast';
import { forgetOrganizationsList } from './composables/organizations-list-memory';
import { startMiniApp } from '@core/telegram/mini-app-bridge';
import {
  disableTelegramBackButton,
  enableTelegramBackButton,
} from '@core/telegram/use-back-button';
import { ApiConflictError, ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';

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
  forgetOrganizationsList();
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function mountAt(identity: string, path: string, scenario?: FakeScenario) {
  const { services } = createTestServices({
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
  await vi.waitFor(() =>
    expect(
      document.body.querySelector('.orgs, .page, [data-state]:not([data-state="loading"])'),
    ).not.toBeNull(),
  );
  await flushPromises();
  return { services, router };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
const names = (selector: string): string[] =>
  Array.from(document.body.querySelectorAll(selector)).map((e) => squash(e.textContent));
const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => squash(b.textContent) === label);
const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
};

const NAVOIY = fakeUuid('org:navoiy');
const CHILONZOR = fakeUuid('org:chilonzor');

describe('organizations list', () => {
  it('shows groups waiting for activation first, with the warning banner and the nav count', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    expect(names('.row__name')).toEqual([
      'Buxoro Mobil Savdo', // newest bot-created group
      'Navoiy Elektronika',
      'Dilnoza Yusupova', // staff-created, link not used yet
      'Samarqand Savdo Markazi', // staff-created, link expired
      'Qarshi Aksessuar', // deactivated by staff, still waiting
      'Alisher Karimov',
      'Andijon Telecom',
      'Chilonzor Gadget',
    ]);
    // Only bound inactive groups wait for staff; unbound ones wait for their customer.
    expect(text('[data-testid="waiting-banner"]')).toContain('3 ta guruh');
    expect(document.body.querySelectorAll('.dt__row--warning')).toHaveLength(5);
    expect(services.waitingOrganizationsStore.count.value).toBe(3);
  });

  it('shows the type, label, group, member count and status of a row', async () => {
    await mountAt('manager', '/staff/organizations');
    const row = Array.from(document.body.querySelectorAll('.dt__row')).find((r) =>
      r.textContent?.includes('Navoiy Elektronika'),
    )!;
    const line = squash(row.textContent);
    expect(line).toContain('Guruh');
    expect(line).toContain('Standart');
    expect(line).toContain('-1002001000022');
    expect(line).toContain("2 ta a'zo");
    expect(line).toContain('Faol emas');
  });

  it('searches by name and by chat id, and says so when nothing matches', async () => {
    await mountAt('manager', '/staff/organizations');
    const input = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    await type(input, 'andijon');
    expect(names('.row__name')).toEqual(['Andijon Telecom']);
    await type(input, '-1002001000033');
    expect(names('.row__name')).toEqual(['Buxoro Mobil Savdo']);
    await type(input, 'zzz');
    expect(names('.row__name')).toEqual([]);
    expect(text('.dt__empty')).toBe('Filtrga mos tashkilot topilmadi.');
  });

  it('combines the search with the status filter', async () => {
    await mountAt('manager', '/staff/organizations');
    const input = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    await type(input, 'a');
    const all = names('.row__name');
    expect(all).toContain('Navoiy Elektronika');
    await type(input, '-1002001000022');
    expect(names('.row__name')).toEqual(['Navoiy Elektronika']);
    expect(text('.row__name')).not.toContain('Andijon');
  });

  it('filters by status through the dropdown', async () => {
    await mountAt('manager', '/staff/organizations');
    (
      document.body.querySelector('[aria-haspopup="listbox"][aria-label="Holat"]') as HTMLElement
    ).click();
    await flushPromises();
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.includes('Faol') && !o.textContent.includes('kutilmoqda'),
    ) as HTMLElement;
    option.click();
    await flushPromises();
    expect(names('.row__name')).toEqual(['Alisher Karimov', 'Andijon Telecom', 'Chilonzor Gadget']);
  });

  it('opens an organization', async () => {
    await mountAt('manager', '/staff/organizations');
    const link = Array.from(document.body.querySelectorAll('a.dt__link')).find((a) =>
      a.textContent?.includes('Navoiy'),
    );
    expect(link?.getAttribute('href')).toBe(`/staff/organizations/${NAVOIY}`);
  });

  it('is open to the admin and closed to roles without EDIT_CUSTOMERS', async () => {
    await mountAt('admin', '/staff/organizations');
    expect(document.body.querySelector('.orgs')).not.toBeNull();
    for (const identity of ['accountant', 'warehouse', 'driver']) {
      document.body.innerHTML = '';
      const { router } = await mountAt(identity, '/staff/organizations');
      expect(router.currentRoute.value.name).toBe('forbidden');
    }
  });

  it('handles the empty, error and denied states (and retry)', async () => {
    await mountAt('manager', '/staff/organizations', 'empty');
    expect(text('[data-state="empty"]')).toContain('Hali tashkilot yo');
    wrappers.pop()?.unmount();
    document.body.innerHTML = '';

    await mountAt('manager', '/staff/organizations', 'error');
    expect(document.body.querySelector('[data-state="error"]')).not.toBeNull();
    wrappers.pop()?.unmount();
    document.body.innerHTML = '';

    await mountAt('manager', '/staff/organizations', 'denied');
    expect(document.body.querySelector('[data-state="denied"]')).not.toBeNull();
  });
});

describe('organization detail', () => {
  it('shows the group facts, who added the bot and the members with their roles and phones', async () => {
    await mountAt('manager', `/staff/organizations/${CHILONZOR}`);
    expect(text('.head__title')).toBe('Chilonzor Gadget');
    const facts = text('.facts');
    expect(facts).toContain('-1002001000011');
    expect(facts).toContain('Dilshod Rakhimov');
    const people = names('.person');
    expect(people).toHaveLength(3);
    expect(people[0]).toContain("Do'kon egasi");
    expect(people[0]).toContain('+998 90 111 2233');
    expect(people[1]).toContain('Sotuvchi');
    // The former member comes last, marked as left, and a missing phone says so.
    expect(people[2]).toContain('Chiqqan');
    expect(people[2]).toContain("Telefon yo'q");
    expect(text('.members__count')).toBe("2 ta faol a'zo");
  });

  it('keeps the block dialog mounted while it fades out', async () => {
    await mountAt('manager', `/staff/organizations/${CHILONZOR}`);
    const ask = document.body.querySelector<HTMLButtonElement>('button[aria-label^="Bloklash:"]');
    ask?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="block-choose"]')).not.toBeNull();
    document.body.querySelector<HTMLButtonElement>('.modal__footer button')?.click();
    await flushPromises();
    expect(document.body.querySelector('.modal--closing')).not.toBeNull();
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="modal"]')).toBeNull());
  });

  it('shows the waiting note and who added the bot for a bot-created group', async () => {
    await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    expect(text('.head__note')).toContain('faollashtirilmagan');
    expect(text('.facts')).toContain('Shaxzod Aminov');
    expect(document.body.querySelector('[data-testid="activate"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="deactivate"]')).toBeNull();
  });

  it('activates only after the confirmation, then updates the page, the nav count and toasts', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    const setStatus = vi.spyOn(services.organizationsApi, 'setStatus');
    await services.waitingOrganizationsStore.refresh();
    expect(services.waitingOrganizationsStore.count.value).toBe(3);

    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    expect(setStatus).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text('[role="dialog"]')).toContain('Navoiy Elektronika');

    button('Ha, faollashtirish')!.click();
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(NAVOIY, 'ACTIVE'));
    await flushPromises();
    expect(document.body.querySelector('[data-testid="deactivate"]')).not.toBeNull();
    expect(document.body.querySelector('.head__note')).toBeNull();
    expect(services.waitingOrganizationsStore.count.value).toBe(2);
    expect(useToast().toast.value?.message).toBe('«Navoiy Elektronika» faollashtirildi');
  });

  it('deactivates an active group after the confirmation', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${CHILONZOR}`);
    const setStatus = vi.spyOn(services.organizationsApi, 'setStatus');
    (document.body.querySelector('[data-testid="deactivate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faolsizlantirish')!.click();
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(CHILONZOR, 'INACTIVE'));
    await flushPromises();
    expect(document.body.querySelector('[data-testid="activate"]')).not.toBeNull();
    expect(text('.head__note')).toContain('faollashtirilmagan');
  });

  it('cancelling the dialog changes nothing', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    const setStatus = vi.spyOn(services.organizationsApi, 'setStatus');
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    button('Bekor qilish')!.click();
    await flushPromises();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with a message on 403 and does not change the page', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    vi.spyOn(services.organizationsApi, 'setStatus').mockRejectedValue(new PermissionDeniedError());
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faollashtirish')!.click();
    await flushPromises();
    expect(text('[role="dialog"] [role="alert"]')).toBe("Bu amal uchun ruxsatingiz yo'q.");
    expect(document.body.querySelector('[data-testid="activate"]')).not.toBeNull();
  });

  it('on 409 shows the conflict message and re-reads the organization', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    vi.spyOn(services.organizationsApi, 'setStatus').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT'),
    );
    const get = vi.spyOn(services.organizationsApi, 'get');
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faollashtirish')!.click();
    await flushPromises();
    expect(text('[role="dialog"] [role="alert"]')).toContain("boshqa tomonidan o'zgartirilgan");
    expect(get).toHaveBeenCalledWith(NAVOIY);
  });

  it('closes the dialog when the re-read after a 409 already shows the target status', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    const current = await services.organizationsApi.get(NAVOIY);
    vi.spyOn(services.organizationsApi, 'setStatus').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT'),
    );
    vi.spyOn(services.organizationsApi, 'get').mockResolvedValue({ ...current, status: 'ACTIVE' });
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faollashtirish')!.click();
    // The modal stays in the DOM for its exit animation.
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    expect(document.body.querySelector('[data-testid="deactivate"]')).not.toBeNull();
  });

  it('keeps the dialog open after a 409 when the re-read shows a different status', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    vi.spyOn(services.organizationsApi, 'setStatus').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT'),
    );
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faollashtirish')!.click();
    await flushPromises();
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('sends one request when the confirm button is clicked twice', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    const current = await services.organizationsApi.get(NAVOIY);
    let finish: (value: typeof current) => void = () => undefined;
    const setStatus = vi
      .spyOn(services.organizationsApi, 'setStatus')
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    const confirm = button('Ha, faollashtirish')!;
    confirm.click();
    confirm.click();
    await flushPromises();
    expect(setStatus).toHaveBeenCalledTimes(1);
    finish({ ...current, status: 'ACTIVE' });
    await flushPromises();
    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it('builds the phone link from digits only', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${CHILONZOR}`);
    const current = await services.organizationsApi.get(CHILONZOR);
    const members = current.members.map((m, i) =>
      i === 0 ? { ...m, phone: '+998 90 111-22-33";x' } : m,
    );
    vi.spyOn(services.organizationsApi, 'setStatus').mockResolvedValue({
      ...current,
      status: 'INACTIVE',
      members,
    });
    (document.body.querySelector('[data-testid="deactivate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faolsizlantirish')!.click();
    await flushPromises();
    const link = document.body.querySelector('.person a[href^="tel:"]');
    expect(link?.getAttribute('href')).toBe('tel:+998901112233');
    expect(document.body.querySelector('section.members')?.getAttribute('aria-labelledby')).toBe(
      'members-title',
    );
  });

  it('on 404 during the action leaves the dialog and shows the not-found state', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    vi.spyOn(services.organizationsApi, 'setStatus').mockRejectedValue(
      new ApiNotFoundError('x', 'NOT_FOUND'),
    );
    vi.spyOn(services.organizationsApi, 'get').mockRejectedValue(
      new ApiNotFoundError('x', 'NOT_FOUND'),
    );
    (document.body.querySelector('[data-testid="activate"]') as HTMLElement).click();
    await flushPromises();
    button('Ha, faollashtirish')!.click();
    await flushPromises();
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(text('[data-state="empty"]')).toContain('Tashkilot topilmadi');
  });

  it('shows not-found for an unknown id and denied for the denied scenario', async () => {
    await mountAt('manager', `/staff/organizations/${fakeUuid('missing')}`);
    expect(text('[data-state="empty"]')).toContain('Tashkilot topilmadi');
    expect(document.body.querySelector('[data-state="error"]')).toBeNull();
    wrappers.pop()?.unmount();
    document.body.innerHTML = '';
    await mountAt('manager', `/staff/organizations/${NAVOIY}`, 'denied');
    expect(document.body.querySelector('[data-state="denied"]')).not.toBeNull();
  });
});

const YUSUPOVA = fakeUuid('org:yusupova');
const KARIMOV = fakeUuid('org:karimov');
const SAMARQAND = fakeUuid('org:samarqand');

const testId = (id: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function pick(dropdownLabel: string, optionText: string): Promise<void> {
  (
    document.body.querySelector(
      `[aria-haspopup="listbox"][aria-label="${dropdownLabel}"]`,
    ) as HTMLElement
  ).click();
  await flushPromises();
  const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) =>
    squash(o.textContent).startsWith(optionText),
  ) as HTMLElement;
  option.click();
  await flushPromises();
}

describe('organization types, labels and invites [C, owner 2026-11-11]', () => {
  it('shows the type and label of each row and filters by both', async () => {
    await mountAt('manager', '/staff/organizations');
    expect(text('[data-testid="orgs-info"]')).toBe('8 ta tashkilot · 6 guruh, 2 shaxs');
    await pick('Turi', 'Shaxs');
    expect(names('.row__name')).toEqual(['Dilnoza Yusupova', 'Alisher Karimov']);
    await pick('Label', 'Hamkor');
    expect(names('.row__name')).toEqual(['Alisher Karimov']);
  });

  it('marks an unbound organization as waiting to connect, and filters by it', async () => {
    await mountAt('manager', '/staff/organizations');
    const row = Array.from(document.body.querySelectorAll('.dt__row')).find((r) =>
      r.textContent?.includes('Dilnoza Yusupova'),
    )!;
    expect(squash(row.textContent)).toContain('Ulanmagan');
    expect(squash(row.textContent)).toContain('Ulanish kutilmoqda');
    await pick('Holat', 'Ulanish kutilmoqda');
    expect(names('.row__name')).toEqual(['Dilnoza Yusupova', 'Samarqand Savdo Markazi']);
  });

  it('creates a PERSON with a label and shows its one-time link, then opens its page', async () => {
    const { services, router } = await mountAt('manager', '/staff/organizations');
    const create = vi.spyOn(services.organizationsApi, 'create');
    testId('add-organization')!.click();
    await flushPromises();
    // The label starts at Standart and the save checks the name first.
    expect(button('Standart')?.getAttribute('aria-pressed')).toBe('true');
    testId('create-org-save')!.click();
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(text('[data-testid="create-org-form"]')).toContain('Nomini yozing.');

    (testId('type-PERSON') as HTMLInputElement).click();
    await type(testId('create-org-name')!.querySelector('input')!, '  Sevara Aliyeva ');
    await type(testId('create-org-phone')!.querySelector('input')!, '998901112244');
    button('Ulgurji')!.click();
    await flushPromises();
    testId('create-org-save')!.click();
    await vi.waitFor(() => expect(testId('create-org-done')).not.toBeNull());
    expect(create).toHaveBeenCalledWith({
      type: 'PERSON',
      name: 'Sevara Aliyeva',
      phone: '+998901112244',
      label: 'WHOLESALE',
    });
    const url = (testId('invite-url') as HTMLInputElement).value;
    expect(url).toMatch(/^https:\/\/t\.me\/iorder_demo_bot\?start=org_/);
    expect(text('[data-testid="create-org-done"]')).toContain('Ulgurji');
    expect(text('[data-testid="invite-time-left"]')).toContain('7 kun 0 soat qoldi');

    testId('create-org-open')!.click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('staff-organization'));
  });

  it('gives a GROUP a link that adds the bot to a group', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    testId('add-organization')!.click();
    await flushPromises();
    await type(testId('create-org-name')!.querySelector('input')!, 'Yangi guruh');
    testId('create-org-save')!.click();
    await vi.waitFor(() => expect(testId('invite-url')).not.toBeNull());
    expect((testId('invite-url') as HTMLInputElement).value).toContain('?startgroup=org_');
    const list = await services.organizationsApi.list({ type: 'GROUP', label: 'STANDARD' });
    expect(list.some((o) => o.name === 'Yangi guruh' && o.status === 'INACTIVE')).toBe(true);
  });

  it('shows a pending PERSON with its link, no activation, and makes a new link', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${YUSUPOVA}`);
    await vi.waitFor(() => expect(testId('invite-url')).not.toBeNull());
    expect(text('[data-testid="head-status"]')).toBe('Ulanish kutilmoqda');
    expect(testId('unlinked-note')).not.toBeNull();
    expect(testId('activate')).toBeNull();
    expect(testId('deactivate')).toBeNull();
    expect(text('[data-testid="customer-section"]')).toContain('hali ulanmagan');
    const before = (testId('invite-url') as HTMLInputElement).value;

    const regenerate = vi.spyOn(services.organizationsApi, 'regenerateInvite');
    testId('invite-regenerate')!.click();
    await flushPromises();
    expect(regenerate).not.toHaveBeenCalled();
    button('Ha, yangi havola')!.click();
    await vi.waitFor(() => expect(regenerate).toHaveBeenCalledWith(YUSUPOVA));
    await vi.waitFor(() =>
      expect((testId('invite-url') as HTMLInputElement | null)?.value).not.toBe(before),
    );
    expect(useToast().toast.value?.message).toBe('Yangi havola yaratildi');
  });

  it('changes the type of an unbound organization after the confirmation; the link follows', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${YUSUPOVA}`);
    await vi.waitFor(() => expect(testId('invite-url')).not.toBeNull());
    expect((testId('invite-url') as HTMLInputElement).value).toContain('?start=');
    const update = vi.spyOn(services.organizationsApi, 'update');
    await pick('Turi', 'Guruh');
    expect(update).not.toHaveBeenCalled();
    button("O'zgartirish")!.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(YUSUPOVA, { type: 'GROUP' }));
    await vi.waitFor(() =>
      expect((testId('invite-url') as HTMLInputElement | null)?.value).toContain('?startgroup='),
    );
    expect(useToast().toast.value?.message).toBe("Tur o'zgartirildi: Guruh");
  });

  it('keeps the type of a linked organization read-only', async () => {
    await mountAt('admin', `/staff/organizations/${KARIMOV}`);
    expect(testId('type-dropdown')).toBeNull();
    expect(testId('label-dropdown')).not.toBeNull();
  });

  it('names the reason of a refused new link (already linked) and re-reads the page', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${YUSUPOVA}`);
    await vi.waitFor(() => expect(testId('invite-regenerate')).not.toBeNull());
    vi.spyOn(services.organizationsApi, 'regenerateInvite').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT', undefined, 'ORGANIZATION_ALREADY_LINKED'),
    );
    const get = vi.spyOn(services.organizationsApi, 'get');
    testId('invite-regenerate')!.click();
    await flushPromises();
    button('Ha, yangi havola')!.click();
    await flushPromises();
    expect(text('[role="dialog"] [role="alert"]')).toContain('allaqachon ulangan');
    expect(get).toHaveBeenCalledWith(YUSUPOVA);
  });

  it('names the reason when an unbound organization is activated', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${NAVOIY}`);
    vi.spyOn(services.organizationsApi, 'setStatus').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT', undefined, 'ORGANIZATION_NOT_LINKED'),
    );
    testId('activate')!.click();
    await flushPromises();
    button('Ha, faollashtirish')!.click();
    await flushPromises();
    expect(text('[role="dialog"] [role="alert"]')).toContain('hali ulanmagan');
  });

  it('says an expired link has run out and offers a new one', async () => {
    await mountAt('manager', `/staff/organizations/${SAMARQAND}`);
    await vi.waitFor(() => expect(testId('invite-card')).not.toBeNull());
    expect(text('[data-testid="head-status"]')).toBe("Havola muddati o'tgan");
    expect(testId('invite-url')).toBeNull();
    expect(testId('invite-expired')).not.toBeNull();
    expect(testId('invite-regenerate')).not.toBeNull();
  });

  it('shows the label as text to the manager: only the admin changes it [C, owner 2026-11-12]', async () => {
    await mountAt('manager', `/staff/organizations/${KARIMOV}`);
    expect(testId('label-dropdown')).toBeNull();
    expect(text('.facts')).toContain('Hamkor');
  });

  it('shows a linked PERSON with its customer and lets the admin change the label', async () => {
    const { services } = await mountAt('admin', `/staff/organizations/${KARIMOV}`);
    expect(testId('invite-section')).toBeNull();
    const customer = text('[data-testid="customer-section"]');
    expect(customer).toContain('Alisher Karimov');
    expect(customer).toContain('700100500');
    expect(customer).toContain('+998 93 555 1020');
    expect(text('[data-testid="head-label"]')).toBe('Hamkor');
    const update = vi.spyOn(services.organizationsApi, 'update');
    await pick('Label (narx turi)', 'Standart');
    expect(update).toHaveBeenCalledWith(KARIMOV, { label: 'STANDARD' });
    await flushPromises();
    expect(text('[data-testid="head-label"]')).toBe('Standart');
    expect(useToast().toast.value?.message).toBe("Label o'zgartirildi: Standart");
  });

  it('edits the name and clears the phone', async () => {
    const { services } = await mountAt('manager', `/staff/organizations/${KARIMOV}`);
    const update = vi.spyOn(services.organizationsApi, 'update');
    testId('edit-organization')!.click();
    await flushPromises();
    const inputs = document.body.querySelectorAll<HTMLInputElement>(
      '[data-testid="edit-org-form"] input',
    );
    await type(inputs[1]!, '');
    button('Saqlash')!.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(KARIMOV, { phone: null }));
  });

  it('shows an organization page read-only to the purchasing manager', async () => {
    const { services } = await mountAt('purchasing', `/staff/organizations/${YUSUPOVA}`);
    const getInvite = vi.spyOn(services.organizationsApi, 'getInvite');
    expect(testId('edit-organization')).toBeNull();
    expect(testId('label-dropdown')).toBeNull();
    expect(testId('type-dropdown')).toBeNull();
    expect(testId('invite-url')).toBeNull();
    expect(text('[data-testid="invite-reader"]')).toContain('qoldi');
    expect(getInvite).not.toHaveBeenCalled();
    wrappers.pop()?.unmount();
    document.body.innerHTML = '';
    await mountAt('purchasing', '/staff/organizations');
    expect(testId('add-organization')).toBeNull();
  });
});

describe('type and label right in the list [owner 2026-11-12]', () => {
  const row = (name: string): HTMLElement =>
    Array.from(document.body.querySelectorAll<HTMLElement>('.dt__row')).find((r) =>
      squash(r.querySelector('.row__name')?.textContent).startsWith(name),
    )!;
  // The accessible name carries the current value ("Navoiy Elektronika labeli: Standart"), so
  // the helpers match its start.
  const trigger = (label: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[aria-haspopup="listbox"][aria-label^="${label}:"]`);
  const pickInline = async (label: string, optionText: string): Promise<void> => {
    trigger(label)!.click();
    await flushPromises();
    (
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((o) =>
        squash(o.textContent).startsWith(optionText),
      ) as HTMLElement
    ).click();
    await flushPromises();
  };

  it('lets the admin change a label in its row at once: no reload, the row in place, undo', async () => {
    const { services, router } = await mountAt('admin', '/staff/organizations');
    const update = vi.spyOn(services.organizationsApi, 'update');
    const list = vi.spyOn(services.organizationsApi, 'list');
    const order = names('.row__name');

    await pickInline('Navoiy Elektronika labeli', 'Ulgurji');
    expect(update).toHaveBeenCalledWith(NAVOIY, { label: 'WHOLESALE' });
    await vi.waitFor(() =>
      expect(squash(row('Navoiy Elektronika').textContent)).toContain('Ulgurji'),
    );
    expect(list).not.toHaveBeenCalled();
    expect(names('.row__name')).toEqual(order);
    expect(router.currentRoute.value.name).toBe('staff-organizations');
    expect(useToast().toast.value).toMatchObject({
      message: "Label o'zgartirildi: Ulgurji",
      undoLabel: 'Bekor qilish',
    });

    undoToast();
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(NAVOIY, { label: 'STANDARD' }));
    await vi.waitFor(() =>
      expect(useToast().toast.value?.message).toBe('Label qaytarildi: Standart'),
    );
    expect(useToast().toast.value?.undoLabel).toBeUndefined();
    expect(squash(row('Navoiy Elektronika').textContent)).toContain('Standart');
  });

  it('locks the row control with a spinner while its label is saved', async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    let release: () => void = () => undefined;
    const real = services.organizationsApi.update.bind(services.organizationsApi);
    vi.spyOn(services.organizationsApi, 'update').mockImplementation(
      (id, change) =>
        new Promise((resolve, reject) => {
          release = () => void real(id, change).then(resolve, reject);
        }),
    );
    await pickInline('Andijon Telecom labeli', 'Hamkor');
    const control = row('Andijon Telecom');
    expect(trigger('Andijon Telecom labeli')?.getAttribute('aria-disabled')).toBe('true');
    expect(squash(control.querySelector('[role="status"]')?.textContent)).toBe('Saqlanmoqda…');
    expect(control.querySelector('.inline__spin')).not.toBeNull();
    // A locked control does not open again.
    trigger('Andijon Telecom labeli')!.click();
    await flushPromises();
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    release();
    // The live region stays (so the next save is announced); only its text goes.
    await vi.waitFor(() => expect(control.querySelector('.inline__spin')).toBeNull());
    expect(squash(control.querySelector('[role="status"]')?.textContent)).toBe('');
    expect(trigger('Andijon Telecom labeli')?.hasAttribute('aria-disabled')).toBe(false);
    expect(squash(control.textContent)).toContain('Hamkor');
  });

  it('shows the label as a badge to the manager and the purchasing manager', async () => {
    await mountAt('manager', '/staff/organizations');
    expect(document.body.querySelectorAll('[data-testid="inline-label"]')).toHaveLength(0);
    expect(document.body.querySelectorAll('[data-testid="org-label"]')).toHaveLength(8);
    wrappers.pop()?.unmount();
    document.body.innerHTML = '';
    await mountAt('purchasing', '/staff/organizations');
    expect(document.body.querySelectorAll('[data-testid="inline-label"]')).toHaveLength(0);
    expect(document.body.querySelectorAll('[data-testid="inline-type"]')).toHaveLength(0);
  });

  it('offers the type only where the server says it may change (typeChangeable)', async () => {
    await mountAt('manager', '/staff/organizations');
    const editable = Array.from(
      document.body.querySelectorAll('[data-testid="inline-type"] [aria-haspopup]'),
    ).map((el) => el.getAttribute('aria-label'));
    expect(editable).toEqual([
      'Dilnoza Yusupova turi: Shaxs',
      'Samarqand Savdo Markazi turi: Guruh',
    ]);
  });

  it('changes a type from the list after the confirmation and hands over the new link', async () => {
    const { services, router } = await mountAt('manager', '/staff/organizations');
    const update = vi.spyOn(services.organizationsApi, 'update');
    await pickInline('Dilnoza Yusupova turi', 'Guruh');
    expect(text('[role="dialog"]')).toContain("«Dilnoza Yusupova» turi «Guruh» bo'ladi");
    expect(update).not.toHaveBeenCalled();

    testId('inline-type-confirm')!.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(YUSUPOVA, { type: 'GROUP' }));
    await vi.waitFor(() =>
      expect((testId('invite-url') as HTMLInputElement | null)?.value).toContain('?startgroup='),
    );
    expect(text('[role="dialog"]')).toContain('Yangi ulanish havolasi');
    expect(testId('invite-copy')).not.toBeNull();
    // The row shows the new type in place; the list page stays.
    expect(trigger('Dilnoza Yusupova turi')?.textContent).toContain('Guruh');
    expect(router.currentRoute.value.name).toBe('staff-organizations');

    testId('inline-type-done')!.click();
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  it('cancelling the type dialog changes nothing', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    const update = vi.spyOn(services.organizationsApi, 'update');
    await pickInline('Samarqand Savdo Markazi turi', 'Shaxs');
    button('Bekor qilish')!.click();
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(trigger('Samarqand Savdo Markazi turi')?.textContent).toContain('Guruh');
  });

  it('a refused type change says why, closes and re-reads that row only', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    vi.spyOn(services.organizationsApi, 'update').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT', undefined, 'ORGANIZATION_ALREADY_LINKED'),
    );
    const get = vi.spyOn(services.organizationsApi, 'get');
    const list = vi.spyOn(services.organizationsApi, 'list');
    await pickInline('Dilnoza Yusupova turi', 'Guruh');
    testId('inline-type-confirm')!.click();
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(YUSUPOVA));
    expect(useToast().toast.value?.message).toContain('allaqachon ulangan');
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    expect(list).not.toHaveBeenCalled();
  });

  it('a refused label change says why and re-reads the row; a 403 re-reads nothing', async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    const update = vi
      .spyOn(services.organizationsApi, 'update')
      .mockRejectedValueOnce(new ApiConflictError('x', 'CONFLICT'));
    const get = vi.spyOn(services.organizationsApi, 'get');
    await pickInline('Navoiy Elektronika labeli', 'Hamkor');
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(NAVOIY));
    expect(useToast().toast.value?.message).toContain('boshqa tomonidan');
    expect(squash(row('Navoiy Elektronika').textContent)).toContain('Standart');

    update.mockRejectedValueOnce(new PermissionDeniedError());
    get.mockClear();
    dismissToast();
    await pickInline('Navoiy Elektronika labeli', 'Hamkor');
    await vi.waitFor(() => expect(useToast().toast.value).not.toBeNull());
    expect(get).not.toHaveBeenCalled();
    expect(squash(row('Navoiy Elektronika').textContent)).toContain('Standart');
  });

  it('a click on the inline control or beside it never opens the row; elsewhere it does', async () => {
    const { router } = await mountAt('admin', '/staff/organizations');
    trigger('Navoiy Elektronika labeli')!.click();
    await flushPromises();
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
    (row('Navoiy Elektronika').querySelector('[data-row-control]') as HTMLElement).click();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('staff-organizations');
    // Keyboard: the arrows on the trigger work the dropdown, not the row.
    const control = trigger('Navoiy Elektronika labeli')!;
    control.focus();
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(control);
    expect(router.currentRoute.value.name).toBe('staff-organizations');

    (row('Navoiy Elektronika').querySelectorAll('td')[3] as HTMLElement).click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('staff-organization'));
    expect(router.currentRoute.value.params.organizationId).toBe(NAVOIY);
  });

  it('puts the controls beside the phone card link, never inside it', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: false }) as MediaQueryList,
    });
    const { services, router } = await mountAt('admin', '/staff/organizations');
    const card = Array.from(document.body.querySelectorAll<HTMLElement>('.dt__cards > li')).find(
      (li) => li.textContent?.includes('Dilnoza Yusupova'),
    )!;
    expect(card.querySelector('a.dt__card [aria-haspopup]')).toBeNull();
    const actions = card.querySelector('.dt__card-actions')!;
    expect(
      actions.querySelector('[aria-label="Dilnoza Yusupova labeli: Standart"]'),
    ).not.toBeNull();
    expect(actions.querySelector('[aria-label="Dilnoza Yusupova turi: Shaxs"]')).not.toBeNull();
    const update = vi.spyOn(services.organizationsApi, 'update');
    await pickInline('Dilnoza Yusupova labeli', 'Hamkor');
    expect(update).toHaveBeenCalledWith(YUSUPOVA, { label: 'PARTNER' });
    expect(router.currentRoute.value.name).toBe('staff-organizations');
  });

  it('Enter and Space on the inline trigger open its menu and never open the row', async () => {
    const { services, router } = await mountAt('admin', '/staff/organizations');
    const update = vi.spyOn(services.organizationsApi, 'update');
    const control = trigger('Navoiy Elektronika labeli')!;
    control.focus();
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      control.dispatchEvent(event);
      // A browser turns Enter / Space on a button into its click.
      if (!event.defaultPrevented) control.click();
      await flushPromises();
      expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
      expect(router.currentRoute.value.name).toBe('staff-organizations');
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flushPromises();
      expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    }
    // Open, move to the next option, Enter chooses it: a save, still no navigation.
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flushPromises();
    control.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(NAVOIY, { label: 'WHOLESALE' }));
    expect(router.currentRoute.value.name).toBe('staff-organizations');
  });

  it('takes the undo away when a newer change of the same row starts', async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    await pickInline('Navoiy Elektronika labeli', 'Ulgurji');
    await vi.waitFor(() => expect(useToast().toast.value?.undoLabel).toBe('Bekor qilish'));
    let release: () => void = () => undefined;
    const real = services.organizationsApi.update.bind(services.organizationsApi);
    const update = vi.spyOn(services.organizationsApi, 'update').mockImplementation(
      (id, change) =>
        new Promise((resolve, reject) => {
          release = () => void real(id, change).then(resolve, reject);
        }),
    );
    await pickInline('Navoiy Elektronika labeli', 'Hamkor');
    // While the newer change saves there is no undo to press (it would restore a replaced value).
    expect(useToast().toast.value).toBeNull();
    release();
    await vi.waitFor(() =>
      expect(useToast().toast.value?.message).toBe("Label o'zgartirildi: Hamkor"),
    );
    undoToast();
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(NAVOIY, { label: 'WHOLESALE' }));
  });

  it('says the row may be outdated when its re-read after a refusal fails too', async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    vi.spyOn(services.organizationsApi, 'update').mockRejectedValue(
      new ApiConflictError('x', 'CONFLICT'),
    );
    vi.spyOn(services.organizationsApi, 'get').mockRejectedValue(new Error('offline'));
    await pickInline('Navoiy Elektronika labeli', 'Hamkor');
    await vi.waitFor(() =>
      expect(useToast().toast.value?.message).toBe(
        "Qatorni yangilab bo'lmadi: u eskirgan bo'lishi mumkin. Sahifani yangilang.",
      ),
    );
  });

  it('the type dialog can be closed while the new link is still being read', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    vi.spyOn(services.organizationsApi, 'getInvite').mockReturnValue(new Promise(() => undefined));
    await pickInline('Dilnoza Yusupova turi', 'Guruh');
    testId('inline-type-confirm')!.click();
    await vi.waitFor(() => expect(text('[role="dialog"]')).toContain('Yangi ulanish havolasi'));
    expect(text('[role="dialog"]')).toContain('Yuklanmoqda');
    testId('inline-type-done')!.click();
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });
});

describe('the way back to the list keeps its filters and its place', () => {
  const scrollTo = vi.fn();
  let windowY = 0;
  const tops = new WeakMap<Element, number>();
  beforeEach(() => {
    scrollTo.mockReset();
    windowY = 0;
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => windowY });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        tops.set(this, value);
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'scrollY');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  });

  type TestRouter = Awaited<ReturnType<typeof mountAt>>['router'];
  const openNavoiy = async (router: TestRouter): Promise<void> => {
    Array.from(document.body.querySelectorAll<HTMLElement>('a.dt__link'))
      .find((a) => a.textContent?.includes('Navoiy'))!
      .click();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('staff-organization'));
    await vi.waitFor(() => expect(document.body.querySelector('a.back')).not.toBeNull());
  };
  const leaveListAt = (y: number, tableTop: number): void => {
    windowY = y;
    document.body.querySelector<HTMLElement>('.dt__scroll')!.scrollTop = tableTop;
  };
  const waitForList = async (): Promise<void> => {
    await vi.waitFor(() => expect(document.body.querySelector('.dt__scroll')).not.toBeNull());
    await flushPromises();
  };

  it('keeps the search and the filters in the URL', async () => {
    const { router } = await mountAt('manager', '/staff/organizations?status=INACTIVE&q=bux');
    expect(names('.row__name')).toEqual(['Buxoro Mobil Savdo']);
    const search = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    expect(search.value).toBe('bux');
    await pick('Turi', 'Guruh');
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({
        q: 'bux',
        status: 'INACTIVE',
        type: 'GROUP',
      }),
    );
    await type(search, '');
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ status: 'INACTIVE', type: 'GROUP' }),
    );
    // An unknown value in an old link reads as "all".
    wrappers.pop()?.unmount();
    document.body.innerHTML = '';
    await mountAt('manager', '/staff/organizations?status=nope');
    expect(names('.row__name')).toHaveLength(8);
  });

  it('the back link returns with the filters and the scroll of both boxes', async () => {
    const { router } = await mountAt('manager', '/staff/organizations?q=a');
    leaveListAt(640, 120);
    await openNavoiy(router);
    const back = document.body.querySelector<HTMLAnchorElement>('a.back')!;
    expect(back.getAttribute('href')).toBe('/staff/organizations?q=a');
    back.click();
    await waitForList();
    expect(router.currentRoute.value.fullPath).toBe('/staff/organizations?q=a');
    // After the shell's scroll to the top (a page change), not before it.
    await vi.waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, left: 0 }));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.body.querySelector<HTMLElement>('.dt__scroll')!.scrollTop).toBe(120);
    expect((document.body.querySelector('input[type="search"]') as HTMLInputElement).value).toBe(
      'a',
    );
  });

  it("Telegram's own back button (Mini App) counts as a return too", async () => {
    type BridgeWindow = {
      TelegramWebviewProxy?: { postEvent: (a: string, b: string) => void };
      Telegram?: { WebView?: { receiveEvent?: (type: string, data: string) => void } };
    };
    const bridge = window as unknown as BridgeWindow;
    bridge.TelegramWebviewProxy = { postEvent: () => undefined };
    startMiniApp('8.0');
    enableTelegramBackButton();
    try {
      const { router } = await mountAt('manager', '/staff/organizations?type=GROUP');
      leaveListAt(500, 40);
      await openNavoiy(router);
      bridge.Telegram?.WebView?.receiveEvent?.('back_button_pressed', '');
      await waitForList();
      expect(router.currentRoute.value.fullPath).toBe('/staff/organizations?type=GROUP');
      await vi.waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, left: 0 }));
      expect(document.body.querySelector<HTMLElement>('.dt__scroll')!.scrollTop).toBe(40);
    } finally {
      disableTelegramBackButton();
      delete bridge.TelegramWebviewProxy;
    }
  });

  it('browser back restores the place too', async () => {
    const { router } = await mountAt('manager', '/staff/organizations');
    leaveListAt(300, 0);
    await openNavoiy(router);
    router.back();
    await waitForList();
    await vi.waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, left: 0 }));
  });

  it('follows a navigation to the same page: the sidebar link without a query clears the filters', async () => {
    const { router } = await mountAt('manager', '/staff/organizations?q=bux&type=GROUP');
    expect(names('.row__name')).toEqual(['Buxoro Mobil Savdo']);
    await router.push({ name: 'staff-organizations' });
    await flushPromises();
    expect((document.body.querySelector('input[type="search"]') as HTMLInputElement).value).toBe(
      '',
    );
    expect(names('.row__name')).toHaveLength(8);
    expect(router.currentRoute.value.query).toEqual({});
    await router.push({ name: 'staff-organizations', query: { label: 'PARTNER' } });
    await flushPromises();
    expect(names('.row__name')).toEqual(['Qarshi Aksessuar', 'Alisher Karimov']);
  });

  it('a deliberate click to the list from an organization (sidebar, dashboard) opens it at the top', async () => {
    const { router } = await mountAt('manager', '/staff/organizations');
    leaveListAt(300, 50);
    await openNavoiy(router);
    // The sidebar entry and the dashboard card are plain links to the list (no back link, no pop).
    await router.push({ name: 'staff-organizations' });
    await waitForList();
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 300, left: 0 });
    expect(document.body.querySelector<HTMLElement>('.dt__scroll')!.scrollTop).toBe(0);
  });

  it('starts at the top when the list is reached another way', async () => {
    const { router } = await mountAt('manager', '/staff/organizations');
    leaveListAt(300, 50);
    await openNavoiy(router);
    await router.push({ name: 'staff-profile' });
    await router.push({ name: 'staff-organizations' });
    await waitForList();
    await flushPromises();
    // The shell's own scroll to the top on a page change is all there is.
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 300, left: 0 });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    expect(document.body.querySelector<HTMLElement>('.dt__scroll')!.scrollTop).toBe(0);
  });
});

describe('the row context menu and the archive [C, owner 2026-11-13]', () => {
  const TERMIZ = fakeUuid('org:termiz');
  const row = (name: string): HTMLElement =>
    Array.from(document.body.querySelectorAll<HTMLElement>('.dt__row')).find((r) =>
      squash(r.querySelector('.row__name')?.textContent).startsWith(name),
    )!;
  const menuItems = (): HTMLElement[] =>
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'));
  const menuLabels = (): string[] => menuItems().map((el) => squash(el.textContent));
  async function rightClick(name: string): Promise<void> {
    const cell = row(name).querySelector('td') ?? row(name);
    cell.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
    await flushPromises();
  }
  async function choose(name: string, label: string): Promise<void> {
    await rightClick(name);
    const item = menuItems().find((el) => squash(el.textContent) === label);
    if (!item) throw new Error(`No menu item "${label}". Have: ${menuLabels().join(' | ')}`);
    item.click();
    await flushPromises();
  }
  const dialogButton = (label: string): HTMLButtonElement =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
      (b) => squash(b.textContent) === label,
    )!;
  const pickLabel = async (label: string, optionText: string): Promise<void> => {
    document.body
      .querySelector<HTMLElement>(`[aria-haspopup="listbox"][aria-label^="${label}:"]`)!
      .click();
    await flushPromises();
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((o) => squash(o.textContent).startsWith(optionText))!
      .click();
    await flushPromises();
  };

  it.each([
    [
      'admin',
      [
        'Ochish',
        'Yangi oynada ochish',
        'Nomi va telefonini tahrirlash',
        'Faolsizlantirish',
        "Labelni o'zgartirish",
        'Telegram ID ni nusxalash',
        "O'chirish",
      ],
    ],
    [
      'manager',
      [
        'Ochish',
        'Yangi oynada ochish',
        'Nomi va telefonini tahrirlash',
        'Faolsizlantirish',
        'Telegram ID ni nusxalash',
      ],
    ],
    ['purchasing', ['Ochish', 'Yangi oynada ochish']],
  ])('offers the %s only what the role may do', async (identity, expected) => {
    await mountAt(identity, '/staff/organizations');
    await rightClick('Chilonzor Gadget');
    expect(document.body.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
      'Chilonzor Gadget: amallar',
    );
    expect(menuLabels()).toEqual(expected);
  });

  it('offers activation only to a bound organization, and the type and link while unbound', async () => {
    await mountAt('manager', '/staff/organizations');
    await rightClick('Navoiy Elektronika');
    expect(menuLabels()).toContain('Faollashtirish');
    await rightClick('Dilnoza Yusupova');
    const labels = menuLabels();
    expect(labels).not.toContain('Faollashtirish');
    expect(labels).toContain("Turini o'zgartirish: Guruh");
    expect(labels).toContain('Ulanish havolasini nusxalash');
    expect(labels).not.toContain('Telegram ID ni nusxalash');
  });

  it('activates from the menu after the same confirmation as the detail page', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    const setStatus = vi.spyOn(services.organizationsApi, 'setStatus');
    await choose('Navoiy Elektronika', 'Faollashtirish');
    expect(setStatus).not.toHaveBeenCalled();
    dialogButton('Ha, faollashtirish').click();
    await flushPromises();
    expect(setStatus).toHaveBeenCalledWith(NAVOIY, 'ACTIVE');
    await vi.waitFor(() => expect(squash(row('Navoiy Elektronika').textContent)).toContain('Faol'));
    expect(services.waitingOrganizationsStore.count.value).toBe(2);
  });

  it('copies the invite link of a pending organization', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mountAt('manager', '/staff/organizations');
    await choose('Dilnoza Yusupova', 'Ulanish havolasini nusxalash');
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]?.[0]).toContain('?start=org_');
    expect(useToast().toast.value?.message).toBe('Ulanish havolasi nusxalandi');
  });

  it('archives after the confirmation: the row leaves the list, and undo restores it', async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    const archive = vi.spyOn(services.organizationsApi, 'archive');
    const restore = vi.spyOn(services.organizationsApi, 'restore');
    await choose('Navoiy Elektronika', "O'chirish");
    expect(archive).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(squash(dialog.textContent)).toContain('tarixi saqlanib qoladi');
    expect(squash(dialog.textContent)).toContain('«Arxiv»');
    dialogButton("Ha, o'chirish").click();
    await flushPromises();
    expect(archive).toHaveBeenCalledWith(NAVOIY);
    expect(names('.row__name')).not.toContain('Navoiy Elektronika');
    // The archived group no longer waits for activation.
    expect(services.waitingOrganizationsStore.count.value).toBe(2);
    expect(useToast().toast.value).toMatchObject({
      message: "«Navoiy Elektronika» o'chirildi (arxivga o'tkazildi)",
      undoLabel: 'Bekor qilish',
    });

    undoToast();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledWith(NAVOIY));
    await vi.waitFor(() => expect(names('.row__name')).toContain('Navoiy Elektronika'));
    expect(useToast().toast.value?.message).toContain('arxivdan tiklandi');
  });

  it('never offers the manager to delete, and the fake refuses the manager too', async () => {
    const { services } = await mountAt('manager', '/staff/organizations');
    await rightClick('Navoiy Elektronika');
    expect(menuLabels()).not.toContain("O'chirish");
    await expect(services.organizationsApi.archive(NAVOIY)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('shows the archive in the URL with its badge, and the admin restores from it', async () => {
    const { services, router } = await mountAt('admin', '/staff/organizations');
    expect(names('.row__name')).not.toContain('Termiz Telefon Savdo');
    Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-testid="orgs-view"] button'),
    )
      .find((b) => squash(b.textContent) === 'Arxiv')!
      .click();
    await flushPromises();
    await vi.waitFor(() => expect(names('.row__name')).toEqual(['Termiz Telefon Savdo']));
    expect(router.currentRoute.value.query).toMatchObject({ archived: '1' });
    expect(text('[data-testid="archived-badge"]')).toBe('Arxivlangan');
    expect(document.body.querySelector('[data-testid="archive-note"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="waiting-banner"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="add-organization"]')).toBeNull();

    await rightClick('Termiz Telefon Savdo');
    expect(menuLabels()).toEqual(['Ochish', 'Yangi oynada ochish', 'Tiklash']);
    const restore = vi.spyOn(services.organizationsApi, 'restore');
    menuItems()
      .find((el) => squash(el.textContent) === 'Tiklash')!
      .click();
    await flushPromises();
    expect(restore).toHaveBeenCalledWith(TERMIZ);
    await vi.waitFor(() => expect(names('.row__name')).toEqual([]));
    expect(text('.dt__empty')).toBe("Arxiv bo'sh.");
    expect((await services.organizationsApi.get(TERMIZ)).status).toBe('INACTIVE');
  });

  it('opens the archive straight from the URL; a manager there gets Open only', async () => {
    await mountAt('manager', '/staff/organizations?archived=1');
    await vi.waitFor(() => expect(names('.row__name')).toEqual(['Termiz Telefon Savdo']));
    await rightClick('Termiz Telefon Savdo');
    expect(menuLabels()).toEqual(['Ochish', 'Yangi oynada ochish']);
  });

  it('shows an archived organization read-only with a banner; the admin restores it there', async () => {
    const { services } = await mountAt('admin', `/staff/organizations/${TERMIZ}`);
    expect(document.body.querySelector('[data-testid="archived-banner"]')).not.toBeNull();
    expect(text('[data-testid="head-archived"]')).toBe('Arxivlangan');
    for (const id of ['edit-organization', 'activate', 'archive', 'label-dropdown']) {
      expect(document.body.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
    const restore = vi.spyOn(services.organizationsApi, 'restore');
    (document.body.querySelector('[data-testid="restore"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(restore).toHaveBeenCalledWith(TERMIZ);
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="archived-banner"]')).toBeNull(),
    );
    // Back INACTIVE and unlinked: no activation by hand, the invite section offers a new link
    // (read again now that the page may write); the admin may delete it again.
    expect(document.body.querySelector('[data-testid="activate"]')).toBeNull();
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="invite-regenerate"]')).not.toBeNull(),
    );
    expect(document.body.querySelector('[data-testid="archive"]')).not.toBeNull();
    expect(useToast().toast.value?.message).toContain('hali ulanmagan');
  });

  it('keeps payments open on an archived organization (debt collection) [P]', async () => {
    await mountAt('manager', `/staff/organizations/${TERMIZ}`);
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="record-payment"]')).not.toBeNull(),
    );
  });

  it('the undo of an archive restores that organization even after leaving its page', async () => {
    const { services, router } = await mountAt('admin', `/staff/organizations/${CHILONZOR}`);
    const restore = vi.spyOn(services.organizationsApi, 'restore');
    (document.body.querySelector('[data-testid="archive"]') as HTMLButtonElement).click();
    await flushPromises();
    dialogButton("Ha, o'chirish").click();
    await flushPromises();
    await router.push(`/staff/organizations/${NAVOIY}`);
    await flushPromises();
    undoToast();
    await flushPromises();
    expect(restore).toHaveBeenCalledWith(CHILONZOR);
    expect((await services.organizationsApi.get(CHILONZOR)).archivedAt).toBeNull();
    // The page on screen (Navoiy) is not replaced by the restored one.
    await vi.waitFor(() => expect(text('.head__title')).toBe('Navoiy Elektronika'));
  });

  it('drops a row the server says is archived (a 409 re-read) instead of keeping it editable', async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    // Someone else archived it meanwhile.
    await services.organizationsApi.archive(NAVOIY);
    await pickLabel('Navoiy Elektronika labeli', 'Ulgurji');
    await vi.waitFor(() => expect(names('.row__name')).not.toContain('Navoiy Elektronika'));
    expect(useToast().toast.value?.message).toContain('arxivda');
  });

  it('says so when the undo restores a row the status filter hides', async () => {
    await mountAt('admin', '/staff/organizations?status=ACTIVE');
    await choose('Chilonzor Gadget', "O'chirish");
    dialogButton("Ha, o'chirish").click();
    await flushPromises();
    expect(names('.row__name')).not.toContain('Chilonzor Gadget');
    undoToast();
    await vi.waitFor(() =>
      expect(useToast().toast.value?.message).toContain("filtr tufayli ro'yxatda ko'rinmaydi"),
    );
    expect(names('.row__name')).not.toContain('Chilonzor Gadget');
  });

  it("keeps the header and the switch while the Ro'yxat/Arxiv switch loads", async () => {
    const { services } = await mountAt('admin', '/staff/organizations');
    let release: () => void = () => undefined;
    const list = services.organizationsApi.list.bind(services.organizationsApi);
    vi.spyOn(services.organizationsApi, 'list').mockImplementation(
      (filter) =>
        new Promise((resolve) => {
          release = () => void list(filter).then(resolve);
        }),
    );
    Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-testid="orgs-view"] button'),
    )
      .find((b) => squash(b.textContent) === 'Arxiv')!
      .click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="orgs-view"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="orgs-table-loading"]')).not.toBeNull();
    release();
    await vi.waitFor(() => expect(names('.row__name')).toEqual(['Termiz Telefon Savdo']));
  });

  it('archives from the detail page after the confirmation (admin only)', async () => {
    const { services } = await mountAt('admin', `/staff/organizations/${CHILONZOR}`);
    (document.body.querySelector('[data-testid="archive"]') as HTMLButtonElement).click();
    await flushPromises();
    dialogButton("Ha, o'chirish").click();
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="archived-banner"]')).not.toBeNull(),
    );
    expect((await services.organizationsApi.get(CHILONZOR)).archivedAt).not.toBeNull();
  });

  it('shows the manager an archived organization without restore', async () => {
    await mountAt('manager', `/staff/organizations/${TERMIZ}`);
    expect(document.body.querySelector('[data-testid="restore"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="edit-organization"]')).toBeNull();
    expect(text('[data-testid="archived-banner"]')).toContain('Tarixi saqlangan');
  });
});
