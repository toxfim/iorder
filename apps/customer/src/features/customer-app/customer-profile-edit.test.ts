import { describe, expect, it, vi } from 'vitest';
import { ApiConflictError, ApiRateLimitedError, ApiValidationError } from '@core/lib/api-errors';
import {
  bodyText,
  click,
  findModalButton,
  mountCustomerApp,
  typeInto,
  useCustomerTestLifecycle,
  type MountOptions,
} from '@/test-utils/customer-app';
import { coreUz } from '@core/i18n/messages/uz';
import { waitFor } from '@core/test-utils/wait';
import { customerEn } from './messages/en';
import { customerRu } from './messages/ru';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();

type Backend = Parameters<NonNullable<MountOptions['decorate']>>[0];

const field = (index: number): HTMLInputElement =>
  document.body.querySelectorAll<HTMLInputElement>('.modal input')[index] as HTMLInputElement;
const fieldError = (index: number): string =>
  document.body
    .querySelectorAll('.modal .field')
    [index]?.querySelector('.field__error')
    ?.textContent?.trim() ?? '';
const generalError = (): string =>
  document.body.querySelector('.modal .confirm__error')?.textContent?.trim() ?? '';
const dialogOpen = (): boolean => document.body.querySelector('.modal') !== null;
const text = (testId: string): string =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
const editButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-testid="profile-edit"]');
const toastText = (): string => document.querySelector('.toast')?.textContent ?? '';

/** The profile of a fake account, with every `setContact` call recorded. */
async function openProfile(initData: string, decorate?: (backend: Backend) => void) {
  const setContact = vi.fn();
  const mounted = await mountCustomerApp(initData, '/profile', {
    decorate: (backend) => {
      const original = backend.meApi.setContact;
      backend.meApi.setContact = (request) => {
        setContact(request);
        return original(request);
      };
      decorate?.(backend);
    },
  });
  await waitFor(() => expect(text('profile-name')).not.toBe(''));
  return { ...mounted, setContact };
}

async function openEditor(): Promise<void> {
  await click(editButton() as HTMLButtonElement);
  await waitFor(() => expect(dialogOpen()).toBe(true));
}

const save = (): Promise<void> => click(findModalButton(customerUz.profileEdit.submit));

