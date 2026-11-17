<script setup lang="ts" generic="Row">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { useMediaQuery } from '@/composables/use-media-query';
import { useTableDensity } from '@/composables/use-table-density';
import RowContextMenu, { type RowMenuItem, type RowMenuPoint } from './RowContextMenu.vue';
import StaffIcon from './StaffIcon.vue';
import TableDensitySwitch from './TableDensitySwitch.vue';
import {
  columnGroups,
  nextSort,
  sortRows,
  type DataTableColumn,
  type SortState,
} from './data-table';

const props = withDefaults(
  defineProps<{
    columns: readonly DataTableColumn<Row>[];
    rows: readonly Row[];
    rowKey: (row: Row) => string;
    /** Link mode: every row is a link, and this is where it goes. */
    rowTo?: (row: Row) => RouteLocationRaw;
    /**
     * Action mode (no `rowTo`): the row opens something on the same page (a side panel). The first
     * cell and the card are buttons. With neither prop the rows are plain: the cells carry their
     * own controls and the phone card is not interactive.
     */
    rowAction?: (row: Row) => void;
    /**
     * Plain mode only: a click on the row (or phone card) outside text inputs, links and labels
     * runs this. A mouse convenience; the cells must still carry their own keyboard-reachable
     * control for the same action. Buttons inside a cell are NOT excluded on purpose (the cost
     * tooltip trigger has no click of its own and falls through to the row, as before).
     */
    rowClick?: (row: Row) => void;
    /** Accessible name of a row's link / button when its first cell alone says too little. */
    rowLabel?: (row: Row) => string;
    /** Accessible name of the table and of the card list. */
    label: string;
    /** Text of the empty state (the page decides: "no orders yet" vs "no match for the filters"). */
    emptyText: string;
    /** A row that needs attention gets an accent edge (a status the person should not miss). */
    rowTone?: (row: Row) => 'warning' | 'accent' | 'muted' | undefined;
    zebra?: boolean;
    /** Hide the comfortable / compact switch (a short list does not need it). */
    densityToggle?: boolean;
    /**
     * The row's context menu: the actions this person may take on it (an empty list = no menu).
     * It opens on a right click or long press, the Context Menu key or Shift+F10 on the row, and
     * the "⋯" button that touch screens show. The choice comes back as `rowMenuChoose`.
     */
    rowMenu?: (row: Row) => readonly RowMenuItem[];
    /** Accessible name of the row's menu and of its "⋯" button. */
    rowMenuLabel?: (row: Row) => string;
  }>(),
  {
    zebra: false,
    densityToggle: true,
    rowTo: undefined,
    rowAction: undefined,
    rowClick: undefined,
    rowLabel: undefined,
    rowTone: undefined,
    rowMenu: undefined,
    rowMenuLabel: undefined,
  },
);
const emit = defineEmits<{ rowMenuChoose: [row: Row, id: string] }>();

const { t } = useI18n();
const { density } = useTableDensity();

// Below 640px only the cards are mounted (not both and hidden by CSS), so a list does not carry
// every badge twice in the DOM. Keep the number in step with the CSS breakpoint below.
const wide = useMediaQuery('(min-width: 640px)', true);

const visible = computed(() => props.columns.filter((c) => !c.hidden));
const groups = computed(() =>
  visible.value.some((c) => c.group !== undefined) ? columnGroups(visible.value) : [],
);
const sort = ref<SortState | null>(null);
// Sorting works on the rows the page already holds; it never asks the server again.
const shown = computed(() => sortRows(props.rows, visible.value, sort.value));

const sortLabel = (column: DataTableColumn<Row>): string =>
  t('table.sortBy', { column: column.label });
function ariaSort(column: DataTableColumn<Row>): 'ascending' | 'descending' | 'none' | undefined {
  if (!column.compare) return undefined;
  if (sort.value?.key !== column.key) return 'none';
  return sort.value.direction === 'asc' ? 'ascending' : 'descending';
}

