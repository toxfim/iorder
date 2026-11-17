<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import type { StockLevel } from '../domain/decimal';
import { useCostFormat } from '../composables/use-cost-format';

// v1: a 7px dot (green / amber below 20 / red at zero) and the quantity. The colour is never the
// only signal: the level is also spoken. With `unit` (the v8 Qoldiq table) the amount reads
// "36 dona" and zero reads the red "Tugagan" instead of a bare 0.
withDefaults(defineProps<{ quantity: string | null; level: StockLevel; unit?: string | null }>(), {
  unit: undefined,
});

const { t } = useI18n();
const { formatQuantity } = useCostFormat();
const { formatUnit } = useFormat();
</script>

<template>
  <span class="stock-cell num">
    <span class="stock-cell__dot" :class="`stock-cell__dot--${level}`" aria-hidden="true" />
    <span
      v-if="quantity !== null && unit !== undefined && level === 'out'"
      class="stock-cell__value stock-cell__value--out"
      aria-hidden="true"
      >{{ t('staffCost.stock.out') }}</span
    >
    <span v-else-if="quantity !== null" class="stock-cell__value">{{
      unit ? `${formatQuantity(quantity)} ${formatUnit(unit)}` : formatQuantity(quantity)
    }}</span>
    <span v-else class="stock-cell__value stock-cell__value--none" aria-hidden="true">—</span>
    <span class="sr-only">{{ t(`staffCost.stockLevel.${level}`) }}</span>
  </span>
</template>

<style scoped>
.stock-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body);
  font-weight: 600;
}

.stock-cell__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 4px;
  background: var(--b5);
}

.stock-cell__dot--ok {
  background: var(--green);
}

.stock-cell__dot--low {
  background: var(--warn);
}

.stock-cell__dot--out {
  background: var(--red);
}

.stock-cell__value--out {
  color: var(--red);
}

.stock-cell__value--none {
  color: var(--t3);
  font-weight: 400;
}
</style>
