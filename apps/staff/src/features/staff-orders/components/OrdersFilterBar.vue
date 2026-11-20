<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDropdown, { type DropdownOption } from '@/components/ui/AppDropdown.vue';
import type { OrderFilters } from '../domain/order-filters';

const props = defineProps<{
  filters: OrderFilters;
  /** Payment and debt exist only in the full view; the warehouse and driver view has no money. */
  showMoney: boolean;
  /**
   * The status list ("Holat") on a phone (below 600px), where only the first three pills are drawn (the
   * design's phone screen); null on a desktop, where every pill is visible.
   */
  stages: readonly DropdownOption[] | null;
}>();

const emit = defineEmits<{
  'update:filters': [value: OrderFilters];
  /** "Tozalash": every filter, the pressed tab and the search too (the approved design). */
  clear: [];
}>();

const { t } = useI18n();

type GroupKey = 'stage' | 'plan' | 'period' | 'payment';
interface Group {
  readonly key: GroupKey;
  readonly label: string;
  readonly value: string;
  readonly options: readonly DropdownOption[];
}

// Applied at once (the URL is the single source), so there is no draft to confirm or lose. The
// design's order: (Holat), To'lov turi, (Label), Sana; the paid / unpaid list comes last. The
// design's "Label" list has no counterpart in the order contract yet, so it is not drawn.
const groups = computed<Group[]>(() => {
  const all = t('orders.filters.all');
  const list: Group[] = [];
  if (props.stages)
    list.push({
      key: 'stage',
      label: t('orders.filters.status'),
      value: props.filters.stage ?? 'all',
      options: props.stages,
    });
  if (props.showMoney)
    list.push({
      key: 'plan',
      label: t('orders.paymentPlan.title'),
      value: props.filters.plan ?? 'all',
      options: [
        { value: 'all', label: all },
        { value: 'FULL', label: t('orders.paymentPlan.FULL') },
        { value: 'DEFERRED', label: t('orders.paymentPlan.DEFERRED') },
      ],
    });
  list.push({
    key: 'period',
    label: t('orders.filters.period'),
    value: props.filters.period ?? 'all',
    options: [
      { value: 'all', label: all },
      { value: 'today', label: t('orders.filters.today') },
      ...(props.showMoney ? [{ value: 'debt', label: t('orders.filters.debt') }] : []),
    ],
  });
  if (props.showMoney)
    list.push({
      key: 'payment',
      label: t('orders.filters.paymentStatus'),
      value: props.filters.payment ?? 'all',
      options: [
        { value: 'all', label: all },
        { value: 'PAID', label: t('orders.payment.PAID') },
        { value: 'UNPAID', label: t('orders.payment.UNPAID') },
      ],
    });
  return list;
});

function pick(key: GroupKey, value: string): void {
  emit('update:filters', { ...props.filters, [key]: value === 'all' ? null : value });
}
</script>

<template>
  <div class="fbar" role="group" :aria-label="t('orders.filters.group')">
    <AppDropdown
      v-for="group in groups"
      :key="group.key"
      class="fbar__dd"
      :class="{ 'fbar__dd--set': group.value !== 'all' }"
      :model-value="group.value"
      :options="group.options"
      :label="group.label"
      min-width="170px"
      :data-testid="`filter-${group.key}`"
      @update:model-value="pick(group.key, $event)"
    >
      <template #value="{ selected }">
        <span class="fbar__value">
          <span class="fbar__key">{{ group.label }}</span>
          <b class="fbar__chosen">{{ selected?.label }}</b>
        </span>
      </template>
    </AppDropdown>
    <button type="button" class="fbar__clear" @click="emit('clear')">
      {{ t('orders.list.filtersClear') }}
    </button>
  </div>
</template>

<style scoped>
/* Approved design: a row of list buttons ("To'lov  Hammasi ⌄") under the toolbar; a set one turns
   soft accent; "Tozalash" is a text link at the end. Two columns on a phone. */
.fbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.fbar__dd {
  flex: 0 0 auto;
  max-width: 100%;
}

.fbar__dd :deep(.dd__trigger) {
  height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  font-size: var(--fs-body-lg);
  font-weight: 500;
}

.fbar__dd :deep(.dd__trigger--open) {
  border-color: var(--acc);
  box-shadow: var(--ring-focus);
}

.fbar__dd--set :deep(.dd__trigger) {
  border-color: var(--acc);
  background: var(--acc-bg);
}

.fbar__value {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.fbar__key {
  flex: none;
  font-weight: 400;
  color: var(--t2);
}

.fbar__dd--set .fbar__key {
  color: var(--acc-fg);
}

.fbar__chosen {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fbar__clear {
  height: 32px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--acc-fg);
  cursor: pointer;
}

.fbar__clear:hover {
  text-decoration: underline;
}

@media (max-width: 599px) {
  .fbar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .fbar__clear {
    justify-self: start;
  }
}

@media (pointer: coarse), (hover: none) {
  .fbar__clear {
    min-height: 44px;
  }
}
</style>
