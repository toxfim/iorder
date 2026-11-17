<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import { PermissionDeniedError } from '@core/lib/api-errors';
import AppButton from '@core/components/ui/AppButton.vue';
import GuardedButton from '@/components/ui/GuardedButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { DriverOption } from '../api/drivers-api';
import { useOrderActions, type ActionOrder } from '../composables/use-order-actions';
import { useOrderPicking, type OrderPicking } from '../composables/use-order-picking';
import { useBlockerText } from '../composables/use-blocker-text';
import { approveBlockers, rejectBlockers, releaseBlockers } from '../domain/action-blockers';
import { canBeCancelled, isClosedWithoutDelivery } from '../domain/order-model';
import type { OrderStatus } from '@iorder/shared';
import type { GoodsReturnState, PaymentMethod } from '@iorder/shared/staff-orders';
import { useAllocationPlan } from '../composables/use-allocation-plan';
import AllocationPlanPicker from './AllocationPlanPicker.vue';
import PaymentMethodChoice from './PaymentMethodChoice.vue';
import ReasonDialog from './ReasonDialog.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const props = defineProps<{
  order: ActionOrder & { status: OrderStatus; goodsReturn: GoodsReturnState };
  /** The manager has unsaved item edits: deciding now would silently drop them. */
  draftPending?: boolean;
  /** Bigger buttons for the driver's phone. */
  large?: boolean;
  /**
   * The order page's picking view (its scanner panel and this release button share it). Without
   * one (a queue card) the panel reads the codes itself and links to the order page to scan.
   */
  picking?: OrderPicking;
}>();
const emit = defineEmits<{ changed: []; stale: [] }>();

const { t } = useI18n();
const { driversApi } = useServices();
const actions = useOrderActions({
  onChanged: () => emit('changed'),
  onStale: () => emit('stale'),
  // The server found codes missing: show what it has now, so the missing lines are listed.
  onCodesIncomplete: () => void codes.value.load({ silent: true }),
  onAllocationConflict: (caught) => allocationPlan.absorbConflict(caught),
});

const allocationPlan = useAllocationPlan();
const permissions = computed(() => actions.permissions());
const status = computed(() => props.order.status);

// Each step is offered only to the role that owns it, at the status it owns (lifecycle §3, §5).
// Anything else is absent, and the text below explains who is next instead of a disabled button.
const managerStep = computed(() => permissions.value.canDecide && status.value === 'SUBMITTED');
const accountingStep = computed(
  () => permissions.value.canAccount && status.value === 'MANAGER_APPROVED',
);
const releaseStep = computed(
  () => permissions.value.canRelease && status.value === 'ACCOUNTING_CLEARED',
);
// [C] 2026-10-30: the warehouse prepares and scans right after the approval. The release button is
// there but locked until accounting clears the order, so the next step is visible.
const prepareStep = computed(
  () => permissions.value.canRelease && status.value === 'MANAGER_APPROVED',
);
const returnStep = computed(
  () => permissions.value.canRelease && props.order.goodsReturn === 'PENDING',
);
const deliverStep = computed(() => permissions.value.canDeliver && status.value === 'RELEASED');
const cancellable = computed(
  () => permissions.value.canCancel && canBeCancelled(props.order.status),
);
const hasStep = computed(
  () =>
    managerStep.value ||
    accountingStep.value ||
    releaseStep.value ||
    prepareStep.value ||
    returnStep.value ||
    deliverStep.value,
);

const note = computed(() => {
  if (props.order.goodsReturn === 'RETURNED' && permissions.value.canRelease) {
    return t('orders.warehouse.toReturn.done');
  }
  if (isClosedWithoutDelivery(status.value)) return t('orders.detail.actions.closed');
  if (status.value === 'RECEIVED') return t('orders.detail.actions.finished');
  const next = t('orders.detail.actions.next', {
    who: t(`orders.detail.actions.nextBy.${status.value}`),
  });
  if (permissions.value.canDecide) return next;
  if (permissions.value.isAdmin) return `${t('orders.detail.actions.adminNote')} ${next}`;
  if (permissions.value.isPurchasing) return `${t('orders.detail.actions.readOnlyNote')} ${next}`;
  return next;
});
// The manager between approval and release can only cancel: v8 says so above the button.
const cancelOnlyText = computed(() =>
  t('orders.detail.actions.cancelOnly', { stage: t(`orders.stages.${status.value}`) }),
);

