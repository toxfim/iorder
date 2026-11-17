/* eslint-disable vue/one-component-per-file -- small throwaway host components per test */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppI18n } from '@/i18n';
import { staffCommonUz } from '@/features/staff-common/messages/uz';
import { resetTableDensity, useTableDensity } from '@/composables/use-table-density';
import DataTable from './DataTable.vue';
import TableDensitySwitch from './TableDensitySwitch.vue';
import source from './DataTable.vue?raw';
import { columnGroups, nextSort, sortRows, type DataTableColumn } from './data-table';

interface Item {
  id: string;
  name: string;
  qty: number;
  price?: string;
}

const items: Item[] = [
  { id: 'a', name: 'Bravo', qty: 5, price: '100' },
  { id: 'b', name: 'Alpha', qty: 20, price: '5' },
  { id: 'c', name: 'Charlie', qty: 1, price: '30' },
];

const baseColumns = (extra: Partial<DataTableColumn<Item>> = {}): DataTableColumn<Item>[] => [
  {
    key: 'name',
    label: 'Name',
    truncate: true,
    text: (r) => r.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    key: 'qty',
    label: 'Qty',
    align: 'end',
    text: (r) => String(r.qty),
    compare: (a, b) => a.qty - b.qty,
  },
  { key: 'price', label: 'Price', align: 'end', text: (r) => r.price ?? '', ...extra },
];

const Page = (props: { columns?: DataTableColumn<Item>[]; rows?: Item[] }, toolbar = false) =>
  defineComponent({
    render: () =>
      h(
        DataTable<Item>,
        {
          columns: props.columns ?? baseColumns(),
          rows: props.rows ?? items,
          rowKey: (r: Item) => r.id,
          rowTo: (r: Item) => ({ path: `/x/${r.id}` }),
          label: 'Things',
          emptyText: 'Nothing here',
        },
        toolbar ? { toolbar: () => h('button', { class: 'tool' }, 'Tool') } : undefined,
      ),
  });

function mountTable(
  props: { columns?: DataTableColumn<Item>[]; rows?: Item[] } = {},
  toolbar = false,
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  });
  const i18n = createAppI18n('UZ');
  i18n.global.mergeLocaleMessage('uz', staffCommonUz);
  return mount(Page(props, toolbar), {
    attachTo: document.body,
    global: { plugins: [router, i18n] },
  });
}

const names = (w: ReturnType<typeof mountTable>): string[] =>
  w.findAll('tbody tr').map((r) => r.findAll('td')[0]?.text() ?? '');

