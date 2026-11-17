<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import AppDrawer from '@/components/ui/AppDrawer.vue';
import type { OrderFilters } from '../domain/order-filters';

const props = defineProps<{
  modelValue: boolean;
  filters: OrderFilters;
  /** Payment and debt exist only in the full view; the warehouse and driver view has no money. */
  showMoney: boolean;
  resultCount: number;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:filters': [value: OrderFilters];
  reset: [];
}>();

const { t } = useI18n();
const uid = useId();

interface Choice {
  readonly value: string;
  readonly label: string;
}
interface Group {
  readonly key: 'payment' | 'period';
  readonly legend: string;
  readonly choices: Choice[];
}

// Applied at once (the URL is the single source), so there is no draft to confirm or lose.
const groups = computed<Group[]>(() => [
  ...(props.showMoney
    ? [
        {
          key: 'payment' as const,
          legend: t('orders.filters.payment'),
          choices: [
            { value: 'all', label: t('orders.filters.all') },
            { value: 'PAID', label: t('orders.payment.PAID') },
            { value: 'UNPAID', label: t('orders.payment.UNPAID') },
          ],
        },
      ]
    : []),
  {
    key: 'period' as const,
    legend: t('orders.filters.period'),
    choices: [
      { value: 'all', label: t('orders.filters.allTime') },
      { value: 'today', label: t('orders.filters.today') },
      ...(props.showMoney ? [{ value: 'debt', label: t('orders.filters.debt') }] : []),
    ],
  },
]);

const current = (key: Group['key']): string => props.filters[key] ?? 'all';

function pick(key: Group['key'], value: string): void {
  emit('update:filters', { ...props.filters, [key]: value === 'all' ? null : value });
}

const resultText = computed(() =>
  t('table.resultCount', { count: props.resultCount }, props.resultCount),
);
</script>

<template>
  <AppDrawer
    :model-value="modelValue"
    :title="t('orders.filters.more')"
    width="min(420px, 100%)"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <fieldset v-for="group in groups" :key="group.key" class="group">
      <legend class="group__legend">{{ group.legend }}</legend>
      <label
        v-for="choice in group.choices"
        :key="choice.value"
        class="choice"
        :class="{ 'choice--on': current(group.key) === choice.value }"
      >
        <input
          type="radio"
          class="choice__input"
          :name="`${uid}-${group.key}`"
          :value="choice.value"
          :checked="current(group.key) === choice.value"
          @change="pick(group.key, choice.value)"
        />
        {{ choice.label }}
      </label>
    </fieldset>
    <template #footer>
      <AppButton variant="secondary" size="lg" @click="emit('reset')">
        {{ t('orders.filters.reset') }}
      </AppButton>
      <AppButton size="lg" class="done" @click="emit('update:modelValue', false)">
        {{ t('orders.filters.show', { result: resultText }) }}
      </AppButton>
    </template>
  </AppDrawer>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin: 0 0 20px;
  padding: 0;
  border: 0;
}

.group__legend {
  margin-bottom: 8px;
  padding: 0;
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--t2);
}

/* v8 filter option: a white hairline button; the chosen one is orange-tinted with an orange ring.
   Rows stay 48px high: the sheet is used with a thumb on a phone. */
.choice {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 14px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  color: var(--ink);
  cursor: pointer;
}

.choice:hover {
  background: var(--hov);
}

.choice--on,
.choice--on:hover {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc-fg);
  font-weight: 600;
}

/* The radio stays in the page for the keyboard and screen readers; the row is the target. */
.choice__input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--acc);
}

.choice:focus-within {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.done {
  flex: 1;
}
</style>
