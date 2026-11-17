<script setup lang="ts">
import { PIECE_UNIT } from '@iorder/shared';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import { isSameQuantity, normalizeQuantity, stepQuantity, toMilli } from '@core/lib/quantity';
import { parseQuantityInput } from '@core/lib/quantity-input';

// Quantity control: minus, a text field (whole numbers only, as the cart endpoint requires), plus.
// The number on screen changes at once (optimistic); taps on minus/plus are collected for a short
// moment and sent as ONE request, typed values are sent when the field is left. Requests of one
// control never overlap: a change made while one is in flight is sent right after it. When the
// server refuses, the number goes back to what the cart really holds. The server prices; this
// control never computes an amount. Stepping below the smallest unit asks for removal.
// With `max` (how many pieces can be ordered now) the field and the plus button stop there and say
// why; the server enforces the same figure, so this is a courtesy, not the rule.
const props = withDefaults(
  defineProps<{
    /** The quantity in the cart, a decimal string. */
    modelValue: string;
    /** Accessible name of the field, for example "<product>: quantity". */
    label: string;
    /** The product name: the plus and minus buttons say which product they change. */
    name: string;
    /** Sends the quantity (null = remove the line). Resolves false when the change failed. */
    commit: (quantity: string | null) => Promise<boolean>;
    disabled?: boolean;
    debounceMs?: number;
    /** The most that can be ordered now, in whole pieces; 0 = out of stock; null = no limit. */
    max?: number | null;
    /** The product's unit, for the note shown at the limit. */
    unit?: string;
  }>(),
  { disabled: false, debounceMs: 350, max: null, unit: PIECE_UNIT },
);

/** How long the "only N in stock" note stays after the limit was hit. */
const LIMIT_NOTE_MS = 4000;

const { t } = useI18n();
const { formatNumber, formatUnit } = useFormat();
const errorId = useId();
const limitId = useId();
// The server spells quantities with three fraction digits ('1.000'); the field shows '1'.
function shownQuantity(quantity: string): string {
  try {
    return normalizeQuantity(quantity);
  } catch {
    return quantity;
  }
}
const draft = ref(shownQuantity(props.modelValue));
const invalid = ref(false);
const busy = ref(false);
// A change is waiting to be sent: the saved line total no longer matches the number shown.
const waiting = ref(false);
const emit = defineEmits<{ unsaved: [value: boolean]; invalid: [value: boolean] }>();
watch(invalid, (value) => emit('invalid', value));
const unsaved = computed(() => waiting.value || busy.value);
watch(unsaved, (value) => emit('unsaved', value));

let timer: ReturnType<typeof setTimeout> | undefined;
// What the person last asked for; null inside means "remove the line". Undefined = nothing asked.
let wanted: { quantity: string | null } | undefined;
let again = false;

const settled = (): boolean => !waiting.value && !busy.value;

// The limit as a quantity string; null = none. A figure is a whole number; '0' means out of stock.
const limit = computed(() =>
  props.max !== null && Number.isSafeInteger(props.max) && props.max >= 0
    ? String(props.max)
    : null,
);
const outOfStock = computed(() => limit.value === '0');
const isAbove = (quantity: string, than: string): boolean => toMilli(quantity) > toMilli(than);
/** Nothing more can be added: the plus button stays pressable only to say why. */
const atLimit = computed(() => {
  if (limit.value === null) return false;
  return !isAbove(limit.value, parseQuantityInput(draft.value) ?? props.modelValue);
});
// Shown for a moment after a press or an entry ran into the limit, then taken away again: a note
// that stayed would keep one card of the price list taller than its neighbours.
const limitNote = ref(false);
let limitTimer: ReturnType<typeof setTimeout> | undefined;
function explainLimit(): void {
  limitNote.value = true;
  clearTimeout(limitTimer);
  limitTimer = setTimeout(() => (limitNote.value = false), LIMIT_NOTE_MS);
}
function forgetLimit(): void {
  clearTimeout(limitTimer);
  limitNote.value = false;
}
// One line under the field at a time: a mistake in the entry comes before the limit note.
const limitNoteShown = computed(() => !invalid.value && limitNote.value && limit.value !== null);
const describedBy = computed(() => {
  if (invalid.value) return errorId;
  return limitNoteShown.value ? limitId : undefined;
});