const moreOpen = ref(false);
const moreId = useId();
const rejectHintId = useId();
const approveHintId = useId();
const cancelHintId = useId();
const releaseHintId = useId();

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

const skipAccounting = ref(false);
// Required for the approval, never preselected: the manager picks it for every order.
const paymentMethod = ref<PaymentMethod | null>(null);
// Skipping accounting and the payment method are deliberate choices for every order: both start
// empty again.
watch(
  () => props.order.id,
  () => {
    skipAccounting.value = false;
    paymentMethod.value = null;
  },
);
// What happened, in words, once the status has moved on: there is no undo for an approval, so the
// person is told what the system does next instead.
// The plan is read when the manager's step is open, and again when the order or its version moves.
watch(
  [managerStep, () => props.order.id, () => props.order.rowVersion],
  ([open]) => {
    if (open) void allocationPlan.load(props.order.id);
  },
  { immediate: true },
);
const justApproved = ref<'normal' | 'skipped' | null>(null);
// The status our own approval leads to. The message goes away when the order is somewhere else
// (another person acted, or it was reloaded): "sent to accounting" would then be untrue.
const approvedStatus = computed<OrderStatus | null>(() => {
  if (justApproved.value === null) return null;
  return justApproved.value === 'skipped' ? 'ACCOUNTING_CLEARED' : 'MANAGER_APPROVED';
});
watch(status, (next) => {
  if (approvedStatus.value !== null && next !== approvedStatus.value) justApproved.value = null;
});
watch(
  () => props.order.id,
  () => {
    justApproved.value = null;
  },
);
// Approving without accounting cannot be undone, so it takes a second, deliberate tap.
const confirmingSkip = ref(false);
watch([() => props.order.id, skipAccounting], () => {
  confirmingSkip.value = false;
});
// Why approve and reject are off, if they are: one list each, shared by the line under the
// button, its tooltip and the dialog a tap opens.
const blockerText = useBlockerText();
const approveBlocked = computed(() =>
  approveBlockers({
    busy: busy.value,
    draftPending: props.draftPending === true,
    planState: allocationPlan.state.value,
    preview: allocationPlan.preview.value,
    draft: allocationPlan.draft.value,
    paymentMethod: paymentMethod.value,
  }),
);
const approveReasons = computed(() => blockerText.texts(approveBlocked.value));
const approveNote = computed(() => blockerText.note(approveBlocked.value));
const rejectReasons = computed(() =>
  blockerText.texts(
    rejectBlockers({ busy: busy.value, draftPending: props.draftPending === true }),
  ),
);
const askApprove = (): void => {
  // The button only explains itself while something blocks it; this is the second lock.
  if (approveBlocked.value.length > 0) return;
  if (skipAccounting.value) confirmingSkip.value = true;
  else void approve();
};
const approve = async (): Promise<boolean> => {
  if (approveBlocked.value.length > 0) return false;
  confirmingSkip.value = false;
  const skipped = skipAccounting.value;
  const method = paymentMethod.value;
  const plan = allocationPlan.choice.value;
  if (method === null || plan === null) return false;
  const done = await run(() => actions.approve(props.order, method, plan, skipped));
  if (done) justApproved.value = skipped ? 'skipped' : 'normal';
  return done;
};
const accountingApprove = (): Promise<boolean> => run(() => actions.accountingApprove(props.order));

const DELIVERY_NOTE_MAX = 1000;
const deliveryNote = ref('');
const deliveryNoteId = useId();
const deliver = async (): Promise<void> => {
  const done = await run(() => actions.deliver(props.order, deliveryNote.value));
  if (done) deliveryNote.value = '';
};

// --- release with a driver -------------------------------------------------------------------------

const driverId = ref<string | null>(null);
const drivers = ref<readonly DriverOption[]>([]);
const driversState = ref<'idle' | 'loading' | 'ready' | 'error' | 'denied'>('idle');
async function loadDrivers(): Promise<void> {
  driversState.value = 'loading';
  try {
    drivers.value = await driversApi.listActiveDrivers();
    driversState.value = 'ready';
  } catch (error) {
    // A missing permission does not heal by asking again, so it gets no retry button.
    driversState.value = error instanceof PermissionDeniedError ? 'denied' : 'error';
  }
}
// Only the warehouse at the release step needs the drivers; nobody else asks for the list.
watch(releaseStep, (needed) => needed && driversState.value === 'idle' && void loadDrivers(), {
  immediate: true,
});
const driverGroup = useId();
// --- unit codes: the release waits until every required code is scanned ---------------------