// A table wider than its box scrolls sideways. Then the first column (the product, the order)
// stays put and a fade at the right edge says there is more; a table that fits gets neither.
const scrollBox = ref<HTMLElement | null>(null);
const overflowX = ref(false);
const moreRight = ref(false);
// The sticky first column's width: focus moving left must stop beside it, not under it.
const stickyWidth = ref(0);
function measureOverflow(): void {
  const box = scrollBox.value;
  overflowX.value = box !== null && box.scrollWidth > box.clientWidth + 1;
  moreRight.value =
    box !== null && overflowX.value && box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
  stickyWidth.value = box?.querySelector<HTMLElement>('thead tr:last-child th')?.offsetWidth ?? 0;
}
watch(scrollBox, (box, _old, onCleanup) => {
  measureOverflow();
  if (!box || typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(measureOverflow);
  observer.observe(box);
  if (box.firstElementChild) observer.observe(box.firstElementChild);
  onCleanup(() => observer.disconnect());
});

// Rows are links; arrow keys walk the first-cell links so a keyboard user does not tab through
// every row (Home/End jump to the ends). Tab still reaches each one.
function onKeydown(event: KeyboardEvent): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('dt__link')) return;
  const root = target.closest('.dt__scroll');
  const links = root ? Array.from(root.querySelectorAll<HTMLElement>('.dt__link')) : [];
  const at = links.indexOf(target);
  if (at === -1) return;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? links.length - 1
        : at + (event.key === 'ArrowDown' ? 1 : -1);
  const element = links[next];
  if (!element) return;
  event.preventDefault();
  element.focus();
}

// The whole row opens its order, but through the ONE link of the first cell (a11y: one link per
// row). A positioned overlay on that link would be trapped inside the sticky first cell on
// tablets, so the row listens instead. Controls inside a cell keep their own click, and so does a
// `data-row-control` area around one (a click beside a small inline control must not open the row).
const INTERACTIVE =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [data-row-control]';
function onRowClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(INTERACTIVE)) return;
  if (window.getSelection()?.toString()) return;
  const row = event.currentTarget;
  if (row instanceof HTMLElement) row.querySelector<HTMLElement>('.dt__link')?.click();
}

const FIELDS = 'a, input, select, textarea, label, summary';
function onPlainRowClick(event: MouseEvent, row: Row): void {
  if (!props.rowClick || event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(FIELDS)) return;
  if (window.getSelection()?.toString()) return;
  props.rowClick(row);
}

const mode = computed<'link' | 'action' | 'static'>(() =>
  props.rowTo ? 'link' : props.rowAction ? 'action' : 'static',
);
const cardAttrs = (row: Row): Record<string, unknown> =>
  props.rowTo
    ? { to: props.rowTo(row) }
    : props.rowAction
      ? { type: 'button', onClick: () => props.rowAction?.(row) }
      : props.rowClick
        ? { onClick: (event: MouseEvent) => onPlainRowClick(event, row) }
        : {};
const cardTag = computed(() =>
  mode.value === 'link' ? RouterLink : mode.value === 'action' ? 'button' : 'div',
);

// --- the row's context menu -------------------------------------------------------------------

type MenuHandle = {
  open: (at: RowMenuPoint, focusAfter: HTMLElement | null) => Promise<void>;
  close: (giveFocusBack: boolean) => void;
};
const menu = ref<MenuHandle | null>(null);
const menuRow = shallowRef<Row | null>(null);
const menuItems = computed(() =>
  menuRow.value !== null && props.rowMenu ? props.rowMenu(menuRow.value) : [],
);
const menuLabel = computed(() =>
  menuRow.value !== null ? (props.rowMenuLabel?.(menuRow.value) ?? props.label) : props.label,
);
const hasMenu = (row: Row): boolean => (props.rowMenu?.(row).length ?? 0) > 0;
const isMenuRow = (row: Row): boolean =>
  menuRow.value !== null && props.rowKey(menuRow.value) === props.rowKey(row);
