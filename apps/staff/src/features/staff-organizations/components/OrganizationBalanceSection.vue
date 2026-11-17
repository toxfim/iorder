<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  CorrectPaymentRequest,
  OrganizationBalanceResponse,
  OrganizationPayment,
  RecordPaymentRequest,
  VoidPaymentRequest,
} from '@iorder/shared/staff-orders';
import { useServices } from '@/app/services';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { useFormat } from '@core/i18n/use-format';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { compareMoney } from '@core/lib/money';
import {
  balancePermissions,
  businessToday,
  describeBalanceError,
  formatPaidOn,
} from '../domain/organization-balance';
import PaymentDialog, { type PaymentDialogMode } from './PaymentDialog.vue';
import PersonName from '@/features/people/components/PersonName.vue';

// The organization's debt and its payments ([C] 2026-10-26), in USD with the so'm equivalent at the
// current rate [P]. Every figure comes from the server; the page only shows it and renders the
// balance each action answers.
const props = defineProps<{ organizationId: string }>();

const { t } = useI18n();
const { organizationBalanceApi, currentUser, clock } = useServices();
const { formatMoneyWithCurrency, formatShortDateTime } = useFormat();
const { formatUsd, formatRate } = useCostFormat();

const permissions = computed(() => balancePermissions(currentUser.user.value?.staffRoles ?? []));

// Warehouse and driver never reach the server: the section is not drawn for them at all.
const view = useAsyncView<OrganizationBalanceResponse>(
  () =>
    permissions.value.canView
      ? organizationBalanceApi.getBalance(props.organizationId)
      : Promise.reject(new PermissionDeniedError()),
  { isEmpty: () => false },
);
watch(
  () => props.organizationId,
  () => void view.reload(),
);

const balance = computed(() => view.data.value);
const hasDue = computed(
  () => balance.value !== null && compareMoney(balance.value.amountDue, '0') > 0,
);
const hasOverpaid = computed(
  () => balance.value !== null && compareMoney(balance.value.overpaid, '0') > 0,
);

const isVoided = (payment: OrganizationPayment): boolean => payment.voidedAt !== null;

const approx = (uzs: string): string =>
  t('organizations.balance.approxUzs', { amount: formatMoneyWithCurrency(uzs) });

/** Under the USD value: what was really paid, or the so'm equivalent of a dollar payment. */
function paymentDetail(payment: OrganizationPayment): string {
  if (payment.currency === 'UZS' && payment.rate !== null) {
    return t('organizations.balance.paidInUzs', {
      amount: formatMoneyWithCurrency(payment.amount),
      rate: formatRate(payment.rate),
    });
  }
  return payment.amountUzs === null ? '' : approx(payment.amountUzs);
}

const columns = computed<DataTableColumn<OrganizationPayment>[]>(() => [
  {
    key: 'paidOn',
    label: t('organizations.balance.columns.paidOn'),
    width: '130px',
    text: (p) => formatPaidOn(p.paidOn),
  },
  {
    key: 'amount',
    label: t('organizations.balance.columns.amount'),
    align: 'end',
    width: '230px',
    text: (p) => formatUsd(p.amountUsd),
  },
  {
    key: 'comment',
    label: t('organizations.balance.columns.comment'),
    truncate: true,
    text: (p) => p.comment ?? '',
  },
  {
    key: 'recordedBy',
    label: t('organizations.balance.columns.recordedBy'),
    width: '170px',
    truncate: true,
    text: (p) => p.recordedByName,
  },
  {
    key: 'recordedAt',
    label: t('organizations.balance.columns.recordedAt'),
    width: '150px',
    text: (p) => formatShortDateTime(p.recordedAt),
  },
  {
    key: 'actions',
    label: t('organizations.balance.columns.actions'),
    srOnlyLabel: true,
    width: '200px',
    hidden: !permissions.value.canFix,
  },
]);

// --- dialogs ---------------------------------------------------------------------------------------

const dialogOpen = ref(false);
const dialogMode = ref<PaymentDialogMode>('record');
// Kept after closing so the dialog text does not blank out during the exit animation.
const target = ref<OrganizationPayment | null>(null);
const busy = ref(false);
const dialogError = ref<string | null>(null);
const today = ref(businessToday(clock));

function open(mode: PaymentDialogMode, payment: OrganizationPayment | null = null): void {
  dialogMode.value = mode;
  target.value = payment;
  dialogError.value = null;
  today.value = businessToday(clock);
  dialogOpen.value = true;
}

function setOpen(value: boolean): void {
  if (!value && busy.value) return;
  dialogOpen.value = value;
}

async function save(
  action: () => Promise<OrganizationBalanceResponse>,
  toastKey: string,
): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  dialogError.value = null;
  try {
    view.data.value = await action();
    showToast({ message: t(toastKey) });
    dialogOpen.value = false;
  } catch (caught) {
    const described = describeBalanceError(caught);
    if (described.reload) {
      // The payment changed under us (voided, gone): say so and show what the server has now.
      dialogOpen.value = false;
      showToast({ message: t(described.key) });
      await refreshQuietly();
    } else {
      dialogError.value = t(described.key);
    }
  } finally {
    busy.value = false;
  }
}

