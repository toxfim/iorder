<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteUpdate, useRoute } from 'vue-router';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useDocumentTitleDetail } from '@core/composables/use-document-title';
import { useServices } from '@/app/services';
import { PAYMENT_PLANS, type PaymentPlan } from '@iorder/shared';
import { useFormat } from '@core/i18n/use-format';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import { formatPhone, telHref } from '@core/lib/phone';
import { rememberedListQuery } from '../composables/orders-list-memory';
import { useUnsavedChanges } from '@/features/pricing/composables/use-unsaved-changes';
import { useItemDraft } from '../composables/use-item-draft';
import { useOrderActions } from '../composables/use-order-actions';
import { useOrderAge } from '../composables/use-order-age';
import { useOrderDetail } from '../composables/use-order-detail';
import { useOrderPicking } from '../composables/use-order-picking';
import { showsPicking } from '../domain/picking-model';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import {
  canChangePaymentMethod,
  canChangePaymentPlan,
  FULFILLMENT_STAGES,
  isClosedWithoutDelivery,
  isFullDetail,
  planTotalOf,
  summaryOf,
  type PaymentMethod,
} from '../domain/order-model';
import type { DraftItem } from '../domain/item-draft';
import {
  paymentTone,
  progressSegments,
  stageTone,
  type ProgressSegmentState,
} from '../domain/order-presentation';
import DeliveryContactCard from './DeliveryContactCard.vue';
import ItemsEditConfirmDialog from './ItemsEditConfirmDialog.vue';
import ItemsUnsavedDialog from './ItemsUnsavedDialog.vue';
import OrderActionsPanel from './OrderActionsPanel.vue';
import OrderAllocationPanel from './OrderAllocationPanel.vue';
import CashSaleWarning from './CashSaleWarning.vue';
import OrderAllocationsTable from './OrderAllocationsTable.vue';
import OrderItems from './OrderItems.vue';
import { freeStockByItem } from '../domain/free-stock';
import OrderTimeline from './OrderTimeline.vue';
import PickingPanel from './PickingPanel.vue';
import PaymentMethodChoice from './PaymentMethodChoice.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const route = useRoute();
const { formatDateTime, formatMoneyWithCurrency } = useFormat();
const { formatUsd, formatRate } = useCostFormat();
const { clock, currentUser, ordersApi } = useServices();
const { ageText } = useOrderAge(clock);
// The order page re-reads the order and its timeline after EVERY change and after a stale row version (409 ORDER_CHANGED), so the next click works on fresh data.
const actions = useOrderActions({ onChanged: () => reload(), onStale: () => reload() });

const orderId = computed(() => String(route.params.orderId ?? ''));
const listLocation = computed(() => ({ name: 'staff-orders', query: rememberedListQuery.value }));

// --- data ------------------------------------------------------------------------------------------

const detail = useOrderDetail(() => orderId.value, { timeline: true });
const state = detail.state;
watch(orderId, () => void detail.load(), { immediate: true });

let pendingReload: Promise<void> = Promise.resolve();
function reload(): void {
  pendingReload = detail.load({ silent: true });
}

const order = computed(() => (state.value === 'ready' ? detail.order.value : null));
useDocumentTitleDetail(() => order.value?.orderNumber);
const full = computed(() => {
  const value = order.value;
  return value && isFullDetail(value) ? value : null;
});
// How long the order has been moving through the pipeline; empty once it is finished or closed.
const waiting = computed(() => (order.value ? ageText(summaryOf(order.value)) : ''));
const stateForView = computed(() => (state.value === 'notFound' ? 'empty' : state.value));

// --- what the viewer may do --------------------------------------------------------------------

const permissions = computed(() => actions.permissions());
const closed = computed(() => (order.value ? isClosedWithoutDelivery(order.value.status) : false));
const editable = computed(
  () => permissions.value.canDecide && order.value?.status === 'SUBMITTED' && full.value !== null,
);
// [C] 2026-10-30: the manager may move the holds from the approval until the release.
const holdsShown = computed(
  () =>
    permissions.value.canDecide &&
    (order.value?.status === 'MANAGER_APPROVED' || order.value?.status === 'ACCOUNTING_CLEARED'),
);
const itemsNote = computed(() => {
  if (!order.value || editable.value) return null;
  return order.value.status === 'SUBMITTED'
    ? t('orders.detail.items.onlyManager')
    : t('orders.detail.items.locked');
});

