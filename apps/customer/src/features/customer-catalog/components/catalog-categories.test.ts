import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bodyText,
  click,
  findButton,
  mountCustomerApp,
  typeInto,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from '@/features/customer-app/messages/uz';

useCustomerTestLifecycle();
afterEach(() => vi.restoreAllMocks());

const messages = customerUz.catalog.categories;
const KABELI = 'Кабели';
const CHARGERS = 'Зарядные устройства';

const all = <T extends Element>(selector: string): T[] =>
  Array.from(document.body.querySelectorAll<T>(selector));
const tabs = (): HTMLElement[] => all<HTMLElement>('[role="tab"]');
const tabLabels = (): string[] =>
  tabs().map((tab) => tab.querySelector('.tabs__label')?.textContent ?? '');
const selectedTab = (): HTMLElement | undefined =>
  tabs().find((tab) => tab.getAttribute('aria-selected') === 'true');
const tabNamed = (label: string): HTMLElement => {
  const found = tabs().find((tab) => tab.querySelector('.tabs__label')?.textContent === label);
  if (!found) throw new Error(`No tab ${label}`);
  return found;
};
const headings = (): string[] =>
  all('.group__title').map((h) => (h.childNodes[0]?.textContent ?? '').trim());
const rowNames = (): string[] => all('.card__name').map((n) => n.textContent ?? '');
const search = (): HTMLInputElement =>
  document.body.querySelector('input[type="search"], .search input') as HTMLInputElement;

const ready = async (path = '/prices') => {
  const mounted = await mountCustomerApp('fake-owner', path);
  await waitFor(() => expect(all('.card').length).toBeGreaterThan(0));
  return mounted;
};

describe('customer price list: category bar', () => {
  it('shows All first with its count, the categories alphabetically with counts, Other last', async () => {
    await ready();
    expect(tabLabels()).toEqual([
      messages.all,
      'Аудио',
      CHARGERS,
      KABELI,
      'Смартфоны',
      messages.other,
    ]);
    // Smartphones count two: the out-of-stock Tecno stays in the list.
    expect(tabs().map((tab) => tab.querySelector('.tabs__count')?.textContent)).toEqual([
      '7',
      '1',
      '2',
      '1',
      '2',
      '1',
    ]);
  });

  it('is an accessible tab list: named, aria-selected on one tab, linked to the results panel', async () => {
    await ready();
    const list = document.body.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe(messages.label);
    expect(tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(selectedTab()?.textContent).toContain(messages.all);
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(selectedTab()?.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(selectedTab()?.id);
    // Ids hold no spaces, so aria-labelledby cannot split a category name.
    expect(selectedTab()?.id).not.toMatch(/\s/);
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
  });

  it('arrow keys move the selection (the arrows select, as in the tabs pattern)', async () => {
    await ready();
    const list = document.body.querySelector('[role="tablist"]') as HTMLElement;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => expect(selectedTab()?.textContent).toContain('Аудио'));
    expect(headings()).toEqual([]);
    expect(rowNames()).toEqual(['Borofone BW05 quloqchin']);
  });

  it('the chosen chip is scrolled into view (horizontally only)', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await ready(`/prices?category=${encodeURIComponent('Смартфоны')}`);
    expect(scroll).toHaveBeenCalledWith({ inline: 'center', block: 'nearest' });
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });
});

describe('customer price list: grouping and filtering', () => {
  it('groups the whole list under category headings, Other last', async () => {
    await ready();
    expect(headings()).toEqual(['Аудио', CHARGERS, KABELI, 'Смартфоны', messages.other]);
    const groups = all('[data-testid="catalog-group"]').map((g) =>
      Array.from(g.querySelectorAll('.card__name')).map((n) => n.textContent),
    );
    expect(groups[1]).toEqual(['Baseus 20W zaryadlovchi', 'Ugreen 65W GaN adapter']);
    expect(groups[4]).toEqual(['Himoya oynasi (Hoco, A15)']);
    // Each list is named by its heading.
    const first = document.body.querySelector('.group ul') as HTMLElement;
    expect(first.getAttribute('aria-labelledby')).toBe(
      document.body.querySelector('.group__title')?.id,
    );
  });

  it('selecting a category filters to it and drops the heading; the URL and the session keep it', async () => {
    const { router } = await ready();
    await click(tabNamed(CHARGERS));
    expect(rowNames()).toEqual(['Baseus 20W zaryadlovchi', 'Ugreen 65W GaN adapter']);
    expect(headings()).toEqual([]);
    expect(selectedTab()?.textContent).toContain(CHARGERS);
    await waitFor(() => expect(router.currentRoute.value.query.category).toBe(CHARGERS));
    expect(window.sessionStorage.getItem('iorder.customer.catalog.category')).toBe(CHARGERS);
    expect(bodyText()).toContain('2 ta mahsulot');
    // Back to All removes both.
    await click(tabNamed(messages.all));
    await waitFor(() => expect(router.currentRoute.value.query.category).toBeUndefined());
    expect(window.sessionStorage.getItem('iorder.customer.catalog.category')).toBeNull();
    expect(headings()).toHaveLength(5);
  });

  it('the Other chip shows the products without a category', async () => {
    const { router } = await ready();
    await click(tabNamed(messages.other));
    expect(rowNames()).toEqual(['Himoya oynasi (Hoco, A15)']);
    await waitFor(() => expect(router.currentRoute.value.query.category).toBe('~other'));
  });

  it('search works inside the selection, and in All it shows matches grouped with live counts', async () => {
    await ready();
    await typeInto(search(), 'hoco');
    // "Hoco" matches the Kabeli product and the Other product (name contains Hoco).
    expect(headings()).toEqual([KABELI, messages.other]);
    expect(tabs().map((tab) => tab.querySelector('.tabs__count')?.textContent)).toEqual([
      '2',
      '0',
      '0',
      '1',
      '0',
      '1',
    ]);
    await click(tabNamed(KABELI));
    expect(rowNames()).toEqual(['Hoco USB-C kabel 1 m']);
    await click(tabNamed(CHARGERS));
    expect(rowNames()).toEqual([]);
    expect(bodyText()).toContain(customerUz.catalog.noResults);
  });

  it('an empty result offers Clear, which resets search and category', async () => {
    await ready();
    await click(tabNamed('Смартфоны'));
    await typeInto(search(), 'baseus');
    expect(bodyText()).toContain(customerUz.catalog.noResults);
    await click(findButton(messages.clear));
    expect(search().value).toBe('');
    expect(selectedTab()?.textContent).toContain(messages.all);
    expect(rowNames()).toHaveLength(7);
    expect(bodyText()).not.toContain(customerUz.catalog.noResults);
  });

  it('the cart controls keep working inside groups', async () => {
    await ready();
    await click(document.body.querySelector('button[aria-label^="Savatga: Baseus"]') as Element);
    await waitFor(() => expect(document.body.querySelector('aside.bar')).not.toBeNull());
    expect(
      document.body.querySelector('input[aria-label="Baseus 20W zaryadlovchi: miqdor"]'),
    ).not.toBeNull();
  });

  it('shows no category anywhere but the price list: not in the cart', async () => {
    const { router } = await ready();
    await click(document.body.querySelector('button[aria-label^="Savatga: Tecno"]') as Element);
    await router.push('/cart');
    await waitFor(() => expect(bodyText()).toContain('Tecno Spark'));
    expect(bodyText()).not.toContain('Смартфоны');
  });
});