beforeEach(() => {
  window.sessionStorage.clear();
  resetTableDensity();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('sort helpers', () => {
  const columns = baseColumns();
  it('sorts stably and cycles ascending, descending, default', () => {
    expect(sortRows(items, columns, { key: 'qty', direction: 'asc' }).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(sortRows(items, columns, { key: 'qty', direction: 'desc' }).map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(sortRows(items, columns, null)).toEqual(items);
    const first = nextSort(null, 'qty');
    expect(first).toEqual({ key: 'qty', direction: 'asc' });
    expect(nextSort(first, 'qty')).toEqual({ key: 'qty', direction: 'desc' });
    expect(nextSort(nextSort(first, 'qty'), 'qty')).toBeNull();
    expect(nextSort(first, 'name')).toEqual({ key: 'name', direction: 'asc' });
  });

  it('keeps equal rows in their arrival order', () => {
    const same = [
      { id: '1', name: 'x', qty: 1 },
      { id: '2', name: 'x', qty: 1 },
      { id: '3', name: 'x', qty: 1 },
    ];
    expect(
      sortRows(same, baseColumns(), { key: 'qty', direction: 'desc' }).map((r) => r.id),
    ).toEqual(['1', '2', '3']);
  });
});

describe('DataTable', () => {
  it('sorts the loaded rows when a sortable header is pressed and marks aria-sort', async () => {
    const w = mountTable();
    expect(names(w)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    await w.get('th button').trigger('click');
    expect(names(w)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(w.findAll('th')[0]?.attributes('aria-sort')).toBe('ascending');
    await w.get('th button').trigger('click');
    expect(names(w)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(w.findAll('th')[0]?.attributes('aria-sort')).toBe('descending');
    await w.get('th button').trigger('click');
    expect(names(w)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    // a column without a comparator has no button and no aria-sort
    expect(w.findAll('th')[2]?.find('button').exists()).toBe(false);
    expect(w.findAll('th')[2]?.attributes('aria-sort')).toBeUndefined();
  });

  it('draws numbers right aligned with tabular figures and tooltips on truncated text', () => {
    const w = mountTable();
    const cells = w.findAll('tbody tr')[0]!.findAll('td');
    expect(cells[1]!.classes()).toContain('dt__td--end');
    expect(cells[1]!.classes()).toContain('dt__td--num');
    expect(cells[0]!.attributes('title')).toBe('Bravo');
    expect(cells[1]!.attributes('title')).toBeUndefined();
  });

  it('does not draw a hidden column (the page decides from the DTO, not from a role)', () => {
    const w = mountTable({ columns: baseColumns({ hidden: true }) });
    expect(w.findAll('th').map((h) => h.text())).toEqual(['Name ↕', 'Qty ↕']);
    expect(w.text()).not.toContain('100');
  });

  it('draws one group header over neighbouring columns of the same group, none without groups', () => {
    expect(mountTable().find('.dt__groups').exists()).toBe(false);
    const grouped: DataTableColumn<Item>[] = baseColumns().map((c) =>
      c.key === 'name' ? c : { ...c, group: 'Prices' },
    );
    const w = mountTable({ columns: grouped });
    const cells = w.findAll('.dt__groups th');
    expect(cells.map((c) => [c.text(), c.attributes('colspan')])).toEqual([
      ['', '1'],
      ['Prices', '2'],
    ]);
    expect(cells[1]!.attributes('scope')).toBe('colgroup');
    expect(w.classes()).toContain('dt--grouped');
    expect(columnGroups(grouped).map((g) => g.span)).toEqual([1, 2]);
  });

  it('makes every row a link in its first cell', () => {
    const w = mountTable();
    const links = w.findAll('tbody a.dt__link');
    expect(links).toHaveLength(3);
    expect(links[0]!.attributes('href')).toBe('/x/a');
  });

  it('opens the row from a click on any cell, but not from a control inside it', async () => {
    const w = mountTable();
    const router = w.vm.$router;
    await w.findAll('tbody tr')[1]!.findAll('td')[2]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/x/b');
    await router.push('/start');
    // a control inside a cell keeps its own click
    const row = w.findAll('tbody tr')[0]!.element;
    const button = document.createElement('button');
    row.querySelectorAll('td')[1]!.append(button);
    button.click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/start');
    // a modified click is left to the browser (new tab)
    await w.findAll('tbody tr')[0]!.findAll('td')[2]!.trigger('click', { ctrlKey: true });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/start');
  });

  it('walks the row links with the arrow keys, Home and End', async () => {
    const w = mountTable();
    const links = w.findAll('tbody a.dt__link').map((l) => l.element as HTMLElement);
    links[0]!.focus();
    await w.findAll('tbody a.dt__link')[0]!.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[1]);
    await w.findAll('tbody a.dt__link')[1]!.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(links[2]);
    await w.findAll('tbody a.dt__link')[2]!.trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(links[1]);
    await w.findAll('tbody a.dt__link')[1]!.trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(links[0]);
  });

  it('shows the empty text and no table when there are no rows', () => {
    const w = mountTable({ rows: [] });
    expect(w.find('table').exists()).toBe(false);
    expect(w.get('.dt__empty').text()).toBe('Nothing here');
  });

  it('switches density, remembers it in sessionStorage and shares it between tables', async () => {
    const w = mountTable();
    expect(w.get('.dt').classes()).toContain('dt--comfortable');
    const compact = w.findAll('.dt__density button').find((b) => b.text() === 'Zich');
    await compact!.trigger('click');
    expect(w.get('.dt').classes()).toContain('dt--compact');
    expect(window.sessionStorage.getItem('iorder.table.density')).toBe('compact');
    const second = mountTable();
    expect(second.get('.dt').classes()).toContain('dt--compact');
  });

  it('still works when sessionStorage throws', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      const w = mountTable();
      const compact = w.findAll('.dt__density button').find((b) => b.text() === 'Zich');
      await compact!.trigger('click');
      expect(w.get('.dt').classes()).toContain('dt--compact');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

function mountWith(extra: Record<string, unknown>, narrow = false) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: !narrow, addEventListener() {}, removeEventListener() {} }),
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  });
  const i18n = createAppI18n('UZ');
  i18n.global.mergeLocaleMessage('uz', staffCommonUz);
  const page = defineComponent({
    render: () =>
      h(DataTable<Item>, {
        columns: baseColumns(),
        rows: items,
        rowKey: (r: Item) => r.id,
        label: 'Things',
        emptyText: 'Nothing here',
        ...extra,
      }),
  });
  return mount(page, { attachTo: document.body, global: { plugins: [router, i18n] } });
}

describe('DataTable link rows with their own controls', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  function mountLinked(narrow: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: !narrow, addEventListener() {}, removeEventListener() {} }),
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
    });
    const i18n = createAppI18n('UZ');
    i18n.global.mergeLocaleMessage('uz', staffCommonUz);
    const page = defineComponent({
      render: () =>
        h(
          DataTable<Item>,
          {
            columns: baseColumns(),
            rows: items,
            rowKey: (r: Item) => r.id,
            rowTo: (r: Item) => `/item/${r.id}`,
            label: 'Things',
            emptyText: 'Nothing here',
          },
          {
            'cell-qty': ({ row }: { row: Item }) =>
              h('span', { 'data-row-control': '', class: 'ctl' }, [
                h('span', { class: 'beside' }, String(row.qty)),
              ]),
            'card-actions': ({ row }: { row: Item }) =>
              h('button', { type: 'button', class: 'act' }, `act ${row.id}`),
          },
        ),
    });
    const wrapper = mount(page, { attachTo: document.body, global: { plugins: [router, i18n] } });
    return { wrapper, router };
  }

  it('a click inside a data-row-control area does not open the row; a plain cell does', async () => {
    const { wrapper, router } = mountLinked(false);
    await router.isReady();
    await wrapper.findAll('tbody tr')[0]!.get('.beside').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/');
    await wrapper.findAll('tbody tr')[0]!.findAll('td')[0]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/item/a');
    wrapper.unmount();
  });

  it('card-actions sit beside the card link inside the same item, never inside the link', () => {
    const { wrapper } = mountLinked(true);
    const item = wrapper.findAll('.dt__cards > li')[0]!;
    expect(item.classes()).toContain('dt__item--actions');
    expect(item.find('a.dt__card .act').exists()).toBe(false);
    expect(item.get('.dt__card-actions .act').text()).toBe('act a');
    wrapper.unmount();
  });
});

