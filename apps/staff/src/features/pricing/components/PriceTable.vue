<script setup lang="ts">
import { nextTick, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import AppBadge from '@core/components/ui/AppBadge.vue';
import RowContextMenu, {
  type RowMenuItem,
  type RowMenuPoint,
} from '@/components/ui/RowContextMenu.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';
import type { PriceRowView } from '../domain/price-row-view';

// The Narxlar table of the approved design (2026-11-19), the page's default layout: the product
// (photo, name, code · stock), the standard prices, «Ulgurji / Hamkor», «Alif factoring», the
// markup, when it last changed and the row actions (Tahrirlash · Tarix · ⋯). Below 1400px Alif
// and "O'zgargan" fold away (the page decides), below 1024px the wholesale column too. A click on the row (not on a
// control) opens the side panel; the "⋯", a right click, the Context Menu key and Shift+F10 open
// the row menu.
const props = defineProps<{
  rows: readonly PriceRowView[];
  /** ≥1400px: the Alif and "O'zgargan" columns. */
  wide: boolean;
  /** ≥1024px: the wholesale column. */
  desktop: boolean;
  /** The markup column (the roles that may view cost). */
  showMarkup: boolean;
  canEdit: boolean;
  menuOf: (view: PriceRowView) => readonly RowMenuItem[];
  label: string;
}>();
const emit = defineEmits<{
  open: [view: PriceRowView];
  edit: [view: PriceRowView];
  history: [view: PriceRowView];
  merge: [view: PriceRowView];
  menu: [view: PriceRowView, id: string];
}>();

const { t } = useI18n();
const productLabel = (view: PriceRowView): string => `${view.row.productCode} ${view.name}`;

// --- the row menu (the same handling as the Qoldiq table) ------------------------------------

type MenuHandle = {
  open: (at: RowMenuPoint, focusAfter: HTMLElement | null) => Promise<void>;
  close: (giveFocusBack: boolean) => void;
};
const menu = ref<MenuHandle | null>(null);
const menuRow = shallowRef<PriceRowView | null>(null);
let menuAnchor: HTMLElement | null = null;
const menuItems = (): readonly RowMenuItem[] => (menuRow.value ? props.menuOf(menuRow.value) : []);

function openMenu(view: PriceRowView, at: RowMenuPoint, anchor: HTMLElement | null): void {
  menuRow.value = view;
  menuAnchor = anchor;
  void nextTick(() => menu.value?.open(at, anchor));
}
const below = (element: Element): RowMenuPoint => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
};
const firstControl = (row: Element): HTMLElement | null =>
  row.querySelector<HTMLElement>('.pt__act');

function onMoreClick(event: MouseEvent, view: PriceRowView): void {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) return;
  if (menuRow.value?.row.productId === view.row.productId && menuAnchor === button) {
    menu.value?.close(true);
    return;
  }
  openMenu(view, below(button), button);
}

function onContextMenu(event: MouseEvent, view: PriceRowView): void {
  const row = event.currentTarget;
  if (!(row instanceof Element)) return;
  const selection = window.getSelection();
  // Selected text keeps the browser's own menu (to copy it).
  if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
  event.preventDefault();
  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
  const anchor = firstControl(row);
  openMenu(
    view,
    fromKeyboard ? below(anchor ?? row) : { x: event.clientX, y: event.clientY },
    anchor,
  );
}

function onKeydown(event: KeyboardEvent, view: PriceRowView): void {
  const menuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
  if (!menuKey || !(event.target instanceof HTMLElement)) return;
  event.preventDefault();
  openMenu(view, below(event.target), event.target);
}

function onRowClick(event: MouseEvent, view: PriceRowView): void {
  const target = event.target;
  if (target instanceof Element && target.closest('button, a, input, label')) return;
  if (window.getSelection()?.toString()) return;
  emit('open', view);
}
</script>

