<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCustomerServices } from '@/features/customer-app/services';
import { useFormat } from '@core/i18n/use-format';
import { planTotal } from '../domain/payment-plan';

// A bar fixed above the bottom menu on the price list: how many positions are in the cart and the
// total the SERVER computed, with a way to the cart. Hidden while the cart is empty or unknown.
// The figure always names its plan, so it can never read as what will be charged when it is not:
// the chosen plan's total, otherwise "if paid in full" [P].
const { t } = useI18n();
const { cart } = useCustomerServices();
const { formatMoneyWithCurrency } = useFormat();

const visible = computed(() => cart.itemCount.value > 0 && cart.cart.value !== null);
const chosen = computed(() =>
  cart.cart.value === null ? null : planTotal(cart.cart.value, cart.paymentPlan.value),
);
const label = computed(() =>
  chosen.value !== null && cart.paymentPlan.value !== null
    ? t(`customer.plan.${cart.paymentPlan.value}`)
    : t('customer.catalog.cartBar.ifFull'),
);
const amount = computed(() => chosen.value ?? cart.cart.value?.totalAmount ?? '0');
</script>

<template>
  <aside v-if="visible" class="bar" :aria-label="t('customer.catalog.cartBar.label')">
    <RouterLink :to="{ name: 'customer-cart' }" class="bar__link">
      <span class="bar__info">
        <span class="bar__count">
          {{ t('customer.cart.positionsCount', { count: cart.itemCount.value }) }}
        </span>
        <span class="bar__plan" data-testid="bar-plan">{{ label }}</span>
        <strong class="bar__total" data-testid="bar-total">
          {{ formatMoneyWithCurrency(amount) }}
        </strong>
      </span>
      <span class="bar__open">{{ t('customer.catalog.cartBar.open') }}</span>
    </RouterLink>
  </aside>
</template>

<style scoped>
.bar {
  position: fixed;
  right: 0;
  bottom: var(--customer-bottom-h, 0px);
  left: 0;
  z-index: var(--z-sticky);
  display: flex;
  justify-content: center;
  padding: 8px 12px;
  /* Lets taps through the empty sides on a wide screen. */
  pointer-events: none;
}

.bar__link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  max-width: 720px;
  min-height: 52px;
  padding: 6px 8px 6px 16px;
  border-radius: var(--r-panel);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
  box-shadow: var(--sh-dropdown);
  pointer-events: auto;
}

.bar__link:focus-visible {
  /* The bar itself is an ink fill, so an ink ring would be invisible. */
  outline: 2px solid var(--btn-ink-fg);
  outline-offset: 3px;
}

.bar__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bar__count {
  font-size: var(--fs-meta);
  color: var(--btn-ink-muted);
}

.bar__plan {
  font-size: var(--fs-meta);
  font-weight: 600;
}

.bar__total {
  font-size: var(--fs-body-lg);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bar__open {
  display: inline-flex;
  flex: none;
  align-items: center;
  min-height: 40px;
  padding: 0 16px;
  border-radius: var(--r-input);
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-body);
  font-weight: 600;
}
</style>
