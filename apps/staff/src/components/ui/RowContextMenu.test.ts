import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import DataTable from './DataTable.vue';
import { clampToViewport, type RowMenuItem } from './RowContextMenu.vue';
import type { DataTableColumn } from './data-table';
import { openDropdownId } from '@core/composables/use-open-dropdown';

interface Item {
  id: string;
  name: string;
}

const items: Item[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
];
const columns: DataTableColumn<Item>[] = [{ key: 'name', label: 'Name', text: (r) => r.name }];
const menuOf = (row: Item): RowMenuItem[] =>
  row.id === 'b'
    ? []
    : [
        { id: 'edit', label: 'Edit', icon: 'pencil' },
        { id: 'copy', label: 'Copy', icon: 'copy' },
        { id: 'remove', label: 'Remove', icon: 'trash', tone: 'danger' },
      ];

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  openDropdownId.value = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountTable(options: { router?: boolean } = {}) {
  const chosen: [string, string][] = [];
  const opened: string[] = [];
  const Host = defineComponent({
    render: () =>
      h(DataTable<Item>, {
        columns,
        rows: items,
        rowKey: (r: Item) => r.id,
        rowAction: (r: Item) => opened.push(r.id),
        rowMenu: menuOf,
        rowMenuLabel: (r: Item) => `${r.name}: actions`,
        label: 'Things',
        emptyText: 'Nothing',
        onRowMenuChoose: (row: Item, id: string) => chosen.push([row.id, id]),
      }),
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  });
  await router.push('/list');
  const wrapper = mount(Host, {
    attachTo: document.body,
    global: { plugins: options.router === false ? [] : [router] },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, chosen, opened, router };
}

const menu = (): HTMLElement | null => document.body.querySelector('[role="menu"]');
const menuItems = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const row = (name: string): HTMLElement => {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>('tbody tr')).find((r) =>
    r.textContent?.includes(name),
  );
  if (!found) throw new Error(`no row ${name}`);
  return found;
};
const rowButton = (name: string): HTMLElement => {
  const found = row(name).querySelector<HTMLElement>('.dt__link');
  if (!found) throw new Error('no row button');
  return found;
};

function rightClick(target: Element, x = 120, y = 80): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 2,
  });
  target.dispatchEvent(event);
  return event;
}