describe('DataTable row modes', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('action mode: the first cell is a button and a click anywhere on the row runs the action', async () => {
    const opened: string[] = [];
    const w = mountWith({ rowAction: (r: Item) => opened.push(r.id) });
    expect(w.findAll('tbody a').length).toBe(0);
    expect(w.findAll('tbody button.dt__link')).toHaveLength(3);
    await w.findAll('tbody tr')[1]!.findAll('td')[2]!.trigger('click');
    await w.findAll('tbody button.dt__link')[2]!.trigger('click');
    expect(opened).toEqual(['b', 'c']);
  });

  it('action mode on a phone: each card is one button', async () => {
    const opened: string[] = [];
    const w = mountWith({ rowAction: (r: Item) => opened.push(r.id) }, true);
    const cards = w.findAll('button.dt__card');
    expect(cards).toHaveLength(3);
    await cards[0]!.trigger('click');
    expect(opened).toEqual(['a']);
  });

  it('static mode: no link, no button, no pointer cursor; cells keep their own controls', () => {
    const w = mountWith({});
    expect(w.findAll('tbody a, tbody button.dt__link')).toHaveLength(0);
    expect(w.get('tbody tr').classes()).toContain('dt__row--static');
    const phone = mountWith({}, true);
    expect(phone.findAll('div.dt__card')).toHaveLength(3);
    expect(phone.findAll('a.dt__card, button.dt__card')).toHaveLength(0);
  });
});

