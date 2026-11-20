<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import GuardedButton from '@/components/ui/GuardedButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useMediaQuery } from '@/composables/use-media-query';
import { useFormat } from '@core/i18n/use-format';
import { useAllocationPlan } from '../composables/use-allocation-plan';
import { useBlockerText } from '../composables/use-blocker-text';
import { useOrderActions } from '../composables/use-order-actions';
import { rejectBlockers } from '../domain/action-blockers';
import type { PlanChoice } from '../domain/allocation-plan';
import type { FullOrderDetail, PaymentMethod } from '../domain/order-model';
import ApproveOrderDialog from './ApproveOrderDialog.vue';
import ReasonDialog, { type ReasonSummary } from './ReasonDialog.vue';

// The manager's step on a SUBMITTED order, in the page header (approved design): «Rad etish» and
// «Tasdiqlash», nothing else (owner 2026-11-20: a new order is refused, not cancelled; cancelling
// stays for the later steps). «Tasdiqlash» opens the same approval dialog as the list (supply plan,
// Savdo turi, the accounting skip); «Rad etish» asks for the reason, which stays required
// (lifecycle §3). Below 1024px the group becomes the sticky bar at the bottom of the screen.
const props = defineProps<{
  order: FullOrderDetail;
  /** Unsaved item edits: deciding now would silently drop them. */
  draftPending: boolean;
  /** The page is saving something else (items, Savdo turi, the plan): deciding waits for it. */
  pageBusy: boolean;
}>();
const emit = defineEmits<{ changed: []; stale: [] }>();

const { t } = useI18n();
const wide = useMediaQuery('(min-width: 1024px)', true);
const { formatMoneyWithCurrency } = useFormat();

let stockRefused = false;
const approvalPlan = useAllocationPlan();
const actions = useOrderActions({
  onChanged: () => emit('changed'),
  onStale: () => emit('stale'),
  // A refusal over stock keeps the dialog open with the fresh plan: one click from approved.
  onAllocationConflict: (caught) => {
    stockRefused = approvalPlan.absorbConflict(caught);
    return stockRefused;
  },
});

const busy = ref(false);
async function run(work: () => Promise<boolean>): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  try {
    return await work();
  } finally {
    busy.value = false;
  }
}

// The item draft and the page's own saves block the buttons here; everything else is decided
// inside the dialog.
const blockerText = useBlockerText();
const draftReasons = computed(() =>
  blockerText.texts(rejectBlockers({ busy: props.pageBusy, draftPending: props.draftPending })),
);

// The sticky bar covers the bottom of the screen: toasts rise above it while it is shown.
watchEffect((onCleanup) => {
  if (wide.value) return;
  const root = document.documentElement;
  root.style.setProperty('--toast-bottom', '96px');
  onCleanup(() => root.style.removeProperty('--toast-bottom'));
});

const approveOpen = ref(false);
async function confirmApprove(
  skipAccounting: boolean,
  paymentMethod: PaymentMethod,
  order: FullOrderDetail,
  plan: PlanChoice,
): Promise<void> {
  stockRefused = false;
  const done = await run(() => actions.approve(order, paymentMethod, plan, skipAccounting));
  if (done || !stockRefused) approveOpen.value = false;
}

const reasonOpen = ref(false);
async function confirmReason(reason: string): Promise<void> {
  const done = await run(() => actions.reject(props.order, reason));
  if (done) reasonOpen.value = false;
}

const summary = computed<ReasonSummary>(() => ({
  orderNumber: props.order.orderNumber,
  total: formatMoneyWithCurrency(props.order.totalAmount),
  client: `${props.order.organizationName} · ${props.order.placedBy.fullName}`,
  plan: t(`orders.paymentPlan.${props.order.paymentPlan}`),
}));
</script>

<template>
  <!-- Below 1024px the group is a fixed bar; it leaves the page (whose entry animation would
       otherwise anchor a fixed element to itself) for the body. -->
  <Teleport to="body" :disabled="wide">
    <div class="hact" role="group" :aria-label="t('orders.detail.sections.actions')">
      <GuardedButton
        variant="secondary"
        size="lg"
        class="hact__reject"
        :reasons="draftReasons"
        :reasons-title="t('orders.blocked.title.reject')"
        data-testid="reject-button"
        @click="reasonOpen = true"
      >
        {{ t('orders.detail.actions.reject') }}
      </GuardedButton>
      <GuardedButton
        size="lg"
        class="hact__approve"
        :reasons="draftReasons"
        :reasons-title="t('orders.blocked.title.approve')"
        :loading="busy"
        data-testid="approve-button"
        @click="approveOpen = true"
      >
        <StaffIcon v-if="!busy" name="check" :size="16" />
        {{ t('orders.detail.actions.approve') }}
      </GuardedButton>
      <ApproveOrderDialog
        v-model="approveOpen"
        :order="order"
        :busy="busy"
        :plan="approvalPlan"
        @confirm="confirmApprove"
      />
      <ReasonDialog
        v-model="reasonOpen"
        kind="reject"
        :busy="busy"
        :summary="summary"
        @confirm="confirmReason"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.hact {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* The design: a white button with a red outline and red text (over the staff secondary look). */
.hact .hact__reject.btn {
  border: 0;
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--red);
  color: var(--red);
}

.hact .hact__reject.btn:hover:not(:disabled) {
  background: var(--hov);
}

/* Tablet and phone: the design's sticky bar at the bottom, the two steps side by side. */
@media (max-width: 1023px) {
  .hact {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: var(--z-action-bar);
    padding: 12px 16px calc(12px + var(--safe-bottom, 0px));
    border-top: 1px solid var(--e8);
    background: var(--w);
  }

  .hact__reject,
  .hact__approve {
    flex: 1 1 0;
    height: 52px;
  }
}
</style>
