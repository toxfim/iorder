import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppI18n } from '@/i18n';
import { staffCostMessages } from '../messages';
import { useUrlState } from '../composables/use-url-state';
import {
  CATEGORY_ALL,
  CATEGORY_NONE,
  categoryTabId,
  type CategoryCounts,
} from '../domain/category-filter';
import CategoryDropdown from './CategoryDropdown.vue';
import dropdownSource from './CategoryDropdown.vue?raw';

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

const COUNTS: CategoryCounts = {
  total: 12,
  uncategorized: 1,
  categories: [
    { category: 'Telefonlar', count: 6 },
    { category: 'Audio', count: 3 },
    { category: 'Aksessuarlar', count: 2 },
  ],
};

async function mountDropdown(options: { path?: string; alsoKnown?: string[] } = {}) {
  const i18n = createAppI18n('UZ');
  i18n.global.mergeLocaleMessage('uz', { staffCost: staffCostMessages.uz });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  });
  await router.push(options.path ?? '/list');
  // The pages bind the dropdown to a ref kept in the address with useUrlState; do the same here.
  const Host = defineComponent({
    setup() {
      const category = ref(CATEGORY_ALL);
      useUrlState('category', category, { fallback: CATEGORY_ALL });
      return () =>
        h('div', [
          h(CategoryDropdown, {
            modelValue: category.value,
            'onUpdate:modelValue': (id: string) => {
              category.value = id;
            },
            counts: COUNTS,
            alsoKnown: options.alsoKnown ?? ['Planshetlar', 'Kabel'],
          }),
          h('button', { class: 'outside', type: 'button' }, 'outside'),
        ]);
    },
  });
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [i18n, router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}

const trigger = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
const input = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('input[role="combobox"]');
const options = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const labels = (): string[] =>
  options().map(
    (o) =>
      `${o.querySelector('.catdd__label')?.textContent} ${o.querySelector('.catdd__count')?.textContent}`,
  );
const value = (): string => trigger().querySelector('.catdd__value')?.textContent?.trim() ?? '';

async function open(): Promise<void> {
  trigger().click();
  await flushPromises();
}
async function type(text: string): Promise<void> {
  const field = input()!;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function key(name: string): Promise<void> {
  input()!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  await flushPromises();
}

describe('CategoryDropdown', () => {
  it('opens with the cursor in the search, counts per category, empty ones dimmed at the end', async () => {
    await mountDropdown();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(value()).toBe('Barcha kategoriyalar');
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(labels()).toEqual([
      'Barcha kategoriyalar 12',
      'Aksessuarlar 2',
      'Audio 3',
      'Telefonlar 6',
      'Kategoriyasiz 1',
      'Kabel 0',
      'Planshetlar 0',
    ]);
    const dimmed = options().filter((o) => o.classList.contains('catdd__option--empty'));
    expect(dimmed.map((o) => o.querySelector('.catdd__label')?.textContent)).toEqual([
      'Kabel',
      'Planshetlar',
    ]);
    expect(document.querySelector('.catdd__foot')?.textContent?.trim()).toBe(
      '6 ta kategoriya · 4 tasida tovar bor',
    );
    // combobox + listbox semantics: the search drives the list through aria-activedescendant.
    const listbox = document.querySelector('[role="listbox"]')!;
    expect(input()?.getAttribute('aria-controls')).toBe(listbox.id);
    expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('filters while typing (no "all" option then) and says when nothing matches', async () => {
    await mountDropdown();
    await open();
    await type('TEL');
    expect(labels()).toEqual(['Telefonlar 6']);
    await type('zzz');
    expect(options()).toHaveLength(0);
    expect(document.querySelector('.catdd__none')?.textContent?.trim()).toBe(
      'Kategoriya topilmadi',
    );
  });

  it('Enter takes the first match, closes, returns focus and writes the address', async () => {
    const { router } = await mountDropdown();
    await open();
    await type('a');
    // "a" matches Aksessuarlar, Audio, Telefonlar, Kategoriyasiz, Kabel, Planshetlar: the first wins.
    await key('Enter');
    expect(value()).toBe('Aksessuarlar');
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(router.currentRoute.value.query.category).toBe(categoryTabId('Aksessuarlar'));
  });

  it('arrow keys move the active option, Enter picks it', async () => {
    await mountDropdown();
    await open();
    await key('ArrowDown');
    await key('ArrowDown');
    expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    await key('Enter');
    expect(value()).toBe('Audio');
  });

  it('Escape closes without choosing and gives focus back to the trigger', async () => {
    await mountDropdown();
    await open();
    await type('Tel');
    await key('Escape');
    expect(input()).toBeNull();
    expect(value()).toBe('Barcha kategoriyalar');
    expect(document.activeElement).toBe(trigger());
  });

  it('a click outside closes it', async () => {
    await mountDropdown();
    await open();
    document
      .querySelector('.outside')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(input()).toBeNull();
  });

  it('a chosen category turns the trigger accent with a clear button that resets the address', async () => {
    const { router } = await mountDropdown();
    await open();
    options()
      .find((o) => o.querySelector('.catdd__label')?.textContent === 'Kategoriyasiz')!
      .click();
    await flushPromises();
    expect(router.currentRoute.value.query.category).toBe(CATEGORY_NONE);
    expect(document.querySelector('.catdd--on')).not.toBeNull();
    const clear = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Kategoriyani tozalash"]',
    )!;
    clear.click();
    await flushPromises();
    expect(value()).toBe('Barcha kategoriyalar');
    expect(document.querySelector('.catdd--on')).toBeNull();
    expect(router.currentRoute.value.query.category).toBeUndefined();
  });

  it('reads the category from the address and falls back when it is unknown', async () => {
    await mountDropdown({ path: '/list?category=c%3AAudio' });
    expect(value()).toBe('Audio');
    wrappers.splice(0).forEach((w) => w.unmount());
    const { router } = await mountDropdown({ path: '/list?category=c%3AYoq' });
    expect(value()).toBe('Barcha kategoriyalar');
    expect(router.currentRoute.value.query.category).toBeUndefined();
  });

  it('fits a phone: the popup never exceeds the screen and the list scrolls inside itself', () => {
    expect(dropdownSource).toMatch(/\.catdd__pop \{[^}]*max-width: calc\(100vw - 32px\)/s);
    expect(dropdownSource).toMatch(/\.catdd__list \{[^}]*max-height: 300px[^}]*overflow-y: auto/s);
    expect(dropdownSource).toMatch(
      /@media \(max-width: 639px\)[\s\S]*\.catdd__pop \{[^}]*width: 100%/,
    );
  });
});
