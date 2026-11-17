<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import AppButton from '@core/components/ui/AppButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { toCents } from '@core/lib/money';
import {
  fromMilli,
  isSameQuantity,
  lineTotal,
  normalizeQuantity,
  stepQuantity,
  toMilli,
} from '@core/lib/quantity';
import { parseQuantityInput } from '@core/lib/quantity-input';
import { shortOf } from '../domain/free-stock';
import {
  effectiveQuantity,
  summarizeDraft,
  type DraftItem,
  type ItemDraft,
} from '../domain/item-draft';
import type { FulfilmentOrderDetail } from '../domain/order-model';

type FulfilmentItem = FulfilmentOrderDetail['items'][number];
type Row = DraftItem | FulfilmentItem;

const props = defineProps<{
  items: readonly Row[];
  /** The server's total for the saved lines; null for the warehouse and the driver (no money). */
  total: string | null;
  /** Unsaved edits of the manager; empty when nothing is staged. */
  draft: ItemDraft;
  /** The manager may change quantities while the order is SUBMITTED. */
  editable: boolean;
  /** A save is running: the steppers and the draft buttons lock. */
  busy: boolean;
  /** Why the lines cannot be changed, when they cannot. */
  note: string | null;
  /**
   * Free stock per order item id (domain/free-stock.ts), shown beside the quantity being edited.
   * A line without an entry (stock not tracked, or the figures did not load) shows nothing.
   */
  free?: ReadonlyMap<string, string>;
}>();
const emit = defineEmits<{
  change: [item: DraftItem, quantity: string | null];
  save: [];
  discard: [];
}>();

const { t } = useI18n();
const { formatMoney, formatNumber, formatUnit } = useFormat();

const isPriced = (item: Row): item is DraftItem => 'unitPrice' in item;
const pricedItems = computed(() => props.items.filter(isPriced));
// The money columns exist only when the server sent prices (never for the warehouse or driver).
const hasMoney = computed(() => props.total !== null || pricedItems.value.length > 0);
const summary = computed(() => summarizeDraft(pricedItems.value, props.draft));
const dirty = computed(() => summary.value.changes.length > 0);

const quantityOf = (item: Row): string | null =>
  isPriced(item) ? effectiveQuantity(item, props.draft) : item.quantity;
const keptLines = computed(() => props.items.filter((item) => quantityOf(item) !== null).length);
const totalQuantity = computed(() =>
  formatNumber(
    fromMilli(
      props.items.reduce((sum, item) => {
        const quantity = quantityOf(item);
        return quantity === null ? sum : sum + toMilli(quantity);
      }, 0n),
    ),
  ),
);
const lineSum = (item: DraftItem): string => {
  const quantity = quantityOf(item);
  return formatMoney(quantity === null ? '0.00' : lineTotal(item.unitPrice, quantity));
};
// While edits are staged the sum is the preview of the draft; otherwise the server's total.
const shownTotal = computed(() => (dirty.value ? summary.value.newTotal : props.total));

// --- typing a quantity (owner 2026-11-09: changing 10 into 200 one click at a time was the only
// way) ---------------------------------------------------------------------------------------------

// The text in the one field that has the focus. A field without the focus shows the staged
// quantity, so text the manager did not confirm (or that was not a number) never stays on screen.
const typing = ref<{ id: string; text: string } | null>(null);
const fieldIds = useId();

const typedOf = (item: Row): string | null =>
  typing.value?.id === item.id ? typing.value.text : null;

/**
 * What typed text asks for: a quantity, `null` to remove the line (a zero, like stepping below
 * one), or `undefined` when it is not a whole quantity the order contract takes. Spaces are
 * dropped: a pasted "1 000" is one thousand.
 */
function readTyped(text: string): string | null | undefined {
  const compact = text.replace(/\s+/g, '');
  if (/^0+$/.test(compact)) return null;
  return parseQuantityInput(compact) ?? undefined;
}

const isInvalid = (item: Row): boolean => {
  const text = typedOf(item);
  return text !== null && text.trim() !== '' && readTyped(text) === undefined;
};

const sameAsk = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : isSameQuantity(a, b);

// The staged quantity can change under the focused field: the first-edit question is answered
// (the dialog hands the focus back before the new quantity arrives), a save reloads the order. The
// field then takes the new number, unless what is typed already says the same.
const stagedWhileTyping = computed(() => {
  const item = props.items.find((i) => i.id === typing.value?.id);
  return item ? quantityOf(item) : undefined;
});
watch(stagedWhileTyping, (staged) => {
  const current = typing.value;
  if (current === null || staged === undefined) return;
  const typed = readTyped(current.text);
  if (typed !== undefined && sameAsk(typed, staged)) return;
  typing.value = { id: current.id, text: staged === null ? '0' : normalizeQuantity(staged) };
});