watch(
  () => props.modelValue,
  (value) => {
    if (!settled()) return;
    draft.value = shownQuantity(value);
    invalid.value = false;
  },
);

async function send(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  waiting.value = false;
  if (busy.value) {
    again = true;
    return;
  }
  const target = wanted;
  wanted = undefined;
  if (
    target === undefined ||
    (target.quantity !== null && isSameQuantity(target.quantity, props.modelValue))
  ) {
    draft.value = shownQuantity(props.modelValue);
    return;
  }
  const shown = draft.value;
  busy.value = true;
  const ok = await props.commit(target.quantity);
  busy.value = false;
  if (!ok) {
    again = false;
    // Something newer was asked meanwhile: keep it and send it, it may well be accepted.
    if (wanted !== undefined) {
      await nextTick();
      await send();
      return;
    }
    // Rollback: show what the cart really holds, unless the person is typing something else.
    if (draft.value === shown) draft.value = shownQuantity(props.modelValue);
    return;
  }
  if (again) {
    again = false;
    // The saved quantity must reach the props before the next change is compared with it.
    await nextTick();
    if (wanted !== undefined) await send();
    return;
  }
  // Let the parent hand down the saved quantity first, then show it.
  await nextTick();
  if (settled()) draft.value = shownQuantity(props.modelValue);
}

// Every change, including a removal, goes through here so requests of one control never overlap.
function schedule(quantity: string | null, immediately: boolean): void {
  wanted = { quantity };
  clearTimeout(timer);
  if (immediately) {
    void send();
    return;
  }
  waiting.value = true;
  timer = setTimeout(() => void send(), props.debounceMs);
}

function step(delta: number): void {
  const base = parseQuantityInput(draft.value) ?? props.modelValue;
  if (limit.value !== null && delta > 0 && !isAbove(limit.value, base)) {
    // At the limit: nothing is added, and the press says why instead of doing nothing.
    explainLimit();
    return;
  }
  if (outOfStock.value && delta < 0) {
    // Nothing is left: there is no quantity to lower to, so minus asks for removal.
    invalid.value = false;
    forgetLimit();
    schedule(null, true);
    return;
  }
  if (limit.value !== null && delta < 0 && isAbove(base, limit.value)) {
    // The stock fell below the quantity: every step down to the limit would be refused, so one
    // press goes straight there.
    invalid.value = false;
    draft.value = limit.value;
    explainLimit();
    schedule(limit.value, false);
    return;
  }
  forgetLimit();
  const next = stepQuantity(base, delta);
  if (next === null) {
    invalid.value = false;
    schedule(null, true);
    return;
  }
  const valid = parseQuantityInput(next);
  if (valid === null) {
    // Past the largest quantity the contract allows.
    invalid.value = true;
    return;
  }
  invalid.value = false;
  draft.value = valid;
  schedule(valid, false);
}

function commitTyped(): void {
  const parsed = parseQuantityInput(draft.value);
  if (parsed === null) {
    invalid.value = true;
    return;
  }
  invalid.value = false;
  if (outOfStock.value) {
    // Nothing is left: no quantity can be typed. The field shows what the cart holds and says why.
    draft.value = shownQuantity(props.modelValue);
    explainLimit();
    return;
  }
  // More than can be ordered: the field stops at the limit and says why.
  const capped = limit.value !== null && isAbove(parsed, limit.value) ? limit.value : parsed;
  if (capped === parsed) forgetLimit();
  else explainLimit();
  draft.value = capped;
  if (!isSameQuantity(capped, props.modelValue) || timer !== undefined) schedule(capped, true);
}

