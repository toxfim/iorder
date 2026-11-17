<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SupplySummary } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { openDropdownId } from '@core/composables/use-open-dropdown';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { useCostFormat } from '../composables/use-cost-format';
import { productPreview } from '../domain/supply-party';

// One use for now, so it stays in this feature: a searchable multi-select of supplies. The list is
// in the page flow, not a floating layer: a modal's body scrolls and would clip it, and on a phone
// the keyboard leaves little room for one. Enter picks, the arrows move, Backspace in an empty
// field takes the last one off.
const SEARCH_DEBOUNCE_MS = 250;

const props = defineProps<{
  modelValue: readonly SupplySummary[];
  error?: string | null;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: readonly SupplySummary[]] }>();

const { t } = useI18n();
const { stockApi } = useServices();
const { formatDate, formatQuantity } = useCostFormat();

const baseId = useId();
const inputId = `${baseId}-input`;
const listId = `${baseId}-list`;
const optionId = (index: number): string => `${baseId}-option-${index}`;

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const query = ref('');
const open = ref(false);
const active = ref(0);
type SearchState = 'loading' | 'ready' | 'error' | 'denied';
const state = ref<SearchState>('loading');
const errorText = ref('');
const results = ref<readonly SupplySummary[]>([]);
const total = ref(0);

const chosen = computed(() => new Set(props.modelValue.map((supply) => supply.deliveryRef)));
const options = computed(() =>
  results.value.filter((supply) => !chosen.value.has(supply.deliveryRef)),
);
// Rows already chosen are hidden from the list, so "no rows" is empty only with nothing chosen.
const emptyText = computed(() => {
  if (query.value.trim() !== '') return t('staffCost.party.noMatch');
  return results.value.length === 0
    ? t('staffCost.party.noSupplies')
    : t('staffCost.party.allChosen');
});
const shortened = computed(() => total.value > results.value.length);

let timer: ReturnType<typeof setTimeout> | undefined;
let run = 0;

async function search(): Promise<void> {
  const mine = ++run;
  state.value = 'loading';
  try {
    const answer = await stockApi.listSupplies({ search: query.value.trim() || undefined });
    if (mine !== run) return;
    results.value = answer.items;
    total.value = answer.total;
    active.value = 0;
    state.value = 'ready';
  } catch (caught) {
    if (mine !== run) return;
    results.value = [];
    if (caught instanceof PermissionDeniedError) {
      state.value = 'denied';
      return;
    }
    errorText.value = translateDescribed(t, describePricingError('stock', caught));
    state.value = 'error';
  }
}

watch(query, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
});
// The modal's Esc waits while a dropdown owns it: the first Esc closes the list only.
watch(open, (isOpen) => {
  openDropdownId.value = isOpen ? baseId : null;
});
onMounted(() => void search());
onBeforeUnmount(() => {
  clearTimeout(timer);
  run += 1;
  if (openDropdownId.value === baseId) openDropdownId.value = null;
});

function pick(supply: SupplySummary): void {
  emit('update:modelValue', [...props.modelValue, supply]);
  active.value = 0;
  if (query.value !== '') query.value = '';
  input.value?.focus();
}

function unpick(deliveryRef: string): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((supply) => supply.deliveryRef !== deliveryRef),
  );
}

function move(step: number): void {
  const count = options.value.length;
  if (!open.value) {
    open.value = true;
    return;
  }
  if (count === 0) return;
  active.value = (active.value + step + count) % count;
  list.value?.querySelector(`#${CSS.escape(optionId(active.value))}`)?.scrollIntoView?.({
    block: 'nearest',
  });
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter': {
      event.preventDefault();
      const highlighted = options.value[active.value];
      if (open.value && highlighted !== undefined) pick(highlighted);
      else open.value = true;
      break;
    }
    case 'Backspace': {
      const last = props.modelValue.at(-1);
      if (query.value === '' && last !== undefined) unpick(last.deliveryRef);
      break;
    }
    case 'Escape':
      if (open.value) {
        event.preventDefault();
        open.value = false;
      }
      break;
  }
}

function summaryOf(supply: SupplySummary): string {
  return t('staffCost.party.rowSummary', {
    products: t(
      'staffCost.party.productCount',
      { count: supply.productCount },
      supply.productCount,
    ),
    quantity: formatQuantity(supply.totalQuantity),
    date: formatDate(supply.deliveredAt),
  });
}
</script>