/** The field's text: what is being typed, otherwise the staged quantity. */
const fieldValue = (item: Row): string => typedOf(item) ?? show(quantityOf(item));

function startTyping(item: DraftItem, event: FocusEvent): void {
  const current = quantityOf(item);
  // Plain digits while editing ("1000", not "1 000"), selected so typing replaces them.
  typing.value = { id: item.id, text: current === null ? '0' : normalizeQuantity(current) };
  const field = event.target as HTMLInputElement;
  void nextTick(() => field.select());
}

function onType(item: DraftItem, event: Event): void {
  typing.value = { id: item.id, text: (event.target as HTMLInputElement).value };
}

/** Enter or leaving the field: stage what was typed. Empty or unreadable text changes nothing. */
function commitTyped(item: DraftItem): void {
  const text = typedOf(item);
  if (text === null) return;
  typing.value = null;
  const wanted = readTyped(text);
  if (wanted === undefined) return;
  if (!sameAsk(wanted, quantityOf(item))) emit('change', item, wanted);
}

function cancelTyping(event: KeyboardEvent): void {
  if (typing.value === null) return;
  // Escape belongs to the field first; only an untouched field lets it reach the page.
  event.stopPropagation();
  typing.value = null;
  (event.target as HTMLInputElement).blur();
}

/**
 * Minus and plus count from what is typed in the field when it is a number, otherwise from the
 * staged quantity. A removed line comes back with one piece on plus. Past the largest quantity
 * the contract takes, plus does nothing.
 */
function step(item: DraftItem, delta: 1 | -1): void {
  const text = typedOf(item);
  const typed = text === null ? undefined : readTyped(text);
  const current = typed === undefined ? quantityOf(item) : typed;
  const next = current === null ? (delta > 0 ? '1' : null) : stepQuantity(current, delta);
  if (next !== null && parseQuantityInput(next) === null) return;
  if (text !== null) typing.value = { id: item.id, text: next ?? '0' };
  emit('change', item, next);
}

/** Puts a removed line back with the quantity the order was saved with. */
const restore = (item: DraftItem): void => emit('change', item, item.quantity);

// --- free stock beside the field ------------------------------------------------------------------

/** The quantity the hint compares with the stock: a readable typed one counts before it is staged. */
function consideredQuantity(item: Row): string | null {
  const text = typedOf(item);
  const typed = text === null ? undefined : readTyped(text);
  return typed === undefined ? quantityOf(item) : typed;
}

function stockHint(item: Row): { free: string; short: string | null } | null {
  const free = props.free?.get(item.id);
  const quantity = consideredQuantity(item);
  if (free === undefined || quantity === null) return null;
  return { free, short: shortOf(quantity, free) };
}