// --- unit codes (IMEI / SN / marking), shared by the scanner panel and the release button -----

const codesShown = computed(
  () => permissions.value.seesCodes && order.value !== null && showsPicking(order.value.status),
);
const picking = useOrderPicking(() => orderId.value);
// Re-read with the order: another order, or the status moved (scanning only while it waits).
watch(
  () => [orderId.value, codesShown.value, order.value?.status] as const,
  ([id, shown], previous) => {
    if (shown) void picking.load({ silent: previous?.[0] === id });
  },
  { immediate: true },
);

// The event that closed a rejected or cancelled order: its reason, and the step it stopped at.
const closingEvent = computed(() => {
  const value = order.value;
  if (!value || !closed.value) return null;
  const events = detail.timeline.value?.events ?? [];
  return [...events].reverse().find((e) => e.toStatus === value.status) ?? null;
});
const closingReason = computed(() => closingEvent.value?.comment ?? null);

const segments = computed(() =>
  order.value
    ? progressSegments(
        order.value.status,
        full.value?.accounting.mode,
        closingEvent.value?.fromStatus ?? null,
      )
    : [],
);
const stepLabel = (index: number): string => t(`orders.steps.${FULFILLMENT_STAGES[index]}`);
/** The caption under a step (v8): done, skipped, current, next, or where a closed order stopped. */
function stepCaption(segment: ProgressSegmentState): string {
  if (segment === 'closed') return order.value ? t(`orders.stages.${order.value.status}`) : '';
  const key = { done: 'done', skipped: 'skipped', next: 'current', todo: 'todo' }[segment];
  return t(`orders.steps.${key}`);
}

// The role(s) the actions are offered for, named in the corner of the actions card.
const roleLabel = computed(() =>
  (currentUser.user.value?.staffRoles ?? []).map((role) => t(`roles.staff.${role}`)).join(', '),
);
const reasonBanner = computed(() => {
  const value = order.value;
  if (!value || !closed.value) return null;
  const label = t(`orders.stages.${value.status}`);
  return closingReason.value
    ? t('orders.detail.reasonBanner', { label, reason: closingReason.value })
    : label;
});

// --- changes ------------------------------------------------------------------------------------

const busy = ref(false);
// One request at a time: a second click while one is in flight is ignored.
async function guarded(work: () => Promise<boolean>): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  try {
    return await work();
  } finally {
    busy.value = false;
  }
}

// --- unsaved item edits --------------------------------------------------------------------------

const draftItems = computed<readonly DraftItem[]>(() => full.value?.items ?? []);
const itemDraft = useItemDraft(draftItems);
// The draft belongs to one order that is still with the manager.
watch([orderId, editable], () => itemDraft.discard());

/** One save = one history event and one customer notification; the draft is cleared once the new lines are shown. */
async function saveDraft(): Promise<boolean> {
  const value = full.value;
  if (!value || !itemDraft.dirty.value) return true;
  const saved = await guarded(() => actions.editItems(value, itemDraft.changes()));
  if (saved) {
    await pendingReload;
    itemDraft.discard();
  }
  return saved;
}

// Changing quantities ends in a customer notification, so the first −/+/× on an order asks once;
// the change that was clicked is applied on "yes", and the later ones (and the save) do not ask.
const editConfirmed = ref(false);
const pendingChange = ref<{ itemId: string; quantity: string | null } | null>(null);
watch(orderId, () => {
  editConfirmed.value = false;
  pendingChange.value = null;
});
function changeQuantity(item: DraftItem, quantity: string | null): void {
  if (editConfirmed.value) itemDraft.setQuantity(item.id, quantity);
  else pendingChange.value = { itemId: item.id, quantity };
}
function confirmEdit(): void {
  const change = pendingChange.value;
  editConfirmed.value = true;
  pendingChange.value = null;
  if (change) itemDraft.setQuantity(change.itemId, change.quantity);
}

// What the stock can still give to each line, shown beside the quantity the manager edits. Read
// with the page and again after every saved change (the row version moves). It is indicative and
// optional: when the read fails the editor simply shows no stock, it never blocks an edit.
const freeStock = shallowRef<ReadonlyMap<string, string>>(new Map());
let freeStockRead = 0;
watch(
  [orderId, () => full.value?.rowVersion, editable],
  async ([id, , canEdit]) => {
    const mine = ++freeStockRead;
    freeStock.value = new Map();
    if (!id || !canEdit) return;
    try {
      const preview = await ordersApi.getAllocationPreview(id);
      if (mine === freeStockRead) freeStock.value = freeStockByItem(preview);
    } catch {
      /* No stock figures: the quantity can still be edited and saved. */
    }
  },
  { immediate: true },
);