async function refreshQuietly(): Promise<void> {
  try {
    view.data.value = await organizationBalanceApi.getBalance(props.organizationId);
  } catch {
    // The toast already told the person; the next visit or retry reports a lasting failure.
  }
}

const onRecord = (request: RecordPaymentRequest): Promise<void> =>
  save(
    () => organizationBalanceApi.recordPayment(props.organizationId, request),
    'organizations.balance.toast.recorded',
  );

function onCorrect(request: CorrectPaymentRequest): Promise<void> {
  const payment = target.value;
  if (!payment) return Promise.resolve();
  return save(
    () => organizationBalanceApi.correctPayment(payment.id, request),
    'organizations.balance.toast.corrected',
  );
}

function onVoid(request: VoidPaymentRequest): Promise<void> {
  const payment = target.value;
  if (!payment) return Promise.resolve();
  return save(
    () => organizationBalanceApi.voidPayment(payment.id, request),
    'organizations.balance.toast.voided',
  );
}
</script>

<template>
  <section
    v-if="permissions.canView"
    class="balance"
    :aria-label="t('organizations.balance.title')"
    data-testid="organization-balance"
  >
    <header class="balance__head">
      <div class="balance__heading">
        <h2 class="balance__title">{{ t('organizations.balance.title') }}</h2>
        <p class="hint">{{ t('organizations.balance.hint') }}</p>
      </div>
      <AppButton
        v-if="permissions.canRecord && view.state.value === 'ready'"
        variant="primary"
        size="md"
        data-testid="record-payment"
        @click="open('record')"
      >
        <StaffIcon name="plus" :size="16" />
        {{ t('organizations.balance.record') }}
      </AppButton>
    </header>

    <StateView :state="view.state.value" @retry="view.reload()">
      <template v-if="balance">
        <!-- v8 KPI tiles: the amount due is the dark card (green when nothing is due). -->
        <dl class="figures">
          <div class="figure figure--main" :class="{ 'figure--clear': !hasDue }">
            <dt>{{ t('organizations.balance.amountDue') }}</dt>
            <StaffIcon name="wallet" :size="18" class="figure__icon" />
            <dd class="num" data-testid="balance-due">
              {{ hasDue ? formatUsd(balance.amountDue) : t('organizations.balance.nothingDue') }}
            </dd>
            <dd
              v-if="hasDue && balance.uzsEquivalent"
              class="figure__uzs figure__uzs--main"
              data-testid="balance-due-uzs"
            >
              {{ approx(balance.uzsEquivalent.amountDue) }}
            </dd>
          </div>
          <div class="figure">
            <dt>{{ t('organizations.balance.receivedTotal') }}</dt>
            <dd class="num" data-testid="balance-received">
              {{ formatUsd(balance.receivedTotal) }}
            </dd>
            <dd v-if="balance.uzsEquivalent" class="figure__uzs">
              {{ approx(balance.uzsEquivalent.receivedTotal) }}
            </dd>
          </div>
          <div class="figure">
            <dt>{{ t('organizations.balance.paidTotal') }}</dt>
            <dd class="num" data-testid="balance-paid">
              {{ formatUsd(balance.paidTotal) }}
            </dd>
            <dd v-if="balance.uzsEquivalent" class="figure__uzs">
              {{ approx(balance.uzsEquivalent.paidTotal) }}
            </dd>
          </div>
          <div
            v-if="hasOverpaid"
            class="figure figure--over"
            :title="t('organizations.balance.overpaidHint')"
          >
            <dt>{{ t('organizations.balance.overpaid') }}</dt>
            <dd class="num" data-testid="balance-overpaid">
              {{ formatUsd(balance.overpaid) }}
            </dd>
            <dd v-if="balance.uzsEquivalent" class="figure__uzs">
              {{ approx(balance.uzsEquivalent.overpaid) }}
            </dd>
          </div>
        </dl>
        <p class="hint" data-testid="balance-rate-note">
          {{
            balance.usdRate
              ? t('organizations.balance.rateNote', { rate: formatRate(balance.usdRate) })
              : t('organizations.balance.noRateNote')
          }}
        </p>

        <h3 class="balance__sub">{{ t('organizations.balance.payments') }}</h3>
        <DataTable
          :columns="columns"
          :rows="balance.payments"
          :row-key="(p: OrganizationPayment) => p.id"
          :row-tone="(p: OrganizationPayment) => (isVoided(p) ? 'muted' : undefined)"
          :label="t('organizations.balance.payments')"
          :empty-text="t('organizations.balance.noPayments')"
          :density-toggle="false"
        >
          <template #cell-amount="{ row }">
            <span class="cell-stack">
              <span class="num" :class="{ struck: isVoided(row) }">{{
                formatUsd(row.amountUsd)
              }}</span>
              <span v-if="paymentDetail(row)" class="amount-detail">{{ paymentDetail(row) }}</span>
            </span>
          </template>
          <template #cell-recordedBy="{ row }">
            <PersonName :name="row.recordedByName" :user-id="row.recordedByUserId" />
          </template>
          <template #cell-comment="{ row }">
            <span class="cell-stack">
              <span v-if="row.comment">{{ row.comment }}</span>
              <span v-if="isVoided(row)" class="voided" data-testid="payment-voided">
                <AppBadge tone="danger" dot>{{ t('organizations.balance.voided') }}</AppBadge>
                <span class="voided__reason">{{ row.voidReason }}</span>
              </span>
            </span>
          </template>
          <template #cell-actions="{ row }">
            <span v-if="!isVoided(row)" class="row-actions">
              <AppButton
                variant="secondary"
                size="xs"
                data-testid="correct-payment"
                @click="open('correct', row)"
              >
                {{ t('organizations.balance.form.correct') }}
              </AppButton>
              <AppButton
                variant="ghost"
                size="xs"
                class="void"
                data-testid="void-payment"
                @click="open('void', row)"
              >
                {{ t('organizations.balance.form.void') }}
              </AppButton>
            </span>
          </template>
          <template #card="{ row }">
            <span class="card__top">
              <b class="num" :class="{ struck: isVoided(row) }">{{ formatUsd(row.amountUsd) }}</b>
              <span class="card__day">{{ formatPaidOn(row.paidOn) }}</span>
            </span>
            <span v-if="paymentDetail(row)" class="amount-detail">{{ paymentDetail(row) }}</span>
            <span v-if="row.comment" class="card__comment">{{ row.comment }}</span>
            <span class="card__meta">
              <PersonName :name="row.recordedByName" :user-id="row.recordedByUserId" /> ·
              {{ formatShortDateTime(row.recordedAt) }}
            </span>
            <span v-if="isVoided(row)" class="voided" data-testid="payment-voided">
              <AppBadge tone="danger" dot>{{ t('organizations.balance.voided') }}</AppBadge>
              <span class="voided__reason">{{ row.voidReason }}</span>
            </span>
            <span v-if="permissions.canFix && !isVoided(row)" class="row-actions">
              <AppButton
                variant="secondary"
                size="xs"
                data-testid="correct-payment"
                @click="open('correct', row)"
              >
                {{ t('organizations.balance.form.correct') }}
              </AppButton>
              <AppButton
                variant="ghost"
                size="xs"
                class="void"
                data-testid="void-payment"
                @click="open('void', row)"
              >
                {{ t('organizations.balance.form.void') }}
              </AppButton>
            </span>
          </template>
        </DataTable>
      </template>
    </StateView>

    <PaymentDialog
      :model-value="dialogOpen"
      :mode="dialogMode"
      :payment="target"
      :today="today"
      :current-rate="balance?.usdRate ?? null"
      :balance="balance"
      :busy="busy"
      :error="dialogError"
      @update:model-value="setOpen"
      @record="onRecord"
      @correct="onCorrect"
      @void="onVoid"
    />
  </section>