// The browser may also fire `contextmenu` for the Context Menu key that already opened the menu.
let keyboardOpenedAt = -Infinity;
const KEYBOARD_ECHO_MS = 800;

// The element the open menu came from (its focus goes back there).
let menuAnchor: HTMLElement | null = null;

function openMenu(row: Row, at: RowMenuPoint, focusAfter: HTMLElement | null): void {
  menuRow.value = row;
  menuAnchor = focusAfter;
  // The items follow `menuRow`: let them render before the menu measures itself.
  void nextTick(() => menu.value?.open(at, focusAfter));
}

/** The row's own control (its link or button), where the focus goes back after the menu. */
function rowControl(container: Element): HTMLElement | null {
  return container.querySelector<HTMLElement>('.dt__link, .dt__card');
}

function belowOf(element: Element): RowMenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

// Text fields keep the browser's own menu (paste, spelling); everything else on a row opens ours.
const NATIVE_MENU = 'input, textarea, select, [contenteditable="true"]';
function onRowContextMenu(event: MouseEvent, row: Row): void {
  if (!hasMenu(row)) return;
  const target = event.target;
  if (target instanceof Element && target.closest(NATIVE_MENU)) return;
  const container = event.currentTarget;
  if (!(container instanceof Element) || hasSelectionIn(container)) return;
  event.preventDefault();
  if (event.timeStamp - keyboardOpenedAt < KEYBOARD_ECHO_MS) return;
  const control = rowControl(container);
  // A keyboard-made event has no pointer position: open under the row's control instead.
  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
  const at = fromKeyboard ? belowOf(control ?? container) : { x: event.clientX, y: event.clientY };
  openMenu(row, at, control);
}

function onRowMenuKey(event: KeyboardEvent, row: Row): void {
  const menuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
  if (!menuKey || !hasMenu(row)) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest(NATIVE_MENU)) return;
  event.preventDefault();
  keyboardOpenedAt = event.timeStamp;
  openMenu(row, belowOf(target), target);
}

function onMoreClick(event: MouseEvent, row: Row): void {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) return;
  // A second press on the same "⋯" closes the menu it opened (a toggle, like any menu button).
  if (isMenuRow(row) && menuAnchor === button) {
    menu.value?.close(true);
    return;
  }
  openMenu(row, belowOf(button), button);
}

/** Text the person selected inside the row: they want the browser's menu to copy it. */
function hasSelectionIn(container: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().trim() === '') return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(container)) return true;
  }
  return false;
}

function onMenuChoose(id: string): void {
  const row = menuRow.value;
  if (row !== null) emit('rowMenuChoose', row, id);
}

const cellText = (column: DataTableColumn<Row>, row: Row): string => column.text?.(row) ?? '';
const cardColumns = computed(() => visible.value.filter((c) => !c.hideOnCard));
</script>