const unsaved = useUnsavedChanges({
  isDirty: itemDraft.dirty,
  save: saveDraft,
  discard: itemDraft.discard,
});
// Another order opened in the same page component is a leave too.
onBeforeRouteUpdate(() => unsaved.confirmLeave());

// --- payment method: manager and accountant see it (the api leaves it out for everyone else) ----

const paymentMethod = computed(() => full.value?.paymentMethod);
const methodEditable = computed(
  () =>
    permissions.value.canDecide &&
    paymentMethod.value !== undefined &&
    order.value !== null &&
    canChangePaymentMethod(order.value.status),
);
// Before the approval there is nothing to show: the manager chooses it in the actions above.
const methodShown = computed(
  () => paymentMethod.value !== undefined && (paymentMethod.value !== null || methodEditable.value),
);
const methodDraft = ref<PaymentMethod | null>(null);
watch(
  paymentMethod,
  (value) => {
    methodDraft.value = value ?? null;
  },
  { immediate: true },
);
const methodChanged = computed(
  () => methodDraft.value !== null && methodDraft.value !== (paymentMethod.value ?? null),
);
const saveMethod = (): void => {
  const value = full.value;
  const method = methodDraft.value;
  if (value && method) void guarded(() => actions.setPaymentMethod(value, method));
};

// --- payment plan ("To'lov turi"): the customer's choice; the manager may change it while SUBMITTED -

const planEditable = computed(
  () =>
    permissions.value.canDecide && order.value !== null && canChangePaymentPlan(order.value.status),
);
const planOptions = computed(() =>
  PAYMENT_PLANS.map((plan) => {
    const total = full.value ? planTotalOf(full.value.items, plan) : null;
    return { plan, total, available: total !== null };
  }),
);
// Waits for the manager's yes: the customer is told, and the total moves.
const planPending = ref<PaymentPlan | null>(null);
watch(orderId, () => {
  planPending.value = null;
});
const planPendingTotal = computed(
  () => planOptions.value.find((option) => option.plan === planPending.value)?.total ?? '0',
);
const confirmPlan = (): void => {
  const value = full.value;
  const plan = planPending.value;
  planPending.value = null;
  if (value && plan) void guarded(() => actions.setPaymentPlan(value, plan));
};
</script>

