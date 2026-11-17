<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import { compareMoney } from '@core/lib/money';
import { useCustomerServices } from '@/features/customer-app/services';

// "Amount to pay" for the person's own organization ([C] 2026-10-26). The figure is the server's;
// the card only shows it, with a calm message when nothing is owed.
const { t } = useI18n();
const { balanceApi } = useCustomerServices();
const { formatMoneyWithCurrency } = useFormat();

const view = useAsyncView(() => balanceApi.getBalance(), { isEmpty: () => false });
const amountDue = computed(() => view.data.value?.amountDue ?? null);
const owes = computed(() => amountDue.value !== null && compareMoney(amountDue.value, '0') > 0);
</script>

<template>
  <section
    class="amount"
    :class="{ 'amount--clear': view.state.value === 'ready' && !owes }"
    :aria-label="t('customer.balance.title')"
    :aria-busy="view.state.value === 'loading' || undefined"
    data-testid="amount-to-pay"
  >
    <p class="amount__label">{{ t('customer.balance.title') }}</p>
    <p v-if="view.state.value === 'loading'" class="amount__muted" role="status">
      {{ t('state.loading') }}
    </p>
    <div v-else-if="view.state.value === 'ready' && amountDue !== null" class="amount__body">
      <strong v-if="owes" class="amount__value" data-testid="amount-due">{{
        formatMoneyWithCurrency(amountDue)
      }}</strong>
      <strong v-else class="amount__clear" data-testid="nothing-due">{{
        t('customer.balance.nothingDue')
      }}</strong>
      <p v-if="owes" class="amount__muted">{{ t('customer.balance.hint') }}</p>
    </div>
    <div v-else class="amount__error" role="alert">
      <span>{{ t('customer.balance.error') }}</span>
      <button type="button" class="amount__retry" @click="view.reload()">
        {{ t('state.retry') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.amount {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 18px;
  border-radius: var(--r-card);
  background: var(--w);
  color: var(--ink);
}
.amount--clear {
  background: var(--acc-bg);
}
.amount__label {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t3);
}
.amount__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.amount__value {
  font-size: var(--fs-amount);
  font-weight: 700;
  overflow-wrap: anywhere;
}
.amount__clear {
  font-size: var(--fs-body);
  font-weight: 600;
}
.amount__muted {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}
.amount__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-small);
  color: var(--t2);
}
.amount__retry {
  min-height: var(--tap-min);
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-small);
  font-weight: 600;
  cursor: pointer;
}
</style>