const stockId = (item: Row): string => `${fieldIds}-${item.id}-stock`;
const errorId = (item: Row): string => `${fieldIds}-${item.id}-error`;
function describedBy(item: Row): string | undefined {
  const ids = [
    isInvalid(item) ? errorId(item) : null,
    stockHint(item) !== null ? stockId(item) : null,
  ].filter((id): id is string => id !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
const changed = (item: Row): boolean => isPriced(item) && props.draft.has(item.id);
const signedDifference = computed(() => {
  const cents = toCents(summary.value.difference.replace('-', ''));
  const negative = summary.value.difference.startsWith('-');
  const sign = cents === 0n ? '' : negative ? '−' : '+';
  return `${sign}${formatMoney(summary.value.difference.replace('-', ''))}`;
});
const show = (quantity: string | null): string =>
  quantity === null ? '0' : formatNumber(quantity);
const currency = computed(() => t('common.currency'));
</script>

<template>
  <div class="items">
    <section class="panel" :aria-label="t('orders.detail.sections.items')">
      <header class="panel__head">
        <div class="panel__heading">
          <h2 class="panel__title">{{ t('orders.detail.sections.items') }}</h2>
          <span class="items__sub">{{
            t('orders.detail.items.sub', { lines: keptLines, count: totalQuantity })
          }}</span>
        </div>
        <span v-if="editable" class="items__note">
          <StaffIcon name="pencil" :size="13" />
          {{ t('orders.detail.items.editHint') }}
        </span>
        <span v-else-if="note" class="items__note">
          <StaffIcon name="lock" :size="13" />
          {{ note }}
        </span>
      </header>

      <p v-if="items.length === 0" class="items__empty" role="status">
        {{ t('orders.detail.items.empty') }}
      </p>
      <div v-else class="grid" :class="hasMoney ? 'grid--money' : 'grid--plain'" role="table">
        <div class="grid__head" role="row">
          <span role="columnheader">{{ t('orders.detail.items.product') }}</span>
          <span role="columnheader">{{ t('orders.detail.items.quantity') }}</span>
          <template v-if="hasMoney">
            <span role="columnheader" class="grid__end" :title="t('orders.detail.items.price')">{{
              t('orders.detail.items.priceColumn', { currency })
            }}</span>
            <span role="columnheader" class="grid__end">{{
              t('orders.detail.items.sumColumn', { currency })
            }}</span>
          </template>
        </div>
        <div
          v-for="item in items"
          :key="item.id"
          class="line"
          role="row"
          :class="{ 'line--removed': quantityOf(item) === null, 'line--changed': changed(item) }"
        >
          <div class="line__name" role="cell">
            <span class="line__title">{{ item.name }}</span>
            <span class="line__code">
              {{ item.productCode }}
              <template v-if="!item.stockTracked">
                ·
                <span :title="t('orders.supplies.untrackedHint')" data-testid="item-by-order">{{
                  t('orders.supplies.untracked')
                }}</span>
              </template>
            </span>
            <span v-if="quantityOf(item) === null" class="line__removed">
              {{ t('orders.detail.draft.removed') }}
            </span>
          </div>
          <div v-if="editable && isPriced(item)" class="line__edit" role="cell">
            <div class="stepper" role="group" :aria-label="item.name">
              <div class="stepper__box" :class="{ 'stepper__box--bad': isInvalid(item) }">
                <!-- mousedown is prevented so the field keeps the focus: the step then counts
                     from what is typed in it, and one change is staged, not two. -->
                <button
                  type="button"
                  class="stepper__btn"
                  :disabled="busy || quantityOf(item) === null"
                  :aria-label="t('orders.detail.items.decrease', { name: item.name })"
                  @mousedown.prevent
                  @click="step(item, -1)"
                >
                  <StaffIcon name="minus" :size="13" />
                </button>
                <input
                  class="stepper__input num"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  spellcheck="false"
                  :value="fieldValue(item)"
                  :disabled="busy"
                  :aria-label="t('orders.detail.items.quantityOf', { name: item.name })"
                  :aria-invalid="isInvalid(item) ? 'true' : undefined"
                  :aria-describedby="describedBy(item)"
                  @focus="startTyping(item, $event)"
                  @input="onType(item, $event)"
                  @blur="commitTyped(item)"
                  @keydown.enter.prevent="commitTyped(item)"
                  @keydown.esc="cancelTyping"
                  @keydown.up.prevent="step(item, 1)"
                  @keydown.down.prevent="step(item, -1)"
                />
                <span class="stepper__unit" aria-hidden="true">{{ formatUnit(item.unit) }}</span>
                <button
                  type="button"
                  class="stepper__btn"
                  :disabled="busy"
                  :aria-label="t('orders.detail.items.increase', { name: item.name })"
                  @mousedown.prevent
                  @click="step(item, 1)"
                >
                  <StaffIcon name="plus" :size="13" />
                </button>
              </div>
              <button
                v-if="quantityOf(item) === null"
                type="button"
                class="stepper__side"
                :disabled="busy"
                :aria-label="t('orders.detail.items.restore', { name: item.name })"
                :title="t('orders.detail.items.restore', { name: item.name })"
                @click="restore(item)"
              >
                <StaffIcon name="history" :size="14" />
              </button>
              <button
                v-else
                type="button"
                class="stepper__side stepper__side--remove"
                :disabled="busy"
                :aria-label="t('orders.detail.items.remove', { name: item.name })"
                :title="t('orders.detail.items.remove', { name: item.name })"
                @click="emit('change', item, null)"
              >
                <StaffIcon name="x" :size="13" />
              </button>
            </div>
          </div>
          <span v-else class="line__qty" role="cell">{{
            `${show(quantityOf(item))} ${formatUnit(item.unit)}`
          }}</span>
          <template v-if="isPriced(item)">
            <span class="line__price num" role="cell">{{ formatMoney(item.unitPrice) }}</span>
            <span class="line__sum num" role="cell">{{ lineSum(item) }}</span>
          </template>
          <!-- Notes about the number sit on a row of their own under the field, so the field, the
               price and the amount stay on ONE line whether or not a note is shown. -->
          <div
            v-if="editable && isPriced(item) && (isInvalid(item) || stockHint(item))"
            class="line__notes"
            role="cell"
          >
            <span v-if="isInvalid(item)" :id="errorId(item)" class="qty__error" role="alert">
              {{ t('orders.detail.items.quantityInvalid') }}
            </span>
            <span
              v-if="stockHint(item)"
              :id="stockId(item)"
              class="qty__stock"
              :class="{ 'qty__stock--short': stockHint(item)?.short }"
              data-testid="item-stock"
            >
              <StaffIcon v-if="stockHint(item)?.short" name="alert" :size="12" />
              {{
                stockHint(item)?.short
                  ? t('orders.detail.items.freeShort', {
                      free: formatNumber(stockHint(item)?.free ?? '0'),
                      short: formatNumber(stockHint(item)?.short ?? '0'),
                      unit: formatUnit(item.unit),
                    })
                  : t('orders.detail.items.free', {
                      free: formatNumber(stockHint(item)?.free ?? '0'),
                      unit: formatUnit(item.unit),
                    })
              }}
            </span>
          </div>
        </div>
      </div>

      <footer v-if="shownTotal !== null" class="panel__foot">
        <span class="snapshot">
          <StaffIcon name="lock" :size="14" class="snapshot__icon" />
          {{ t('orders.detail.items.snapshot') }}
        </span>
        <span class="total">
          <span class="total__label">{{ t('orders.detail.items.total') }}</span>
          <span class="total__sum num">{{ formatMoney(shownTotal) }} {{ currency }}</span>
        </span>
      </footer>
    </section>

    <section v-if="dirty" class="draft" :aria-label="t('orders.detail.draft.title')">
      <div class="draft__head">
        <b class="draft__title"
          >{{ t('orders.detail.draft.title') }} ·
          {{ t('orders.detail.draft.count', { count: summary.changes.length }) }}</b
        >
        <span class="draft__totals num">
          <s>{{ formatMoney(summary.oldTotal) }}</s> {{ '→' }}
          <b>{{ formatMoney(summary.newTotal) }}</b
          >, {{ signedDifference }} {{ currency }}
        </span>
      </div>
      <ul class="draft__list">
        <li v-for="change in summary.changes" :key="change.itemId" class="draft__change">
          <template v-if="change.to === null">
            {{
              t('orders.detail.timeline.removed', { name: change.name, from: show(change.from) })
            }}
          </template>
          <template v-else>
            {{ change.name }}: <s>{{ show(change.from) }}</s> {{ '→' }}
            <b>{{ show(change.to) }}</b>
            {{ t('orders.detail.items.pieces') }}
          </template>
        </li>
      </ul>
      <span class="draft__preview">{{ t('orders.detail.draft.preview') }}</span>
      <div class="draft__buttons">
        <AppButton variant="secondary" size="sm" :disabled="busy" @click="emit('discard')">
          {{ t('orders.detail.draft.discard') }}
        </AppButton>
        <AppButton size="sm" :loading="busy" @click="emit('save')">
          {{ t('orders.detail.draft.save') }}
        </AppButton>
        <span class="draft__hint">{{ t('orders.detail.draft.oneEvent') }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.items {
  display: flex;
  flex-direction: column;
  gap: var(--gap-block);
  min-width: 0;
}

/* v8 card: white, hairline ring, 12px radius; the table runs edge to edge inside it. */
.panel {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 20px;
}

.panel__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.panel__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.items__sub {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.items__note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.items__empty {
  margin: 0;
  padding: 40px 20px;
  border-top: 1px solid var(--e8);
  text-align: center;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* Columns of v8: product | quantity (| price | amount). A phone gets two rows per line instead of
   a sideways scroll: name and amount on top, quantity and unit price under them. */
.grid {
  --cols: minmax(0, 1fr) 196px;
  min-width: 0;
}

.grid--money {
  --cols: minmax(0, 1fr) 196px 100px 110px;
}

.grid__head,
.line {
  display: grid;
  grid-template-columns: var(--cols);
  /* Columns only: the optional notes row under a line brings its own small distance. */
  gap: 0 12px;
  align-items: center;
  padding: 0 20px;
  border-top: 1px solid var(--e8);
}

.grid__head {
  height: 40px;
  background: var(--f5);
  font-size: var(--fs-group);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--t2);
}

.grid__end {
  text-align: right;
}

.line {
  min-height: 58px;
  padding-top: 12px;
  padding-bottom: 12px;
  font-size: var(--fs-small);
  transition: background-color 0.2s ease;
}

.line--changed {
  background: var(--acc-bg);
}

.line__name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.line__code {
  font-family: var(--font-mono);
  font-size: var(--fs-group);
  color: var(--t2);
}

.line__qty {
  font-variant-numeric: tabular-nums;
}

.line__price,
.line__sum {
  text-align: right;
  white-space: nowrap;
}

.line__sum {
  font-weight: 600;
}

.line--removed .line__title,
.line--removed .line__sum {
  color: var(--t3);
  text-decoration: line-through;
}

.line__removed {
  font-size: var(--fs-group);
  color: var(--red);
}

/* What the manager should know about the number, under the field and as wide as the three
   columns to its right allow, so a sentence does not wrap inside the narrow quantity column. */
.line__notes {
  display: flex;
  flex-wrap: wrap;
  grid-column: 2 / -1;
  align-items: center;
  gap: 4px 12px;
  min-width: 0;
  margin-top: 6px;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* One field with its two steps: minus | number + unit | plus, in a single hairline box. */
.stepper__box {
  display: flex;
  align-items: center;
  height: 32px;
  overflow: hidden;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.stepper__box:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.stepper__box--bad,
.stepper__box--bad:focus-within {
  box-shadow: inset 0 0 0 1px var(--red);
}

.stepper__btn {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}

.stepper__btn:hover:not(:disabled) {
  background: var(--hov);
}

.stepper__btn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.stepper__btn:disabled,
.stepper__side:disabled {
  cursor: default;
  color: var(--b5);
}

/* Right-aligned digits meet the unit: the pair reads "12 dona", as the plain quantity does. */
.stepper__input {
  width: 52px;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  text-align: right;
  outline: none;
}

.stepper__input:disabled {
  color: var(--t2);
}

.stepper__unit {
  flex: none;
  padding: 0 6px 0 4px;
  font-size: var(--fs-group);
  color: var(--t2);
  white-space: nowrap;
}

/* Remove the line, or put a removed one back: beside the box, not one of its steps. */
.stepper__side {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.stepper__side--remove {
  color: var(--red);
}

.stepper__side:hover:not(:disabled) {
  background: var(--hov);
}

.stepper__side:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.qty__error {
  font-size: var(--fs-group);
  color: var(--red);
}

.qty__stock {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-group);
  color: var(--t2);
}

.qty__stock--short {
  padding: 2px 6px;
  border-radius: var(--r-kbd);
  background: var(--amber-bg);
  color: var(--amber);
}

.panel__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  padding: 16px 20px;
  border-top: 1px solid var(--e8);
}

.snapshot {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.snapshot__icon {
  color: var(--acc);
}

.total {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.total__label {
  font-size: var(--fs-body);
  font-weight: 600;
}

.total__sum {
  font-size: 19px;
}

/* v8 unsaved-changes card: orange tint with an orange ring. */
.draft {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border-radius: var(--r-card);
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  font-size: var(--fs-meta);
  animation: viewIn 0.2s var(--ease) both;
}

.draft__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.draft__title {
  font-size: var(--fs-body);
  font-weight: 600;
}

.draft__totals {
  font-size: var(--fs-small);
}

.draft__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 16px;
}

/* On the orange tint --t2 keeps its contrast in both themes. */
.draft__preview {
  color: var(--t2);
}

.draft__buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.draft__hint {
  font-size: var(--fs-group);
  color: var(--acc-fg);
}

@media (max-width: 559px) {
  .grid__head {
    display: none;
  }

  .line {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding: 12px 16px;
  }

  .line__name {
    grid-column: 1 / -1;
  }

  .grid--money .line__name {
    grid-column: 1;
  }

  .grid--money .line__sum {
    grid-column: 2;
    grid-row: 1;
  }

  .line__notes {
    grid-column: 1 / -1;
    margin-top: 0;
  }

  .line__price {
    color: var(--t2);
  }

  .line__price::before {
    content: '× ';
  }

  .panel__head,
  .panel__foot {
    padding-right: 16px;
    padding-left: 16px;
  }
}

@media (pointer: coarse), (hover: none) {
  .stepper__box {
    height: 44px;
  }

  .stepper__btn {
    width: 44px;
  }

  .stepper__side {
    width: 44px;
    height: 44px;
  }

  /* 16px keeps iOS from zooming the page when the field takes the focus. */
  .stepper__input {
    font-size: 16px;
  }
}
</style>
