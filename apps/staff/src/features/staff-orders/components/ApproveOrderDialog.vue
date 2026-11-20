<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PaymentMethod } from '@iorder/shared/staff-orders';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import GuardedButton from '@/components/ui/GuardedButton.vue';
import { useFormat } from '@core/i18n/use-format';
import { fromMilli, toMilli } from '@core/lib/quantity';
import {
  isFullDetail,
  isFullSummary,
  type FullOrderDetail,
  type OrderSummary,
} from '../domain/order-model';
import type { AllocationPlan } from '../composables/use-allocation-plan';
import { useBlockerText } from '../composables/use-blocker-text';
import { approveBlockers } from '../domain/action-blockers';
import type { PlanChoice } from '../domain/allocation-plan';
import AllocationPlanPicker from './AllocationPlanPicker.vue';
import PaymentMethodChoice from './PaymentMethodChoice.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const props = defineProps<{
  modelValue: boolean;
  /** The order to approve; null while the dialog is closed. */
  order: OrderSummary | null;
  /** The approval request is running: the confirm button locks. */
  busy: boolean;
  /** Owned by the parent, which feeds it the refusal of the approval it sends. */
  plan: AllocationPlan;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** The order as just read (its row version is the one the manager is deciding on). */
  confirm: [
    skipAccounting: boolean,
    paymentMethod: PaymentMethod,
    order: FullOrderDetail,
    plan: PlanChoice,
  ];
}>();

const { t } = useI18n();
const { formatMoney, formatMoneyWithCurrency, formatNumber } = useFormat();
const { ordersApi } = useServices();

// The list holds no lines, so the dialog reads the order itself: what is approved is what the
// manager sees here, with the row version it was read at.
const detail = ref<FullOrderDetail | null>(null);
const loadState = ref<'loading' | 'ready' | 'error'>('loading');
let run = 0;
async function loadDetail(id: string): Promise<void> {
  const mine = ++run;
  loadState.value = 'loading';
  detail.value = null;
  try {
    const result = await ordersApi.getOrder(id);
    if (mine !== run) return;
    if (isFullDetail(result)) {
      detail.value = result;
      loadState.value = 'ready';
    } else {
      loadState.value = 'error';
    }
  } catch {
    if (mine === run) loadState.value = 'error';
  }
}

// The order as just read wins over the list row it was opened from: its sum is the current one.
const fullOrder = computed(() => {
  if (detail.value && detail.value.id === props.order?.id) return detail.value;
  return props.order && isFullSummary(props.order) ? props.order : null;
});

// A quick call to the person who placed the order, to settle a doubt before approving.
const phone = computed(() => {
  const value = detail.value?.placedBy.phone;
  return value ? value.replace(/[^+\d]/g, '') : null;
});

/** Lines named in the dialog; the rest is summarised so the dialog stays small on a phone. */
const SHOWN_LINES = 4;

const skipAccounting = ref(false);
const paymentMethod = ref<PaymentMethod | null>(null);
// Approving without accounting cannot be undone, so it takes a second tap, as on the order page.
const confirmingSkip = ref(false);
// Every opening starts without the skip and without a payment method: both must be deliberate.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      skipAccounting.value = false;
      paymentMethod.value = null;
      confirmingSkip.value = false;
      if (props.order) {
        void loadDetail(props.order.id);
        void props.plan.load(props.order.id);
      }
    }
  },
);
watch(skipAccounting, () => {
  confirmingSkip.value = false;
});

const shown = computed(() => detail.value?.items.slice(0, SHOWN_LINES) ?? []);
const hidden = computed(() => Math.max((detail.value?.items.length ?? 0) - SHOWN_LINES, 0));
const pieces = computed(() =>
  formatNumber(
    fromMilli((detail.value?.items ?? []).reduce((sum, i) => sum + toMilli(i.quantity), 0n)),
  ),
);

function onUpdate(value: boolean): void {
  // Closing while the request runs would hide its outcome.
  if (!value && props.busy) return;
  emit('update:modelValue', value);
}

// Why the confirm button is off, if it is: the same list as on the order page (the dialog has no
// item edits, and it reads the order itself).
const blockerText = useBlockerText();
const blocked = computed(() =>
  approveBlockers({
    busy: props.busy,
    order: loadState.value,
    draftPending: false,
    planState: props.plan.state.value,
    preview: props.plan.preview.value,
    draft: props.plan.draft.value,
    paymentMethod: paymentMethod.value,
  }),
);
const reasons = computed(() => blockerText.texts(blocked.value));
// Printed only over a loaded order: while it loads or fails the dialog already says so above.
const note = computed(() => (loadState.value === 'ready' ? blockerText.note(blocked.value) : null));