describe('customer price list: category in the URL and the session', () => {
  it('opens on the category of a deep link', async () => {
    await ready(`/prices?category=${encodeURIComponent(KABELI)}`);
    expect(selectedTab()?.textContent).toContain(KABELI);
    expect(rowNames()).toEqual(['Hoco USB-C kabel 1 m']);
  });

  it('an unknown ?category= falls back to All and is cleaned from the URL and the session', async () => {
    window.sessionStorage.setItem('iorder.customer.catalog.category', KABELI);
    const { router } = await ready('/prices?category=nope&x=1');
    expect(selectedTab()?.textContent).toContain(messages.all);
    expect(rowNames()).toHaveLength(7);
    await waitFor(() => expect(router.currentRoute.value.query).toEqual({ x: '1' }));
    expect(window.sessionStorage.getItem('iorder.customer.catalog.category')).toBeNull();
  });

  it('an empty ?category= is removed from the URL like any other invalid value', async () => {
    const { router } = await ready('/prices?category=&x=1');
    expect(selectedTab()?.textContent).toContain(messages.all);
    await waitFor(() => expect(router.currentRoute.value.query).toEqual({ x: '1' }));
  });

  it('choosing a category scrolls up when the list top is hidden behind the tools bar', async () => {
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    await ready();
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    const tools = document.body.querySelector('.tools') as HTMLElement;
    const rect = (top: number, bottom: number) => () => ({ top, bottom }) as DOMRect;
    panel.getBoundingClientRect = rect(-500, 0);
    tools.getBoundingClientRect = rect(0, 130);
    await click(tabNamed(CHARGERS));
    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith({ top: -630 }));

    scrollBy.mockClear();
    panel.getBoundingClientRect = rect(300, 900);
    await click(tabNamed(KABELI));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('restores the category of the session and makes it a shareable link', async () => {
    window.sessionStorage.setItem('iorder.customer.catalog.category', 'Аудио');
    const { router } = await ready();
    expect(selectedTab()?.textContent).toContain('Аудио');
    await waitFor(() => expect(router.currentRoute.value.query.category).toBe('Аудио'));
  });

  it('ignores a remembered category the list does not have', async () => {
    window.sessionStorage.setItem('iorder.customer.catalog.category', 'Old category');
    await ready();
    expect(selectedTab()?.textContent).toContain(messages.all);
  });

  it('works when sessionStorage throws (the URL still carries the choice)', async () => {
    // Only the category key is blocked: the app keeps its sign-in data in the same storage.
    const blocked = new Set(['getItem', 'setItem', 'removeItem']);
    const originals = {
      getItem: Storage.prototype.getItem,
      setItem: Storage.prototype.setItem,
      removeItem: Storage.prototype.removeItem,
    };
    for (const method of blocked) {
      const name = method as keyof typeof originals;
      vi.spyOn(Storage.prototype, name).mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key === 'iorder.customer.catalog.category') throw new Error('blocked');
        return (originals[name] as (k: string, v: string) => unknown).call(this, key, value);
      } as never);
    }
    const { router } = await ready();
    await click(tabNamed(KABELI));
    expect(rowNames()).toEqual(['Hoco USB-C kabel 1 m']);
    await waitFor(() => expect(router.currentRoute.value.query.category).toBe(KABELI));
  });

  it('follows the URL when it changes (back/forward)', async () => {
    const { router } = await ready();
    await router.push(`/prices?category=${encodeURIComponent('Смартфоны')}`);
    await waitFor(() => expect(selectedTab()?.textContent).toContain('Смартфоны'));
    await router.push('/prices');
    await waitFor(() => expect(selectedTab()?.textContent).toContain(messages.all));
  });
});