<template>
  <div class="page">
    <AppBackLink :to="listLocation">{{ t('orders.page.title') }}</AppBackLink>

    <StateView
      :state="stateForView"
      :title="state === 'notFound' ? t('orders.detail.notFound.title') : undefined"
      :description="state === 'notFound' ? t('orders.detail.notFound.description') : undefined"
      @retry="detail.load()"
    >
      <template v-if="order">
        <header class="head">
          <div class="head__row">
            <h1 class="head__title">
              {{ t('orders.detail.title') }} <span class="head__id">{{ order.orderNumber }}</span>
            </h1>
            <div class="head__badges">
              <AppBadge :tone="stageTone(order.status)" dot>{{
                t(`orders.stages.${order.status}`)
              }}</AppBadge>
              <AppBadge v-if="full" :tone="paymentTone(full.paymentStatus)" dot class="head__pay">
                {{ t(`orders.payment.${full.paymentStatus}`) }}
              </AppBadge>
            </div>
          </div>
          <p class="head__meta">
            <span class="head__org">{{ order.organizationName }}</span>
            <template v-if="full">
              ·
              <i18n-t scope="global" keypath="orders.detail.metaPlaced">
                <template #name>
                  <PersonName :name="full.placedBy.fullName" :user-id="full.placedBy.userId" />
                </template>
              </i18n-t>
            </template>
            · <time :datetime="order.submittedAt">{{ formatDateTime(order.submittedAt) }}</time>
            <template v-if="waiting">
              ·
              <span :title="t('table.sinceSubmitted')">{{
                t('orders.detail.metaAge', { age: waiting })
              }}</span></template
            >
          </p>
        </header>

        <div v-if="reasonBanner" class="closed" role="status">
          <StaffIcon name="x" :size="18" class="closed__icon" />
          <p class="banner">{{ reasonBanner }}</p>
        </div>

        <ol class="progress" :aria-label="t('orders.detail.progress')">
          <li
            v-for="(segment, index) in segments"
            :key="index"
            class="progress__step"
            :class="`progress__step--${segment}`"
            :aria-current="segment === 'next' ? 'step' : undefined"
          >
            <span class="progress__dot" :class="`progress__dot--${segment}`" aria-hidden="true">
              <StaffIcon v-if="segment === 'done'" name="check" :size="14" :stroke-width="2" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="progress__text">
              <span class="progress__label">{{ stepLabel(index) }}</span>
              <span class="progress__note">{{ stepCaption(segment) }}</span>
            </span>
            <StaffIcon
              v-if="index < segments.length - 1"
              name="right"
              :size="13"
              class="progress__arrow"
            />
          </li>
        </ol>

        <div class="layout">
          <section class="panel panel--actions" :aria-label="t('orders.detail.sections.actions')">
            <div class="panel__head">
              <h2 class="panel__title">{{ t('orders.detail.sections.actions') }}</h2>
              <span class="panel__aside">{{ roleLabel }}</span>
            </div>
            <OrderActionsPanel
              :order="order"
              :draft-pending="itemDraft.dirty.value"
              :picking="codesShown ? picking : undefined"
              @changed="reload"
              @stale="reload"
            />
            <OrderAllocationPanel
              v-if="holdsShown"
              class="panel__holds"
              :order-id="order.id"
              :row-version="order.rowVersion"
              :status="order.status"
              @changed="reload"
            />
          </section>

          <div class="main">
            <CashSaleWarning
              v-if="permissions.canAccount && full?.paymentMethod === 'CASH'"
              :total="full.totalAmount"
            />
            <OrderItems
              v-if="order.status === 'SUBMITTED'"
              :items="order.items"
              :total="full?.totalAmount ?? null"
              :draft="itemDraft.draft.value"
              :editable="editable"
              :busy="busy"
              :note="itemsNote"
              :free="freeStock"
              @change="changeQuantity"
              @save="saveDraft"
              @discard="itemDraft.discard"
            />
            <!-- During picking the warehouse reads the supplies in its scanner panel below. -->
            <OrderAllocationsTable
              v-else-if="full || !codesShown"
              :lines="order.items"
              :status="order.status"
              :total="full?.totalAmount ?? null"
              :note="itemsNote"
            />

            <section
              v-if="full?.customerComment"
              class="panel comment"
              :aria-label="t('orders.detail.sections.comment')"
            >
              <StaffIcon name="message" :size="16" class="comment__icon" />
              <div class="comment__body">
                <h2 class="comment__title">{{ t('orders.detail.sections.comment') }}</h2>
                <p class="comment__text">{{ full.customerComment }}</p>
              </div>
            </section>

            <PickingPanel v-if="codesShown" :picking="picking" :shows-supplies="!full" />
          </div>

          <aside class="side">
            <!-- Money: the server sends it to the manager, the accountant and the admin only. -->
            <section v-if="full" class="panel" :aria-label="t('orders.detail.paymentCard.title')">
              <h2 class="panel__title">{{ t('orders.detail.paymentCard.title') }}</h2>
              <div class="fact">
                <span class="fact__label">{{ t('orders.detail.paymentCard.status') }}</span>
                <AppBadge :tone="paymentTone(full.paymentStatus)" dot>
                  {{ t(`orders.payment.${full.paymentStatus}`) }}
                </AppBadge>
              </div>
              <!-- The order's frozen rate: what it counts for in the organization's debt. -->
              <div class="fact" data-testid="order-total-usd">
                <span class="fact__label">{{ t('orders.detail.paymentCard.totalUsd') }}</span>
                <b class="fact__value">{{
                  t('orders.detail.paymentCard.totalUsdValue', {
                    usd: formatUsd(full.totalUsd),
                    rate: formatRate(full.usdRate),
                  })
                }}</b>
              </div>
              <div v-if="methodShown" class="method-box" data-testid="payment-method-card">
                <template v-if="methodEditable">
                  <PaymentMethodChoice v-model="methodDraft" compact :disabled="busy" />
                  <AppButton
                    v-if="methodChanged"
                    size="sm"
                    :loading="busy"
                    data-testid="payment-method-save"
                    @click="saveMethod"
                  >
                    {{ t('orders.paymentMethod.save') }}
                  </AppButton>
                </template>
                <div v-else class="fact">
                  <span class="fact__label">{{ t('orders.paymentMethod.title') }}</span>
                  <b class="fact__value" data-testid="payment-method-value">{{
                    paymentMethod ? t(`orders.paymentMethod.${paymentMethod}`) : ''
                  }}</b>
                </div>
              </div>
              <div class="plan-box" data-testid="payment-plan-card">
                <div class="fact">
                  <span class="fact__label">{{ t('orders.paymentPlan.title') }}</span>
                  <b class="fact__value" data-testid="payment-plan-value">{{
                    t(`orders.paymentPlan.${full.paymentPlan}`)
                  }}</b>
                </div>
                <div v-if="planEditable" class="plan-box__options">
                  <AppButton
                    v-for="option in planOptions"
                    v-show="option.plan !== full.paymentPlan"
                    :key="option.plan"
                    size="sm"
                    variant="ghost"
                    :disabled="busy || !option.available || itemDraft.dirty.value"
                    :data-testid="`payment-plan-change-${option.plan}`"
                    @click="planPending = option.plan"
                  >
                    {{
                      t('orders.paymentPlan.changeTo', {
                        plan: t(`orders.paymentPlan.${option.plan}`),
                      })
                    }}
                  </AppButton>
                  <p
                    v-if="
                      full.paymentPlan === 'FULL' &&
                      !planOptions.some((o) => o.plan === 'DEFERRED' && o.available)
                    "
                    class="plan-box__reason"
                    data-testid="payment-plan-reason"
                  >
                    {{ t('orders.paymentPlan.noDeferredPrice') }}
                  </p>
                </div>
              </div>
              <p class="panel__foot">{{ t('orders.detail.paymentCard.neverBlocks') }}</p>
            </section>

            <DeliveryContactCard v-if="order.deliveryContact" :contact="order.deliveryContact" />
            <section v-else class="panel" :aria-label="t('orders.contact.title')">
              <h2 class="panel__title">{{ t('orders.contact.title') }}</h2>
              <b class="org">{{ order.organizationName }}</b>
              <p class="muted">{{ t('orders.contact.hiddenForRole') }}</p>
            </section>

            <section
              v-if="order.driver || !closed"
              class="panel driver"
              :aria-label="t('orders.detail.sections.delivery')"
            >
              <span class="driver__icon" aria-hidden="true"
                ><StaffIcon name="truck" :size="16"
              /></span>
              <span class="driver__text">
                <span class="driver__label">{{ t('orders.detail.delivery.driver') }}</span>
                <span class="driver__name">
                  <PersonName
                    v-if="order.driver"
                    :name="order.driver.fullName"
                    :user-id="order.driver.userId"
                  />
                  <template v-else>{{ t('orders.detail.delivery.notYet') }}</template>
                </span>
              </span>
              <a
                v-if="order.driver?.phone"
                class="driver__call"
                :href="telHref(order.driver.phone)"
                :aria-label="`${t('orders.detail.delivery.phone')}: ${order.driver.fullName}`"
                >{{ formatPhone(order.driver.phone) }}</a
              >
            </section>

            <section class="panel" :aria-label="t('orders.detail.sections.timeline')">
              <div class="panel__head">
                <h2 class="panel__title">{{ t('orders.detail.sections.timeline') }}</h2>
                <span class="panel__aside">{{ t('orders.detail.timeline.order') }}</span>
              </div>
              <div class="timeline-box">
                <p v-if="detail.timelineState.value === 'loading'" class="muted" role="status">
                  {{ t('state.loading') }}
                </p>
                <p v-else-if="detail.timelineState.value === 'error'" class="muted" role="alert">
                  {{ t('orders.detail.timeline.error') }}
                  <button type="button" class="link" @click="detail.load({ silent: true })">
                    {{ t('state.retry') }}
                  </button>
                </p>
                <OrderTimeline v-else :events="detail.timeline.value?.events ?? []" />
              </div>
            </section>
          </aside>
        </div>
      </template>
    </StateView>

    <AppConfirmDialog
      :model-value="planPending !== null"
      :title="t('orders.paymentPlan.confirmTitle')"
      :description="
        t('orders.paymentPlan.confirmDescription', {
          plan: planPending ? t(`orders.paymentPlan.${planPending}`) : '',
          total: formatMoneyWithCurrency(planPendingTotal),
        })
      "
      :confirm-label="t('orders.paymentPlan.confirmAction')"
      @update:model-value="(open) => !open && (planPending = null)"
      @confirm="confirmPlan"
    />
    <ItemsEditConfirmDialog
      :model-value="pendingChange !== null"
      @update:model-value="(open) => !open && (pendingChange = null)"
      @confirm="confirmEdit"
    />
    <ItemsUnsavedDialog
      :model-value="unsaved.open.value"
      :count="itemDraft.summary.value.changes.length"
      :busy="unsaved.busy.value"
      @choose="unsaved.choose"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--gap-block);
  animation: viewIn 0.35s var(--ease) both;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: -14px;
}