function confirm(): void {
  // The button only explains itself while something blocks it; this is the second lock.
  if (blocked.value.length > 0) return;
  if (skipAccounting.value && !confirmingSkip.value) {
    confirmingSkip.value = true;
    return;
  }
  const choice = props.plan.choice.value;
  if (detail.value && paymentMethod.value && choice) {
    emit('confirm', skipAccounting.value, paymentMethod.value, detail.value, choice);
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('orders.approveDialog.title')"
    :description="t('orders.approveDialog.notice')"
    @update:model-value="onUpdate"
  >
    <!-- The approved design's summary box: number, total, customer · who placed it, payment plan. -->
    <div v-if="order" class="sum" data-testid="approve-summary">
      <span class="sum__row">
        <b class="sum__id mono">{{ order.orderNumber }}</b>
        <b v-if="fullOrder" class="mono">{{ formatMoneyWithCurrency(fullOrder.totalAmount) }}</b>
      </span>
      <span class="sum__who">
        {{ order.organizationName }}
        <template v-if="fullOrder">· {{ fullOrder.placedBy.fullName }}</template>
      </span>
      <span v-if="fullOrder" class="sum__plan">{{
        t(`orders.paymentPlan.${fullOrder.paymentPlan}`)
      }}</span>
    </div>
    <p v-if="loadState === 'loading'" class="status" role="status">{{ t('state.loading') }}</p>
    <p v-else-if="loadState === 'error'" class="status status--error" role="alert">
      {{ t('orders.approveDialog.loadError') }}
      <button v-if="order" type="button" class="retry" @click="loadDetail(order.id)">
        {{ t('state.retry') }}
      </button>
    </p>
    <template v-else-if="detail">
      <p class="who">
        <i18n-t scope="global" keypath="orders.approveDialog.placedBy">
          <template #name>
            <PersonName :name="detail.placedBy.fullName" :user-id="detail.placedBy.userId" />
          </template>
        </i18n-t>
        <a v-if="phone" class="who__call" :href="`tel:${phone}`">{{
          t('orders.approveDialog.call')
        }}</a>
      </p>
      <ul class="lines">
        <li v-for="line in shown" :key="line.id" class="lines__item">
          <span class="lines__name">{{ line.name }}</span>
          <span class="lines__qty num">{{ `× ${formatNumber(line.quantity)}` }}</span>
        </li>
        <li v-if="hidden > 0" class="lines__more">
          {{ t('orders.approveDialog.more', { count: hidden }) }}
        </li>
      </ul>
      <p class="total">
        <span>
          {{ t('dashboard.queue.positions', { count: detail.itemCount }, detail.itemCount) }}
          · {{ t('orders.approveDialog.pieces', { count: pieces }) }}
        </span>
        <b class="num">{{ formatMoney(detail.totalAmount) }} {{ t('common.currency') }}</b>
      </p>
      <AllocationPlanPicker
        class="allocation"
        :plan="plan"
        :order-id="detail.id"
        :disabled="busy"
      />
      <PaymentMethodChoice
        v-model="paymentMethod"
        class="method"
        :disabled="busy"
        required
        :hint="t('orders.paymentMethod.required')"
      />
      <label class="skip">
        <input v-model="skipAccounting" type="checkbox" class="skip__box" />
        <span class="skip__text">
          <span class="skip__title">{{ t('orders.detail.actions.skipAccounting') }}</span>
          <span class="skip__hint">{{ t('orders.detail.actions.skipAccountingHint') }}</span>
        </span>
      </label>
      <p v-if="confirmingSkip" class="skip-confirm" role="alert" data-testid="approve-skip-confirm">
        {{ t('orders.detail.actions.approveSkipConfirm') }}
      </p>
      <p v-if="note" class="blocked" data-testid="approve-reason">{{ note }}</p>
    </template>
    <template #footer>
      <AppButton
        v-if="confirmingSkip"
        variant="secondary"
        size="lg"
        :disabled="busy"
        @click="confirmingSkip = false"
      >
        {{ t('orders.detail.actions.approveSkipBack') }}
      </AppButton>
      <AppButton v-else variant="secondary" size="lg" :disabled="busy" @click="onUpdate(false)">
        {{ t('orders.approveDialog.back') }}
      </AppButton>
      <GuardedButton
        size="lg"
        :loading="busy"
        :reasons="reasons"
        :reasons-title="t('orders.blocked.title.approve')"
        data-testid="approve-confirm"
        @click="confirm"
      >
        {{
          confirmingSkip
            ? t('orders.detail.actions.approveSkipYes')
            : t('orders.approveDialog.confirm')
        }}
      </GuardedButton>
    </template>
  </AppModal>
</template>
<style scoped>
/* The approved design's grey summary box above the choices. */
.sum {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 16px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--page);
}

.sum__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.mono {
  font-family: var(--font-mono);
}

.sum__id {
  font-size: var(--fs-body);
}

.sum__who {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.sum__plan {
  font-size: var(--fs-body);
  color: var(--t3);
}

.status {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.status--error {
  color: var(--red);
}

.retry {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-weight: 600;
  color: var(--acc-fg);
  cursor: pointer;
}

.who {
  margin: 0 0 12px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.who__call {
  margin-left: 6px;
  color: var(--acc-fg);
  text-decoration: none;
}

/* v8 approval modal: the lines in a hairline box ruled by hairlines. */
.lines {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border-radius: var(--r-row);
  box-shadow: inset 0 0 0 1px var(--e8);
  list-style: none;
}

.lines__item,
.lines__more {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: var(--fs-small);
}

.lines__item + .lines__item,
.lines__more {
  border-top: 1px solid var(--e8);
}

.lines__name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.lines__qty {
  flex: none;
  color: var(--t2);
}

.lines__more {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.total {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  margin: 8px 0 18px;
  padding: 12px 14px;
  border-radius: var(--r-row);
  background: var(--f5);
  font-size: var(--fs-small);
  color: var(--t2);
}

.total b {
  font-size: var(--fs-section);
  font-weight: 500;
  color: var(--ink);
}

.allocation,
.method {
  margin-bottom: 18px;
}

.skip {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}

.skip__box {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 1px 0 0;
  accent-color: var(--acc);
}

.skip__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skip__title {
  font-size: var(--fs-small);
  font-weight: 500;
}

.skip__hint {
  font-size: var(--fs-group);
  color: var(--t2);
}

/* The first thing to do before "Approve" works, in the accent colour of the order page's line. */
.blocked {
  margin: 12px 0 0;
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

/* Same orange notice as the order page's skip confirmation. */
.skip-confirm {
  margin: 12px 0 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  font-size: var(--fs-small);
  font-weight: 600;
}
</style>
