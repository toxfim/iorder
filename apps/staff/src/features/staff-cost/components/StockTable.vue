<script setup lang="ts">
import { nextTick, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StockOverviewItem } from '@iorder/shared/staff-cost';
import AppBadge from '@core/components/ui/AppBadge.vue';
import RowContextMenu, {
  type RowMenuItem,
  type RowMenuPoint,
} from '@/components/ui/RowContextMenu.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';
import { useCostFormat } from '../composables/use-cost-format';
import { stockLevel, toScaled } from '../domain/decimal';

// The Qoldiq table of the approved design (2026-11-19): a plain table that scrolls with the page
// (no box of its own, no sticky column), 64px rows, the free stock as a coloured figure with a
// fill bar, the price action and a "⋯" on every row. The product name is the row's button (it
// opens the side panel); a click elsewhere on the row does the same for a mouse. The "⋯", a right
// click, the Context Menu key and Shift+F10 open the row menu. Owner choice 2026-11-19: the
// latest cost stays, under the selling price.
const props = defineProps<{
  rows: readonly StockOverviewItem[];
  /** ≥1280px: the category / brand column (no supplier column: owner 2026-11-20). */
  wide: boolean;
  /** ≥1024px: the "updated" column. */
  desktop: boolean;
  nameOf: (item: StockOverviewItem) => string;
  /** The formatted USD selling price; null = not in the published list. */
  priceOf: (item: StockOverviewItem) => string | null;
  isNew: (item: StockOverviewItem) => boolean;
  canPrice: (item: StockOverviewItem) => boolean;
  menuOf: (item: StockOverviewItem) => readonly RowMenuItem[];
  /** Accessible name of the table. */
  label: string;
}>();
const emit = defineEmits<{
  open: [item: StockOverviewItem];
  price: [item: StockOverviewItem];
  menu: [item: StockOverviewItem, id: string];
}>();

const { t } = useI18n();
const { formatDate, formatQuantity, formatUsd } = useCostFormat();

function scaled(quantity: string | null): bigint | null {
  if (quantity === null) return null;
  try {
    return toScaled(quantity, 3);
  } catch {
    return null;
  }
}
/** More is held than the sheet shows: the sheet may already show the shipment. A look, not an error. */
const overHeld = (item: StockOverviewItem): boolean =>
  (scaled(item.heldQuantity) ?? 0n) > (scaled(item.stockQuantity) ?? 0n);
/** Fill of the free stock bar, full at 60 pieces (the design's scale). */
function barWidth(item: StockOverviewItem): string {
  const free = scaled(item.availableQuantity) ?? 0n;
  return `${free >= 60_000n ? 100 : Number((free * 100n) / 60_000n)}%`;
}

// --- the row menu --------------------------------------------------------------------------------

// RowContextMenu is generic, so its instance type is spelled out (as DataTable does).
type MenuHandle = {
  open: (at: RowMenuPoint, focusAfter: HTMLElement | null) => Promise<void>;
  close: (giveFocusBack: boolean) => void;
};
const menu = ref<MenuHandle | null>(null);
const menuRow = shallowRef<StockOverviewItem | null>(null);
let menuAnchor: HTMLElement | null = null;
const menuItems = (): readonly RowMenuItem[] => (menuRow.value ? props.menuOf(menuRow.value) : []);

function openMenu(item: StockOverviewItem, at: RowMenuPoint, anchor: HTMLElement | null): void {
  menuRow.value = item;
  menuAnchor = anchor;
  void nextTick(() => menu.value?.open(at, anchor));
}
const below = (element: Element): RowMenuPoint => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
};
const nameButton = (row: Element): HTMLElement | null =>
  row.querySelector<HTMLElement>('.st__name');

function onMoreClick(event: MouseEvent, item: StockOverviewItem): void {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) return;
  // A second press on the same "⋯" closes the menu it opened.
  if (menuRow.value?.productId === item.productId && menuAnchor === button) {
    menu.value?.close(true);
    return;
  }
  openMenu(item, below(button), button);
}

function onContextMenu(event: MouseEvent, item: StockOverviewItem): void {
  const row = event.currentTarget;
  if (!(row instanceof Element)) return;
  const selection = window.getSelection();
  // Selected text keeps the browser's own menu (to copy it).
  if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
  event.preventDefault();
  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
  const anchor = nameButton(row);
  openMenu(
    item,
    fromKeyboard ? below(anchor ?? row) : { x: event.clientX, y: event.clientY },
    anchor,
  );
}

function onKeydown(event: KeyboardEvent, item: StockOverviewItem): void {
  const menuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
  if (!menuKey || !(event.target instanceof HTMLElement)) return;
  event.preventDefault();
  openMenu(item, below(event.target), event.target);
}

