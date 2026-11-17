<script setup lang="ts">
import GoodsIcon from '@/features/customer-goods/components/GoodsIcon.vue';
import '@/features/customer-goods/goods.css';
import PaymentPlanChoice from '@/features/customer-cart/components/PaymentPlanChoice.vue';
import type { CustomerOrder, CustomerTimelineResponse, PaymentPlan } from '@iorder/shared';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import StateView, { type StateViewState } from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useDocumentTitleDetail } from '@core/composables/use-document-title';
import { showToast } from '@core/composables/use-toast';
import { useCustomerServices } from '@/features/customer-app/services';
import { useErrorMessage } from '@/features/customer-app/composables/use-error-message';
import { useFormat } from '@core/i18n/use-format';
import { ApiConflictError, ApiNotFoundError } from '@core/lib/api-errors';
import {
  PAYMENT_TONE,
  canOfferCancelHint,
  canOfferReceive,
  customerOrderState,
  showsPaymentBadge,
  stateHintKey,
  stateLabelKey,
} from '../domain/order-display';
import { formatSecondsLeft, useCountdown } from '../composables/use-countdown';
import OrderTimeline from './OrderTimeline.vue';

interface OrderScreen {
  readonly order: CustomerOrder;
  readonly timeline: CustomerTimelineResponse;
}

const { t } = useI18n();
const route = useRoute();
const { ordersApi, session, goods } = useCustomerServices();
const { formatMoneyWithCurrency, formatDateTime, formatNumber, formatTime, formatUnit } =
  useFormat();
const describe = useErrorMessage();

const orderId = computed(() => String(route.params.id));

async function loadScreen(): Promise<OrderScreen> {
  const [order, timeline] = await Promise.all([
    ordersApi.get(orderId.value),
    ordersApi.timeline(orderId.value),
  ]);
  return { order, timeline };
}

const view = useAsyncView<OrderScreen>(loadScreen, { isEmpty: () => false });
useDocumentTitleDetail(() => view.data.value?.order.orderNumber);

// A foreign and a missing order look the same: one "not found" screen, no hint which.
const screenState = computed<StateViewState>(() =>
  view.error.value instanceof ApiNotFoundError ? 'empty' : view.state.value,
);

const order = computed(() => view.data.value?.order ?? null);
// Customers never cancel (owner rule 2026-10-22): they are told to contact the manager.
const showCancelHint = computed(() => (order.value ? canOfferCancelHint(order.value) : false));
const showReceive = computed(() =>
  order.value ? canOfferReceive(order.value, session.organizationRole.value) : false,
);

// The written reason of a rejection or cancellation, repeated above the history so it is not
// missed. It is the comment of the event that moved the order into its final status.
const stopReason = computed<string | null>(() => {
  const data = view.data.value;
  if (!data || (data.order.status !== 'REJECTED' && data.order.status !== 'CANCELLED')) return null;
  const closing = [...data.timeline.events]
    .reverse()
    .find((event) => event.toStatus === data.order.status && event.comment);
  return closing?.comment ?? null;
});

/** Refreshes the data under the open screen without the loading skeleton. */
async function refreshQuietly(): Promise<void> {
  try {
    view.data.value = await loadScreen();
  } catch {
    // The screen keeps showing what it had; the person can pull a fresh one with a reload.
  }
}

type Action = 'receive';
const dialog = ref<Action | null>(null);
const busy = ref(false);
const dialogError = ref<string | null>(null);

function open(action: Action): void {
  dialogError.value = null;
  dialog.value = action;
}

// The order moved while the person was looking at it: show the fresh state and say why the
// action was not done, instead of leaving a dialog that can never succeed.
async function onActionFailed(caught: unknown): Promise<void> {
  const stale =
    caught instanceof ApiConflictError &&
    (caught.reason === 'ORDER_CHANGED' || caught.reason === 'ILLEGAL_ORDER_TRANSITION');
  if (!stale) {
    dialogError.value = describe(caught);
    return;
  }
  dialog.value = null;
  await refreshQuietly();
  showToast({
    message: caught.reason === 'ORDER_CHANGED' ? t('customer.order.reloaded') : describe(caught),
  });
}