function key(target: Element, keyName: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('RowContextMenu on a DataTable row', () => {
  it('opens at the pointer on a right click, instead of the browser menu', async () => {
    await mountTable();
    const event = rightClick(row('Alpha').querySelector('td') ?? row('Alpha'), 120, 80);
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    const el = menu();
    expect(el?.getAttribute('aria-label')).toBe('Alpha: actions');
    expect(el?.style.left).toBe('120px');
    expect(el?.style.top).toBe('80px');
    expect(menuItems().map((i) => i.textContent?.trim())).toEqual(['Edit', 'Copy', 'Remove']);
    // The first item has the focus; the others are reached with the arrows (roving tabindex).
    expect(document.activeElement).toBe(menuItems()[0]);
    expect(menuItems().map((i) => i.tabIndex)).toEqual([0, -1, -1]);
    // The destructive item stands apart.
    expect(el?.querySelector('[role="separator"]')).not.toBeNull();
    expect(menuItems()[2]?.classList.contains('rowmenu__item--danger')).toBe(true);
  });

  it('keeps the browser menu on a row without actions and on text fields', async () => {
    await mountTable();
    const event = rightClick(row('Bravo'));
    await flushPromises();
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(row('Bravo').querySelector('[data-testid="row-menu-button"]')).toBeNull();
    const input = document.createElement('input');
    row('Alpha').querySelector('td')?.append(input);
    const onField = rightClick(input);
    await flushPromises();
    expect(onField.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it('walks the items with the arrows, Home and End, and picks one with a click', async () => {
    const { chosen, opened } = await mountTable();
    rightClick(rowButton('Alpha'));
    await flushPromises();
    const el = menu();
    if (!el) throw new Error('no menu');
    key(el, 'ArrowDown');
    expect(document.activeElement).toBe(menuItems()[1]);
    key(el, 'ArrowDown');
    key(el, 'ArrowDown');
    // Wraps around.
    expect(document.activeElement).toBe(menuItems()[0]);
    key(el, 'ArrowUp');
    expect(document.activeElement).toBe(menuItems()[2]);
    key(el, 'Home');
    expect(document.activeElement).toBe(menuItems()[0]);
    key(el, 'End');
    expect(document.activeElement).toBe(menuItems()[2]);
    menuItems()[1]?.click();
    await flushPromises();
    expect(chosen).toEqual([['a', 'copy']]);
    expect(menu()).toBeNull();
    // The focus is back on the row, and the right click never opened the row itself.
    expect(document.activeElement).toBe(rowButton('Alpha'));
    expect(opened).toEqual([]);
  });

  it('closes on Escape and gives the focus back to the row', async () => {
    const { chosen } = await mountTable();
    rowButton('Alpha').focus();
    rightClick(rowButton('Alpha'));
    await flushPromises();
    const escape = key(menu() ?? document.body, 'Escape');
    await flushPromises();
    expect(escape.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(rowButton('Alpha'));
    expect(chosen).toEqual([]);
  });

  it('opens from the keyboard: the Context Menu key and Shift+F10 on the focused row', async () => {
    const { chosen } = await mountTable();
    const control = rowButton('Alpha');
    control.focus();
    const menuKey = key(control, 'ContextMenu');
    await flushPromises();
    expect(menuKey.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    // The browser's own contextmenu that follows the key opens nothing twice.
    rightClick(control, 0, 0);
    await flushPromises();
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
    key(menu() ?? document.body, 'Escape');
    await flushPromises();
    expect(document.activeElement).toBe(control);

    key(control, 'F10', { shiftKey: true });
    await flushPromises();
    expect(menu()).not.toBeNull();
    // Enter or Space on the focused item is the browser's own button click.
    (document.activeElement as HTMLElement).click();
    await flushPromises();
    expect(chosen).toEqual([['a', 'edit']]);
    // F10 alone is not the menu key.
    key(control, 'F10');
    await flushPromises();
    expect(menu()).toBeNull();
  });

  it('closes on an outside press, a scroll and a route change, without moving the focus', async () => {
    const { router } = await mountTable();
    const outside = document.createElement('button');
    document.body.append(outside);

    rightClick(rowButton('Alpha'));
    await flushPromises();
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(menu()).toBeNull();

    rightClick(rowButton('Alpha'));
    await flushPromises();
    // A press inside the menu keeps it open.
    menuItems()[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(menu()).not.toBeNull();
    window.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(menu()).toBeNull();

    rightClick(rowButton('Alpha'));
    await flushPromises();
    await router.push('/elsewhere');
    await flushPromises();
    expect(menu()).toBeNull();
  });

  it('works without a router (route change watching is skipped)', async () => {
    await mountTable({ router: false });
    rightClick(rowButton('Alpha'));
    await flushPromises();
    expect(menu()).not.toBeNull();
  });

  it('stays inside the viewport near the right and bottom edges', async () => {
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 300);
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'menu') {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 220,
          bottom: 140,
          width: 220,
          height: 140,
        } as DOMRect;
      }
      return original.call(this);
    });
    await mountTable();
    rightClick(rowButton('Alpha'), 390, 290);
    await flushPromises();
    const el = menu();
    // 400 - 220 - 8 = 172; opened upwards: 290 - 140 = 150.
    expect(el?.style.left).toBe('172px');
    expect(el?.style.top).toBe('150px');
    expect(el?.classList.contains('rowmenu--measuring')).toBe(false);
  });

  it('offers a "⋯" button for touch screens that opens the same menu and gets the focus back', async () => {
    const { chosen } = await mountTable();
    const more = row('Alpha').querySelector<HTMLButtonElement>('[data-testid="row-menu-button"]');
    if (!more) throw new Error('no more button');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-label')).toBe('Alpha: actions');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    more.click();
    await flushPromises();
    expect(menu()).not.toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    key(menu() ?? document.body, 'Escape');
    await flushPromises();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(chosen).toEqual([]);
  });

  it('toggles from the "⋯" button: a second press closes the menu instead of reopening it', async () => {
    await mountTable();
    const more = row('Alpha').querySelector<HTMLButtonElement>('[data-testid="row-menu-button"]');
    if (!more) throw new Error('no more button');
    // A real press: pointerdown first (the outside-press listener sees it), then the click.
    const press = async (): Promise<void> => {
      more.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      more.click();
      await flushPromises();
    };
    await press();
    expect(menu()).not.toBeNull();
    await press();
    expect(menu()).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
    await press();
    expect(menu()).not.toBeNull();
  });

  it('keeps the browser menu when text inside the row is selected (to copy it)', async () => {
    await mountTable();
    const cell = row('Alpha').querySelector('td');
    if (!cell) throw new Error('no cell');
    const range = document.createRange();
    range.selectNodeContents(cell);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const event = rightClick(cell);
    await flushPromises();
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    // A selection elsewhere does not take the row's menu away.
    selection?.removeAllRanges();
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    const other = document.createRange();
    other.selectNodeContents(outside);
    selection?.addRange(other);
    const second = rightClick(cell);
    await flushPromises();
    expect(second.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    selection?.removeAllRanges();
  });

  it('puts the "⋯" button beside the phone card, never inside the card button', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { chosen } = await mountTable();
    const card = document.body.querySelector<HTMLElement>('.dt__cards li');
    const more = card?.querySelector<HTMLButtonElement>('[data-testid="row-menu-button"]');
    if (!card || !more) throw new Error('no card menu button');
    expect(more.closest('.dt__card')).toBeNull();
    more.click();
    await flushPromises();
    menuItems()[2]?.click();
    await flushPromises();
    expect(chosen).toEqual([['a', 'remove']]);
    // A long press on the card (Android fires contextmenu for it) opens the menu too.
    rightClick(card.querySelector('.dt__card') ?? card);
    await flushPromises();
    expect(menu()).not.toBeNull();
  });
});

describe('clampToViewport', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 160 };
  it('keeps a point that fits', () => {
    expect(clampToViewport({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });
  it('moves left at the right edge and up at the bottom edge', () => {
    expect(clampToViewport({ x: 950, y: 750 }, size, viewport)).toEqual({ x: 792, y: 590 });
  });
  it('never goes past the top-left margin, even for a menu taller than the viewport', () => {
    expect(clampToViewport({ x: -20, y: 50 }, { width: 200, height: 900 }, viewport)).toEqual({
      x: 8,
      y: 8,
    });
  });
});