// Leaving the page must not lose a change that is still waiting. There is no keepalive request in
// the HTTP client, so this is a best-effort immediate send when the page is hidden or closed.
function flushWaiting(): void {
  if (timer !== undefined) void send();
}
function flushWhenHidden(): void {
  if (document.visibilityState === 'hidden') flushWaiting();
}
onMounted(() => {
  window.addEventListener('pagehide', flushWaiting);
  document.addEventListener('visibilitychange', flushWhenHidden);
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', flushWaiting);
  document.removeEventListener('visibilitychange', flushWhenHidden);
  clearTimeout(limitTimer);
  flushWaiting();
  // The watcher dies with the component, so a still-set "unsaved" would never be cleared.
  emit('unsaved', false);
  emit('invalid', false);
});
</script>

<template>
  <div class="stepper">
    <div class="stepper__box" :class="{ 'stepper__box--invalid': invalid }">
      <button
        type="button"
        class="stepper__btn"
        :disabled="disabled"
        :aria-label="t('customer.quantity.decrease', { name })"
        @click="step(-1)"
      >
        <span aria-hidden="true">{{ '−' }}</span>
      </button>
      <input
        v-model="draft"
        class="stepper__input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        :disabled="disabled"
        :aria-label="label"
        :aria-busy="busy || undefined"
        :aria-invalid="invalid || undefined"
        :aria-describedby="describedBy"
        @change="commitTyped"
        @keydown.enter.prevent="commitTyped"
      />
      <!-- At the limit the button is not `disabled`: it stays reachable and a press explains. -->
      <button
        type="button"
        class="stepper__btn"
        :class="{ 'stepper__btn--limit': atLimit }"
        :disabled="disabled"
        :aria-disabled="atLimit || undefined"
        :aria-label="t('customer.quantity.increase', { name })"
        @click="step(1)"
      >
        <span aria-hidden="true">{{ '+' }}</span>
      </button>
    </div>
    <p v-if="invalid" :id="errorId" class="stepper__error" role="alert">
      {{ t('customer.quantity.invalid') }}
    </p>
    <p
      v-else-if="limitNoteShown && limit !== null"
      :id="limitId"
      class="stepper__note"
      role="status"
      data-testid="stepper-limit"
    >
      {{
        outOfStock
          ? t('customer.quantity.none')
          : t('customer.quantity.limit', { count: formatNumber(limit), unit: formatUnit(unit) })
      }}
    </p>
  </div>
</template>

<style scoped>
.stepper {
  display: flex;
  flex-direction: column;
  /* Not `stretch`: in a wide grid cell the bordered box would grow past its buttons and input,
     leaving an empty bordered area on the right. The box hugs its content. */
  align-items: flex-start;
  gap: 4px;
}

.stepper__box {
  display: flex;
  align-items: center;
  max-width: 100%;
  height: var(--tap-min);
  overflow: hidden;
  border: 1px solid var(--d9);
  border-radius: var(--r-btn-sm);
  background: var(--w);
}

.stepper__box:focus-within {
  border-color: var(--ink);
}

.stepper__box--invalid {
  border-color: var(--red);
}

.stepper__btn {
  flex: none;
  width: var(--tap-min);
  height: 100%;
  border: 0;
  background: var(--f5);
  color: var(--ink);
  font-size: 18px;
  cursor: pointer;
}

.stepper__btn:hover:not(:disabled) {
  background: var(--ef);
}

.stepper__btn:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -3px;
}

.stepper__btn:disabled,
.stepper__btn--limit {
  color: var(--b5);
}

.stepper__btn:disabled {
  cursor: not-allowed;
}

/* Still pressable (the press explains the limit), so no hover fill that promises an effect. */
.stepper__btn--limit:hover:not(:disabled) {
  background: var(--f5);
}

.stepper__input {
  width: 64px;
  min-width: 0;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--ink);
  /* 16px keeps iOS from zooming the page when the field is focused. */
  font-size: 16px;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.stepper__input:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.stepper__error,
.stepper__note {
  margin: 0;
  max-width: 200px;
  font-size: var(--fs-meta);
}

.stepper__error {
  color: var(--red);
}

/* An explanation, not a mistake of the person: normal text contrast, no alarm colour. */
.stepper__note {
  color: var(--t2);
}
</style>
