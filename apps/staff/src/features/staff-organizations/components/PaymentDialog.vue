<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  PAYMENT_COMMENT_MAX_LENGTH,
  PAYMENT_CURRENCIES,
  type CorrectPaymentRequest,
  type OrganizationPayment,
  type PaymentCurrency,
  type RecordPaymentRequest,
  type VoidPaymentRequest,
} from '@iorder/shared/staff-orders';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { useFormat } from '@core/i18n/use-format';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import {
  buildCorrectRequest,
  buildRecordRequest,
  paymentPreview,
  plainRate,
  type PaymentFormField,
  type PaymentPreview,
} from '../domain/organization-balance';

export type PaymentDialogMode = 'record' | 'correct' | 'void';

const props = defineProps<{
  modelValue: boolean;
  mode: PaymentDialogMode;
  /** The payment being corrected or voided (null when recording a new one). */
  payment: OrganizationPayment | null;
  /** Today in Asia/Tashkent (`YYYY-MM-DD`): the default and the latest day that can be chosen. */
  today: string;
  /** The current rate setting: what a new so'm payment starts from. */
  currentRate: string | null;
  /** The balance now, for the debt after this payment on the confirm step. */
  balance: { readonly amountDue: string; readonly overpaid: string } | null;
  busy?: boolean;
  /** A translated message of the last failed save. */
  error?: string | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  record: [request: RecordPaymentRequest];
  correct: [request: CorrectPaymentRequest];
  void: [request: VoidPaymentRequest];
}>();

const { t } = useI18n();
const { formatMoneyWithCurrency } = useFormat();
const { formatUsd } = useCostFormat();
const ids = {
  amount: useId(),
  currency: useId(),
  rate: useId(),
  paidOn: useId(),
  comment: useId(),
  reason: useId(),
};

const amount = ref('');
const currency = ref<PaymentCurrency | null>(null);
const rate = ref('');
const paidOn = ref('');
const comment = ref('');
const reason = ref('');
const invalid = ref<PaymentFormField | null>(null);
// Set once the form is valid: the manager then sees what will be saved and confirms it.
const preview = ref<PaymentPreview | null>(null);

// Every opening starts from the payment being changed, or from an empty form dated today.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    amount.value = props.payment?.amount ?? '';
    currency.value = props.payment?.currency ?? null;
    rate.value = plainRate(props.payment?.rate ?? props.currentRate ?? '');
    paidOn.value = props.payment?.paidOn ?? props.today;
    comment.value = props.payment?.comment ?? '';
    reason.value = '';
    invalid.value = null;
    preview.value = null;
  },
  { immediate: true },
);

// A refused save goes back to the form, where the field can be fixed.
watch(
  () => props.error,
  (error) => {
    if (error) preview.value = null;
  },
);

const title = computed(() => t(`organizations.balance.form.${props.mode}Title`));
const hint = computed(() => t(`organizations.balance.form.${props.mode}Hint`));
const confirmLabel = computed(() => {
  if (props.mode === 'void') return t('organizations.balance.form.confirmVoid');
  if (preview.value === null) return t('organizations.balance.form.next');
  if (props.mode === 'correct') return t('organizations.balance.form.correct');
  return t('organizations.balance.form.save');
});
const amountLabel = computed(() =>
  currency.value === null
    ? t('organizations.balance.form.amount')
    : t('organizations.balance.form.amountIn', {
        currency: t(`organizations.balance.form.currencyShort.${currency.value}`),
      }),
);
const showsFields = computed(() => props.mode !== 'void');
const needsReason = computed(() => props.mode !== 'record');
const message = computed(() =>
  invalid.value ? t(`organizations.balance.invalid.${invalid.value}`) : (props.error ?? null),
);

function showPreview(): void {
  if (currency.value === null) return;
  preview.value = paymentPreview(
    { amount: amount.value, currency: currency.value, rate: rate.value },
    props.balance ?? { amountDue: '0.00', overpaid: '0.00' },
    props.currentRate,
    props.mode === 'correct' ? props.payment : null,
  );
}