async function run(call: () => Promise<CustomerOrder>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  dialogError.value = null;
  try {
    await call();
    dialog.value = null;
    await refreshQuietly();
    showToast({ message: t('customer.order.received') });
    await goods.refresh();
  } catch (caught) {
    await onActionFailed(caught);
  } finally {
    busy.value = false;
  }
}

// The customer's short time to change the plan (owner rule 2026-10-30). The end time and the totals
// come from the server, which also decides; the control goes away when the time runs out on the
// screen or when the server says it is over, even if the fresh read then fails.
const planRefused = ref(false);
const pendingPlan = ref<PaymentPlan | null>(null);
const planBusy = ref(false);
const planError = ref<string | null>(null);
const planUntil = computed(() => order.value?.paymentPlanChangeableUntil ?? null);
const { secondsLeft } = useCountdown(planUntil);
const planTotals = computed(() =>
  planRefused.value || secondsLeft.value === 0 ? null : (order.value?.paymentPlanTotals ?? null),
);
const pendingTotal = computed(() =>
  pendingPlan.value === null ? null : (planTotals.value?.[pendingPlan.value] ?? null),
);

function askPlan(plan: PaymentPlan): void {
  if (plan === order.value?.paymentPlan) return;
  planError.value = null;
  pendingPlan.value = plan;
}

async function confirmPlan(): Promise<void> {
  const plan = pendingPlan.value;
  if (planBusy.value || plan === null || order.value === null) return;
  planBusy.value = true;
  planError.value = null;
  try {
    await ordersApi.changePaymentPlan(orderId.value, {
      paymentPlan: plan,
      expectedRowVersion: order.value.rowVersion,
    });
    pendingPlan.value = null;
    await refreshQuietly();
    showToast({ message: t('customer.order.planChange.done') });
  } catch (caught) {
    const reason = caught instanceof ApiConflictError ? caught.reason : undefined;
    if (reason === 'ORDER_CHANGED') {
      pendingPlan.value = null;
      await refreshQuietly();
      showToast({ message: t('customer.order.reloaded') });
    } else if (reason === 'PAYMENT_PLAN_WINDOW_ENDED' || reason === 'PAYMENT_PLAN_NOT_CHANGEABLE') {
      planRefused.value = true;
      pendingPlan.value = null;
      await refreshQuietly();
      showToast({ message: describe(caught) });
    } else {
      planError.value = describe(caught);
    }
  } finally {
    planBusy.value = false;
  }
}

const receive = (): Promise<void> =>
  run(() => ordersApi.receive(orderId.value, { expectedRowVersion: order.value?.rowVersion }));
</script>