// A mouse click anywhere on the row opens the panel; controls inside keep their own click.
function onRowClick(event: MouseEvent, item: StockOverviewItem): void {
  const target = event.target;
  if (target instanceof Element && target.closest('button, a, input, label')) return;
  if (window.getSelection()?.toString()) return;
  emit('open', item);
}
</script>

<template>
  <div class="st">
    <table class="st__table" :aria-label="label">
      <thead>
        <tr>
          <th class="st__l">{{ t('staffCost.stock.product') }}</th>
          <th v-if="wide" class="st__l st__catbrand">
            {{ t('staffCost.stock.columns.catBrand') }}
          </th>
          <th class="st__num">{{ t('staffCost.stock.total') }}</th>
          <th class="st__num">{{ t('staffCost.stock.held') }}</th>
          <th class="st__avail">{{ t('staffCost.stock.available') }}</th>
          <th class="st__price">{{ t('staffCost.stock.columns.price') }}</th>
          <th v-if="desktop" class="st__date">{{ t('staffCost.stock.columns.updated') }}</th>
          <th class="st__acts">
            <span class="sr-only">{{ t('staffCost.stock.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.productId"
          class="st__row"
          :class="{ 'st__row--muted': !row.isActive }"
          @click="onRowClick($event, row)"
          @contextmenu="onContextMenu($event, row)"
          @keydown="onKeydown($event, row)"
        >
          <td class="st__l">
            <span class="st__product">
              <ProductThumb
                :src="row.imageUrl"
                :large-src="row.imageLargeUrl"
                :alt="nameOf(row)"
                :size="44"
              />
              <span class="st__titles">
                <button
                  type="button"
                  class="st__name"
                  :aria-label="`${row.productCode} ${nameOf(row)}: ${t('staffCost.stock.openPanel')}`"
                  @click="emit('open', row)"
                >
                  {{ nameOf(row) }}
                </button>
                <span class="st__meta">
                  <span class="mono code">{{ row.productCode }}</span>
                  <template v-if="!wide">
                    <span aria-hidden="true">·</span>
                    <span>{{ row.category ?? t('staffCost.categories.none') }}</span>
                    <template v-if="row.brand !== null">
                      <span aria-hidden="true">·</span><span>{{ row.brand }}</span>
                    </template>
                  </template>
                  <span v-if="!row.isPriced" class="pill pill--off">{{
                    t('staffCost.stock.pricedNo')
                  }}</span>
                  <span v-if="isNew(row)" class="pill pill--new">{{
                    t('staffCost.stock.newBadge')
                  }}</span>
                  <AppBadge v-if="!row.isActive" tone="warning">{{
                    t('prices.row.inactiveBadge')
                  }}</AppBadge>
                </span>
              </span>
            </span>
          </td>
          <td v-if="wide" class="st__l">
            <span class="st__stack">
              <span>{{ row.category ?? t('staffCost.categories.none') }}</span>
              <span class="st__sub">{{ row.brand ?? '—' }}</span>
            </span>
          </td>
          <td class="st__num mono">
            {{ row.stockQuantity !== null ? formatQuantity(row.stockQuantity) : '—' }}
          </td>
          <td class="st__num mono st__held" :class="{ 'st__held--over': overHeld(row) }">
            {{ formatQuantity(row.heldQuantity) }}
            <AppBadge v-if="overHeld(row)" tone="warning">{{
              t('staffCost.stock.overHeld')
            }}</AppBadge>
          </td>
          <td class="st__avail">
            <span
              v-if="row.availableQuantity !== null"
              class="st__free"
              :class="`st__free--${stockLevel(row.availableQuantity)}`"
            >
              <b>{{
                stockLevel(row.availableQuantity) === 'out'
                  ? t('staffCost.stockLevel.out')
                  : formatQuantity(row.availableQuantity)
              }}</b>
              <span
                v-if="stockLevel(row.availableQuantity) !== 'out'"
                class="st__bar"
                aria-hidden="true"
                ><i :style="{ width: barWidth(row) }"
              /></span>
              <span v-if="stockLevel(row.availableQuantity) === 'low'" class="sr-only">{{
                t('staffCost.stockLevel.low')
              }}</span>
            </span>
            <span v-else class="st__none"
              >—<span class="sr-only">{{ t('staffCost.stockLevel.unknown') }}</span></span
            >
          </td>
          <td class="st__price">
            <b class="mono" :class="{ st__none: priceOf(row) === null }">{{
              priceOf(row) ?? '—'
            }}</b>
            <span v-if="row.latestDelivery?.costUsd" class="st__cost mono"
              >{{ t('staffCost.cost.column') }} {{ formatUsd(row.latestDelivery.costUsd) }}</span
            >
          </td>
          <td v-if="desktop" class="st__date mono">
            {{ row.latestDelivery ? formatDate(row.latestDelivery.deliveredAt) : '—' }}
          </td>
          <td class="st__acts">
            <span class="st__actions">
              <button
                v-if="canPrice(row)"
                type="button"
                class="st__act setprice"
                :class="{ 'st__act--accent': !row.isPriced }"
                :data-action="row.isPriced ? 'change-price' : 'set-price'"
                :aria-label="
                  t(
                    row.isPriced
                      ? 'staffCost.stock.changePriceLabel'
                      : 'staffCost.stock.setPriceLabel',
                    {
                      product: `${row.productCode} ${nameOf(row)}`,
                    },
                  )
                "
                @click="emit('price', row)"
              >
                {{
                  row.isPriced ? t('staffCost.stock.changePrice') : t('staffCost.stock.setPrice')
                }}
              </button>
              <button
                type="button"
                class="st__act st__more"
                aria-haspopup="menu"
                :aria-expanded="menuRow?.productId === row.productId"
                :aria-label="
                  t('prices.rowMenu.label', { code: row.productCode, name: nameOf(row) })
                "
                data-testid="row-menu-button"
                @click="onMoreClick($event, row)"
              >
                <StaffIcon name="more" :size="16" />
              </button>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
    <RowContextMenu
      ref="menu"
      :label="
        menuRow
          ? t('prices.rowMenu.label', { code: menuRow.productCode, name: nameOf(menuRow) })
          : ''
      "
      :items="menuItems()"
      @choose="(id: string) => menuRow && emit('menu', menuRow, id)"
      @close="menuRow = null"
    />
  </div>
</template>

<style scoped>
/* Only sideways scrolling, and only when the window is narrower than the table. */
.st {
  overflow-x: auto;
  border: 1px solid var(--e8);
  border-radius: var(--r-panel);
  background: var(--w);
}

.st__table {
  width: 100%;
  min-width: 640px;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-small);
}

.st__table th {
  height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--e8);
  background: var(--f5);
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: right;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--t2);
}