function submit(): void {
  if (props.busy) return;
  const form = {
    amount: amount.value,
    currency: currency.value,
    rate: rate.value,
    paidOn: paidOn.value,
    comment: comment.value,
  };
  if (needsReason.value && reason.value.trim() === '') {
    invalid.value = 'reason';
    return;
  }
  if (props.mode === 'void') {
    invalid.value = null;
    emit('void', { reason: reason.value.trim() });
    return;
  }
  if (props.mode === 'correct') {
    if (!props.payment) return;
    const result = buildCorrectRequest(props.payment, form, reason.value);
    invalid.value = result.ok ? null : result.field;
    if (!result.ok) return;
    if (preview.value === null) showPreview();
    else emit('correct', result.request);
    return;
  }
  const result = buildRecordRequest(form);
  invalid.value = result.ok ? null : result.field;
  if (!result.ok) return;
  if (preview.value === null) showPreview();
  else emit('record', result.request);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="title"
    :description="hint"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <dl v-if="preview" class="confirm" data-testid="payment-confirm">
      <div class="confirm__row">
        <dt>{{ t('organizations.balance.form.confirmUsd') }}</dt>
        <dd class="num" data-testid="payment-confirm-usd">{{ formatUsd(preview.usd) }}</dd>
      </div>
      <div v-if="preview.uzs !== null" class="confirm__row">
        <dt>{{ t('organizations.balance.form.confirmUzs') }}</dt>
        <dd class="num" data-testid="payment-confirm-uzs">
          {{
            preview.uzsApprox
              ? t('organizations.balance.approxUzs', {
                  amount: formatMoneyWithCurrency(preview.uzs),
                })
              : formatMoneyWithCurrency(preview.uzs)
          }}
        </dd>
      </div>
      <div class="confirm__row confirm__row--total">
        <dt data-testid="payment-confirm-after-label">
          {{
            t(
              `organizations.balance.form.${preview.overpaidAfter === '0.00' ? 'confirmDebtAfter' : 'confirmOverpaidAfter'}`,
            )
          }}
        </dt>
        <dd class="num" data-testid="payment-confirm-after">
          {{
            formatUsd(preview.overpaidAfter === '0.00' ? preview.debtAfter : preview.overpaidAfter)
          }}
        </dd>
      </div>
    </dl>
    <form v-show="!preview" class="form" novalidate @submit.prevent="submit">
      <template v-if="showsFields">
        <div class="row">
          <label :for="ids.currency" class="label">{{
            t('organizations.balance.form.currency')
          }}</label>
          <select
            :id="ids.currency"
            v-model="currency"
            class="input"
            :class="{ 'input--error': invalid === 'currency' }"
            data-testid="payment-currency"
          >
            <option :value="null" disabled>
              {{ t('organizations.balance.form.currencyPlaceholder') }}
            </option>
            <option v-for="option in PAYMENT_CURRENCIES" :key="option" :value="option">
              {{ t(`organizations.balance.form.currencies.${option}`) }}
            </option>
          </select>
        </div>
        <div class="row">
          <label :for="ids.amount" class="label" data-testid="payment-amount-label">{{
            amountLabel
          }}</label>
          <input
            :id="ids.amount"
            v-model="amount"
            class="input num"
            :class="{ 'input--error': invalid === 'amount' }"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :disabled="currency === null"
            data-testid="payment-amount"
          />
          <p v-if="currency === null" class="hint">
            {{ t('organizations.balance.form.pickCurrencyFirst') }}
          </p>
        </div>
        <div v-if="currency === 'UZS'" class="row">
          <label :for="ids.rate" class="label">{{ t('organizations.balance.form.rate') }}</label>
          <input
            :id="ids.rate"
            v-model="rate"
            class="input num"
            :class="{ 'input--error': invalid === 'rate' }"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            required
            data-testid="payment-rate"
          />
        </div>
        <div class="row">
          <label :for="ids.paidOn" class="label">{{
            t('organizations.balance.form.paidOn')
          }}</label>
          <input
            :id="ids.paidOn"
            v-model="paidOn"
            class="input"
            :class="{ 'input--error': invalid === 'paidOn' }"
            type="date"
            :max="today"
            data-testid="payment-paid-on"
          />
        </div>
        <div class="row">
          <label :for="ids.comment" class="label">{{
            t('organizations.balance.form.comment')
          }}</label>
          <textarea
            :id="ids.comment"
            v-model="comment"
            class="input input--area"
            :class="{ 'input--error': invalid === 'comment' }"
            rows="2"
            :maxlength="PAYMENT_COMMENT_MAX_LENGTH"
            data-testid="payment-comment"
          />
        </div>
      </template>
      <div v-if="needsReason" class="row">
        <label :for="ids.reason" class="label">{{ t('organizations.balance.form.reason') }}</label>
        <textarea
          :id="ids.reason"
          v-model="reason"
          class="input input--area"
          :class="{ 'input--error': invalid === 'reason' }"
          rows="2"
          required
          data-testid="payment-reason"
        />
      </div>
      <p v-if="message" class="error" role="alert" data-testid="payment-error">{{ message }}</p>
    </form>
    <template #footer>
      <AppButton
        v-if="preview"
        variant="secondary"
        size="lg"
        data-testid="payment-back"
        @click="preview = null"
      >
        {{ t('organizations.balance.form.back') }}
      </AppButton>
      <AppButton v-else variant="secondary" size="lg" @click="emit('update:modelValue', false)">
        {{ t('organizations.balance.form.close') }}
      </AppButton>
      <AppButton
        :variant="mode === 'void' ? 'danger' : 'primary'"
        size="lg"
        :loading="busy"
        data-testid="payment-submit"
        @click="submit"
      >
        {{ confirmLabel }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* v8 form field: 11px/500 label, 40px white input with a hairline ring, accent ring on focus. */
.label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

.input {
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font: inherit;
  font-size: var(--fs-small);
  color: var(--ink);
}

.input--area {
  height: auto;
  padding: 10px 12px;
  resize: vertical;
}

.input--error {
  box-shadow: inset 0 0 0 1px var(--red);
}

.input:focus-visible {
  outline: 0;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.input:disabled {
  background: var(--e8);
  color: var(--t3);
}

.hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.error {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--red);
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.confirm__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  font-size: var(--fs-small);
}

.confirm__row dt {
  color: var(--t2);
}

.confirm__row dd {
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.confirm__row--total {
  padding-top: 10px;
  border-top: 1px solid var(--e8);
}
</style>