<template>
  <section class="order-page">
    <AppBackLink :to="{ name: 'customer-orders' }">{{ t('customer.order.back') }}</AppBackLink>
    <StateView
      :state="screenState"
      :title="screenState === 'empty' ? t('customer.order.notFound.title') : undefined"
      :description="screenState === 'empty' ? t('customer.order.notFound.description') : undefined"
      @retry="view.reload()"
    >
      <template v-if="order">
        <header class="order-heading">
          <h1>{{ t('customer.goods.order') }} {{ order.orderNumber }}</h1>
          <p>
            {{ formatDateTime(order.submittedAt) }} ·
            {{ session.organizationName.value }}
          </p>
        </header>
        <!-- One of the three customer states in words, and one sentence about what comes next. -->
        <header class="order-hero" :data-state="customerOrderState(order.status)">
          <div class="order-hero-status">
            <GoodsIcon name="box-status" />
            <h2 aria-live="polite" data-testid="order-state">
              {{ t(stateLabelKey(order.status)) }}
            </h2>
            <AppBadge v-if="showsPaymentBadge(order)" :tone="PAYMENT_TONE[order.paymentStatus]"
              >{{ t('customer.order.payment') }}:
              {{ t(`customer.orders.payment.${order.paymentStatus}`) }}</AppBadge
            >
          </div>
          <p class="order-hero-hint" data-testid="order-state-hint">
            {{ t(stateHintKey(order.status)) }}
          </p>
        </header>
        <p v-if="stopReason" class="order-stop stop-reason" role="note">
          <strong>{{ t('customer.order.reason') }}:</strong> {{ stopReason }}
        </p>
        <div v-if="showReceive" class="order-receive">
          <div>
            <h2>{{ t('customer.order.receiveTitle') }}</h2>
            <p>{{ t('customer.order.receiveHint') }}</p>
          </div>
          <AppButton size="lg" @click="open('receive')">{{
            t('customer.order.receive')
          }}</AppButton>
        </div>
        <section v-if="planTotals" class="goods-panel order-plan-change" data-testid="plan-change">
          <PaymentPlanChoice
            :totals="planTotals"
            :model-value="pendingPlan ?? order.paymentPlan"
            :warning="t('customer.order.planChange.hint')"
            :disabled="planBusy"
            @update:model-value="askPlan"
          />
          <p class="order-plan-change__time" data-testid="plan-change-time" role="timer">
            {{
              t('customer.order.planChange.until', {
                time: formatTime(planUntil ?? ''),
                left: formatSecondsLeft(secondsLeft),
              })
            }}
          </p>
        </section>
        <div class="order-layout">
          <section class="goods-panel order-products" aria-labelledby="order-items">
            <h2 id="order-items">{{ t('customer.order.items') }} · {{ order.items.length }}</h2>
            <div class="order-item-head">
              <span>{{ t('customer.goods.product') }}</span
              ><span>{{ t('customer.goods.quantityPrice') }}</span
              ><span>{{ t('customer.order.total') }}</span>
            </div>
            <ul class="order-items">
              <li v-for="item in order.items" :key="item.id">
                <div>
                  <strong>{{ item.name }}</strong
                  ><span class="goods-muted">{{ item.productCode }}</span>
                </div>
                <span class="order-each">{{
                  t('customer.order.each', {
                    quantity: formatNumber(item.quantity),
                    unit: formatUnit(item.unit),
                    price: formatMoneyWithCurrency(item.unitPrice),
                  })
                }}</span
                ><strong class="order-line-total">{{
                  formatMoneyWithCurrency(item.lineTotal)
                }}</strong>
              </li>
            </ul>
            <p class="order-plan" data-testid="order-payment-plan">
              <span>{{ t('customer.cart.plan.title') }}</span>
              <strong>{{ t(`customer.plan.${order.paymentPlan}`) }}</strong>
            </p>
            <div class="order-total">
              <strong>{{ t('customer.order.total') }}</strong
              ><strong>{{ formatMoneyWithCurrency(order.totalAmount) }}</strong>
            </div>
            <p class="goods-muted">{{ order.items.length }} {{ t('customer.goods.product') }}</p>
          </section>
          <aside class="order-tracking">
            <section class="goods-panel" aria-labelledby="order-timeline">
              <h2 id="order-timeline">{{ t('customer.order.timeline') }}</h2>
              <OrderTimeline
                :events="view.data.value?.timeline.events ?? []"
                :ordered-at="order.submittedAt"
              />
            </section>
            <aside class="goods-note">
              <strong>{{ t('customer.goods.updatesTitle') }}</strong>
              <p>{{ t('customer.goods.updatesHint') }}</p>
            </aside>
          </aside>
          <section class="goods-panel order-contact">
            <div>
              <h2>{{ t('customer.order.placedBy') }}</h2>
              <p>{{ order.placedByName }}</p>
            </div>
            <div>
              <h2>{{ t('customer.presentation.yourShop') }}</h2>
              <p>{{ session.organizationName.value }}</p>
            </div>
          </section>
        </div>
        <p v-if="showCancelHint" class="goods-muted" data-test="cancel-hint">
          {{ t('customer.order.cancelByManager') }}
        </p>
      </template>
    </StateView>
    <AppConfirmDialog
      :model-value="dialog === 'receive'"
      :title="t('customer.order.receiveTitle')"
      :description="t('customer.order.receiveHint')"
      :confirm-label="t('customer.order.receive')"
      :loading="busy"
      :error="dialogError"
      @update:model-value="dialog = $event ? 'receive' : null"
      @confirm="receive"
    />
    <AppConfirmDialog
      :model-value="pendingPlan !== null"
      :title="t('customer.order.planChange.confirmTitle')"
      :description="
        pendingPlan === null
          ? ''
          : t('customer.order.planChange.confirmDescription', {
              plan: t(`customer.plan.${pendingPlan}`),
              total: formatMoneyWithCurrency(pendingTotal ?? '0'),
            })
      "
      :confirm-label="t('customer.order.planChange.confirmAction')"
      :loading="planBusy"
      :error="planError"
      @update:model-value="!$event && (pendingPlan = null)"
      @confirm="confirmPlan"
    />
  </section>
