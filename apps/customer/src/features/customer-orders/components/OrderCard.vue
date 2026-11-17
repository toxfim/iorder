<script setup lang="ts">
import GoodsIcon from '@/features/customer-goods/components/GoodsIcon.vue';
import type { CustomerOrderSummary } from '@iorder/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppBadge from '@core/components/ui/AppBadge.vue';
import { useFormat } from '@core/i18n/use-format';
import {
  PAYMENT_TONE,
  showsPaymentBadge,
  stateLabelKey,
  stateNoteKey,
  stateTone,
} from '../domain/order-display';

const props = defineProps<{ order: CustomerOrderSummary }>();
const { t } = useI18n();
const { formatMoneyWithCurrency, formatShortDateTime } = useFormat();
const noteKey = computed(() => stateNoteKey(props.order.status));
</script>

<template>
  <RouterLink
    :to="{ name: 'customer-order', params: { id: order.id } }"
    class="card"
    :aria-label="t('customer.orders.open', { number: order.orderNumber })"
  >
    <div class="card__top">
      <span class="card__number">{{ order.orderNumber }}</span>
      <span class="card__date">{{ formatShortDateTime(order.submittedAt) }}</span>
    </div>
    <div class="card__badges">
      <!-- One of the three customer states, in words: the colour only repeats it. -->
      <AppBadge :tone="stateTone(order.status)" data-testid="order-state">{{
        t(stateLabelKey(order.status))
      }}</AppBadge>
      <AppBadge v-if="showsPaymentBadge(order)" :tone="PAYMENT_TONE[order.paymentStatus]">
        {{ t(`customer.orders.payment.${order.paymentStatus}`) }}
      </AppBadge>
      <span class="card__open" aria-hidden="true">{{ '↗' }}</span>
      <span v-if="noteKey" class="card__note" data-testid="order-state-note">{{ t(noteKey) }}</span>
    </div>
    <div class="card__bottom">
      <span class="card__by sr-only">
        {{ t('customer.orders.placedBy') }}:
        {{ order.placedByMe ? t('customer.orders.you') : order.placedByName }}
      </span>
      <span class="card__count">{{
        t('customer.orders.positions', { count: order.itemCount })
      }}</span>
      <span class="card__sum">
        {{ formatMoneyWithCurrency(order.totalAmount) }}
      </span>
    </div>
    <GoodsIcon class="card__desktop-open" name="right" />
  </RouterLink>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--e8);
  border-radius: var(--r-panel);
  background: var(--w);
  color: var(--ink);
}

.card:hover {
  border-color: var(--d9);
}

.card:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.card:active {
  border-color: var(--ink);
}

.card__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.card__number {
  font-family: var(--font-mono);
  font-size: var(--fs-body-lg);
  font-weight: 500;
}

.card__date {
  font-size: var(--fs-small);
  color: var(--t3);
}

.card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.card__open {
  margin-left: auto;
  color: var(--t3);
}
/* Under the badges, the full width of the row: whether the receipt is confirmed yet. */
.card__note {
  flex-basis: 100%;
  font-size: var(--fs-meta);
  color: var(--t3);
}
.card__count {
  color: var(--t3);
}

.card__bottom {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px 12px;
  font-size: var(--fs-body);
}

.card__by {
  color: var(--t3);
}

.card__sum {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.card__desktop-open {
  display: none;
}
@media (min-width: 960px) {
  .card {
    display: grid;
    grid-template-columns:
      minmax(90px, 0.8fr) minmax(125px, 1fr) minmax(160px, 1.3fr) minmax(85px, 0.7fr)
      minmax(130px, 1.1fr) 20px;
    align-items: center;
    gap: var(--gap-card);
    padding: var(--goods-pad);
    border: 0;
    border-top: 1px solid var(--e8);
    border-radius: 0;
  }
  .card__top,
  .card__bottom {
    display: contents;
  }
  .card__number {
    grid-column: 1;
    grid-row: 1;
  }
  .card__date {
    grid-column: 2;
    grid-row: 1;
  }
  .card__badges {
    grid-column: 3;
    grid-row: 1;
  }
  .card__badges .card__open {
    display: none;
  }
  .card__count {
    grid-column: 4;
    grid-row: 1;
  }
  .card__sum {
    grid-column: 5;
    grid-row: 1;
    text-align: end;
  }
  .card__desktop-open {
    display: block;
    grid-column: 6;
    grid-row: 1;
  }
}
</style>
