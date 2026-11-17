<script setup lang="ts">
import type { CustomerOrderSummary } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import { stateHintKey, stateLabelKey } from '@/features/customer-orders/domain/order-display';

// The active order as one line to its page (design "2a"): a dark card on a phone, a white bar on
// a tablet, a chip in the heading on a desktop. The same DOM, the page's grid moves it.
defineProps<{ order: CustomerOrderSummary }>();
const { t } = useI18n();
</script>

<template>
  <RouterLink
    :to="{ name: 'customer-order', params: { id: order.id } }"
    class="active-order"
    :aria-label="
      t('customer.home.activeOrderLabel', {
        number: order.orderNumber,
        state: t(stateLabelKey(order.status)),
      })
    "
    data-testid="home-active-order"
  >
    <svg
      class="active-order__icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 7h11v9H2zM13 10h4l3 3v3h-7" />
      <circle cx="6" cy="17.5" r="1.8" />
      <circle cx="16.5" cy="17.5" r="1.8" />
    </svg>
    <span class="active-order__text">
      <span class="active-order__line">
        <strong>{{ order.orderNumber }}</strong>
        <span aria-hidden="true">{{ '·' }}</span>
        <span data-testid="home-order-state">{{ t(stateLabelKey(order.status)) }}</span>
      </span>
      <span class="active-order__hint" data-testid="home-order-hint">
        {{ t(stateHintKey(order.status)) }}
      </span>
    </span>
    <span class="active-order__track"
      >{{ t('customer.home.track') }} <span aria-hidden="true">{{ '↗' }}</span></span
    >
  </RouterLink>
</template>

<style scoped>
.active-order {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: var(--tap-min);
  padding: 14px 16px;
  border-radius: var(--r-panel);
  background: var(--hero-bg);
  color: var(--hero-fg);
}
.active-order__icon {
  flex: none;
  color: var(--acc-on-dark);
}
.active-order__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.active-order__line {
  display: flex;
  gap: 6px;
  font-size: var(--fs-body);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.active-order__hint {
  font-size: var(--fs-group);
  color: var(--hero-muted);
}
.active-order__track {
  flex: none;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--acc-on-dark);
}

@media (min-width: 640px) {
  .active-order {
    padding: 12px 16px;
    background: var(--w);
    color: var(--ink);
  }
  .active-order__hint {
    color: var(--t3);
  }
  .active-order__icon,
  .active-order__track {
    color: var(--acc-fg);
  }
}

@media (min-width: 960px) {
  .active-order {
    gap: 8px;
    min-height: var(--tap-min);
    padding: 0 14px;
    border-radius: var(--r-input);
    font-size: var(--fs-small);
  }
  .active-order__icon {
    width: 20px;
    height: 20px;
  }
  .active-order__line {
    font-size: var(--fs-small);
  }
  .active-order__hint,
  .active-order__track {
    display: none;
  }
}
</style>