.plan-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-box__options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.plan-box__reason {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t3);
}

.head__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

/* v8 page title: 28px regular. */
.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.head__meta {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
  overflow-wrap: anywhere;
}

/* v8 closed-order banner: a grey card with a red cross. */
.closed {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-radius: var(--r-card);
  background: var(--ef);
}

.closed__icon {
  color: var(--red);
}

.banner {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

/* v8 stepper: six numbered circles in a white card; done ones green with a check, the current one
   orange, the step a closed order stopped at in red. Scrolls sideways on a phone. */
.progress {
  display: flex;
  gap: 14px;
  margin: 0;
  padding: 18px 20px;
  overflow-x: auto;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  list-style: none;
  scrollbar-width: thin;
}

.progress__step {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 10px;
  min-width: 128px;
}

.progress__dot {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--page);
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--t3);
}

.progress__dot--done {
  background: var(--green-bg);
  color: var(--green);
}

.progress__dot--next {
  background: var(--acc);
  color: var(--acc-on);
}

.progress__dot--skipped,
.progress__dot--closed {
  background: var(--ef);
}

.progress__dot--closed {
  color: var(--red);
}

.progress__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.progress__label {
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--t2);
}

.progress__step--done .progress__label,
.progress__step--skipped .progress__label {
  color: var(--ink);
}

