import { describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { LOCALE_STORAGE_KEY } from '@core/i18n';
import {
  bodyText,
  click,
  findButton,
  mountCustomerApp,
  typeInto,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import arrowAccentIcon from './assets/icons/arrow-accent.svg';
import gridAccentIcon from './assets/icons/grid-accent.svg';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();

describe('customer Figma flows', () => {
  it('keeps the customer palette active for body-teleported dialogs and releases it on unmount', async () => {
    document.documentElement.dataset.theme = 'dark';
    const { wrapper } = await mountCustomerApp('fake-owner', '/profile');
    expect(document.documentElement.hasAttribute('data-customer-app')).toBe(true);
    wrapper.unmount();
    expect(document.documentElement.hasAttribute('data-customer-app')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    delete document.documentElement.dataset.theme;
  });
  it('opens the home route with the caller organization and links to the real order', async () => {
    const { wrapper } = await mountCustomerApp('fake-owner', '/');
    await waitFor(() => expect(wrapper.find('.active-order').exists()).toBe(true));
    expect(bodyText()).toContain('Texno Plaza');
    expect(wrapper.find('.active-order').attributes('href')).toMatch(/^\/orders\//);
    expect(bodyText()).not.toContain('IO-10460');
  });

  it('shows own profile and changes language through the checked bottom sheet', async () => {
    await mountCustomerApp('fake-owner', '/profile');
    await waitFor(() => expect(document.querySelector('.language')).not.toBeNull());
    expect(bodyText()).toContain('Texno Plaza');
    const opener = document.querySelector<HTMLButtonElement>('.language');
    opener?.focus();
    await click(opener as Element);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('.languages [aria-pressed="true"]')?.textContent).toContain('✓');
    await click(findButton('English'));
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('EN');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await click(opener as Element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(opener as Element);
    await click(findButton("O'zbekcha"));
    localStorage.removeItem(LOCALE_STORAGE_KEY);
  });

  it('searches categories and closes the sheet after applying a category', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(document.querySelector('.category-trigger')).not.toBeNull());
    await click(document.querySelector('.category-trigger') as Element);
    const search = document.querySelector('[role="dialog"] input[type="search"]');
    await typeInto(search as Element, 'Кабели');
    expect(document.querySelectorAll('.category-options button')).toHaveLength(1);
    await click(document.querySelector('.category-options button') as Element);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.category-trigger')?.textContent).toContain('Кабели');
    expect(document.querySelectorAll('.card')).toHaveLength(1);
  });

  it('resets category search after dismissing and restores focus to the selector', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(document.querySelector('.category-trigger')).not.toBeNull());
    const opener = document.querySelector<HTMLButtonElement>('.category-trigger')!;
    opener.focus();
    await click(opener);
    await typeInto(document.querySelector('[role="dialog"] input') as Element, 'missing-category');
    expect(document.querySelectorAll('.category-options button')).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(opener);
    await click(opener);
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('');
    expect(document.querySelectorAll('.category-options button').length).toBeGreaterThan(1);
    expect(
      document.querySelector('.category-options [aria-pressed="true"]')?.textContent,
    ).toContain('\u2713');
  });

  // Design "Two-column photo grid": the trigger names the category, the line under it counts.
  it('counts the shown products on the mobile results line and shows UZS pricing context', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(document.querySelector('.category-trigger')).not.toBeNull());
    const results = (): string => document.querySelector('.category-results')?.textContent ?? '';
    expect(results()).toContain('7 ta mahsulot');
    expect(results()).toContain("Narxlar so'mda");
    await click(document.querySelector('.category-trigger') as Element);
    await typeInto(document.querySelector('[role="dialog"] input') as Element, 'Кабели');
    await click(document.querySelector('.category-options button') as Element);
    expect(results()).toContain('1 ta mahsulot');
    expect(document.querySelector('.category-trigger')?.textContent).toContain('Кабели');
  });

  it('keeps the Figma home catalog entry as one link to products', async () => {
    const { wrapper, router } = await mountCustomerApp('fake-owner', '/');
    const entry = wrapper.find('.catalog-entry');
    expect(entry.text()).toContain(customerUz.presentation.productsPrices);
    // Bundled assets (small ones are inlined), so compare with what the import resolves to.
    expect(entry.findAll('img').map((img) => img.attributes('src'))).toEqual([
      gridAccentIcon,
      arrowAccentIcon,
    ]);
    await entry.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('customer-catalog');
  });

  it('filters on the server before pagination, then searches beyond the first page', async () => {
    await mountCustomerApp('fake-owner', '/orders', { pageSize: 1 });
    await waitFor(() => expect(document.querySelectorAll('a.card')).toHaveLength(1));
    await click(findButton(customerUz.presentation.completed));
    // The newest finished order is a received one: "delivered", with the receipt confirmed.
    await waitFor(() =>
      expect(document.querySelector('a.card')?.textContent).toContain(
        customerUz.orderState.note.RECEIPT_CONFIRMED,
      ),
    );
    expect(document.querySelector('a.card')?.textContent).toContain(
      customerUz.orderState.DELIVERED,
    );
    await click(findButton(customerUz.orders.filterAll));
    const search = document.querySelector<HTMLInputElement>('input[type="search"]');
    await typeInto(search as Element, '10480');
    await waitFor(() =>
      expect(document.querySelector('a.card')?.textContent).toContain('IO-10480'),
    );
    expect(document.querySelectorAll('a.card')).toHaveLength(1);
  });
});
