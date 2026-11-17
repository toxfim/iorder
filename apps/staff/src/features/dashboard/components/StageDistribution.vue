<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import {
  FULFILLMENT_STAGES,
  stageIndex,
  type FulfillmentStage,
} from '@/features/staff-orders/domain/order-model';
import type { StageFilter } from '@/features/staff-orders/domain/order-filters';

const { t } = useI18n();
const router = useRouter();
const { dashboardSummaryStore } = useServices();
// Per status from the server's summary (every order the person may see, never a loaded subset).
const byStatus = computed(() => dashboardSummaryStore.summary.value?.ordersByStatus ?? {});
const countOf = (status: keyof typeof byStatus.value): number => byStatus.value[status] ?? 0;
// Still moving: in the pipeline and not yet received.
const activeCount = computed(() =>
  FULFILLMENT_STAGES.filter((stage) => stageIndex(stage) < stageIndex('RECEIVED')).reduce(
    (sum, stage) => sum + countOf(stage),
    0,
  ),
);

// Design v8 bar colours: the two approval steps orange, warehouse and road blue, done green,
// rejected/cancelled grey.
const STAGE_COLORS: Record<FulfillmentStage, string> = {
  SUBMITTED: 'var(--acc)',
  MANAGER_APPROVED: 'var(--acc)',
  ACCOUNTING_CLEARED: 'var(--blue)',
  RELEASED: 'var(--blue)',
  DELIVERED: 'var(--green)',
  RECEIVED: 'var(--green)',
};

interface StageRow {
  readonly stage: StageFilter;
  readonly label: string;
  readonly count: number;
  readonly color: string;
}

const rows = computed<StageRow[]>(() => {
  const stages: StageRow[] = FULFILLMENT_STAGES.map((stage) => ({
    stage,
    label: t(`orders.stages.${stage}`),
    count: countOf(stage),
    color: STAGE_COLORS[stage],
  }));
  const closed = countOf('REJECTED') + countOf('CANCELLED');
  return [
    ...stages,
    { stage: 'CLOSED', label: t('orders.filters.closed'), count: closed, color: 'var(--t3)' },
  ];
});

// Bars are relative to the busiest row, like the design; 1 keeps an all-zero list drawable.
const widest = computed(() => Math.max(1, ...rows.value.map((row) => row.count)));
const width = (count: number): string => `${Math.round((count / widest.value) * 100)}%`;

function open(stage: StageFilter): void {
  void router.push({ name: 'staff-orders', query: { stage } });
}
</script>

<template>
  <section class="dist" :aria-label="t('dashboard.stages.title')">
    <header class="dist__head">
      <h2 class="dist__title">{{ t('dashboard.stages.title') }}</h2>
      <span class="dist__active">
        {{ t('dashboard.stages.active', { count: activeCount }, activeCount) }}
      </span>
    </header>

    <ul class="dist__list">
      <li v-for="row in rows" :key="row.stage">
        <button type="button" class="dist__row" @click="open(row.stage)">
          <span class="dist__label">{{ row.label }}</span>
          <span class="dist__track" aria-hidden="true">
            <span class="dist__fill" :style="{ width: width(row.count), background: row.color }" />
          </span>
          <b class="dist__count num">{{ row.count }}</b>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.dist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.dist__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dist__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.dist__active {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.dist__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dist__row {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr) 28px;
  align-items: center;
  gap: 12px;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  text-align: left;
  cursor: pointer;
}

.dist__row:hover {
  background: var(--hov);
}

.dist__row:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.dist__label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.dist__track {
  height: 8px;
  overflow: hidden;
  border-radius: var(--r-kbd);
  background: var(--ef);
}

.dist__fill {
  display: block;
  height: 100%;
  border-radius: var(--r-kbd);
  transition: width 0.45s var(--ease);
}

.dist__count {
  font-weight: 400;
  text-align: right;
}

@media (pointer: coarse), (hover: none) {
  .dist__row {
    min-height: 44px;
  }
}
</style>