<template>
  <div
    class="dt"
    :class="[
      `dt--${density}`,
      { 'dt--zebra': zebra, 'dt--grouped': groups.length > 0, 'dt--overflow': overflowX },
    ]"
  >
    <div v-if="(densityToggle && wide) || $slots.toolbar" class="dt__bar">
      <slot name="toolbar" />
      <TableDensitySwitch v-if="densityToggle && wide" class="dt__density" />
    </div>

    <!-- Wide screens: a table with a sticky header; below 640px the same rows are cards. -->
    <div
      v-if="wide && shown.length > 0"
      class="dt__frame"
      :class="{ 'dt__frame--more': moreRight }"
    >
      <div
        ref="scrollBox"
        class="dt__scroll"
        role="region"
        tabindex="0"
        :aria-label="t('table.scrollRegion', { label })"
        :style="{ '--dt-sticky-w': `${stickyWidth}px` }"
        @scroll.passive="measureOverflow"
      >
        <table class="dt__table" :aria-label="label" @keydown="onKeydown">
          <colgroup>
            <col v-for="column in visible" :key="column.key" :style="{ width: column.width }" />
          </colgroup>
          <thead>
            <tr v-if="groups.length > 0" class="dt__groups">
              <th
                v-for="cell in groups"
                :key="`group-${cell.key}`"
                :colspan="cell.span"
                :scope="cell.label ? 'colgroup' : undefined"
                :class="{ 'dt__group--named': cell.label !== '' }"
              >
                {{ cell.label }}
              </th>
            </tr>
            <tr>
              <th
                v-for="column in visible"
                :key="column.key"
                scope="col"
                :class="{ 'dt__th--end': column.align === 'end' }"
                :style="{ minWidth: column.minWidth }"
                :aria-sort="ariaSort(column)"
                :title="column.hint"
              >
                <button
                  v-if="column.compare"
                  type="button"
                  class="dt__sort"
                  :aria-label="sortLabel(column)"
                  @click="sort = nextSort(sort, column.key)"
                >
                  {{ column.label }}
                  <span
                    class="dt__arrow"
                    :class="{ 'dt__arrow--on': sort?.key === column.key }"
                    aria-hidden="true"
                  >
                    {{ sort?.key === column.key ? (sort.direction === 'asc' ? '↑' : '↓') : '↕' }}
                  </span>
                </button>
                <span v-else-if="column.srOnlyLabel" class="sr-only">{{ column.label }}</span>
                <template v-else>{{ column.label }}</template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in shown"
              :key="rowKey(row)"
              class="dt__row"
              :class="{
                'dt__row--warning': rowTone?.(row) === 'warning',
                'dt__row--accent': rowTone?.(row) === 'accent',
                'dt__row--muted': rowTone?.(row) === 'muted',
                'dt__row--static': mode === 'static' && !rowClick,
              }"
              @click="mode === 'static' ? onPlainRowClick($event, row) : onRowClick($event)"
              @contextmenu="onRowContextMenu($event, row)"
              @keydown="onRowMenuKey($event, row)"
            >
              <td
                v-for="(column, index) in visible"
                :key="column.key"
                :class="{
                  'dt__td--end': column.align === 'end',
                  'dt__td--trunc': column.truncate,
                  'num dt__td--num': column.align === 'end',
                }"
                :title="column.truncate ? cellText(column, row) : undefined"
              >
                <!-- The first cell may lead with its own control (a photo) BESIDE the row's link,
                   never inside it: a link or button cannot hold another one. Without a lead the
                   wrapper is display: contents, so the other tables lay out as before. -->
                <span
                  v-if="index === 0"
                  class="dt__first"
                  :class="{ 'dt__first--lead': $slots.lead || rowMenu }"
                >
                  <slot name="lead" :row="row" />
                  <RouterLink
                    v-if="rowTo"
                    :to="rowTo(row)"
                    class="dt__link"
                    :aria-label="rowLabel?.(row)"
                  >
                    <slot :name="`cell-${column.key}`" :row="row">{{ cellText(column, row) }}</slot>
                  </RouterLink>
                  <button
                    v-else-if="rowAction"
                    type="button"
                    class="dt__link dt__link--button"
                    :aria-label="rowLabel?.(row)"
                    @click="rowAction(row)"
                  >
                    <slot :name="`cell-${column.key}`" :row="row">{{ cellText(column, row) }}</slot>
                  </button>
                  <slot v-else :name="`cell-${column.key}`" :row="row">{{
                    cellText(column, row)
                  }}</slot>
                  <button
                    v-if="hasMenu(row)"
                    type="button"
                    class="dt__more"
                    aria-haspopup="menu"
                    :aria-expanded="isMenuRow(row)"
                    :aria-label="rowMenuLabel?.(row) ?? t('table.rowMenu')"
                    data-testid="row-menu-button"
                    @click="onMoreClick($event, row)"
                  >
                    <StaffIcon name="more" :size="18" />
                  </button>
                </span>
                <slot v-else :name="`cell-${column.key}`" :row="row">{{
                  cellText(column, row)
                }}</slot>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ul v-if="!wide && shown.length > 0" class="dt__cards" :aria-label="label">
      <!-- `card-actions`: controls of a card (an inline dropdown) sit BESIDE its link or button,
           never inside it (a link cannot hold a control); the item then draws the card frame. -->
      <li
        v-for="row in shown"
        :key="rowKey(row)"
        :class="{
          'dt__item--actions': $slots['card-actions'],
          'dt__item--warning': $slots['card-actions'] && rowTone?.(row) === 'warning',
          'dt__item--menu': hasMenu(row),
        }"
        @contextmenu="onRowContextMenu($event, row)"
        @keydown="onRowMenuKey($event, row)"
      >
        <component
          :is="cardTag"
          v-bind="cardAttrs(row)"
          class="dt__card"
          :aria-label="rowLabel?.(row)"
          :class="{
            'dt__card--warning': rowTone?.(row) === 'warning',
            'dt__card--accent': rowTone?.(row) === 'accent',
            'dt__card--muted': rowTone?.(row) === 'muted',
            'dt__card--static': mode === 'static' && !rowClick,
          }"
        >
          <slot name="card" :row="row">
            <span class="dt__card-title">{{ cellText(visible[0]!, row) }}</span>
            <span v-for="column in cardColumns.slice(1)" :key="column.key" class="dt__card-line">
              <span class="dt__card-label">{{ column.label }}</span>
              <slot :name="`cell-${column.key}`" :row="row">{{ cellText(column, row) }}</slot>
            </span>
          </slot>
        </component>
        <div v-if="$slots['card-actions']" class="dt__card-actions">
          <slot name="card-actions" :row="row" />
        </div>
        <button
          v-if="hasMenu(row)"
          type="button"
          class="dt__more dt__more--card"
          aria-haspopup="menu"
          :aria-expanded="isMenuRow(row)"
          :aria-label="rowMenuLabel?.(row) ?? t('table.rowMenu')"
          data-testid="row-menu-button"
          @click="onMoreClick($event, row)"
        >
          <StaffIcon name="more" :size="18" />
        </button>
      </li>
    </ul>

    <p v-if="shown.length === 0" class="dt__empty" role="status">{{ emptyText }}</p>

    <RowContextMenu
      v-if="rowMenu"
      ref="menu"
      :label="menuLabel"
      :items="menuItems"
      @choose="onMenuChoose"
      @close="menuRow = null"
    />
  </div>