</template>

<style scoped>
/* No card around the section: the figures are cards and the payment table is its own card. */
.balance {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.balance__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.balance__heading {
  display: flex;
  flex: 1 1 260px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.balance__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.balance__sub {
  margin: 4px 0 -6px;
  font-size: var(--fs-section);
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  gap: 16px;
  margin: 0;
}

/* v8 KPI tile: white hairline card, 12px grey label, 30px tabular value. */
.figure {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.figure dt {
  font-size: var(--fs-small);
  color: var(--t2);
}

.figure dd {
  margin: 0;
  font-size: 22px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.figure dd.figure__uzs {
  margin-top: -8px;
  font-size: var(--fs-meta);
  line-height: 1.3;
  color: var(--t2);
}

.figure--main dd.figure__uzs--main {
  color: var(--hero-muted);
}

.figure--clear dd.figure__uzs--main {
  color: var(--green);
}

.amount-detail {
  font-size: var(--fs-meta);
  color: var(--t2);
  overflow-wrap: anywhere;
}

/* Design v8: the amount due is the dark card, like the first dashboard figure. */
.figure--main {
  background: var(--hero-bg);
  box-shadow: inset 0 0 0 1px var(--hero-bg);
  color: var(--hero-fg);
}

.figure--main dt {
  padding-right: 28px;
  color: var(--hero-muted);
}

.figure--main dd {
  font-size: 30px;
  line-height: 1.1;
}

/* Top right, as in the v8 KPI tile; outside the dt/dd pair so the list stays valid. */
.figure__icon {
  position: absolute;
  top: 20px;
  right: 20px;
  color: var(--acc);
}

.figure--clear {
  background: var(--green-bg);
  box-shadow: inset 0 0 0 1px var(--green-bg);
  color: var(--green);
}

.figure--clear dt,
.figure--clear .figure__icon {
  color: var(--green);
}

.figure--over {
  background: var(--acc-bg2);
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.voided {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.voided__reason {
  font-size: var(--fs-meta);
  color: var(--t2);
  overflow-wrap: anywhere;
}

.struck {
  text-decoration: line-through;
  color: var(--t3);
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.void {
  color: var(--red);
}

.card__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 10px;
}

.card__day,
.card__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.card__comment {
  font-size: var(--fs-small);
  overflow-wrap: anywhere;
}
</style>
