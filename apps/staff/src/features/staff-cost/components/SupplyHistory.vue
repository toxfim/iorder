<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppCard from '@/components/ui/AppCard.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { useCostFormat } from '../composables/use-cost-format';
import { toSupplyLines } from '../domain/cost-view';

// "Postavka tarixi": the full delivery history of one product, at the END of the side panel.
const props = defineProps<{ productId: string }>();

const { t } = useI18n();
const { costApi } = useServices();
const { formatUsd, formatUzsWithCurrency, formatRate, formatQuantity, formatDate } =
  useCostFormat();

// Mounted by the panel only while it is open, so every opening reads fresh history.
const view = useAsyncView(() => costApi.getProductCostReference(props.productId), {
  isEmpty: (reference) => reference.deliveries.length === 0,
});

const lines = computed(() => toSupplyLines(view.data.value?.deliveries ?? []));
const errorText = computed(() =>
  translateDescribed(t, describePricingError('load', view.error.value)),
);
</script>

<template>
  <!-- A v8 card: the title as its header, one hairline-ruled row per delivery. -->
  <AppCard
    class="supply"
    :title="t('staffCost.supply.title')"
    :aria-label="t('staffCost.supply.title')"
  >
    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('staffCost.supply.empty') : undefined"
      :description="view.state.value === 'error' ? errorText : undefined"
      @retry="view.reload"
    >
      <ol class="supply__list">
        <li v-for="line in lines" :key="line.ref + line.date" class="line">
          <div class="line__head">
            <span class="mono line__ref">{{ line.ref }}</span>
            <span class="line__date">{{ formatDate(line.date) }}</span>
          </div>
          <dl class="line__facts">
            <div>
              <dt>{{ t('staffCost.supply.delivered') }}</dt>
              <dd class="num">{{ formatQuantity(line.delivered) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.available') }}</dt>
              <dd class="num">{{ formatQuantity(line.available) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.usd') }}</dt>
              <dd class="num">{{ formatUsd(line.usd) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.rate') }}</dt>
              <dd class="num">{{ formatRate(line.rate) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.uzs') }}</dt>
              <dd class="num">{{ formatUzsWithCurrency(line.uzs) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.supplier') }}</dt>
              <dd>{{ line.supplier }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.method') }}</dt>
              <dd>{{ line.method }}</dd>
            </div>
            <div v-if="line.category !== ''">
              <dt>{{ t('staffCost.supply.category') }}</dt>
              <dd>{{ line.category }}</dd>
            </div>
          </dl>
        </li>
      </ol>
    </StateView>
  </AppCard>
</template>

<style scoped>
.supply__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.line {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
}

.line__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.line__ref {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.line__date {
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.line__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px 12px;
  margin: 0;
}

.line__facts dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.line__facts dd {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

/* Empty, error and loading states sit inside the card: a smaller margin than on a page. */
.supply :deep(.state) {
  margin: 24px auto 28px;
  padding: 0 20px;
}
</style>
