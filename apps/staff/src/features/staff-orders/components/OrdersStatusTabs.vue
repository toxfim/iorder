<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { type StageFilter, type StageTabCount } from '../domain/order-filters';
import type { FulfillmentStage } from '../domain/order-model';

const props = defineProps<{
  /** The pressed tab: a stage, `CLOSED`, or `all`. */
  modelValue: StageFilter | 'all';
  counts: readonly StageTabCount[];
  /** The role's own step: placed right after "All" and marked. */
  ownStage: FulfillmentStage | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: StageFilter | 'all'] }>();

const { t } = useI18n();

const tabs = computed(() => {
  const label = (value: StageFilter | 'all'): string =>
    value === 'all'
      ? t('orders.filters.all')
      : value === 'CLOSED'
        ? t('orders.filters.closed')
        : t(`orders.stages.${value}`);
  const all = props.counts.map((c) => ({ ...c, label: label(c.value) }));
  const own = all.find((tab) => tab.value === props.ownStage);
  const rest = all.filter((tab) => tab.value !== 'all' && tab !== own);
  return [all[0], ...(own ? [own] : []), ...rest].filter((tab) => tab !== undefined);
});
</script>

<template>
  <div class="tabs" role="group" :aria-label="t('orders.filters.stage')">
    <button
      v-for="tab in tabs"
      :key="tab.value"
      type="button"
      class="tab"
      :class="{ 'tab--on': tab.value === modelValue, 'tab--own': tab.value === ownStage }"
      :aria-pressed="tab.value === modelValue"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
      <span v-if="tab.value === ownStage" class="tab__own">{{ t('orders.filters.ownStep') }}</span>
      <span class="tab__count">{{ tab.count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* v8 underline tabs on a hairline: one row that scrolls sideways on a phone instead of wrapping.
   Pressed tab: orange label with a 2px bar and an orange count chip. */
.tabs {
  display: flex;
  gap: 24px;
  overflow-x: auto;
  box-shadow: inset 0 -1px 0 var(--e8);
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 42px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--t2);
  font-size: var(--fs-small);
  font-weight: 400;
  white-space: nowrap;
  cursor: pointer;
}

.tab:hover {
  color: var(--ink);
}

.tab:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.tab--on,
.tab--on:hover {
  box-shadow: inset 0 -2px 0 var(--acc);
  color: var(--acc-fg);
  font-weight: 600;
}

.tab__own {
  font-size: var(--fs-group);
  font-weight: 400;
  color: var(--acc-fg);
}

.tab__count {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--ef);
  font-size: var(--fs-group);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.tab--on .tab__count {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

@media (pointer: coarse), (hover: none) {
  .tab {
    min-height: 44px;
  }
}
</style>
