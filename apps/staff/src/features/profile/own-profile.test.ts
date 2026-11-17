import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import UserBlock from '@/features/auth/components/UserBlock.vue';
import { useTheme } from '@/features/preferences/composables/use-theme';
import { createAppI18n } from '@/i18n';
import { ensureStaffSystemPagesMessages } from '@/i18n/staff-system-pages-messages';
import { createAppRouter } from '@/router';
import { createTestServices } from '@/test-utils/create-test-services';
import { withStaffCostMessages } from '@/test-utils/staff-cost-i18n';
import { dismissToast } from '@core/composables/use-toast';
import ToastHost from '@core/components/ui/ToastHost.vue';
import {
  ApiConflictError,
  ApiRateLimitedError,
  ApiValidationError,
  NetworkError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { waitFor } from '@core/test-utils/wait';
import { createMemoryHistory } from 'vue-router';
import { createFakeOwnProfileApi } from '@/features/staff-profile/api/fake-own-profile-api';
import {
  createHttpOwnProfileApi,
  type OwnProfileApi,
} from '@/features/staff-profile/api/own-profile-api';
import ProfilePage from './components/ProfilePage.vue';
import { staffProfileMessages } from './messages';
import { staffProfileUz } from './messages/uz';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  dismissToast();
  useTheme().setChoice('system');
  vi.restoreAllMocks();
});

async function i18nWithPages() {
  const i18n = withStaffCostMessages(createAppI18n());
  await ensureStaffSystemPagesMessages(i18n);
  return i18n;
}

interface Mounted {
  wrapper: VueWrapper;
  services: Services;
  update: ReturnType<typeof vi.fn<OwnProfileApi['update']>>;
}