</template>

<style scoped>
/*
 * Design v8 table: a white card with a hairline ring, a 40px grey header row of 10px/500 labels,
 * 56px rows of 12px text ruled by hairlines, the warm --hov on hover. The outer cells keep the
 * card's 20px inset.
 */
.dt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  --dt-pad-y: 10px;
  --dt-pad-x: 6px;
  --dt-pad-edge: 20px;
  --dt-row-h: 56px;
  /* One number for the sticky header's height AND the scroll padding below it, per density. */
  --dt-head-h: 40px;
  /* The column group row above the header (0 without groups). */
  --dt-group-h: 0px;
}

.dt--grouped {
  --dt-group-h: 26px;
}

.dt--compact {
  --dt-pad-y: 6px;
  --dt-row-h: 40px;
  --dt-head-h: 34px;
}

@media (pointer: coarse) {
  .dt {
    --dt-head-h: 48px;
  }
}

.dt__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dt__scroll {
  /* The containing block for absolutely positioned cell content (.sr-only labels): without it they
     anchor to an outer positioned ancestor, escape this scroll box and stretch the page. */
  position: relative;
  /* Both axes scroll inside the box, so the header can stick without a page-level offset. A page
     whose table is its main content raises the cap (--dt-max-h) towards the window height. */
  max-height: var(--dt-max-h, 72vh);
  overflow: auto;
  /* Keyboard focus (Enter in a cell, Tab) must not land under the sticky header or, when the page
     has a sticky bar, under that: pages raise --dt-scroll-pad-bottom for it. */
  scroll-padding-top: calc(var(--dt-head-h) + var(--dt-group-h));
  scroll-padding-bottom: var(--dt-scroll-pad-bottom, 0px);
  /* A border, not an inset ring: the sticky header and cell backgrounds would paint over a ring. */
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
}

