import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { StaffAccountResponse } from '@iorder/shared/staff-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { ApiConflictError, PermissionDeniedError } from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { fakeUuid } from '@core/lib/fake-ids';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import type { StaffAccountsApi } from './api/staff-accounts-api';
import type { StaffUsersApi } from './api/staff-users-api';

const wrappers: VueWrapper[] = [];
const ADMIN = fakeUuid('staff-account:admin');
const MANAGER = fakeUuid('staff-account:manager');
const DRIVER = fakeUuid('staff-account:driver');
const BLOCKED = fakeUuid('staff-account:blocked-driver');

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
  vi.restoreAllMocks();
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function mountAccounts(
  identity: string,
  options: {
    scenario?: FakeScenario;
    accounts?: Partial<StaffAccountsApi>;
    users?: Partial<StaffUsersApi>;
  } = {},
) {
  const { services: base } = createTestServices({
    identityId: identity,
    scenario: options.scenario,
    clock: { now: () => TEST_NOW },
  });
  await base.currentUser.ensureLoaded();
  const services: Services = {
    ...base,
    staffAccountsApi: { ...base.staffAccountsApi, ...options.accounts },
    staffUsersApi: { ...base.staffUsersApi, ...options.users },
  };
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push('/staff/employees');
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await vi.waitFor(() =>
    expect(
      document.body.querySelector('.accounts, [data-state]:not([data-state="loading"])'),
    ).not.toBeNull(),
  );
  await flushPromises();
  return { services, router };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const q = <T extends Element>(selector: string): T | null =>
  document.body.querySelector<T>(selector);
const text = (selector: string): string => squash(q(selector)?.textContent);
const rows = (): string[] =>
  Array.from(document.body.querySelectorAll('tbody .dt__row')).map((r) => squash(r.textContent));
const rowOf = (name: string): HTMLElement =>
  Array.from(document.body.querySelectorAll<HTMLElement>('tbody .dt__row')).find((r) =>
    r.textContent?.includes(name),
  ) as HTMLElement;
const click = async (el: Element | null): Promise<void> => {
  (el as HTMLElement).click();
  await flushPromises();
};
const clickId = (id: string): Promise<void> => click(q(`[data-testid="${id}"]`));
// Row actions live in the row's "more" menu, which is teleported to <body> while open.
const openMenu = (name: string): Promise<void> =>
  click(rowOf(name).querySelector('[data-testid="account-menu"]'));
const menuItem = (id: string): HTMLElement | null => q(`[role="menu"] [data-testid="${id}"]`);
async function action(name: string, id: string): Promise<void> {
  await openMenu(name);
  await click(menuItem(id));
}
const field = (label: string): HTMLInputElement => {
  const l = Array.from(document.body.querySelectorAll('label')).find((e) =>
    squash(e.textContent).startsWith(label),
  );
  return document.body.querySelector(
    `#${CSS.escape(l?.getAttribute('for') ?? 'none')}`,
  ) as HTMLInputElement;
};
const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
};
const checkbox = (role: string): HTMLInputElement | null =>
  q<HTMLInputElement>(`input[type="checkbox"][data-role="${role}"]`);

async function fillValid(login = 'yangi@iorder.uz', telegramId = '700123456'): Promise<void> {
  await type(field("To'liq ism"), 'Yangi Xodim');
  await type(field('Login'), login);
  await type(field('Parol'), 'correct-horse-battery');
  await click(checkbox('DRIVER'));
  // Mandatory since 2026-10-28: the bot tells staff from customers in groups by this id.
  await type(field('Telegram ID'), telegramId);
}