/** The profile page of a demo person; `api` replaces the profile calls, each `update` is recorded. */
async function mountPage(
  identityId: string,
  options: { phone?: string | null; api?: Partial<OwnProfileApi> } = {},
): Promise<Mounted> {
  const { services: base } = createTestServices({ identityId });
  await base.currentUser.ensureLoaded();
  const fake = createFakeOwnProfileApi(() => base.currentUser.user.value, options.phone ?? null);
  const update = vi.fn<OwnProfileApi['update']>(options.api?.update ?? fake.update);
  const services: Services = {
    ...base,
    ownProfileApi: { get: options.api?.get ?? fake.get, update },
  };
  const i18n = await i18nWithPages();
  const wrapper = mount(ProfilePage, {
    attachTo: document.body,
    global: { plugins: [i18n], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  wrappers.push(
    mount(ToastHost, { attachTo: document.body, global: { plugins: [i18n] } }) as VueWrapper,
  );
  await flushPromises();
  return { wrapper, services, update };
}

const phoneField = (wrapper: VueWrapper) => wrapper.get('[data-testid="profile-phone"]');
const editButton = (wrapper: VueWrapper) =>
  wrapper.get<HTMLButtonElement>('[data-testid="profile-edit"]');
const dialogOpen = (): boolean => document.body.querySelector('.modal') !== null;
const input = (index: number): HTMLInputElement =>
  document.body.querySelectorAll<HTMLInputElement>('.modal input')[index] as HTMLInputElement;
const fieldError = (index: number): string =>
  document.body
    .querySelectorAll('.modal .field')
    [index]?.querySelector('.field__error')
    ?.textContent?.trim() ?? '';
const generalError = (): string =>
  document.body.querySelector('.modal .confirm__error')?.textContent?.trim() ?? '';
const toastText = (): string => document.body.querySelector('.toast')?.textContent ?? '';

async function type(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

function modalButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`No dialog button containing "${label}"`);
  return found;
}

async function openEditor(wrapper: VueWrapper): Promise<void> {
  await editButton(wrapper).trigger('click');
  await waitFor(() => expect(dialogOpen()).toBe(true));
}

async function save(): Promise<void> {
  modalButton(staffProfileUz.edit.save).click();
  await flushPromises();
}

describe('own name and phone on the staff profile', () => {
  it('shows the name and the phone, with the edit action in the card header', async () => {
    const { wrapper } = await mountPage('manager', { phone: '+998901234567' });
    expect(wrapper.get('[data-testid="profile-name"]').text().length).toBeGreaterThan(0);
    expect(phoneField(wrapper).text()).toBe('+998 90 123 4567');
    expect(phoneField(wrapper).attributes('data-state')).toBe('ready');
    // The action shares the header line with the card title (the v8 card header).
    const button = editButton(wrapper);
    expect(button.text()).toBe(staffProfileUz.personal.edit);
    expect(button.element.disabled).toBe(false);
    const head = button.element.closest('.card__head');
    expect(head?.querySelector('.card__title')?.textContent).toBe(staffProfileUz.personal.title);
    expect(button.element.closest('.card__actions')).not.toBeNull();
    // `.personal` is the hook of the rule that keeps that header on one line at every width.
    expect(head?.closest('.card')?.classList.contains('personal')).toBe(true);
    expect(wrapper.text()).toContain(staffProfileUz.personal.subtitle);
  });

  it('a person without a phone sees "not entered", every staff role alike', async () => {
    for (const identity of ['admin', 'accountant', 'warehouse', 'driver']) {
      const { wrapper } = await mountPage(identity);
      expect(phoneField(wrapper).text()).toBe(staffProfileUz.personal.phoneMissing);
      expect(editButton(wrapper).element.disabled).toBe(false);
    }
  });

  it('while the phone is being read the edit action is off', async () => {
    let release: (value: { fullName: string; phone: string | null }) => void = () => undefined;
    const { wrapper } = await mountPage('manager', {
      api: { get: () => new Promise((resolve) => (release = resolve)) },
    });
    expect(phoneField(wrapper).text()).toBe(staffProfileUz.personal.phoneLoading);
    expect(phoneField(wrapper).attributes('data-state')).toBe('loading');
    expect(editButton(wrapper).element.disabled).toBe(true);
    release({ fullName: 'Aziza Yusupova', phone: '+998901234567' });
    await flushPromises();
    expect(phoneField(wrapper).text()).toBe('+998 90 123 4567');
    expect(editButton(wrapper).element.disabled).toBe(false);
  });

  it.each([
    ['a network failure', new NetworkError('offline')],
    ['a refusal', new PermissionDeniedError('no')],
  ])('%s of the read is an error with a retry, and editing stays off', async (_label, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const get = vi
      .fn<OwnProfileApi['get']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ fullName: 'Aziza Yusupova', phone: null });
    const { wrapper } = await mountPage('manager', { api: { get } });
    expect(phoneField(wrapper).attributes('data-state')).toBe('error');
    expect(phoneField(wrapper).get('[role="alert"]').text()).toBe(
      staffProfileUz.personal.phoneError,
    );
    expect(editButton(wrapper).element.disabled).toBe(true);
    // The rest of the page is still there.
    expect(wrapper.find('[data-testid="profile-role"]').exists()).toBe(true);

    await wrapper.get('[data-testid="profile-retry"]').trigger('click');
    await flushPromises();
    expect(phoneField(wrapper).text()).toBe(staffProfileUz.personal.phoneMissing);
    expect(editButton(wrapper).element.disabled).toBe(false);
  });

  it('saves a change: one request, the page, the session name and a toast show it', async () => {
    const { wrapper, services, update } = await mountPage('manager', { phone: '+998901234567' });
    const oldName = services.currentUser.user.value?.displayName ?? '';
    await openEditor(wrapper);
    expect(document.body.textContent).toContain(staffProfileUz.edit.title);
    expect(input(0).value).toBe(oldName);
    expect(input(1).value).toBe('998 90 123 4567');

    await type(input(0), '  Sardor Aliyev ');
    await type(input(1), '998935550011');
    expect(input(1).value).toBe('998 93 555 0011');
    await save();

    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ fullName: 'Sardor Aliyev', phone: '+998935550011' });
    expect(wrapper.get('[data-testid="profile-name"]').text()).toBe('Sardor Aliyev');
    expect(wrapper.get('[data-testid="profile-identity"]').text()).toContain('Sardor Aliyev');
    expect(phoneField(wrapper).text()).toBe('+998 93 555 0011');
    expect(services.currentUser.user.value?.displayName).toBe('Sardor Aliyev');
    // Nothing else about the session moved.
    expect(services.currentUser.user.value?.staffRoles).toEqual(['MANAGER']);
    expect(toastText()).toContain(staffProfileUz.edit.saved);

    // The next opening starts from what was saved.
    await openEditor(wrapper);
    expect(input(0).value).toBe('Sardor Aliyev');
    expect(input(1).value).toBe('998 93 555 0011');
  });

  it('the sidebar user block shows the new name without another sign-in', async () => {
    const { wrapper, services } = await mountPage('driver');
    const router = createAppRouter(services.currentUser, createMemoryHistory());
    const block = mount(UserBlock, {
      global: {
        plugins: [router, await i18nWithPages()],
        provide: { [servicesKey as symbol]: services },
      },
    });
    wrappers.push(block);
    await openEditor(wrapper);
    await type(input(0), 'Bekzod T.');
    await save();
    await waitFor(() => expect(block.get('.user__name').text()).toBe('Bekzod T.'));
  });

  it('nothing edited: saving sends no request, closes the dialog and shows no toast', async () => {
    const { wrapper, update } = await mountPage('manager', { phone: '+998901234567' });
    await openEditor(wrapper);
    await save();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(update).not.toHaveBeenCalled();
    expect(toastText()).toBe('');

    // The same name with spaces around it is not a change either.
    await openEditor(wrapper);
    await type(input(0), `  ${input(0).value} `);
    await save();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(update).not.toHaveBeenCalled();
  });

  it('cancel keeps the saved values and the next opening forgets the typing', async () => {
    const { wrapper, update } = await mountPage('manager', { phone: '+998901234567' });
    const name = wrapper.get('[data-testid="profile-name"]').text();
    await openEditor(wrapper);
    await type(input(0), 'Someone Else');
    modalButton('Bekor qilish').click();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(update).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="profile-name"]').text()).toBe(name);
    await openEditor(wrapper);
    expect(input(0).value).toBe(name);
  });

  it('an emptied phone field removes the number', async () => {
    const { wrapper, update } = await mountPage('accountant', { phone: '+998901234567' });
    const name = wrapper.get('[data-testid="profile-name"]').text();
    await openEditor(wrapper);
    expect(document.body.textContent).toContain(staffProfileUz.edit.phoneHint);
    await type(input(1), '');
    await save();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(update).toHaveBeenCalledWith({ fullName: name, phone: null });
    expect(phoneField(wrapper).text()).toBe(staffProfileUz.personal.phoneMissing);
  });

  it('checks the fields before any request: an empty name, an incomplete phone', async () => {
    const { wrapper, update } = await mountPage('manager');
    await openEditor(wrapper);
    await type(input(0), '   ');
    await type(input(1), '99890');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(fieldError(0)).toBe(staffProfileUz.edit.errors.name);
    expect(fieldError(1)).toBe(staffProfileUz.edit.errors.phone);
    expect(input(0).getAttribute('aria-invalid')).toBe('true');
    expect(update).not.toHaveBeenCalled();
  });

  const refuse = (path: string) => () =>
    Promise.reject(new ApiValidationError('x', 'VALIDATION_FAILED', [{ path, message: 'bad' }]));

  it("shows the server's refusal at the field it names, until that field is changed", async () => {
    const { wrapper, services } = await mountPage('manager', { api: { update: refuse('phone') } });
    const name = services.currentUser.user.value?.displayName;
    await openEditor(wrapper);
    await type(input(1), '998935550011');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(fieldError(0)).toBe('');
    expect(fieldError(1)).toBe(staffProfileUz.edit.errors.phone);
    expect(generalError()).toBe('');
    expect(toastText()).toBe('');
    expect(services.currentUser.user.value?.displayName).toBe(name);
    await type(input(1), '998935550012');
    expect(fieldError(1)).toBe('');
  });

  it('a refused name is shown at the name field', async () => {
    const { wrapper } = await mountPage('driver', { api: { update: refuse('fullName') } });
    await openEditor(wrapper);
    await type(input(0), 'Bekzod T.');
    await save();
    expect(fieldError(0)).toBe(staffProfileUz.edit.errors.name);
    expect(fieldError(1)).toBe('');
  });

  it('too many tries and other failures are one general line; the dialog stays open', async () => {
    let failure: unknown = new ApiRateLimitedError('x', 'RATE_LIMITED', 30);
    const { wrapper } = await mountPage('manager', {
      api: { update: () => Promise.reject(failure) },
    });
    const name = wrapper.get('[data-testid="profile-name"]').text();
    await openEditor(wrapper);
    await type(input(0), 'Sardor Aliyev');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(generalError()).toBe(staffProfileUz.edit.errors.rateLimited);
    expect(fieldError(0)).toBe('');

    for (const next of [
      new PermissionDeniedError('no'),
      new ApiConflictError('x', 'CONFLICT'),
      new NetworkError('offline'),
    ]) {
      failure = next;
      await save();
      expect(dialogOpen()).toBe(true);
      expect(generalError()).not.toBe('');
      expect(generalError()).not.toBe(staffProfileUz.edit.errors.rateLimited);
    }
    expect(wrapper.get('[data-testid="profile-name"]').text()).toBe(name);
  });

  it('a double press of save sends one request', async () => {
    const { wrapper, update } = await mountPage('manager');
    await openEditor(wrapper);
    await type(input(0), 'Sardor Aliyev');
    const button = modalButton(staffProfileUz.edit.save);
    button.click();
    button.click();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('own profile http adapter', () => {
  function setup(body: unknown) {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body))));
    const api = createHttpOwnProfileApi(
      createHttpClient({ baseUrl: 'https://api.test', fetchImpl }),
    );
    const call = (): [string, RequestInit] =>
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    return { api, call };
  }

  it('reads and replaces the profile at a route that names nobody', async () => {
    const read = setup({ fullName: 'Sardor Aliyev', phone: null });
    expect(await read.api.get()).toEqual({ fullName: 'Sardor Aliyev', phone: null });
    expect(read.call()[0]).toBe('https://api.test/staff/me/profile');
    expect(read.call()[1].method).toBe('GET');

    const write = setup({ fullName: 'Sardor Aliyev', phone: '+998901234567' });
    await write.api.update({ fullName: 'Sardor Aliyev', phone: '+998901234567' });
    const [url, init] = write.call();
    expect(url).toBe('https://api.test/staff/me/profile');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      fullName: 'Sardor Aliyev',
      phone: '+998901234567',
    });
  });

  it('refuses an answer with anything but the two fields', async () => {
    const { api } = setup({ fullName: 'Sardor', phone: null, staffRoles: ['ADMIN'] });
    await expect(api.get()).rejects.toThrow();
  });
});

describe('texts of the own profile edit', () => {
  it('exist in all three languages, with no empty one', () => {
    for (const messages of Object.values(staffProfileMessages)) {
      const texts = [
        ...Object.values(messages.edit).filter((value) => typeof value === 'string'),
        ...Object.values(messages.edit.errors),
        messages.personal.phone,
        messages.personal.phoneMissing,
        messages.personal.phoneLoading,
        messages.personal.phoneError,
        messages.personal.retry,
        messages.personal.edit,
      ];
      for (const value of texts) expect(value.trim().length).toBeGreaterThan(0);
    }
    expect(staffProfileMessages.ru.edit.title).not.toBe(staffProfileMessages.uz.edit.title);
    expect(staffProfileMessages.en.edit.title).not.toBe(staffProfileMessages.uz.edit.title);
  });
});