.dt__frame {
  position: relative;
  min-width: 0;
}

/* "More to the right": a thin fade at the right edge while the table scrolls sideways; it goes away
   at the scroll end, so the last column's figures are never under it there. */
.dt__frame--more::after {
  content: '';
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  z-index: 4;
  width: 16px;
  border-radius: 0 var(--r-card) var(--r-card) 0;
  background: linear-gradient(to right, transparent, var(--e8));
  pointer-events: none;
}

.dt__scroll:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.dt__table {
  width: 100%;
  min-width: var(--dt-min-width, 720px);
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-small);
}

.dt__table th {
  position: sticky;
  top: 0;
  z-index: 2;
  height: var(--dt-head-h);
  padding: 0 var(--dt-pad-x);
  border-bottom: 1px solid var(--e8);
  background: var(--f5);
  font-size: var(--fs-group);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--t2);
}

/* The group row sticks at the top, the column labels right under it. */
.dt--grouped .dt__table thead tr:not(.dt__groups) th {
  top: var(--dt-group-h);
}

.dt__table .dt__groups th {
  height: var(--dt-group-h);
  border-bottom: 0;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-align: center;
}

.dt__table .dt__groups th.dt__group--named {
  border-bottom: 1px solid var(--e8);
  border-left: 1px solid var(--e8);
}

.dt__table th:first-child,
.dt__table td:first-child {
  padding-left: var(--dt-pad-edge);
}

.dt__table th:last-child,
.dt__table td:last-child {
  padding-right: var(--dt-pad-edge);
}

.dt__th--end {
  text-align: right !important;
}

.dt__sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  /* Buttons reset both; the header row's uppercase must reach the sortable labels too. */
  letter-spacing: inherit;
  text-transform: inherit;
  color: inherit;
  cursor: pointer;
}

@media (pointer: coarse) {
  .dt__sort {
    min-width: 44px;
    min-height: 44px;
  }
}

.dt__sort:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.dt__arrow {
  font-size: 8px;
  color: var(--t3);
}

.dt__arrow--on {
  color: var(--ink);
}

.dt__table td {
  height: var(--dt-row-h);
  padding: var(--dt-pad-y) var(--dt-pad-x);
  vertical-align: middle;
  background: var(--w);
  transition: background-color 0.15s ease;
}

.dt__row + .dt__row td {
  border-top: 1px solid var(--e8);
}

.dt__td--end {
  text-align: right;
}