describe('DataTable plain rows with a row click', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('runs the row click outside fields, keeps the pointer cursor, tints accent rows', async () => {
    const clicked: string[] = [];
    const w = mountWith({
      rowClick: (r: Item) => clicked.push(r.id),
      rowTone: (r: Item) => (r.id === 'b' ? 'accent' : undefined),
    });
    const rowsEls = w.findAll('tbody tr');
    expect(rowsEls[0]!.classes()).not.toContain('dt__row--static');
    expect(rowsEls[1]!.classes()).toContain('dt__row--accent');
    await rowsEls[0]!.findAll('td')[1]!.trigger('click');
    const field = document.createElement('input');
    rowsEls[2]!.findAll('td')[1]!.element.append(field);
    field.click();
    expect(clicked).toEqual(['a']);
  });

  it('turns a phone card into a click target without making it a button', async () => {
    const clicked: string[] = [];
    const w = mountWith({ rowClick: (r: Item) => clicked.push(r.id) }, true);
    const cards = w.findAll('div.dt__card');
    expect(cards).toHaveLength(3);
    await cards[1]!.trigger('click');
    expect(clicked).toEqual(['b']);
  });

  it('reads a screen-reader-only header without a visible title', () => {
    const w = mountWith({});
    expect(w.find('thead .sr-only').exists()).toBe(false);
    const hidden = mountTable({
      columns: [
        { key: 'name', label: 'Name', text: (r: Item) => r.name },
        { key: 'x', label: 'Remove', srOnlyLabel: true },
      ],
    });
    expect(hidden.get('thead th:last-child .sr-only').text()).toBe('Remove');
  });
});

describe('DataTable on a phone and for assistive tech', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('mounts the cards only below 640px and the table only from 640px', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    const narrow = mountTable({}, true);
    expect(narrow.find('table').exists()).toBe(false);
    expect(narrow.findAll('.dt__card')).toHaveLength(3);
    // the page's toolbar stays, only the density switch goes
    expect(narrow.find('.tool').exists()).toBe(true);
    expect(narrow.find('.dt__density').exists()).toBe(false);
    document.body.innerHTML = '';
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const wide = mountTable({}, true);
    expect(wide.find('table').exists()).toBe(true);
    expect(wide.find('.dt__cards').exists()).toBe(false);
    expect(wide.find('.dt__density').exists()).toBe(true);
  });

  it('makes the scroll box a labelled, keyboard-reachable region', () => {
    const region = mountTable().get('.dt__scroll');
    expect(region.attributes('role')).toBe('region');
    expect(region.attributes('tabindex')).toBe('0');
    expect(region.attributes('aria-label')).toBeTruthy();
  });
});

