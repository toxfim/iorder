<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';

// [C] owner 2026-10-30: a cash sale has no invoice, and the accountant must not miss that. It never
// blocks anything: the accountant still approves the order.
defineProps<{ total: string }>();

const { t } = useI18n();
const { formatMoney } = useFormat();
</script>

<template>
  <p class="warning" role="note" data-testid="cash-sale-warning">
    <b class="warning__title">{{ t('orders.supplies.cashTitle') }}</b>
    <span>{{ t('orders.supplies.cashBody') }}</span>
    <span class="num warning__total">
      {{ t('orders.detail.items.total') }}: {{ formatMoney(total) }} {{ t('common.currency') }}
    </span>
  </p>
</template>

<style scoped>
.warning {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  font-size: var(--fs-small);
  color: var(--ink);
}

.warning__title {
  font-weight: 600;
  color: var(--acc-fg);
}

.warning__total {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
