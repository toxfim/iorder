<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useMediaQuery } from '@/composables/use-media-query';
import { useFormat } from '@core/i18n/use-format';
import { formatPhone } from '@core/lib/phone';
import { useOrderAge } from '../composables/use-order-age';
import {
  isClosedWithoutDelivery,
  isFullSummary,
  type FullOrderSummary,
  type OrderSummary,
} from '../domain/order-model';
import OrderStatusPill from './OrderStatusPill.vue';
import OrganizationTags from './OrganizationTags.vue';

const props = defineProps<{
  orders: readonly OrderSummary[];
  /** The manager: SUBMITTED rows get the quick "Tasdiqlash" (it opens the approval dialog). */
  canApprove: boolean;
  emptyText: string;
}>();
const emit = defineEmits<{ approve: [order: FullOrderSummary] }>();

const { t } = useI18n();
const { clock } = useServices();
const { formatMoneyWithCurrency, formatShortDateTime } = useFormat();
const { agoText } = useOrderAge(clock);

// The design's layouts: a table from 600px (the payment plan column folds away below 1024px), the
// compact cards on a phone.
const table = useMediaQuery('(min-width: 600px)', true);

// The server's DTO decides what exists: a warehouse or driver list carries no money, no payment
// plan and no person, so those columns are not drawn (no role check in the client).
const hasMoney = computed(() => props.orders.some(isFullSummary));

const quickApprove = (order: OrderSummary): order is FullOrderSummary =>
  props.canApprove && order.status === 'SUBMITTED' && isFullSummary(order);

/** "12 daqiqa oldin", "40 kun oldin" (the design, also for finished orders); the time if unreadable. */
function when(order: OrderSummary): string {
  return agoText(order) || formatShortDateTime(order.submittedAt);
}

const contactOf = (order: OrderSummary): { name: string; phone: string | null } | null =>
  isFullSummary(order)
    ? {
        name: order.placedBy.fullName,
        phone: order.placedBy.phone ? formatPhone(order.placedBy.phone) : null,
      }
    : null;

/** The label is in the FULL summary only (the roles that see money). */
const labelOf = (order: OrderSummary) => (isFullSummary(order) ? order.organizationLabel : null);
const totalOf = (order: OrderSummary): string | null =>
  isFullSummary(order) ? formatMoneyWithCurrency(order.totalAmount) : null;
const planOf = (order: OrderSummary): string | null =>
  isFullSummary(order) ? t(`orders.paymentPlan.${order.paymentPlan}`) : null;
const toOrder = (order: OrderSummary) => ({
  name: 'staff-order',
  params: { orderId: order.id },
});
</script>

<template>
  <div
    v-if="table"
    class="tbl"
    :class="{ 'tbl--plain': !hasMoney }"
    role="table"
    :aria-label="t('orders.page.list')"
  >
    <div class="tr tr--head" role="row">
      <span role="columnheader">{{ t('orders.list.order') }}</span>
      <span role="columnheader">{{ t('orders.list.client') }}</span>
      <template v-if="hasMoney">
        <span role="columnheader">{{ t('orders.list.contact') }}</span>
        <span role="columnheader" class="end">{{ t('orders.list.total') }}</span>
        <span role="columnheader" class="col-plan">{{ t('orders.list.plan') }}</span>
      </template>
      <span role="columnheader">{{ t('orders.list.status') }}</span>
      <span role="columnheader"
        ><span class="sr-only">{{ t('orders.list.approve') }}</span></span
      >
    </div>
    <div v-for="order in orders" :key="order.id" class="tr" role="row" data-testid="order-row">
      <span class="cell cell--order" role="cell">
        <RouterLink
          class="row-link mono"
          :to="toOrder(order)"
          :aria-label="t('orders.list.openLabel', { id: order.orderNumber })"
          >{{ order.orderNumber }}</RouterLink
        >
        <small class="muted" data-testid="order-when">{{ when(order) }}</small>
      </span>
      <span class="cell cell--client" role="cell">
        <b class="client">{{ order.organizationName }}</b>
        <OrganizationTags :type="order.organizationType" :label="labelOf(order)" />
        <small v-if="!hasMoney" class="muted">{{
          t('orders.list.items', { count: order.itemCount }, order.itemCount)
        }}</small>
      </span>
      <template v-if="hasMoney">
        <span class="cell cell--contact" role="cell">
          <template v-if="contactOf(order)">
            <span class="contact-name">{{ contactOf(order)?.name }}</span>
            <span v-if="contactOf(order)?.phone" class="mono muted phone">{{
              contactOf(order)?.phone
            }}</span>
          </template>
        </span>
        <b class="cell end mono total" role="cell" data-testid="order-total">{{
          totalOf(order)
        }}</b>
        <span class="cell col-plan plan" role="cell" data-testid="order-plan">{{
          isClosedWithoutDelivery(order.status) ? '' : planOf(order)
        }}</span>
      </template>
      <span class="cell" role="cell">
        <OrderStatusPill :status="order.status" />
      </span>
      <span class="cell cell--act" role="cell">
        <button
          v-if="quickApprove(order)"
          type="button"
          class="approve"
          :aria-label="t('orders.list.approveLabel', { id: order.orderNumber })"
          data-testid="row-approve"
          @click="emit('approve', order)"
        >
          {{ t('orders.list.approve') }}
        </button>
        <StaffIcon v-else name="right" :size="16" class="chev" />
      </span>
    </div>
    <p v-if="orders.length === 0" class="empty" role="status">{{ emptyText }}</p>
  </div>

  <ul v-else class="cards" :aria-label="t('orders.page.list')">
    <li v-for="order in orders" :key="order.id" class="card" data-testid="order-row">
      <div class="card__top">
        <span class="card__id">
          <RouterLink
            class="row-link mono"
            :to="toOrder(order)"
            :aria-label="t('orders.list.openLabel', { id: order.orderNumber })"
            >{{ order.orderNumber }}</RouterLink
          >
          <small class="muted" data-testid="order-when">{{ when(order) }}</small>
        </span>
        <OrderStatusPill :status="order.status" />
      </div>
      <div class="card__mid">
        <span class="card__who">
          <b class="client client--lg">{{ order.organizationName }}</b>
          <OrganizationTags :type="order.organizationType" :label="labelOf(order)" />
          <small v-if="!contactOf(order)" class="muted">{{
            t('orders.list.items', { count: order.itemCount }, order.itemCount)
          }}</small>
        </span>
        <b v-if="totalOf(order)" class="mono card__total" data-testid="order-total">{{
          totalOf(order)
        }}</b>
      </div>
      <span v-if="contactOf(order)" class="card__contact">
        <span class="card__cname">{{ contactOf(order)?.name }}</span>
        <span v-if="contactOf(order)?.phone" class="mono muted">{{ contactOf(order)?.phone }}</span>
      </span>
      <div class="card__bot">
        <span class="plan">{{ isClosedWithoutDelivery(order.status) ? '' : planOf(order) }}</span>
        <button
          v-if="quickApprove(order)"
          type="button"
          class="approve approve--lg"
          :aria-label="t('orders.list.approveLabel', { id: order.orderNumber })"
          data-testid="row-approve"
          @click="emit('approve', order)"
        >
          {{ t('orders.list.approve') }}
        </button>
        <StaffIcon v-else name="right" :size="16" class="chev" />
      </div>
    </li>
    <li v-if="orders.length === 0" class="empty" role="status">{{ emptyText }}</li>
  </ul>