describe('DataTable layout rules (CSS source)', () => {
  const css = source;

  it('does not rely on a positioned link overlay (the sticky first cell would trap it)', () => {
    expect(css).not.toMatch(/\.dt__link::after/);
    expect(css).not.toMatch(/\.dt__table td \{[^}]*position: relative/s);
    expect(css).toMatch(/\.dt__row \{[^}]*cursor: pointer/s);
  });

  it('gives the sort button a 44px target on touch screens', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*\.dt__sort \{[^}]*min-height: 44px/);
  });

  it('shows the row focus ring for keyboard focus only', () => {
    expect(css).toMatch(/\.dt__row:has\(\.dt__link:focus-visible\)/);
    expect(css).not.toMatch(/\.dt__row:focus-within \{[^}]*outline/s);
  });

  it('does not hide the toolbar slot on phones', () => {
    expect(css).not.toMatch(/\.dt__bar \{\s*display: none/);
  });

  it('has a sticky header', () => {
    expect(css).toMatch(/\.dt__table th \{[^}]*position: sticky;[^}]*top: 0/s);
  });

  it('keeps focus below the sticky header via one density-aware variable', () => {
    expect(css).toMatch(/\.dt \{[^}]*--dt-head-h: \d+px/s);
    expect(css).toMatch(/\.dt--compact \{[^}]*--dt-head-h: \d+px/s);
    // A table with column groups adds the group row's height on top.
    expect(css).toMatch(
      /\.dt__scroll \{[^}]*scroll-padding-top: calc\(var\(--dt-head-h\) \+ var\(--dt-group-h\)\)/s,
    );
    expect(css).toMatch(/\.dt__scroll \{[^}]*scroll-padding-bottom: var\(--dt-scroll-pad-bottom/s);
    expect(css).toMatch(/\.dt__table th \{[^}]*height: var\(--dt-head-h\)/s);
    expect(css).toMatch(/\.dt__table \{[^}]*min-width: var\(--dt-min-width, 720px\)/s);
  });

  it('keeps the first column in place on narrow widths', () => {
    expect(css).toMatch(/@media \(max-width: 960px\)[\s\S]*first-child[\s\S]*position: sticky/);
    expect(css).toMatch(/\.dt__scroll \{[^}]*overflow: auto/s);
  });

  it('turns rows into cards under 640px', () => {
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*\.dt__scroll \{\s*display: none/);
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*\.dt__cards \{\s*display: flex/);
  });

  it('gives the card a 44px target and the figures tabular numerals', () => {
    expect(css).toMatch(/\.dt__card \{[^}]*min-height: var\(--tap-min, 44px\)/s);
    expect(css).toMatch(/font-variant-numeric: tabular-nums/);
  });

  it('uses design tokens only: no hex colours', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe('DataTable sideways overflow', () => {
  const sizes = { scrollWidth: 0, clientWidth: 0 };
  const restore: Array<() => void> = [];
  beforeEach(() => {
    for (const key of ['scrollWidth', 'clientWidth'] as const) {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, key);
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('dt__scroll') ? sizes[key] : 0;
        },
      });
      restore.push(() => {
        Reflect.deleteProperty(HTMLElement.prototype, key);
        if (original) Object.defineProperty(Element.prototype, key, original);
      });
    }
  });
  afterEach(() => {
    restore.splice(0).forEach((undo) => undo());
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('marks a table wider than its box and shows the fade until the scroll end', async () => {
    sizes.scrollWidth = 1200;
    sizes.clientWidth = 900;
    const w = mountWith({});
    const box = w.get('.dt__scroll');
    await box.trigger('scroll');
    expect(w.get('.dt').classes()).toContain('dt--overflow');
    expect(w.get('.dt__frame').classes()).toContain('dt__frame--more');

    box.element.scrollLeft = 300;
    await box.trigger('scroll');
    expect(w.get('.dt').classes()).toContain('dt--overflow');
    expect(w.get('.dt__frame').classes()).not.toContain('dt__frame--more');
  });

  it('leaves a table that fits alone', async () => {
    sizes.scrollWidth = 900;
    sizes.clientWidth = 900;
    const w = mountWith({});
    await w.get('.dt__scroll').trigger('scroll');
    expect(w.get('.dt').classes()).not.toContain('dt--overflow');
    expect(w.get('.dt__frame').classes()).not.toContain('dt__frame--more');
  });

  it('keeps focus beside the sticky first column (scroll padding from its width)', () => {
    expect(source).toMatch(
      /\.dt--overflow \.dt__scroll \{[^}]*scroll-padding-left: var\(--dt-sticky-w, 0px\)/s,
    );
    expect(source).toMatch(/'--dt-sticky-w': `\$\{stickyWidth\}px`/);
  });
});

describe('TableDensitySwitch', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  function mountSwitch(wide: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: wide, addEventListener() {}, removeEventListener() {} }),
    });
    const i18n = createAppI18n('UZ');
    i18n.global.mergeLocaleMessage('uz', staffCommonUz);
    return mount(TableDensitySwitch, { attachTo: document.body, global: { plugins: [i18n] } });
  }

  it('sets the shared table density, so a table elsewhere on the page follows it', async () => {
    const w = mountSwitch(true);
    const compact = w.findAll('button').find((b) => b.text() === 'Zich');
    await compact?.trigger('click');
    expect(useTableDensity().density.value).toBe('compact');
    expect(window.sessionStorage.getItem('iorder.table.density')).toBe('compact');
  });

  it('is not shown on phones, where the rows are cards', () => {
    expect(mountSwitch(false).find('button').exists()).toBe(false);
  });
});