</template>
<style scoped>
.order-page {
  display: flex;
  flex-direction: column;
  gap: var(--goods-pad);
}
.order-page h1,
.order-page h2,
.order-page p {
  margin: 0;
}
.order-heading {
  display: flex;
  flex-direction: column;
  gap: var(--gap-row);
}
.order-heading h1 {
  font-size: var(--goods-title-size);
  font-weight: 600;
}
.order-heading p {
  color: var(--t3);
  font-size: var(--fs-small);
}
.order-hero {
  display: flex;
  flex-direction: column;
  gap: var(--gap-card);
  padding: var(--goods-pad);
  border-radius: var(--r-card);
  background: var(--hero-bg);
  color: var(--hero-fg);
}
.order-hero-hint {
  font-size: var(--fs-small);
}
.order-hero-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-card);
}
.order-page h2 {
  font-size: var(--fs-body);
  font-weight: 600;
}
/* The state is the headline of the dark card: it is the only place that says where the order is. */
.order-page .order-hero-status h2 {
  font-size: var(--fs-section);
}
.order-layout,
.order-tracking {
  display: flex;
  flex-direction: column;
  gap: var(--goods-pad);
}
.order-items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.order-items li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--gap-row) var(--gap-card);
  padding-block: var(--goods-row-pad);
  font-size: var(--fs-body);
}
.order-items li > div {
  display: flex;
  flex-direction: column;
  gap: var(--gap-row);
  min-width: 0;
}
.order-items strong {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.order-each {
  grid-column: 1;
  font-size: var(--fs-meta);
  color: var(--t3);
}
.order-line-total {
  grid-column: 2;
  grid-row: 1 / span 2;
  text-align: end;
  white-space: nowrap;
  font-size: var(--fs-meta);
}
.order-plan {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-card);
  margin: 0;
  font-size: var(--fs-body);
}
.order-plan-change {
  display: flex;
  flex-direction: column;
  gap: var(--gap-card);
}
.order-plan-change__time {
  color: var(--t2);
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
}
.order-total {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-card);
  border-top: 1px solid var(--e8);
  padding-top: var(--gap-card);
  font-size: var(--fs-body);
}
.order-item-head {
  display: none;
}
.order-contact {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.order-contact p {
  margin-top: var(--gap-card);
  font-size: var(--fs-small);
}
.order-contact h2 {
  color: var(--t3);
  font-size: var(--fs-meta);
  font-weight: 400;
}
.order-stop {
  background: var(--red-bg);
  color: var(--red);
  padding: var(--goods-row-pad);
  border-radius: var(--r-row);
  overflow-wrap: anywhere;
}
.order-receive {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-card);
  padding: var(--goods-pad);
  border: 1px solid var(--acc);
  border-radius: var(--r-card);
  background: var(--w);
}
.order-receive p {
  color: var(--t3);
  font-size: var(--fs-small);
  margin-top: var(--gap-row);
}
@media (min-width: 960px) {
  .order-layout {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
    align-items: start;
    gap: 24px;
  }
  .order-tracking {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
  .order-products,
  .order-contact {
    grid-column: 1;
  }
  .order-item-head,
  .order-items li {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(110px, 1fr) auto;
    gap: var(--gap-card);
  }
  .order-item-head {
    font-size: var(--fs-meta);
    color: var(--t3);
    border-bottom: 1px solid var(--e8);
    padding-bottom: var(--gap-card);
  }
  .order-line-total,
  .order-each {
    grid-column: auto;
    grid-row: auto;
  }
}
</style>