.progress__step--next .progress__label {
  color: var(--acc-fg);
}

.progress__step--closed .progress__label {
  color: var(--red);
}

.progress__note {
  font-size: var(--fs-group);
  color: var(--t2);
}

.progress__arrow {
  flex: none;
  color: var(--t3);
}

/* Phone: actions right under the header, then the items, then contact and history. Wide: the
   v8 two columns, content on the left and a 360px side column (actions on top) on the right. */
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--gap-block);
  align-items: start;
}

.main,
.side {
  display: flex;
  flex-direction: column;
  gap: var(--gap-block);
  min-width: 0;
}

.side {
  gap: 16px;
}

@media (min-width: 1100px) {
  .layout {
    grid-template-columns: minmax(0, 1fr) 360px;
    grid-template-rows: auto 1fr;
    grid-template-areas:
      'main actions'
      'main side';
    row-gap: 16px;
  }

  .panel--actions {
    grid-area: actions;
  }

  .main {
    grid-area: main;
  }

  .side {
    grid-area: side;
  }
}

/* v8 card: white, hairline ring, 12px radius, 20px padding. */
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.panel--actions {
  gap: 16px;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.panel__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.panel__aside {
  font-size: var(--fs-group);
  color: var(--t2);
}

.panel__foot {
  margin: 0;
  font-size: var(--fs-group);
  color: var(--t2);
}

.fact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.fact__label {
  font-size: var(--fs-small);
  color: var(--t2);
}

.fact__value {
  font-size: var(--fs-small);
  font-weight: 600;
}

.method-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--e8);
}

.org {
  font-size: var(--fs-small);
  font-weight: 500;
}

/* v8 driver strip: an icon tile, the name, the phone on the right. */
.driver {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
}

.driver__icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-btn-sm);
  background: var(--page);
  color: var(--t2);
}

.driver__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.driver__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.driver__name {
  font-size: var(--fs-small);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.driver__call {
  display: inline-flex;
  align-items: center;
  font-size: var(--fs-small);
  white-space: nowrap;
  color: var(--acc-fg);
  text-decoration: none;
}

.comment {
  flex-direction: row;
  gap: 12px;
  padding: 18px 20px;
}

.comment__icon {
  color: var(--t2);
}

.comment__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.comment__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.comment__text {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
  overflow-wrap: anywhere;
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

.muted {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

@media (pointer: coarse), (hover: none) {
  .driver__call,
  .link {
    min-height: 44px;
  }
}

@media (max-width: 639px) {
  .progress {
    padding: 14px 16px;
  }

  .panel {
    padding: 16px;
  }
}
</style>