.dt__td--num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dt__td--trunc {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dt__row {
  cursor: pointer;
}

.dt__row--static {
  cursor: default;
}

.dt__link--button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.dt--zebra .dt__row:nth-child(even) td {
  background: var(--page);
}

.dt__row:not(.dt__row--static):hover td,
.dt__row:focus-within td {
  background: var(--hov);
}

.dt__row--muted td,
.dt__card--muted {
  color: var(--t3);
}

.dt__row--warning td:first-child {
  box-shadow: inset 3px 0 0 var(--amber);
}

.dt__row.dt__row--accent td,
.dt__row.dt__row--accent:hover td,
.dt__row.dt__row--accent:focus-within td {
  background: var(--acc-bg);
}

.dt__first {
  display: contents;
}

.dt__first--lead {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.dt__first--lead > .dt__link {
  flex: 1 1 auto;
  min-width: 0;
}

.dt__link {
  color: inherit;
  font-weight: 600;
  text-decoration: none;
}

.dt__link:focus-visible {
  outline: none;
}

.dt__row:has(.dt__link:focus-visible) {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

/* A table that scrolls sideways keeps its first column in place while the rest scrolls; on narrow
   screens that still show a table (tablets) it always does. */
.dt--overflow .dt__scroll {
  scroll-padding-left: var(--dt-sticky-w, 0px);
}

.dt--overflow .dt__table th:first-child,
.dt--overflow .dt__table td:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  box-shadow: 1px 0 0 var(--e8);
}

.dt--overflow .dt__table th:first-child {
  z-index: 3;
}

.dt--overflow .dt__table .dt__row--warning td:first-child {
  box-shadow:
    inset 3px 0 0 var(--amber),
    1px 0 0 var(--e8);
}

@media (max-width: 960px) {
  .dt__scroll {
    scroll-padding-left: var(--dt-sticky-w, 0px);
  }

  .dt__table th:first-child,
  .dt__table td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    box-shadow: 1px 0 0 var(--e8);
  }

  .dt__table th:first-child {
    z-index: 3;
  }

  .dt__table .dt__row--warning td:first-child {
    box-shadow:
      inset 3px 0 0 var(--amber),
      1px 0 0 var(--e8);
  }
}

.dt__cards {
  display: none;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dt__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: var(--tap-min, 44px);
  padding: 14px 16px;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: inherit;
}

.dt__card--warning {
  box-shadow:
    inset 3px 0 0 var(--amber),
    inset 0 0 0 1px var(--e8);
}

.dt__card.dt__card--accent,
.dt__card.dt__card--accent:hover {
  background: var(--acc-bg);
}

button.dt__card {
  width: 100%;
  border: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dt__card:hover:not(.dt__card--static),
.dt__card:focus-visible {
  background: var(--hov);
}

/* A card with its own controls: the item is the frame, the link fills its top part. */
.dt__item--actions {
  overflow: hidden;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.dt__item--warning {
  box-shadow:
    inset 3px 0 0 var(--amber),
    inset 0 0 0 1px var(--e8);
}

.dt__item--actions > .dt__card {
  padding-bottom: 8px;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.dt__card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 16px 14px;
}

.dt__card-title {
  font-size: var(--fs-body);
  font-weight: 600;
}

.dt__card-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-small);
}

.dt__card-label {
  color: var(--t2);
}

.dt__empty {
  margin: 0;
  padding: 40px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  text-align: center;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* The row menu's "⋯" button: only touch screens show it (no right click there); a mouse and a
   keyboard reach the same menu through the row itself. */
.dt__more {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -6px -8px -6px 0;
  padding: 0;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.dt__more:hover,
.dt__more[aria-expanded='true'] {
  background: var(--f5);
  color: var(--ink);
}

.dt__more:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

@media (pointer: coarse) {
  .dt__more {
    display: inline-flex;
  }

  /* The card and its "⋯" share one frame: the card is a button and cannot hold another one. */
  .dt__item--menu {
    display: flex;
    align-items: flex-start;
    border-radius: var(--r-row);
    background: var(--w);
    box-shadow: inset 0 0 0 1px var(--e8);
  }

  .dt__item--menu:has(> .dt__card--warning) {
    box-shadow:
      inset 3px 0 0 var(--amber),
      inset 0 0 0 1px var(--e8);
  }

  .dt__item--menu > .dt__card {
    flex: 1 1 auto;
    min-width: 0;
    background: transparent;
    box-shadow: none;
  }

  .dt__more--card {
    margin: 6px 6px 0 -8px;
  }
}

@media (max-width: 639px) {
  .dt__frame,
  .dt__scroll {
    display: none;
  }

  .dt__cards {
    display: flex;
  }
}
</style>
