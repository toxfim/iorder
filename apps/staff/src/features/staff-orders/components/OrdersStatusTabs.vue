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
  /**
   * Draw only the first N pills, of equal width (the design's phone and tablet screens); the other
   * statuses are in "Filtrlar → Holat".
   */
  limit?: number;
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
  const all = props.counts.map((c) => ({
    ...c,
    label: label(c.value),
    short: t(`orders.list.tabShort.${c.value}`),
  }));
  const own = all.find((tab) => tab.value === props.ownStage);
  const rest = all.filter((tab) => tab.value !== 'all' && tab !== own);
  const ordered = [all[0], ...(own ? [own] : []), ...rest].filter((tab) => tab !== undefined);
  return props.limit === undefined ? ordered : ordered.slice(0, props.limit);
});
</script>

<template>
  <div
    class="tabs"
    :class="{ 'tabs--even': limit !== undefined }"
    role="group"
    :aria-label="t('orders.filters.stage')"
  >
    <button
      v-for="tab in tabs"
      :key="tab.value"
      type="button"
      class="tab"
      :class="{ 'tab--on': tab.value === modelValue, 'tab--own': tab.value === ownStage }"
      :aria-pressed="tab.value === modelValue"
      @click="emit('update:modelValue', tab.value)"
    >
      <span class="tab__label" :title="limit !== undefined ? tab.label : undefined">{{
        limit !== undefined ? tab.short : tab.label
      }}</span
      >{{ ' ' }}
      <span v-if="tab.value === ownStage" class="tab__own">{{ t('orders.filters.ownStep') }}</span>
      <span class="tab__count">{{ tab.count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Approved «Buyurtmalar» design: rounded pills with the count in mono; the pressed one is ink.
   One row that scrolls sideways when it does not fit (tablet, phone). */
.tabs {
  display: flex;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: 999px;
  background: var(--w);
  color: var(--ink);
  font-size: var(--fs-body-lg);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.tab:hover {
  border-color: var(--d9);
  background: var(--hov);
}

.tab:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.tab--on,
.tab--on:hover {
  border-color: var(--btn-ink-bg);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

/* The role's own step comes right after "All"; the design draws no caption, so the note is
   for screen readers only. */
.tab__own {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.tab__count {
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--t3);
}

.tab--on .tab__count {
  color: inherit;
  font-weight: 400;
}

/* The phone's three pills: one row of truly equal columns. */
.tabs--even {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.tabs--even .tab {
  justify-content: center;
  min-width: 0;
  padding: 0 8px;
}

.tabs--even .tab__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (pointer: coarse), (hover: none) {
  .tab {
    min-height: 44px;
  }
}

@media (max-width: 599px) {
  .tab {
    height: 40px;
    padding: 0 16px;
  }
}
</style>