.st__table td {
  height: 64px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ef);
  text-align: right;
  vertical-align: middle;
  white-space: nowrap;
}

.st__table tbody tr:last-child td {
  border-bottom: 0;
}

.st__row {
  cursor: pointer;
}

.st__row:hover td {
  background: var(--hov);
}

.st__table .st__l {
  text-align: left;
  white-space: normal;
}

.st__catbrand {
  width: 150px;
}

.st__avail {
  width: 112px;
}

.st__price {
  width: 104px;
}

.st__date {
  width: 96px;
}

.st__acts {
  width: 1%;
}

.mono,
.code {
  font-family: var(--font-mono);
}

.st__num {
  font-size: var(--fs-meta);
}

.st__product {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 220px;
}

.st__titles {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.st__name {
  display: -webkit-box;
  max-width: 340px;
  overflow: hidden;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-weight: 500;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.st__name:focus-visible,
.st__act:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.st__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: var(--fs-group);
  color: var(--t2);
}

.st__stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.st__sub {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.st__held {
  color: var(--t2);
}

.st__held--over {
  font-weight: 600;
  color: var(--ink);
}

.st__free {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.st__free b {
  font-weight: 600;
}

.st__free--ok {
  color: var(--green);
}

.st__free--low {
  color: var(--acc-fg);
}

.st__free--out {
  color: var(--red);
}

.st__bar {
  display: inline-flex;
  width: 48px;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ef);
}

.st__bar i {
  display: block;
  height: 100%;
  background: currentcolor;
}

.st__none {
  color: var(--t3);
}

.st__price b {
  display: block;
  font-size: var(--fs-small);
  font-weight: 600;
}

.st__cost {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-group);
  color: var(--t3);
}

.st__date {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.st__actions {
  display: inline-flex;
  gap: 6px;
}

.st__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.st__act:hover {
  background: var(--hov);
}

.st__act--accent {
  border-color: var(--acc);
  background: var(--acc);
  color: var(--acc-on);
  font-weight: 600;
}

.st__act--accent:hover {
  background: var(--acc-hover);
}

.st__more {
  width: 36px;
  padding: 0;
}

.pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: var(--fs-group);
  font-weight: 500;
  white-space: nowrap;
}

.pill--off {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.pill--new {
  background: var(--blue-bg);
  color: var(--blue);
}

.st__row--muted .st__name {
  color: var(--t2);
}

/* Tablet: tighter cells (the design's 8px). */
@media (max-width: 1023px) {
  .st__table {
    min-width: 560px;
  }

  .st__table th,
  .st__table td {
    padding-right: 8px;
    padding-left: 8px;
  }
}

@media (pointer: coarse) {
  .st__act {
    min-height: 44px;
  }

  .st__more {
    min-width: 44px;
  }
}
</style>