const ownPicking = useOrderPicking(() => props.order.id);
const codes = computed<OrderPicking>(() => props.picking ?? ownPicking);
watch(
  [computed(() => releaseStep.value || prepareStep.value), () => props.order.id],
  ([needed]) => {
    if (needed && !props.picking)
      void ownPicking.load({ silent: ownPicking.picking.value !== null });
  },
  { immediate: true },
);
const codesState = computed(() => codes.value.state.value);
const codesComplete = computed(() => codes.value.complete.value);
const codesProgress = computed(() => codes.value.progress.value);
const missingLines = computed(() =>
  (codes.value.picking.value?.lines ?? []).filter((line) => line.incompleteUnits > 0),
);

const releaseBlocked = computed(() =>
  releaseBlockers({
    busy: busy.value,
    cleared: releaseStep.value,
    codesState: codesState.value,
    codesComplete: codesComplete.value,
    codesProgress: codesProgress.value,
    driversState: driversState.value,
    driverCount: drivers.value.length,
    driverChosen: driverId.value !== null,
  }),
);
const releaseReasons = computed(() => blockerText.texts(releaseBlocked.value));
const releaseNote = computed(() => blockerText.note(releaseBlocked.value));

const release = (): Promise<boolean> => {
  const driver = driverId.value;
  // The button only explains itself while something blocks it; this is the second lock.
  if (driver === null || releaseBlocked.value.length > 0) return Promise.resolve(false);
  return run(() => actions.release(props.order, driver));
};

const markGoodsReturned = (): Promise<boolean> => run(() => actions.markGoodsReturned(props.order));

// --- reasons --------------------------------------------------------------------------------------

type ReasonFor = 'reject' | 'accountingReject' | 'cancel';
const reasonFor = ref<ReasonFor | null>(null);
const lastReason = ref<ReasonFor>('reject');
const reasonOpen = computed({
  get: () => reasonFor.value !== null,
  set: (value) => {
    if (!value) reasonFor.value = null;
  },
});
const openReason = (kind: ReasonFor): void => {
  lastReason.value = kind;
  reasonFor.value = kind;
};

async function confirmReason(reason: string): Promise<void> {
  const kind = reasonFor.value;
  if (!kind) return;
  const done = await run(() => {
    if (kind === 'cancel') return actions.cancel(props.order, reason);
    if (kind === 'accountingReject') return actions.accountingReject(props.order, reason);
    return actions.reject(props.order, reason);
  });
  if (done) reasonFor.value = null;
}
</script>

