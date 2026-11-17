<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import StateView from '@core/components/ui/StateView.vue';
import { compareNewestFirst, compareOldestFirst } from '../domain/order-model';
import { DRIVER_SCOPE } from '../domain/order-scopes';
import DashboardSummaryPanel from './DashboardSummaryPanel.vue';
import OrdersTruncatedNote from './OrdersTruncatedNote.vue';
import QueueOrderCard from './QueueOrderCard.vue';

const { t } = useI18n();
const { ordersStore } = useServices();

// Server-filtered: this role never downloads the whole history.
onMounted(() => void ordersStore.loadFor(DRIVER_SCOPE));

// D1: the orders assigned to this driver (the api sends no others). Mobile first: big buttons,
// the phone numbers of the people to call, no prices, totals or payment.
const mine = computed(() =>
  ordersStore.orders.value.filter((order) => order.status === 'RELEASED').sort(compareOldestFirst),
);

const DONE_LIMIT = 10;
const done = computed(() =>
  ordersStore.orders.value
    .filter((order) => order.status === 'DELIVERED' || order.status === 'RECEIVED')
    .sort(compareNewestFirst)
    .slice(0, DONE_LIMIT),
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
        <h1 class="head__title">{{ t('orders.driver.title') }}</h1>
      </header>

      <section class="block" :aria-label="t('orders.driver.mine.title')">
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.driver.mine.title') }}</h2>
          <span class="block__count">{{ mine.length }}</span>
        </div>
        <QueueOrderCard v-for="order in mine" :key="order.id" :order="order" large />
        <p v-if="mine.length === 0" class="empty" role="status">
          {{ t('orders.driver.mine.empty') }}
        </p>
      </section>

      <section class="block" :aria-label="t('orders.driver.done.title')">
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.driver.done.title') }}</h2>
          <span class="block__count">{{ done.length }}</span>
        </div>
        <QueueOrderCard v-for="order in done" :key="order.id" :order="order" read-only />
        <p v-if="done.length === 0" class="empty" role="status">
          {{ t('orders.driver.done.empty') }}
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