<template>
  <div class="combo">
    <label class="combo__label" :for="inputId">{{ t('staffCost.party.supplyLabel') }}</label>
    <div class="combo__box" :class="{ 'combo__box--error': error }">
      <StaffIcon name="search" :size="16" />
      <input
        :id="inputId"
        ref="input"
        v-model="query"
        class="combo__input"
        type="text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        :aria-expanded="open"
        :aria-controls="listId"
        :aria-activedescendant="open && options.length > 0 ? optionId(active) : undefined"
        :aria-invalid="error ? true : undefined"
        :placeholder="t('staffCost.party.supplyPlaceholder')"
        @focus="open = true"
        @click="open = true"
        @blur="open = false"
        @keydown="onKeydown"
      />
      <kbd class="combo__kbd" aria-hidden="true">{{ t('staffCost.party.enterKey') }}</kbd>
    </div>
    <p class="combo__hint">{{ t('staffCost.party.keysHint') }}</p>
    <p v-if="error" class="combo__error" role="alert">{{ error }}</p>

    <div v-show="open" class="combo__popup">
      <!-- Pressing a row must not take the focus: the blur would close the list first. -->
      <ul
        v-show="state === 'ready' && options.length > 0"
        :id="listId"
        ref="list"
        class="combo__list"
        role="listbox"
        aria-multiselectable="true"
        :aria-label="t('staffCost.party.supplyLabel')"
      >
        <li
          v-for="(supply, index) in options"
          :id="optionId(index)"
          :key="supply.deliveryRef"
          class="option"
          :class="{ 'option--active': index === active }"
          role="option"
          aria-selected="false"
          :data-ref="supply.deliveryRef"
          @mousedown.prevent
          @mouseenter="active = index"
          @click="pick(supply)"
        >
          <span class="option__top">
            <span class="option__ref">{{ supply.deliveryRef }}</span>
            <span v-if="supply.partyNumber !== null" class="option__party">
              {{ t('staffCost.party.currentParty', { party: supply.partyNumber }) }}
            </span>
          </span>
          <span class="option__meta">{{ productPreview(supply) }}</span>
          <span class="option__meta">{{ summaryOf(supply) }}</span>
        </li>
      </ul>
      <p v-if="state === 'loading'" class="combo__status" aria-busy="true" role="status">
        {{ t('state.loading') }}
      </p>
      <p v-else-if="state === 'denied'" class="combo__status" role="alert">
        {{ t('staffCost.party.denied') }}
      </p>
      <div v-else-if="state === 'error'" class="combo__status combo__status--error" role="alert">
        <span>{{ errorText }}</span>
        <button type="button" class="combo__link" @mousedown.prevent @click="search">
          {{ t('common.retry') }}
        </button>
      </div>
      <p v-else-if="options.length === 0" class="combo__status" role="status">{{ emptyText }}</p>
      <p v-else-if="shortened" class="combo__status">
        {{ t('staffCost.party.shortened', { shown: results.length, total }) }}
      </p>
    </div>

    <div v-if="modelValue.length > 0" class="chosen">
      <div class="chosen__head">
        <span class="combo__label">
          {{ t('staffCost.party.chosen', { count: modelValue.length }) }}
        </span>
        <button
          type="button"
          class="combo__link"
          data-testid="party-clear"
          @click="emit('update:modelValue', [])"
        >
          {{ t('staffCost.party.clear') }}
        </button>
      </div>
      <ul class="chosen__list">
        <li v-for="supply in modelValue" :key="supply.deliveryRef" class="row">
          <div class="row__text">
            <span class="option__top">
              <span class="option__ref">{{ supply.deliveryRef }}</span>
              <span v-if="supply.partyNumber !== null" class="option__party">
                {{ t('staffCost.party.currentParty', { party: supply.partyNumber }) }}
              </span>
            </span>
            <span class="option__meta">{{ productPreview(supply) }}</span>
            <span class="option__meta">{{ summaryOf(supply) }}</span>
          </div>
          <button
            type="button"
            class="row__remove"
            :aria-label="t('staffCost.party.remove', { id: supply.deliveryRef })"
            @click="unpick(supply.deliveryRef)"
          >
            <StaffIcon name="x" :size="14" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.combo {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.combo__label {
  font-size: var(--fs-meta);
  color: var(--t3);
}

.combo__box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--t3);
}

.combo__box:focus-within {
  box-shadow: inset 0 0 0 1px var(--acc);
}

.combo__box--error {
  box-shadow: inset 0 0 0 1px var(--red);
}

.combo__input {
  flex: 1;
  min-width: 0;
  height: 42px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--t1);
  font: inherit;
  font-size: var(--fs-body);
}

.combo__kbd {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-group);
  color: var(--t3);
}

@media (hover: none) {
  .combo__kbd {
    display: none;
  }
}

.combo__hint {
  margin: 0;
  font-size: var(--fs-group);
  color: var(--t3);
}

@media (hover: none) {
  .combo__hint {
    display: none;
  }
}

.combo__error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--red);
}

.combo__popup {
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  overflow: hidden;
}

.combo__list {
  max-height: 240px;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
}

.option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--r-kbd);
  cursor: pointer;
}

.option--active {
  background: var(--acc-bg);
}

.option__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.option__ref {
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.option__party {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  font-size: var(--fs-group);
  color: var(--acc-fg);
}

.option__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
  overflow-wrap: anywhere;
}

.combo__status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.combo__status--error {
  color: var(--red);
}

.combo__link {
  border: 0;
  padding: 0;
  background: none;
  font: inherit;
  font-size: var(--fs-meta);
  color: var(--t2);
  text-decoration: underline;
  cursor: pointer;
}

.chosen {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.chosen__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chosen__list {
  margin: 0;
  padding: 0;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
  list-style: none;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
}

.row + .row {
  border-top: 1px solid var(--e8);
}

.row__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row__remove {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--r-kbd);
  background: none;
  color: var(--t3);
  cursor: pointer;
}

.row__remove:hover {
  background: var(--acc-bg);
}
</style>