describe('staff accounts page: who sees what', () => {
  it('lists the accounts for an administrator with badges, password and Telegram facts', async () => {
    await mountAccounts('admin');
    expect(text('.head__title')).toBe('Xodimlar');
    expect(text('.head__info')).toBe('7 ta hisob');
    expect(rows()).toHaveLength(7);
    const admin = squash(rowOf('Rahmatulla Qosimov').textContent);
    expect(admin).toContain('admin@iorder.uz');
    expect(admin).toContain('Administrator');
    expect(admin).toContain('Faol');
    expect(admin).toContain("O'rnatilgan");
    expect(admin).toContain('Ulangan');
    const driver = squash(rowOf('Temur Boboyev').textContent);
    expect(driver).toContain("O'rnatilmagan");
    expect(driver).toContain('Hali kirmagan');
    expect(squash(rowOf('Sardorbek Hamidov').textContent)).toContain('Bloklangan');
    expect(squash(rowOf('Ravshan Haydarov').textContent)).toContain('Ulanmagan');
  });

  it('opens for a manager too, but an accountant is refused by the route', async () => {
    await mountAccounts('manager');
    expect(rows()).toHaveLength(7);
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    const { router } = await mountAccounts('accountant');
    expect(router.currentRoute.value.name).toBe('forbidden');
  });

  it('shows the server refusal as the permission-denied state', async () => {
    const list = vi.fn().mockRejectedValue(new PermissionDeniedError());
    await mountAccounts('manager', { accounts: { list } });
    expect(q('[data-state="denied"]')).not.toBeNull();
  });

  it('shows the loading error with a retry', async () => {
    const list = vi
      .fn<StaffAccountsApi['list']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([]);
    await mountAccounts('admin', { accounts: { list } });
    expect(q('[data-state="error"]')).not.toBeNull();
    await click(q('[data-state="error"] button'));
    await vi.waitFor(() => expect(q('.accounts')).not.toBeNull());
    expect(text('.dt__empty')).toBe("Hozircha xodim hisobi yo'q.");
  });

  it('keeps administrator accounts from a manager: no actions, only the note', async () => {
    await mountAccounts('manager');
    const adminRow = rowOf('Rahmatulla Qosimov');
    expect(adminRow.querySelector('[data-testid="account-menu"]')).toBeNull();
    expect(adminRow.textContent).toContain('Administrator hisobini faqat administrator');
    await openMenu('Temur Boboyev');
    expect(menuItem('account-telegram')).not.toBeNull();
    expect(menuItem('account-credentials')).not.toBeNull();
  });

  it('offers block and unblock to an administrator only', async () => {
    await mountAccounts('manager');
    await openMenu('Temur Boboyev');
    expect(menuItem('account-credentials')).not.toBeNull();
    expect(menuItem('account-status')).toBeNull();
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin');
    await openMenu('Temur Boboyev');
    expect(menuItem('account-status')).not.toBeNull();
  });

  it('filters by text, role and status', async () => {
    await mountAccounts('admin');
    const search = q<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    await type(search, 'ravshan@');
    expect(rows()).toHaveLength(1);
    await type(search, 'zzz');
    expect(text('.dt__empty')).toBe('Filtrga mos hisob topilmadi.');
  });

  it('counts each role on its tile and filters by it; a second click clears the filter', async () => {
    await mountAccounts('admin');
    const tile = (role: string): HTMLButtonElement =>
      q<HTMLButtonElement>(`[data-role-tile="${role}"]`) as HTMLButtonElement;
    const adminCount = Array.from(document.body.querySelectorAll('tbody .dt__row')).filter((r) =>
      r.textContent?.includes('Administrator'),
    ).length;
    expect(squash(tile('ADMIN').textContent)).toContain(`${adminCount} xodim`);
    await click(tile('ADMIN'));
    expect(tile('ADMIN').getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toHaveLength(adminCount);
    expect(rows().every((r) => r.includes('Administrator'))).toBe(true);
    await click(tile('ADMIN'));
    expect(tile('ADMIN').getAttribute('aria-pressed')).toBe('false');
    expect(rows()).toHaveLength(7);
  });

  it('opens the row menu, closes it with Escape and gives the focus back', async () => {
    await mountAccounts('admin');
    await openMenu('Temur Boboyev');
    const trigger = rowOf('Temur Boboyev').querySelector<HTMLElement>(
      '[data-testid="account-menu"]',
    );
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const menu = q<HTMLElement>('[role="menu"]');
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(q('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('staff accounts page: create', () => {
  it('does not offer ADMIN to a manager, and does to an administrator', async () => {
    await mountAccounts('manager');
    await clickId('add-account');
    expect(checkbox('ADMIN')).toBeNull();
    expect(checkbox('MANAGER')).not.toBeNull();
    expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin');
    await clickId('add-account');
    expect(checkbox('ADMIN')).not.toBeNull();
    expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(6);
  });

  it('checks the fields before any request and explains each problem', async () => {
    const create = vi.fn<StaffAccountsApi['create']>();
    await mountAccounts('admin', { accounts: { create } });
    await clickId('add-account');
    await click(q('[data-testid="create-account-submit"]'));
    expect(create).not.toHaveBeenCalled();
    const errors = Array.from(document.body.querySelectorAll('[role="alert"]')).map((e) =>
      squash(e.textContent),
    );
    expect(errors).toContain('Ismni kiriting.');
    expect(errors.some((e) => e.startsWith('Login name@iorder.uz'))).toBe(true);
    expect(errors.some((e) => e.startsWith('Parol kamida 8'))).toBe(true);
    expect(errors).toContain('1 tadan 5 tagacha rol tanlang.');

    await type(field("To'liq ism"), 'A');
    await type(field('Login'), 'Not A Login');
    await type(field('Parol'), 'short');
    await type(field('Telefon'), '12345');
    await type(field('Telegram ID'), '0');
    await click(q('[data-testid="create-account-submit"]'));
    expect(create).not.toHaveBeenCalled();
    expect(
      Array.from(document.body.querySelectorAll('[role="alert"]')).map((e) =>
        squash(e.textContent),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Telefon +998901234567'),
        expect.stringContaining('Telegram ID faqat raqamlardan'),
      ]),
    );
  });

  it('creates an account with a typed password: sends it once, keeps none, shows none', async () => {
    const create = vi.fn<StaffAccountsApi['create']>();
    const { services } = await mountAccounts('admin');
    create.mockImplementation((input) => services.staffAccountsApi.create(input));
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin', { accounts: { create } });

    await clickId('add-account');
    await fillValid('  Yangi@iorder.uz ');
    await type(field('Telefon'), '+998901234567');
    await type(field('Telegram ID'), '700123456');
    await click(q('[data-testid="create-account-submit"]'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      fullName: 'Yangi Xodim',
      login: 'yangi@iorder.uz',
      password: 'correct-horse-battery',
      roles: ['DRIVER'],
      language: 'UZ',
      phone: '+998901234567',
      telegramUserId: '700123456',
    });
    await vi.waitFor(() => expect(rows()).toHaveLength(8));
    expect(useToast().toast.value?.message).toContain('Yangi Xodim');
    // No password anywhere on the page, and no one-time display for a typed password.
    expect(q('[data-testid="generated-password"]')).toBeNull();
    expect(document.body.textContent).not.toContain('correct-horse-battery');
    expect(Array.from(document.body.querySelectorAll('input')).map((i) => i.value)).not.toContain(
      'correct-horse-battery',
    );
  });

  it('empties the typed password at submit, so a failed try must type it again', async () => {
    const create = vi
      .fn<StaffAccountsApi['create']>()
      .mockRejectedValue(new ApiConflictError('x', 'CONFLICT'));
    await mountAccounts('admin', { accounts: { create } });
    await clickId('add-account');
    await fillValid();
    await click(q('[data-testid="create-account-submit"]'));
    expect(text('.error')).toContain('Amalni bajarib bo');
    expect(field('Parol').value).toBe('');
    expect(text('.modal')).not.toContain('correct-horse-battery');
  });

  it('generates a strong password, shows it once with a copy button and a warning, then forgets it', async () => {
    const create = vi.fn<StaffAccountsApi['create']>();
    const { services } = await mountAccounts('admin');
    create.mockImplementation((input) => services.staffAccountsApi.create(input));
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin', { accounts: { create } });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await clickId('add-account');
    await type(field("To'liq ism"), 'Yangi Xodim');
    await type(field('Login'), 'yangi@iorder.uz');
    await click(checkbox('DRIVER'));
    await type(field('Telegram ID'), '700123456');
    await clickId('password-generate');
    const generated = (q('[data-testid="password-input"]') as HTMLInputElement).value;
    expect(generated).toHaveLength(20);
    expect((q('[data-testid="password-input"]') as HTMLInputElement).type).toBe('text');

    await click(q('[data-testid="create-account-submit"]'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].password).toBe(generated);
    await vi.waitFor(() => expect(q('[data-testid="generated-password"]')).not.toBeNull());
    expect(text('[data-testid="generated-password"]')).toBe(generated);
    expect(text('.modal')).toContain("faqat hozir ko'rsatiladi va keyin qayta ko'rsatilmaydi");
    expect(q('[data-testid="password-input"]')).toBeNull();

    await clickId('password-copy');
    expect(writeText).toHaveBeenCalledWith(generated);
    expect(text('.modal')).toContain('Nusxa olindi');

    await clickId('password-done');
    // During the exit animation the secret is already gone but the panel does not flip to the form.
    expect(q('[data-testid="modal"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(generated);
    expect(q('[data-testid="create-account-form"]')).toBeNull();
    expect(q('[data-testid="password-input"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="modal"]')).toBeNull());
    expect(document.body.textContent).not.toContain(generated);
    // Opening the dialog again starts blank.
    await clickId('add-account');
    expect((q('[data-testid="password-input"]') as HTMLInputElement).value).toBe('');
    expect(q('[data-testid="generated-password"]')).toBeNull();
  });

  it('tells the person when copying is not possible', async () => {
    const { services } = await mountAccounts('admin');
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin', {
      accounts: { create: (i) => services.staffAccountsApi.create(i) },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    await clickId('add-account');
    await type(field("To'liq ism"), 'Yangi Xodim');
    await type(field('Login'), 'yangi@iorder.uz');
    await click(checkbox('DRIVER'));
    await type(field('Telegram ID'), '700123456');
    await clickId('password-generate');
    await click(q('[data-testid="create-account-submit"]'));
    await vi.waitFor(() => expect(q('[data-testid="generated-password"]')).not.toBeNull());
    await clickId('password-copy');
    expect(text('.modal')).toContain("Nusxa olib bo'lmadi");
  });

  it('toggles the password between hidden and shown', async () => {
    await mountAccounts('admin');
    await clickId('add-account');
    const input = q('[data-testid="password-input"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('new-password');
    await clickId('password-toggle');
    expect(input.type).toBe('text');
    await clickId('password-toggle');
    expect(input.type).toBe('password');
  });

  it('sends one request for a double click', async () => {
    let finish: (a: StaffAccountResponse) => void = () => undefined;
    const create = vi.fn(
      () =>
        new Promise<StaffAccountResponse>((resolve) => {
          finish = resolve;
        }),
    );
    await mountAccounts('admin', { accounts: { create } });
    await clickId('add-account');
    await fillValid();
    const submit = q<HTMLButtonElement>(
      '[data-testid="create-account-submit"]',
    ) as HTMLButtonElement;
    submit.click();
    submit.click();
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    finish({
      id: fakeUuid('new'),
      fullName: 'Yangi Xodim',
      login: 'yangi@iorder.uz',
      roles: ['DRIVER'],
      status: 'ACTIVE',
      hasPassword: true,
      telegramLinked: false,
      lastSignInAt: null,
      createdAt: '2026-10-19T04:30:00.000Z',
    });
    await flushPromises();
  });

  it.each([
    ['403', new PermissionDeniedError('x'), "Bu amalga ruxsat yo'q."],
    ['409', new ApiConflictError('x', 'CONFLICT'), 'allaqachon band'],
  ])('shows the same plain message for %s whatever the cause', async (_n, failure, message) => {
    const create = vi.fn<StaffAccountsApi['create']>().mockRejectedValue(failure);
    await mountAccounts('admin', { accounts: { create } });
    await clickId('add-account');
    await fillValid();
    await click(q('[data-testid="create-account-submit"]'));
    expect(text('.error')).toContain(message);
  });
});

describe('staff accounts page: Telegram link', () => {
  it('links a Telegram id, validating digits, and offers no way to remove it', async () => {
    const setTelegram = vi.fn<StaffAccountsApi['setTelegram']>();
    const { services } = await mountAccounts('admin');
    setTelegram.mockImplementation((id, value) => services.staffAccountsApi.setTelegram(id, value));
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin', { accounts: { setTelegram } });

    await action('Ravshan Haydarov', 'account-telegram');
    expect(text('.modal')).toContain('Hozir: Ulanmagan');
    expect(q('[data-testid="telegram-unlink"]')).toBeNull();
    // An empty field is a mistake, not a request to unlink.
    await clickId('telegram-save');
    expect(setTelegram).not.toHaveBeenCalled();
    expect(text('.modal')).toContain('faqat raqamlardan');
    await type(field('Telegram ID'), '0');
    await clickId('telegram-save');
    expect(setTelegram).not.toHaveBeenCalled();

    await type(field('Telegram ID'), '700555000');
    await clickId('telegram-save');
    await vi.waitFor(() =>
      expect(setTelegram).toHaveBeenCalledWith(expect.any(String), '700555000'),
    );
    await vi.waitFor(() =>
      expect(squash(rowOf('Ravshan Haydarov').textContent)).toContain('Ulangan'),
    );

    // Once linked, the dialog still has no unlink control.
    await action('Ravshan Haydarov', 'account-telegram');
    expect(q('[data-testid="telegram-unlink"]')).toBeNull();
  });

  it('shows the refusal inside the dialog', async () => {
    const setTelegram = vi.fn().mockRejectedValue(new PermissionDeniedError());
    await mountAccounts('manager', { accounts: { setTelegram } });
    await action('Temur Boboyev', 'account-telegram');
    await type(field('Telegram ID'), '700555000');
    await clickId('telegram-save');
    expect(text('.error')).toContain("ruxsat yo'q");
  });
});

describe('staff accounts page: login and password', () => {
  it('needs a login or a password, checks them, and keeps the typed password out of the page afterwards', async () => {
    const setCredentials = vi.fn<StaffAccountsApi['setCredentials']>();
    const { services } = await mountAccounts('admin');
    setCredentials.mockImplementation((id, input) =>
      services.staffAccountsApi.setCredentials(id, input),
    );
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin', { accounts: { setCredentials } });

    await action('Temur Boboyev', 'account-credentials');
    await clickId('credentials-save');
    expect(setCredentials).not.toHaveBeenCalled();
    expect(text('.modal')).toContain('Login yoki parolni kiriting');

    await type(field('Yangi parol'), 'short');
    await clickId('credentials-save');
    expect(setCredentials).not.toHaveBeenCalled();
    expect(text('.modal')).toContain('kamida 8 belgidan');

    await type(field('Yangi parol'), 'a-long-new-password');
    await type(field('Yangi login'), 'temur2@iorder.uz');
    await clickId('credentials-save');
    await vi.waitFor(() => expect(setCredentials).toHaveBeenCalledTimes(1));
    expect(setCredentials.mock.calls[0]?.[1]).toEqual({
      login: 'temur2@iorder.uz',
      password: 'a-long-new-password',
    });
    await vi.waitFor(() => expect(q('[data-testid="modal"]')).toBeNull());
    expect(document.body.textContent).not.toContain('a-long-new-password');
    await vi.waitFor(() =>
      expect(squash(rowOf('Temur Boboyev').textContent)).toContain('temur2@iorder.uz'),
    );
    expect(squash(rowOf('Temur Boboyev').textContent)).toContain("O'rnatilgan");
  });

  it('shows a generated replacement password once', async () => {
    const setCredentials = vi.fn<StaffAccountsApi['setCredentials']>().mockResolvedValue({
      userId: DRIVER,
      login: 'temur@iorder.uz',
      passwordChangedAt: '2026-10-19T04:30:00.000Z',
    });
    await mountAccounts('admin', { accounts: { setCredentials } });
    await action('Temur Boboyev', 'account-credentials');
    await clickId('password-generate');
    const generated = (q('[data-testid="password-input"]') as HTMLInputElement).value;
    await clickId('credentials-save');
    await vi.waitFor(() => expect(q('[data-testid="generated-password"]')).not.toBeNull());
    expect(text('[data-testid="generated-password"]')).toBe(generated);
    await clickId('password-done');
    expect(q('[data-testid="modal"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(generated);
    expect(q('[data-testid="password-input"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="modal"]')).toBeNull());
    expect(document.body.textContent).not.toContain(generated);
  });
});

describe('staff accounts page: block and unblock a staff account', () => {
  it('asks first, blocks, and unblocks again', async () => {
    const blockUser = vi.fn<StaffUsersApi['blockUser']>();
    const unblockUser = vi.fn<StaffUsersApi['unblockUser']>();
    const { services } = await mountAccounts('admin');
    blockUser.mockImplementation((id, o) => services.staffUsersApi.blockUser(id, o));
    unblockUser.mockImplementation((id) => services.staffUsersApi.unblockUser(id));
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await mountAccounts('admin', { users: { blockUser, unblockUser } });

    await action('Temur Boboyev', 'account-status');
    expect(blockUser).not.toHaveBeenCalled();
    expect(text('.modal__title')).toBe('Bloklash: Temur Boboyev');
    expect(text('.modal')).toContain('Telegram guruhlaridan chiqarilmaydi');
    await click(Array.from(document.body.querySelectorAll('.modal button')).at(-1) ?? null);
    await vi.waitFor(() =>
      expect(blockUser).toHaveBeenCalledWith(DRIVER, { removeFromGroups: false }),
    );
    await vi.waitFor(() =>
      expect(squash(rowOf('Temur Boboyev').textContent)).toContain('Bloklangan'),
    );

    await action('Sardorbek Hamidov', 'account-status');
    await click(Array.from(document.body.querySelectorAll('.modal button')).at(-1) ?? null);
    await vi.waitFor(() => expect(unblockUser).toHaveBeenCalledWith(BLOCKED));
    await vi.waitFor(() =>
      expect(squash(rowOf('Sardorbek Hamidov').textContent)).toContain('Faol'),
    );
  });

  it('keeps the dialog open with a message when the server refuses (last administrator)', async () => {
    const blockUser = vi
      .fn()
      .mockRejectedValue(new ApiConflictError('x', 'CONFLICT', {}, 'LAST_ADMIN'));
    await mountAccounts('admin', { users: { blockUser } });
    await action('Rahmatulla Qosimov', 'account-status');
    await click(Array.from(document.body.querySelectorAll('.modal button')).at(-1) ?? null);
    expect(text('.modal')).toContain('kamida bitta faol administrator');
    expect(squash(rowOf('Rahmatulla Qosimov').textContent)).toContain('Faol');
    expect(ADMIN).toBeTruthy();
    expect(MANAGER).toBeTruthy();
  });
});

describe('staff accounts page: the password stays off every surface', () => {
  it('is not logged, stored or put in a URL while creating an account', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { router } = await mountAccounts('admin');
    await clickId('add-account');
    await fillValid();
    await click(q('[data-testid="create-account-submit"]'));
    await vi.waitFor(() => expect(rows()).toHaveLength(8));
    const secret = 'correct-horse-battery';
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    }
    expect(window.location.href).not.toContain(secret);
    expect(router.currentRoute.value.fullPath).not.toContain(secret);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(secret);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(secret);
  });
});

describe('staff accounts page: the purchasing manager reads', () => {
  it('lists the people without any credential fact or action', async () => {
    await mountAccounts('purchasing');
    expect(rows().length).toBeGreaterThan(0);
    expect(document.body.querySelector('[data-testid="add-account"]')).toBeNull();
    expect(document.body.querySelector('.login')).toBeNull();
    expect(document.body.textContent).not.toContain('@iorder.uz');
    expect(document.body.querySelector('[data-testid="account-menu"]')).toBeNull();
    expect(document.body.querySelectorAll('thead th').length).toBe(3);
  });
});
