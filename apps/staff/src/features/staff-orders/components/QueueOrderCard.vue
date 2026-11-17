<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppBadge from '@core/components/ui/AppBadge.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useServices } from '@/app/services';
import { useFormat } from '@core/i18n/use-format';
import { useOrderAge } from '../composables/use-order-age';
import { useOrderDetail } from '../composables/use-order-detail';
import { isFullSummary, totalOf, type OrderSummary } from '../domain/order-model';
import { paymentTone, stageTone } from '../domain/order-presentation';
import CashSaleWarning from './CashSaleWarning.vue';
import DeliveryContactCard from './DeliveryContactCard.vue';
import OrderActionsPanel from './OrderActionsPanel.vue';
import OrderAllocationsTable from './OrderAllocationsTable.vue';

const props = defineProps<{
  order: OrderSummary;
  /** Bigger buttons for the driver's phone. */
  large?: boolean;
  /** Mark an order the manager passed without the accountant (informational list). */
  skippedNote?: string;
  /** Hide the actions: the card only informs (the accountant's "passed without you" list). */
  readOnly?: boolean;
  /** The accountant's queue: Savdo turi, To'lov turi and the cash warning, without opening the card. */
  saleFacts?: boolean;
}>();

const { t } = useI18n();
const { formatMoney, formatShortDateTime } = useFormat();
const { clock } = useServices();
const { ageText } = useOrderAge(clock);
const waiting = computed(() => ageText(props.order));

// The driver's cards (large) start open: the delivered button and the phone to call are what the
// driver came for, and a tap more is a tap too many on a phone in the street.
const open = ref(props.large === true);
const bodyId = useId();

// The order is read when the card is first opened (a queue can hold dozens of orders), and again
// after an action or a stale row version so the next click uses the version the server has now.
const detail = useOrderDetail(() => props.order.id, { timeline: false });
const opened = ref(false);
watch(
  open,
  (value) => {
    if (value && !opened.value) {
      opened.value = true;
      void detail.load();
    }
  },
  { immediate: true },
);
// The list entry changed under an open card (another action or a refresh): re-read the detail.
watch(
  () => props.order.rowVersion,
  () => {
    if (opened.value) void detail.load({ silent: true });
  },
);

const total = computed(() => totalOf(props.order));
const sale = computed(() =>
  props.saleFacts === true && isFullSummary(props.order) ? props.order : null,
);
const reload = (): void => void detail.load({ silent: true });
const items = computed(() => detail.order.value?.items ?? []);
</script>