describe('a customer edits their own name and phone in the profile', () => {
  it('shows the saved name and phone, with the edit action on the heading line', async () => {
    await openProfile('fake-owner');
    expect(text('profile-name')).toBe('Anvar Soliyev');
    expect(text('profile-phone')).toBe('+998 90 111 2233');
    expect(text('profile-contact-hint')).toBe(customerUz.presentation.contactHint);
    // One line: the heading and the action are the two children of the same row.
    const button = editButton();
    expect(button?.textContent?.trim()).toBe(customerUz.profileEdit.action);
    const row = button?.parentElement;
    expect(row?.classList.contains('section-head')).toBe(true);
    expect([...(row?.children ?? [])].map((child) => child.tagName)).toEqual(['H3', 'BUTTON']);
  });

  it('opens with the saved values and saves a change: the page, the session and a toast show it', async () => {
    const { services, setContact } = await openProfile('fake-owner');
    await openEditor();
    expect(bodyText()).toContain(customerUz.profileEdit.title);
    expect(document.body.querySelector('.modal')?.textContent).toContain(
      customerUz.presentation.contactHint,
    );
    expect(field(0).value).toBe('Anvar Soliyev');
    expect(field(1).value).toBe('998 90 111 2233');

    await typeInto(field(0), '  Anvar Solijonov ');
    await typeInto(field(1), '998935550011');
    await save();

    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(setContact).toHaveBeenCalledTimes(1);
    expect(setContact).toHaveBeenCalledWith({
      fullName: 'Anvar Solijonov',
      phone: '+998935550011',
    });
    expect(text('profile-name')).toBe('Anvar Solijonov');
    expect(text('profile-phone')).toBe('+998 93 555 0011');
    // The name at the top of the page comes from the same session answer.
    expect(document.querySelector('.identity h2')?.textContent).toBe('Anvar Solijonov');
    expect(services.session.me.value?.contact).toEqual({
      fullName: 'Anvar Solijonov',
      phone: '+998935550011',
    });
    expect(toastText()).toContain(customerUz.profileEdit.saved);
    // The phone is never put into the storage or the URL.
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('935550011');

    // It can be changed again, starting from what was just saved.
    await openEditor();
    expect(field(0).value).toBe('Anvar Solijonov');
    await typeInto(field(0), 'Anvar Soliyev');
    await save();
    await waitFor(() => expect(text('profile-name')).toBe('Anvar Soliyev'));
    expect(setContact).toHaveBeenCalledTimes(2);
  });

  it('nothing edited: saving sends no request, closes the dialog and shows no toast', async () => {
    const { setContact } = await openProfile('fake-owner');
    await openEditor();
    await save();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(setContact).not.toHaveBeenCalled();
    expect(toastText()).toBe('');
    expect(text('profile-name')).toBe('Anvar Soliyev');

    // Typing the same name with spaces around it is not a change either.
    await openEditor();
    await typeInto(field(0), ' Anvar Soliyev  ');
    await save();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(setContact).not.toHaveBeenCalled();
  });

  it('cancel leaves everything as it was, and the next opening starts from the saved values', async () => {
    const { setContact } = await openProfile('fake-owner');
    await openEditor();
    await typeInto(field(0), 'Someone Else');
    await click(findModalButton(coreUz.common.cancel));
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(setContact).not.toHaveBeenCalled();
    expect(text('profile-name')).toBe('Anvar Soliyev');
    await openEditor();
    expect(field(0).value).toBe('Anvar Soliyev');
  });

  it('checks the fields before any request: an empty name, an incomplete phone', async () => {
    const { setContact } = await openProfile('fake-owner');
    await openEditor();
    await typeInto(field(0), '   ');
    await typeInto(field(1), '99890');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(fieldError(0)).toBe(customerUz.contact.errors.name);
    expect(fieldError(1)).toBe(customerUz.contact.errors.phone);
    expect(field(0).getAttribute('aria-invalid')).toBe('true');
    expect(setContact).not.toHaveBeenCalled();
  });

  it("shows the server's refusal at the field it names, until that field is changed", async () => {
    const { setContact } = await openProfile('fake-owner', (backend) => {
      backend.meApi.setContact = () =>
        Promise.reject(
          new ApiValidationError('x', 'VALIDATION_FAILED', [{ path: 'phone', message: 'bad' }]),
        );
    });
    await openEditor();
    await typeInto(field(1), '998935550011');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(fieldError(0)).toBe('');
    expect(fieldError(1)).toBe(customerUz.contact.errors.phone);
    expect(generalError()).toBe('');
    expect(text('profile-phone')).toBe('+998 90 111 2233');
    expect(toastText()).toBe('');
    expect(setContact).not.toHaveBeenCalled();

    await typeInto(field(1), '998935550012');
    expect(fieldError(1)).toBe('');
  });

  it('a refused name is shown at the name field', async () => {
    await openProfile('fake-owner', (backend) => {
      backend.meApi.setContact = () =>
        Promise.reject(
          new ApiValidationError('x', 'VALIDATION_FAILED', [{ path: 'fullName', message: 'bad' }]),
        );
    });
    await openEditor();
    await typeInto(field(0), 'Anvar S');
    await save();
    expect(fieldError(0)).toBe(customerUz.contact.errors.name);
    expect(fieldError(1)).toBe('');
  });

  it('too many tries and other failures are one general line; the dialog stays open', async () => {
    let failWith: unknown = new ApiRateLimitedError('x', 'RATE_LIMITED', 30);
    await openProfile('fake-owner', (backend) => {
      backend.meApi.setContact = () => Promise.reject(failWith);
    });
    await openEditor();
    await typeInto(field(0), 'Anvar S');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(generalError()).toBe(customerUz.contact.errors.rateLimited);
    expect(fieldError(0)).toBe('');

    failWith = new ApiConflictError('x', 'CONFLICT');
    await save();
    expect(dialogOpen()).toBe(true);
    expect(generalError()).not.toBe('');
    expect(generalError()).not.toBe(customerUz.contact.errors.rateLimited);
    expect(text('profile-name')).toBe('Anvar Soliyev');
  });

  it('a double press of save sends one request', async () => {
    const { setContact } = await openProfile('fake-owner');
    await openEditor();
    await typeInto(field(0), 'Anvar Solijonov');
    const button = findModalButton(customerUz.profileEdit.submit);
    button.click();
    button.click();
    await waitFor(() => expect(text('profile-name')).toBe('Anvar Solijonov'));
    expect(setContact).toHaveBeenCalledTimes(1);
  });

  it('a customer without a phone yet adds it here, and the first order then does not ask', async () => {
    const { services } = await openProfile('fake-newcomer');
    expect(text('profile-phone')).toBe(customerUz.presentation.phoneMissing);
    expect(services.session.needsContact.value).toBe(true);
    await openEditor();
    expect(field(0).value).toBe('Dilshod Karimov');
    expect(field(1).value).toBe('');
    await typeInto(field(1), '998935550147');
    await save();
    await waitFor(() => expect(text('profile-phone')).toBe('+998 93 555 0147'));
    expect(services.session.needsContact.value).toBe(false);
  });
});

describe('a company employee viewing the app', () => {
  it('sees the name read-only, is told where to change it, and has no edit action or dialog', async () => {
    const { setContact } = await openProfile('fake-viewer');
    expect(text('profile-name')).toBe('Fake Staff Viewer');
    expect(editButton()).toBeNull();
    expect(text('profile-contact-hint')).toBe(customerUz.profileEdit.viewerHint);
    // No phone row: this app is told nothing about an employee's phone.
    expect(document.querySelector('[data-testid="profile-phone"]')).toBeNull();
    expect(bodyText()).not.toContain(customerUz.presentation.phoneMissing);
    expect(document.body.querySelector('.modal')).toBeNull();
    expect(setContact).not.toHaveBeenCalled();
  });
});

describe('texts of the profile edit', () => {
  it('exist in all three languages, with no empty one', () => {
    for (const messages of [customerUz, customerRu, customerEn]) {
      for (const value of [
        ...Object.values(messages.profileEdit),
        messages.presentation.contactHint,
        messages.presentation.phoneMissing,
      ]) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    expect(customerRu.profileEdit.action).not.toBe(customerUz.profileEdit.action);
    expect(customerEn.profileEdit.action).not.toBe(customerUz.profileEdit.action);
  });
});