<template>
  <div class="actions" :class="{ 'actions--large': large }">
    <template v-if="managerStep">
      <AllocationPlanPicker :plan="allocationPlan" :order-id="order.id" :disabled="busy" />
      <PaymentMethodChoice
        v-model="paymentMethod"
        :disabled="busy"
        required
        :hint="t('orders.paymentMethod.required')"
      />
      <!-- The accounting skip sits above the approve button, not between approve and reject, so a
           mis-tap on the full-row targets below cannot toggle it. -->
      <fieldset class="skip">
        <legend class="sr-only">{{ t('orders.detail.actions.skipSection') }}</legend>
        <label class="skip__label">
          <input v-model="skipAccounting" type="checkbox" class="skip__box" />
          <span class="skip__text">
            <span class="skip__title">{{ t('orders.detail.actions.skipAccounting') }}</span>
            <span class="skip__hint">{{ t('orders.detail.actions.skipAccountingHint') }}</span>
          </span>
        </label>
      </fieldset>
      <!-- Approving without accounting cannot be undone: a second, deliberate tap. -->
      <div v-if="confirmingSkip" class="block confirm" data-testid="skip-confirm">
        <p class="confirm__text" role="alert">
          {{ t('orders.detail.actions.approveSkipConfirm') }}
        </p>
        <GuardedButton
          size="xl"
          block
          :reasons="approveReasons"
          :reasons-title="t('orders.blocked.title.approve')"
          :loading="busy"
          data-testid="skip-confirm-yes"
          @click="approve"
        >
          {{ t('orders.detail.actions.approveSkipYes') }}
        </GuardedButton>
        <p v-if="approveNote" class="hint hint--blocked" data-testid="approve-reason">
          {{ approveNote }}
        </p>
        <AppButton
          variant="secondary"
          block
          :disabled="busy"
          data-testid="skip-confirm-back"
          @click="confirmingSkip = false"
        >
          {{ t('orders.detail.actions.approveSkipBack') }}
        </AppButton>
      </div>
      <div v-else class="block">
        <GuardedButton
          size="xl"
          block
          class="main"
          :reasons="approveReasons"
          :reasons-title="t('orders.blocked.title.approve')"
          :loading="busy"
          :described-by="approveNote ? undefined : approveHintId"
          data-testid="approve-button"
          @click="askApprove"
        >
          <StaffIcon v-if="!busy" name="check" :size="16" />
          {{
            t(
              skipAccounting
                ? 'orders.detail.actions.approveSkip'
                : 'orders.detail.actions.approve',
            )
          }}
        </GuardedButton>
        <!-- While something blocks the approval this line names the first thing to do; the
             button's tooltip and its dialog list everything. -->
        <p v-if="approveNote" class="hint hint--blocked" data-testid="approve-reason">
          {{ approveNote }}
        </p>
        <p v-else :id="approveHintId" class="hint">
          {{
            t(
              skipAccounting
                ? 'orders.detail.actions.approveHintSkipped'
                : 'orders.detail.actions.approveHint',
            )
          }}
        </p>
      </div>
      <!-- Rejecting (the order was not accepted) and cancelling (an accepted order stops) are
           different things to the customer, so cancel is kept one step away, under "More". -->
      <div class="block">
        <div class="pair">
          <GuardedButton
            variant="secondary"
            :reasons="rejectReasons"
            :reasons-title="t('orders.blocked.title.reject')"
            :described-by="rejectHintId"
            data-testid="reject-button"
            @click="openReason('reject')"
          >
            {{ t('orders.detail.actions.reject') }}
          </GuardedButton>
          <AppButton
            v-if="cancellable"
            variant="secondary"
            :aria-expanded="moreOpen"
            :aria-controls="moreId"
            @click="moreOpen = !moreOpen"
          >
            {{ t('orders.detail.actions.more') }}
            <StaffIcon
              name="down"
              :size="13"
              class="chevron"
              :class="{ 'chevron--open': moreOpen }"
            />
          </AppButton>
        </div>
        <p :id="rejectHintId" class="hint">{{ t('orders.detail.actions.rejectHint') }}</p>
      </div>
      <div v-if="cancellable && moreOpen" :id="moreId" class="block">
        <AppButton
          variant="secondary"
          block
          class="cancel"
          :disabled="busy"
          :aria-describedby="cancelHintId"
          @click="openReason('cancel')"
        >
          <StaffIcon name="x" :size="14" />
          {{ t('orders.detail.actions.cancel') }}
        </AppButton>
        <p :id="cancelHintId" class="hint">{{ t('orders.detail.actions.cancelHint') }}</p>
      </div>
    </template>

    <template v-else-if="accountingStep">
      <p class="lead">{{ t('orders.detail.actions.accountingHint') }}</p>
      <AppButton size="xl" block class="main" :loading="busy" @click="accountingApprove">
        <StaffIcon v-if="!busy" name="check" :size="16" />
        {{ t('orders.detail.actions.accountingApprove') }}
      </AppButton>
      <AppButton variant="secondary" block :disabled="busy" @click="openReason('accountingReject')">
        {{ t('orders.detail.actions.reject') }}
      </AppButton>
    </template>

    <template v-else-if="returnStep">
      <p class="lead" data-testid="goods-return-note">{{ t('orders.warehouse.toReturn.hint') }}</p>
      <AppButton
        size="xl"
        block
        class="main"
        :loading="busy"
        data-testid="goods-returned-button"
        @click="markGoodsReturned"
      >
        <StaffIcon v-if="!busy" name="check" :size="16" />
        {{ t('orders.warehouse.toReturn.button') }}
      </AppButton>
    </template>

    <template v-else-if="releaseStep || prepareStep">
      <p v-if="prepareStep" class="lead" data-testid="prepare-note">
        {{ t('orders.warehouse.prepare.pending') }}
      </p>
      <fieldset v-if="releaseStep" class="drivers">
        <legend class="field__label">
          {{ t('orders.detail.actions.driver') }}<span aria-hidden="true"> *</span>
        </legend>
        <p v-if="driversState === 'denied'" class="note note--error" role="alert">
          {{ t('orders.detail.actions.driversForbidden') }}
        </p>
        <p v-else-if="driversState === 'error'" class="note note--error" role="alert">
          {{ t('orders.detail.actions.driversError') }}
          <button type="button" class="link" @click="loadDrivers">{{ t('state.retry') }}</button>
        </p>
        <p v-else-if="driversState !== 'ready'" class="note" role="status">
          {{ t('orders.detail.actions.driversLoading') }}
        </p>
        <p v-else-if="drivers.length === 0" class="note">
          {{ t('orders.detail.actions.noDrivers') }}
        </p>
        <template v-else>
          <label
            v-for="driver in drivers"
            :key="driver.id"
            class="driver"
            :class="{ 'driver--on': driverId === driver.id }"
          >
            <input
              v-model="driverId"
              type="radio"
              class="driver__radio"
              :name="driverGroup"
              :value="driver.id"
              :disabled="busy"
            />
            <span class="driver__name"
              ><PersonName :name="driver.fullName" :user-id="driver.id"
            /></span>
          </label>
        </template>
      </fieldset>

      <p v-if="codesState === 'loading' || codesState === 'idle'" class="note" role="status">
        {{ t('orders.picking.checking') }}
      </p>
      <p v-else-if="codesState === 'error'" class="note note--error" role="alert">
        {{ t('orders.picking.loadError') }}
        <button type="button" class="link" @click="codes.load()">{{ t('state.retry') }}</button>
      </p>
      <p v-else-if="codesState === 'denied'" class="note note--error" role="alert">
        {{ t('orders.picking.denied') }}
      </p>
      <div
        v-else-if="codesState === 'ready' && codesProgress.total > 0"
        class="codes"
        role="status"
        :data-testid="codesComplete ? 'release-codes-ready' : 'release-codes-missing'"
      >
        <div class="codes__head">
          <span class="codes__title">{{ t('orders.detail.actions.codesTitle') }}</span>
          <span class="codes__count" :class="{ 'codes__count--done': codesComplete }">{{
            t('orders.detail.actions.codesReady', codesProgress)
          }}</span>
        </div>
        <template v-if="!codesComplete">
          <span class="sr-only">{{ t('orders.picking.releaseBlocked', codesProgress) }}</span>
          <ul class="codes__list">
            <li v-for="line in missingLines" :key="line.itemId">
              {{
                t('orders.picking.missingLine', { name: line.name, count: line.incompleteUnits })
              }}
            </li>
          </ul>
          <RouterLink
            v-if="!picking"
            class="link"
            :to="{ name: 'staff-order', params: { orderId: order.id } }"
          >
            {{ t('orders.picking.openToScan') }}
          </RouterLink>
        </template>
      </div>
      <GuardedButton
        size="xl"
        block
        class="main"
        :reasons="releaseReasons"
        :reasons-title="t('orders.blocked.title.release')"
        :loading="busy"
        :described-by="releaseNote ? undefined : releaseHintId"
        data-testid="release-button"
        @click="release"
      >
        <StaffIcon v-if="!busy" name="truck" :size="16" />
        {{ t('orders.detail.actions.release') }}
      </GuardedButton>
      <!-- While something blocks the release this line names the first thing to do. -->
      <p v-if="releaseNote" class="hint hint--blocked" data-testid="release-reason">
        {{ releaseNote }}
      </p>
      <p v-else :id="releaseHintId" class="hint">
        {{ t('orders.detail.actions.releaseHint') }}
      </p>
    </template>

    <template v-else-if="deliverStep">
      <label :for="deliveryNoteId" class="field__label">
        {{ t('orders.detail.actions.deliveryNote') }}
      </label>
      <textarea
        :id="deliveryNoteId"
        v-model="deliveryNote"
        class="note-field"
        rows="3"
        :maxlength="DELIVERY_NOTE_MAX"
        :placeholder="t('orders.detail.actions.deliveryNotePlaceholder')"
      />
      <span class="counter">{{
        t('orders.detail.actions.deliveryNoteCount', {
          count: deliveryNote.length,
          max: DELIVERY_NOTE_MAX,
        })
      }}</span>
      <AppButton size="xl" block class="main" :loading="busy" @click="deliver">
        <StaffIcon v-if="!busy" name="check" :size="16" />
        {{ t('orders.detail.actions.delivered') }}
      </AppButton>
    </template>

    <p v-if="justApproved && !managerStep" class="done" role="status" data-testid="approved-next">
      <StaffIcon name="circlecheck" :size="15" />
      {{
        t(
          justApproved === 'skipped'
            ? 'orders.detail.actions.approvedNextSkipped'
            : 'orders.detail.actions.approvedNext',
        )
      }}
    </p>
    <div v-if="!hasStep" class="info">
      <StaffIcon name="clock" :size="15" class="info__icon" />
      <p class="note">{{ note }}</p>
    </div>
    <template v-if="cancellable && !managerStep">
      <p class="lead">{{ cancelOnlyText }}</p>
      <AppButton
        variant="secondary"
        block
        class="cancel"
        :disabled="busy"
        @click="openReason('cancel')"
      >
        <StaffIcon name="x" :size="14" />
        {{ t('orders.detail.actions.cancel') }}
      </AppButton>
    </template>

    <ReasonDialog
      v-model="reasonOpen"
      :kind="(reasonFor ?? lastReason) === 'cancel' ? 'cancel' : 'reject'"
      :busy="busy"
      @confirm="confirmReason"
    />
  </div>
