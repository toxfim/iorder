<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import StateView from '@core/components/ui/StateView.vue';
import {
  compareNewestFirst,
  compareOldestFirst,
  isFullSummary,
  isSkippedByManager,
  stageIndex,
} from '../domain/order-model';
import { ACCOUNTANT_SCOPE } from '../domain/order-scopes';
import DashboardSummaryPanel from './DashboardSummaryPanel.vue';
import OrdersTruncatedNote from './OrdersTruncatedNote.vue';
import QueueOrderCard from './QueueOrderCard.vue';

const { t } = useI18n();
const { ordersStore } = useServices();

// Server-filtered: this role never downloads the whole history.
onMounted(() => void ordersStore.loadFor(ACCOUNTANT_SCOPE));

// A1: the orders the manager approved that wait for the accountant, oldest first. The accountant
// sees prices and totals but no phone numbers (the api sends none).
const queue = computed(() =>
  ordersStore.orders.value
    .filter(isFullSummary)
    .filter((order) => order.status === 'MANAGER_APPROVED')
    .sort(compareOldestFirst),
);

// The manager may pass an order without the accountant (lifecycle 3.1). The accountant still sees
// it as a new order, for information: the newest first, not yet received, never closed ones.
const SKIPPED_LIMIT = 20;
const skipped = computed(() =>
  ordersStore.orders.value
    .filter(isFullSummary)
    .filter(isSkippedByManager)
    .filter((order) => stageIndex(order.status) >= 2 && order.status !== 'RECEIVED')
    .sort(compareNewestFirst)
    .slice(0, SKIPPED_LIMIT),
);

const pageState = computed(() =>
  ordersStore.state.value === 'empty' ? 'ready' : ordersStore.state.value,
);
</script>

<template>
  <StateView :state="pageState" @retry="ordersStore.load()">
    <div class="page">
      <OrdersTruncatedNote />
      <DashboardSummaryPanel />
      <header class="head">
        <h1 class="head__title">{{ t('orders.accounting.title') }}</h1>
      </header>

      <section class="block" :aria-label="t('orders.accounting.queue.title')">
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.accounting.queue.title') }}</h2>
          <span class="block__count">{{ queue.length }}</span>
        </div>
        <p class="block__info">{{ t('orders.accounting.queue.info') }}</p>
        <QueueOrderCard v-for="order in queue" :key="order.id" :order="order" sale-facts />
        <p v-if="queue.length === 0" class="empty" role="status">
          {{ t('orders.accounting.queue.empty') }}
        </p>
      </section>

      <section class="block" :aria-label="t('orders.accounting.skipped.title')">
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.accounting.skipped.title') }}</h2>
          <span class="block__count">{{ skipped.length }}</span>
        </div>
        <p class="block__info">{{ t('orders.accounting.skipped.info') }}</p>
        <QueueOrderCard
          v-for="order in skipped"
          :key="order.id"
          :order="order"
          :skipped-note="`${t('orders.accounting.skipped.badge')} · ${t('orders.accounting.skipped.note')}`"
          read-only
          sale-facts
        />
        <p v-if="skipped.length === 0" class="empty" role="status">
          {{ t('orders.accounting.skipped.empty') }}
        </p>
      </section>
    </div>
  </StateView>
</template>

<style scoped>
/* The role queues are not drawn in v8; they use the v8 list language: a 28px regular title, 15px
   section heads with a count chip, white hairline cards and the list's empty card. */
.page {
  display: flex;
  flex-direction: column;
  gap: var(--gap-block);
  animation: viewIn 0.35s var(--ease) both;
}

.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.block__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.block__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.block__count {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  font-size: var(--fs-group);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--acc-fg);
}

.block__info {
  margin: -6px 0 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.empty {
  margin: 0;
  padding: 40px 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  text-align: center;
  font-size: var(--fs-small);
  color: var(--t2);
}
</style>