</template>

<style scoped>
/* Approved «Buyurtmalar» design (1440 / 768 / 390). The whole row opens the order: the number is
   the link and its ::after covers the row; the quick approve sits above that layer. */
.tbl {
  overflow: hidden;
  border: 1px solid var(--e8);
  border-radius: 14px;
  background: var(--w);
}

.tr {
  position: relative;
  display: grid;
  grid-template-columns: 108px minmax(0, 1.3fr) minmax(0, 1fr) 150px 120px 130px 104px;
  gap: 16px;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--ef);
  font-size: var(--fs-body-lg);
}

.tbl--plain .tr,
.tbl--plain .tr--head {
  grid-template-columns: 108px minmax(0, 1fr) 150px 104px;
}

.tr:last-of-type {
  border-bottom: 0;
}

.tr:not(.tr--head):hover {
  background: var(--hov);
}

.tr--head {
  padding: 11px 20px;
  background: var(--f5);
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--t3);
}

.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cell--client {
  gap: 5px;
}

.cell--act {
  align-items: flex-end;
}

.end {
  text-align: right;
}

.mono {
  font-family: var(--font-mono);
}

.row-link {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}

.row-link::after {
  content: '';
  position: absolute;
  inset: 0;
}

.row-link:focus-visible {
  outline: none;
}

.row-link:focus-visible::after {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.muted {
  font-size: var(--fs-small);
  color: var(--t3);
}

.client {
  overflow-wrap: anywhere;
  font-size: var(--fs-section);
  font-weight: 600;
  line-height: 1.3;
}

/* One line each: a long name ends in an ellipsis instead of pushing the sum (768). */
.contact-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phone {
  white-space: nowrap;
}

.total {
  font-size: var(--fs-body-lg);
  font-weight: 600;
  white-space: nowrap;
}

.plan {
  color: var(--t2);
}

.approve {
  position: relative;
  z-index: 1;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--acc);
  border-radius: 9px;
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-body);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.approve:hover {
  border-color: var(--acc-hover);
  background: var(--acc-hover);
}

.approve:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.chev {
  color: var(--b5);
}

.empty {
  margin: 0;
  padding: 40px;
  text-align: center;
  color: var(--t3);
  list-style: none;
}

/* Tablet: the payment plan column folds away (the design's 768 table). */
@media (max-width: 1023px) {
  .tr {
    grid-template-columns: 80px minmax(0, 1fr) minmax(0, 1fr) 128px 96px 92px;
    gap: 10px;
    padding: 14px 16px;
  }

  .tbl--plain .tr {
    grid-template-columns: 80px minmax(0, 1fr) 96px 92px;
  }

  .col-plan {
    display: none;
  }

  .total {
    font-size: var(--fs-body);
  }
}

/* Phone cards. */
.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--e8);
  border-radius: 14px;
  background: var(--w);
}

.card__top,
.card__mid,
.card__bot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.card__id {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.card__id .row-link {
  font-size: var(--fs-section);
}

.card__who {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.client--lg {
  font-size: 17px;
}

/* The design's phone card: the name and the phone on one line. */
.card__contact {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
  color: var(--t2);
  font-size: var(--fs-body-lg);
}

.card__cname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card__total {
  flex: none;
  font-size: var(--fs-section);
  font-weight: 600;
}

.card__bot {
  min-height: 36px;
}

.approve--lg {
  height: 40px;
  padding: 0 16px;
  font-size: var(--fs-body-lg);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (pointer: coarse), (hover: none) {
  .approve {
    min-height: 44px;
  }
}
</style>