</template>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field__label {
  margin: 0 0 8px;
  padding: 0;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.main {
  font-size: var(--fs-body);
}

.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.chevron {
  transition: transform 0.2s var(--ease);
}

.chevron--open {
  transform: rotate(180deg);
}

.cancel {
  justify-content: flex-start;
  color: var(--red);
}

/* v8 checkbox row: the box and two lines of text; the box stays native for the keyboard. */
.skip {
  margin: 0;
  padding: 0;
  border: 0;
}

.skip__label {
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

.confirm {
  padding: 14px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.confirm__text {
  margin: 0 0 4px;
  font-size: var(--fs-small);
  font-weight: 600;
}

.lead {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.hint {
  margin: 0;
  font-size: var(--fs-group);
  color: var(--t2);
}

.note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* The first thing to do before the button above works: where the hint sits, in the accent colour. */
.hint--blocked {
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

.note--error {
  color: var(--red);
}

/* v8 info box: a grey panel with a clock, for "who is next" and closed orders. */
.info {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  color: var(--t2);
}

.info__icon {
  margin-top: 1px;
}

.done {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--green);
}

/* v8 driver choice: one radio card per driver, an orange ring on the chosen one. */
.drivers {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.driver {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  cursor: pointer;
}

.driver:hover {
  background: var(--hov);
}

.driver--on,
.driver--on:hover {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.driver:focus-within {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.driver__radio {
  flex: none;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--acc);
}

.driver__name {
  font-size: var(--fs-small);
  font-weight: 500;
}

.codes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.codes__head {
  display: flex;
  align-self: stretch;
  justify-content: space-between;
  gap: 8px;
}

.codes__title {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.codes__count {
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--acc-fg);
}

.codes__count--done {
  color: var(--green);
}

.codes__list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

.link {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--acc-fg);
  cursor: pointer;
}

.note-field {
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font: inherit;
  /* 16px on a phone keeps iOS from zooming in; v8's 12px applies with a mouse. */
  font-size: 16px;
  color: var(--ink);
  resize: vertical;
}

.note-field:focus {
  outline: none;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.counter {
  align-self: flex-end;
  margin-top: -8px;
  font-size: var(--fs-group);
  color: var(--t2);
}

/* The driver works one-handed on a phone: the delivered button is as big as a thumb. */
.actions--large .main {
  height: 56px;
  font-size: var(--fs-section);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (hover: hover) and (pointer: fine) {
  .note-field {
    font-size: var(--fs-small);
  }
}

@media (pointer: coarse), (hover: none) {
  .link {
    min-height: 44px;
  }
}
</style>