<template>
  <article class="card" :class="{ 'card--open': open }">
    <div class="card__head">
      <div class="card__main">
        <span class="card__org">{{ order.organizationName }}</span>
        <span class="card__meta">
          <span class="mono card__number">{{ order.orderNumber }}</span>
          · {{ formatShortDateTime(order.submittedAt) }} ·
          {{ t('orders.queue.positions', { count: order.itemCount }, order.itemCount) }}
        </span>
        <span v-if="waiting" class="card__wait" :title="t('table.sinceSubmitted')">{{
          t('table.orderAge', { age: waiting })
        }}</span>
        <span v-if="skippedNote" class="card__note">{{ skippedNote }}</span>
      </div>
      <div class="card__side">
        <div class="card__badges">
          <AppBadge :tone="stageTone(order.status)" dot>{{
            t(`orders.stages.${order.status}`)
          }}</AppBadge>
          <AppBadge v-if="isFullSummary(order)" :tone="paymentTone(order.paymentStatus)" dot>
            {{ t(`orders.payment.${order.paymentStatus}`) }}
          </AppBadge>
          <!-- Manager and accountant only: the server leaves the field out for everyone else. -->
          <AppBadge v-if="isFullSummary(order) && order.paymentMethod" tone="neutral">
            {{ t(`orders.paymentMethod.${order.paymentMethod}`) }}
          </AppBadge>
        </div>
        <b v-if="total !== null" class="card__total num">
          {{ formatMoney(total) }} {{ t('common.currency') }}
        </b>
      </div>
      <div class="card__buttons">
        <button
          type="button"
          class="btn"
          :aria-expanded="open"
          :aria-controls="bodyId"
          @click="open = !open"
        >
          {{ open ? t('orders.queue.hideDetails') : t('orders.queue.details') }}
          <StaffIcon name="down" :size="13" class="btn__chevron" />
        </button>
        <!-- One button on a closed card: the full page is offered once the card is open (F-25). -->
        <RouterLink
          v-if="open"
          class="btn btn--link"
          :to="{ name: 'staff-order', params: { orderId: order.id } }"
          :aria-label="t('dashboard.queue.openLabel', { id: order.orderNumber })"
        >
          {{ t('orders.queue.open') }}
          <StaffIcon name="right" :size="13" />
        </RouterLink>
      </div>
    </div>

    <div v-if="sale" class="card__sale">
      <CashSaleWarning v-if="sale.paymentMethod === 'CASH'" :total="sale.totalAmount" />
      <dl class="sale" data-testid="sale-facts">
        <div v-if="sale.paymentMethod" class="sale__fact">
          <dt>{{ t('orders.paymentMethod.title') }}</dt>
          <dd>{{ t(`orders.paymentMethod.${sale.paymentMethod}`) }}</dd>
        </div>
        <div class="sale__fact">
          <dt>{{ t('orders.paymentPlan.title') }}</dt>
          <dd>{{ t(`orders.paymentPlan.${sale.paymentPlan}`) }}</dd>
        </div>
      </dl>
    </div>

    <div v-if="open" :id="bodyId" class="card__body">
      <p v-if="detail.state.value === 'loading'" class="muted" role="status">
        {{ t('state.loading') }}
      </p>
      <p v-else-if="detail.state.value === 'notFound'" class="muted" role="status">
        {{ t('orders.queue.detailGone') }}
      </p>
      <p v-else-if="detail.state.value === 'denied'" class="muted" role="alert">
        {{ t('state.denied.description') }}
      </p>
      <p v-else-if="detail.state.value === 'error'" class="muted" role="alert">
        {{ t('orders.queue.detailError') }}
        <button type="button" class="link" @click="detail.load()">{{ t('state.retry') }}</button>
      </p>
      <template v-else-if="detail.order.value">
        <OrderAllocationsTable
          :lines="items"
          :status="detail.order.value.status"
          :total="detail.order.value.detail === 'FULL' ? detail.order.value.totalAmount : null"
        />
        <div class="card__columns">
          <DeliveryContactCard
            v-if="detail.order.value.deliveryContact"
            :contact="detail.order.value.deliveryContact"
          />
          <div v-if="!readOnly" class="card__actions">
            <OrderActionsPanel
              :order="detail.order.value"
              :large="large"
              @changed="reload"
              @stale="reload"
            />
          </div>
        </div>
      </template>
    </div>
  </article>
</template>

<style scoped>
/* A queue entry in the v8 list language: a white hairline card; the number in orange like the
   list's first column; opening it shows the same item, contact and action cards as the order page. */
.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 16px 20px;
}

.card__main {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.card__org {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.card__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.card__number {
  font-weight: 500;
  color: var(--acc-fg);
}

.card__wait {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.card__note {
  align-self: flex-start;
  margin-top: 2px;
  padding: 3px 8px;
  border-radius: var(--r-pill);
  background: var(--acc-bg);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--acc-fg);
}

.card__side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.card__badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.card__total {
  font-size: var(--fs-body);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.card__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* The v8 secondary button: white with a hairline ring, 36px. */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
}

.btn:hover {
  background: var(--hov);
}

.btn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.btn__chevron {
  color: var(--t2);
  transition: transform 0.2s var(--ease);
}

.card--open .btn__chevron {
  transform: rotate(180deg);
}

.btn--link {
  color: var(--acc-fg);
}

.card__sale {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 20px 16px;
}

.sale {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
}

.sale__fact {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sale__fact dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.sale__fact dd {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px 20px;
  border-top: 1px solid var(--e8);
  background: var(--f5);
}

.card__columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  align-items: start;
}

.card__actions {
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.muted {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.link {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-weight: 600;
  color: var(--acc-fg);
  cursor: pointer;
}

@media (max-width: 639px) {
  .card__head,
  .card__sale,
  .card__body {
    padding-right: 16px;
    padding-left: 16px;
  }

  .card__side {
    align-items: flex-start;
  }

  .card__badges {
    justify-content: flex-start;
  }

  .card__buttons,
  .card__buttons .btn {
    flex: 1 1 auto;
  }

  .card__columns {
    grid-template-columns: minmax(0, 1fr);
  }

  .card__actions {
    padding: 16px;
  }
}

@media (pointer: coarse), (hover: none) {
  /* The inline "retry" link of the error line is tapped too. */
  .btn,
  .link {
    min-height: 44px;
  }
}
</style>