<template>
  <div class="pt">
    <table class="pt__table" :aria-label="label">
      <thead>
        <tr>
          <th class="pt__l">{{ t('prices.page.columns.product') }}</th>
          <th>{{ t('prices.page.columns.standard') }}</th>
          <th v-if="desktop">{{ t('prices.page.columns.wholesale') }}</th>
          <th v-if="wide">{{ t('prices.page.columns.alif') }}</th>
          <th v-if="showMarkup">{{ t('prices.page.columns.markup') }}</th>
          <th v-if="wide">{{ t('prices.page.columns.changed') }}</th>
          <th class="pt__acts">
            <span class="sr-only">{{ t('prices.page.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="view in rows"
          :key="view.row.productId"
          class="pt__row"
          :class="{ 'pt__row--muted': !view.row.isActive }"
          :data-product="view.row.productCode"
          @click="onRowClick($event, view)"
          @contextmenu="onContextMenu($event, view)"
          @keydown="onKeydown($event, view)"
        >
          <td class="pt__l">
            <span class="pt__product">
              <ProductThumb
                :src="view.row.imageUrl"
                :large-src="view.row.imageLargeUrl"
                :alt="view.name"
                :size="40"
              />
              <span class="pt__titles">
                <span class="pt__name">{{ view.name }}</span>
                <span class="pt__meta">
                  <span class="mono code">{{ view.row.productCode }}</span>
                  <template v-if="view.stock">
                    <span aria-hidden="true">·</span>
                    <span class="pt__stock" :class="`pt__stock--${view.stock.tone}`">{{
                      view.stock.text
                    }}</span>
                  </template>
                  <span
                    v-if="view.row.codeGenerated"
                    class="pill pill--blue"
                    data-testid="manual-badge"
                    >{{ t('prices.page.byOrderBadge') }}</span
                  >
                  <AppBadge v-if="!view.row.isActive" tone="warning">{{
                    t('prices.row.inactiveBadge')
                  }}</AppBadge>
                  <!-- The sheet has a product with the same name: the likely merge target. -->
                  <button
                    v-if="view.row.codeGenerated && view.row.sheetMatch && canEdit"
                    type="button"
                    class="pt__match"
                    :title="
                      t('staffCost.manual.sheetMatchHint', {
                        name: view.row.sheetMatch.name,
                        code: view.row.sheetMatch.productCode,
                      })
                    "
                    :aria-label="
                      t('staffCost.manual.sheetMatchHint', {
                        name: view.row.sheetMatch.name,
                        code: view.row.sheetMatch.productCode,
                      })
                    "
                    data-testid="sheet-match-badge"
                    @click="emit('merge', view)"
                  >
                    <AppBadge tone="accent">{{ t('staffCost.manual.sheetMatchBadge') }}</AppBadge>
                  </button>
                </span>
              </span>
            </span>
          </td>
          <td>
            <span class="pv">
              <b class="pv__main" :class="{ 'pv__main--below': view.belowCost }" data-sale>{{
                view.sale ?? '—'
              }}</b>
              <small v-if="view.deferred" class="pv__sub" data-deferred>{{
                t('prices.page.deferred', { price: view.deferred })
              }}</small>
            </span>
          </td>
          <td v-if="desktop">
            <span
              class="pv"
              :title="view.wholesale.fromStandard ? t('prices.row.fromStandardHint') : undefined"
            >
              <b
                :class="view.wholesale.fromStandard ? 'pv__muted' : 'pv__value'"
                data-wholesale-price
                >{{ view.wholesale.price ?? '—' }}</b
              >
              <small v-if="view.wholesale.fromStandard" class="pv__note" data-from-standard>{{
                t('prices.page.standardPrice')
              }}</small>
              <small v-else-if="view.wholesale.deferred" class="pv__sub">{{
                t('prices.page.deferred', { price: view.wholesale.deferred })
              }}</small>
            </span>
          </td>
          <td v-if="wide">
            <span v-if="view.alif" class="pv">
              <b class="pv__value" data-alif-price>{{ view.alif.price }}</b>
              <small v-if="view.alif.deferred" class="pv__sub">{{
                t('prices.page.deferred', { price: view.alif.deferred })
              }}</small>
            </span>
            <span
              v-else
              class="pv__none"
              :title="t('prices.row.notOfferedAlifHint')"
              data-not-offered-alif
              >—<span class="sr-only">{{ t('prices.page.notOffered') }}</span></span
            >
          </td>
          <td v-if="showMarkup">
            <span
              v-if="view.markup"
              class="pill"
              :class="view.belowCost ? 'pill--warn' : 'pill--ok'"
              :title="view.markup.full"
              data-markup
              >{{ view.markup.short }}<span class="sr-only"> ({{ view.markup.full }})</span></span
            >
            <span v-else class="pv__none">—</span>
          </td>
          <td v-if="wide" class="pt__changed">
            <template v-if="view.changed">
              <span>{{ view.changed.when }}</span>
              <small v-if="view.changed.who">{{ view.changed.who }}</small>
            </template>
            <span v-else class="pv__none">—</span>
          </td>
          <td class="pt__acts">
            <span class="pt__actions">
              <button
                v-if="canEdit"
                type="button"
                class="pt__act"
                :aria-label="t('prices.page.editLabel', { product: productLabel(view) })"
                data-action="edit"
                @click="emit('edit', view)"
              >
                <StaffIcon name="pencil" :size="16" /><span class="pt__actlabel">{{
                  t('prices.page.edit')
                }}</span>
              </button>
              <button
                type="button"
                class="pt__act pt__act--icon"
                :aria-label="t('prices.page.historyLabel', { product: productLabel(view) })"
                :title="t('prices.page.history')"
                data-action="history"
                @click="emit('history', view)"
              >
                <StaffIcon name="history" :size="16" />
              </button>
              <button
                type="button"
                class="pt__act pt__act--icon"
                aria-haspopup="menu"
                :aria-expanded="menuRow?.row.productId === view.row.productId"
                :aria-label="
                  t('prices.rowMenu.label', { code: view.row.productCode, name: view.name })
                "
                data-testid="row-menu-button"
                @click="onMoreClick($event, view)"
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
          ? t('prices.rowMenu.label', { code: menuRow.row.productCode, name: menuRow.name })
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
.pt {
  overflow-x: auto;
  border: 1px solid var(--e8);
  border-radius: var(--r-panel);
  background: var(--w);
}

.pt__table {
  width: 100%;
  min-width: 640px;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-small);
}

.pt__table th {
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

.pt__table td {
  height: 72px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ef);
  text-align: right;
  vertical-align: middle;
  white-space: nowrap;
}

.pt__table tbody tr:last-child td {
  border-bottom: 0;
}

.pt__row {
  cursor: pointer;
}

.pt__row:hover td {
  background: var(--hov);
}

.pt__table .pt__l {
  text-align: left;
  white-space: normal;
}

.pt__acts {
  width: 1%;
}

.mono {
  font-family: var(--font-mono);
}

.pt__product {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 220px;
}

.pt__titles {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.pt__name {
  display: -webkit-box;
  max-width: 320px;
  overflow: hidden;
  font-weight: 500;
  line-height: 1.3;
  color: var(--ink);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.pt__row--muted .pt__name {
  color: var(--t2);
}

.pt__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: var(--fs-group);
  color: var(--t2);
}

.pt__stock {
  font-weight: 600;
}

.pt__stock--ok {
  color: var(--green);
}

.pt__stock--low {
  color: var(--acc-fg);
}

.pt__stock--out {
  color: var(--red);
}

.pt__match {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.pv {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.pv__main,
.pv__value,
.pv__muted {
  font-family: var(--font-mono);
  font-weight: 500;
  white-space: nowrap;
}

.pv__main {
  font-size: var(--fs-body);
  color: var(--ink);
}

.pv__main--below {
  color: var(--acc-fg);
}

.pv__value {
  color: var(--ink);
}

.pv__muted {
  font-style: italic;
  color: var(--t2);
}

.pv__sub {
  font-family: var(--font-mono);
  font-size: var(--fs-group);
  color: var(--blue);
}

.pv__note {
  font-size: var(--fs-group);
  font-style: italic;
  color: var(--t2);
}

.pv__none {
  color: var(--t3);
}

.pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--fs-group);
  font-weight: 500;
  white-space: nowrap;
}

.pt__meta .pill {
  height: 18px;
  padding: 0 6px;
}

.pill--ok {
  background: var(--green-bg);
  color: var(--green);
}

.pill--warn {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.pill--blue {
  background: var(--blue-bg);
  color: var(--blue);
}

.pt__changed {
  color: var(--t2);
}

.pt__changed > span,
.pt__changed > small {
  display: block;
}

.pt__changed small {
  margin-top: 2px;
  font-size: var(--fs-group);
  color: var(--t3);
}

.pt__actions {
  display: inline-flex;
  gap: 6px;
}

.pt__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
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

.pt__act:hover {
  background: var(--hov);
}

.pt__act:focus-visible,
.pt__match:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.pt__act--icon {
  width: 36px;
  padding: 0;
}

/* A laptop beside the menu (1024–1399): an icon-only edit button (its name stays for screen
   readers). A tablet has fewer columns, so the design's text button fits again. */
@media (min-width: 1024px) and (max-width: 1399px) {
  .pt__act:not(.pt__act--icon) {
    width: 36px;
    padding: 0;
  }

  .pt__actlabel {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

/* Below 1280 (a laptop beside the menu, a tablet): tighter cells and a narrower name. */
@media (max-width: 1279px) {
  .pt__table th,
  .pt__table td {
    padding-right: 8px;
    padding-left: 8px;
  }

  .pt__product {
    min-width: 200px;
  }

  .pt__name {
    max-width: 240px;
  }
}

@media (max-width: 1023px) {
  .pt__table {
    min-width: 560px;
  }
}

@media (pointer: coarse) {
  .pt__act {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
