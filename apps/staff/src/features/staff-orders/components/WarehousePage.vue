<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import StateView from '@core/components/ui/StateView.vue';
import { compareOldestFirst, type OrderSummary } from '../domain/order-model';
import { WAREHOUSE_SCOPE } from '../domain/order-scopes';
import DashboardSummaryPanel from './DashboardSummaryPanel.vue';
import OrdersTruncatedNote from './OrdersTruncatedNote.vue';
import QueueOrderCard from './QueueOrderCard.vue';

const { t } = useI18n();
const { ordersStore } = useServices();

// Server-filtered: this role never downloads the whole history.
onMounted(() => void ordersStore.loadFor(WAREHOUSE_SCOPE));

// W1, oldest first. The api sends the warehouse only orders from MANAGER_APPROVED on, with no
// prices, totals or payment ([C] 2026-10-30): it prepares and scans right after the approval, the
// release waits for accounting.
const sorted = (keep: (order: OrderSummary) => boolean): OrderSummary[] =>
  ordersStore.orders.value.filter(keep).sort(compareOldestFirst);
const ready = computed(() => sorted((order) => order.status === 'ACCOUNTING_CLEARED'));
const preparing = computed(() => sorted((order) => order.status === 'MANAGER_APPROVED'));
const toReturn = computed(() => sorted((order) => order.goodsReturn === 'PENDING'));
// Newest first, unlike the queues: nothing waits in this list, it is for looking an order up.
const closed = computed(() =>
  sorted(
    (order) =>
      (order.status === 'CANCELLED' || order.status === 'REJECTED') &&
      order.goodsReturn !== 'PENDING',
  ).reverse(),
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
        <h1 class="head__title">{{ t('orders.warehouse.title') }}</h1>
      </header>

      <section class="block" :aria-label="t('orders.warehouse.ready.title')">
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.warehouse.ready.title') }}</h2>
          <span class="block__count">{{ ready.length }}</span>
        </div>
        <p class="block__info">{{ t('orders.warehouse.ready.info') }}</p>
        <QueueOrderCard v-for="order in ready" :key="order.id" :order="order" />
        <p v-if="ready.length === 0" class="empty" role="status">
          {{ t('orders.warehouse.ready.empty') }}
        </p>
      </section>

      <section class="block" :aria-label="t('orders.warehouse.prepare.title')">
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.warehouse.prepare.title') }}</h2>
          <span class="block__count">{{ preparing.length }}</span>
        </div>
        <p class="block__info">{{ t('orders.warehouse.prepare.info') }}</p>
        <QueueOrderCard v-for="order in preparing" :key="order.id" :order="order" />
        <p v-if="preparing.length === 0" class="empty" role="status">
          {{ t('orders.warehouse.prepare.empty') }}
        </p>
      </section>

      <section
        v-if="toReturn.length > 0"
        class="block"
        :aria-label="t('orders.warehouse.toReturn.title')"
      >
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.warehouse.toReturn.title') }}</h2>
          <span class="block__count">{{ toReturn.length }}</span>
        </div>
        <p class="block__info">{{ t('orders.warehouse.toReturn.info') }}</p>
        <QueueOrderCard v-for="order in toReturn" :key="order.id" :order="order" />
      </section>

      <section
        v-if="closed.length > 0"
        class="block"
        :aria-label="t('orders.warehouse.closed.title')"
      >
        <div class="block__head">
          <h2 class="block__title">{{ t('orders.warehouse.closed.title') }}</h2>
          <span class="block__count">{{ closed.length }}</span>
        </div>
        <p class="block__info">{{ t('orders.warehouse.closed.info') }}</p>
        <QueueOrderCard v-for="order in closed" :key="order.id" :order="order" read-only />
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
