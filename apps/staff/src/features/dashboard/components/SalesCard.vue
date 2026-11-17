<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppSegmented from '@/components/ui/AppSegmented.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import { averageMoney, sumMoney } from '@core/lib/money';
import type { SalesPeriod } from '../api/dashboard-api';
import { bucketLabel, buildSalesChart } from '../domain/sales-chart';

const { t } = useI18n();
const { dashboardApi, clock } = useServices();
const { formatMoney, formatMillions, formatPercentChange } = useFormat();

const period = ref<'7' | '30'>('7');
const asNumber = (value: '7' | '30'): SalesPeriod => (value === '7' ? 7 : 30);

const view = useAsyncView(() => dashboardApi.getSalesStats(asNumber(period.value)), {
  isEmpty: () => false,
});
// A period change keeps the previous chart on screen until the new data arrives, so the dots can
// slide to their new places (v1 transitions top/left over .45s) instead of the card flashing.
const lastStats = ref(view.data.value);
watch(
  () => view.data.value,
  (stats) => {
    if (stats) lastStats.value = stats;
  },
);
watch(period, () => void view.reload());

const stats = computed(() => lastStats.value);
const total = computed(() => sumMoney(stats.value?.buckets.map((b) => b.total) ?? []));
const change = computed(() =>
  stats.value ? formatPercentChange(total.value, stats.value.previousTotal) : null,
);
const average = computed(() =>
  stats.value && stats.value.orderCount > 0
    ? formatMillions(
        averageMoney(total.value, stats.value.orderCount),
        t('dashboard.sales.averageUnit'),
      )
    : '—',
);
const chart = computed(() =>
  buildSalesChart(stats.value?.buckets ?? [], (index) => {
    const bucket = stats.value?.buckets[index];
    return bucket ? bucketLabel(bucket, clock, t('dashboard.sales.today')) : '';
  }),
);

const options = computed(() => [
  { value: '7' as const, label: t('dashboard.sales.period7') },
  { value: '30' as const, label: t('dashboard.sales.period30') },
]);

// The dot of the last bucket is the filled, larger one; hovering any dot shows `label: amount`.
const tip = (label: string, amount: string): string =>
  `${label}: ${formatMoney(amount)} ${t('common.currency')}`;
</script>

<template>
  <section class="sales" :aria-label="t('dashboard.sales.title')">
    <header class="sales__head">
      <h2 class="sales__title">{{ t('dashboard.sales.title') }}</h2>
      <AppSegmented
        v-model="period"
        size="sm"
        track="e8"
        :options="options"
        :label="t('dashboard.sales.period')"
      />
    </header>

    <StateView
      :state="stats ? 'ready' : view.state.value"
      :description="undefined"
      @retry="view.reload"
    >
      <div class="sales__figures">
        <span class="sales__caption">{{ t('dashboard.sales.total') }}</span>
        <div class="sales__total">
          <span class="sales__amount num">{{ formatMoney(total) }}</span>
          <span class="sales__unit">{{ t('common.currency') }}</span>
          <AppBadge v-if="change" :tone="change.positive ? 'success' : 'danger'">
            {{ change.text }}
          </AppBadge>
        </div>
        <span class="sales__vs">{{ t(`dashboard.sales.vsPrevious${period}`) }}</span>
      </div>

      <div class="plot">
        <div class="plot__box" role="img" :aria-label="t('dashboard.sales.chartLabel')">
          <span class="plot__rule plot__rule--top" />
          <span class="plot__rule plot__rule--mid" />
          <span class="plot__rule plot__rule--base" />
          <svg
            viewBox="0 0 300 100"
            preserveAspectRatio="none"
            class="plot__svg"
            aria-hidden="true"
          >
            <polygon :points="chart.area" class="plot__area" />
            <polyline :points="chart.line" class="plot__line" />
          </svg>
          <span
            v-for="(dot, index) in chart.dots"
            :key="index"
            class="dot"
            :class="{ 'dot--last': dot.isLast }"
            :style="{ left: `${dot.xPercent}%`, top: `${dot.yPercent}%` }"
            :title="tip(dot.label, dot.total)"
          />
        </div>
        <div class="plot__labels" aria-hidden="true">
          <span v-for="(dot, index) in chart.dots" :key="index">{{ dot.label }}</span>
        </div>
        <!-- The chart is a picture; the same numbers are available as a list for assistive tech. -->
        <ul class="sr-only">
          <li v-for="(dot, index) in chart.dots" :key="index">{{ tip(dot.label, dot.total) }}</li>
        </ul>
      </div>

      <div class="mini">
        <div class="mini__tile">
          <span class="mini__label">{{ t('dashboard.sales.orders') }}</span>
          <b class="mini__value">{{
            t('dashboard.sales.ordersValue', { count: stats?.orderCount ?? 0 })
          }}</b>
        </div>
        <div class="mini__tile">
          <span class="mini__label">{{ t('dashboard.sales.average') }}</span>
          <b class="mini__value num">{{ average }}</b>
        </div>
      </div>
    </StateView>
  </section>
</template>

<style scoped>
.sales {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  min-width: 0;
}

.sales__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.sales__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.sales__figures {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sales__caption {
  font-size: var(--fs-small);
  color: var(--t2);
}

.sales__total {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
}

.sales__amount {
  font-size: 30px;
  font-weight: 400;
  line-height: 1.05;
}

.sales__unit {
  font-size: var(--fs-small);
  color: var(--t2);
}

.sales__vs {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.plot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 14px 10px;
  border-radius: var(--r-row);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.plot__box {
  position: relative;
  height: 120px;
}

.plot__rule {
  position: absolute;
  right: 0;
  left: 0;
  border-top: 1px dashed var(--e8);
}

.plot__rule--top {
  top: 0;
}

.plot__rule--mid {
  top: 50%;
}

.plot__rule--base {
  bottom: 0;
  border-top-style: solid;
}

.plot__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.plot__area {
  fill: var(--acc-bg);
}

.plot__line {
  fill: none;
  stroke: var(--acc);
  stroke-width: 2.5;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.dot {
  position: absolute;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border: 2px solid var(--acc);
  border-radius: 50%;
  background: var(--w);
  box-sizing: border-box;
  cursor: default;
  transition:
    top 0.45s var(--ease),
    left 0.45s var(--ease);
}

.dot--last {
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  background: var(--acc);
}

.plot__labels {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  font-size: 10px;
  color: var(--t2);
  white-space: nowrap;
}

.mini {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mini__tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px;
  border-radius: var(--r-row);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.mini__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.mini__value {
  font-size: 18px;
  font-weight: 400;
}
</style>
