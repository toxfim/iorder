<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { USD_RATE_BANK_MARKUP_UZS } from '@iorder/shared';
import { useCostFormat } from '../composables/use-cost-format';
import { useUsdRate, type RateSaveResult } from '../composables/use-usd-rate';
import { assessRate, parseRateInput, rateToInput, type RateAssessment } from '../domain/rate-input';
import PersonName from '@/features/people/components/PersonName.vue';

// "Kurs $1 = 12 650 so'm" (v1): shows the rate in force, its source and date. Manager and admin
// enter a rate for 24 hours or end it early; the accountant only reads it. The order of the sources
// is the server's (the channel's post, a manual rate, the Central Bank + 40).
//
// Laid out as ONE bar with a shared centre line (owner 2026-11-09): the rate, its source, what needs
// attention and the way back to the automatic rate, in that order from the left. It used to be a
// right-aligned column inside the page actions, which grew to three lines and threw the buttons
// next to it off their line.
const props = defineProps<{ canEdit: boolean }>();

const { t } = useI18n();
const { costApi } = useServices();
const { formatRate, formatDate, formatDay } = useCostFormat();
const model = useUsdRate(costApi);
const inputId = useId();
const hintId = useId();

const editing = ref(false);
const draft = ref('');
const field = ref<HTMLInputElement | null>(null);
const problem = ref<string | null>(null);
// A value that parsed but looks unusual waits here for the manager's explicit confirmation.
const pending = ref<{ value: string; why: Exclude<RateAssessment, 'ok'> } | null>(null);

// Separate from the plain source line: the name inside this sentence carries the person card.
const manualAuthor = computed(() => {
  const rate = model.rate.value;
  if (rate?.source !== 'MANUAL' || !rate.updatedBy) return null;
  return {
    name: rate.updatedBy,
    userId: rate.updatedByUserId,
    date: rate.updatedAt ? formatDate(rate.updatedAt) : '',
  };
});

const source = computed(() => {
  const rate = model.rate.value;
  if (rate?.source === 'CBU') {
    return t('staffCost.rate.sourceCbu', {
      date: rate.rateDate ? formatDay(rate.rateDate) : '',
      markup: USD_RATE_BANK_MARKUP_UZS,
    });
  }
  if (rate?.source === 'CHANNEL') {
    return t('staffCost.rate.sourceChannel', {
      date: rate.rateDate ? formatDay(rate.rateDate) : '',
    });
  }
  if (rate?.source === 'MANUAL') {
    return t('staffCost.rate.sourceManual', {
      date: rate.updatedAt ? formatDate(rate.updatedAt) : '',
    });
  }
  return null;
});

const refreshFailedOn = computed(() => {
  const failedAt = model.rate.value?.lastRefreshFailedAt;
  return failedAt ? formatDate(failedAt) : null;
});

const channelFailedOn = computed(() => {
  const failedAt = model.rate.value?.lastChannelFailedAt;
  return failedAt ? formatDate(failedAt) : null;
});

const manualUntil = computed(() => {
  const until = model.rate.value?.manualExpiresAt;
  return until ? formatDate(until) : null;
});

// A manual rate the channel's post is outranking right now: without this line a saved rate looks lost.
const manualWaiting = computed(() => {
  const rate = model.rate.value;
  return rate?.source === 'CHANNEL' && rate.manualRate ? formatRate(rate.manualRate) : null;
});

// The button is only useful while a manual rate is in force (or a bank refresh failed).
const showFollow = computed(
  () => model.rate.value?.followsCentralBank === false || refreshFailedOn.value !== null,
);

const offersFollow = computed(() => props.canEdit && showFollow.value && !editing.value);
// The two side groups exist only with something in them, so an empty one never takes a gap.
const hasInfo = computed(
  () =>
    problem.value !== null ||
    manualAuthor.value !== null ||
    source.value !== null ||
    (manualUntil.value !== null && manualWaiting.value === null),
);
const hasAlert = computed(
  () =>
    manualWaiting.value !== null ||
    channelFailedOn.value !== null ||
    refreshFailedOn.value !== null,
);
const hasSide = computed(() => hasAlert.value || offersFollow.value);

function failureText(result: RateSaveResult): string {
  if (result.ok) return '';
  if (result.reason === 'empty') return t('staffCost.rate.empty');
  if (result.reason === 'invalid') return t('staffCost.rate.invalid');
  if (result.reason === 'ambiguous') return t('staffCost.rate.ambiguous');
  return translateDescribed(t, describePricingError('rate', result.error));
}

async function startEdit(): Promise<void> {
  draft.value = model.rate.value?.rate ? rateToInput(model.rate.value.rate) : '';
  problem.value = null;
  editing.value = true;
  await nextTick();
  field.value?.select();
}

function cancel(): void {
  editing.value = false;
  problem.value = null;
}

async function submit(): Promise<void> {
  const parsed = parseRateInput(draft.value);
  if (!parsed.ok) {
    problem.value = failureText(parsed);
    return;
  }
  const why = assessRate(parsed.value, model.rate.value?.rate ?? null);
  if (why !== 'ok') {
    problem.value = null;
    pending.value = { value: parsed.value, why };
    return;
  }
  await persist(parsed.value);
}

async function confirmPending(): Promise<void> {
  const confirmed = pending.value;
  pending.value = null;
  if (confirmed) await persist(confirmed.value);
}

async function persist(value: string): Promise<void> {
  const result = await model.save(value);
  if (result.ok) {
    editing.value = false;
    problem.value = null;
    showToast({
      message: t('staffCost.rate.saved', { rate: formatRate(result.rate.rate ?? '0') }),
    });
  } else {
    problem.value = failureText(result);
  }
}

async function follow(): Promise<void> {
  const result = await model.follow();
  if (result.ok) {
    showToast({ message: t('staffCost.rate.followed') });
  } else {
    showToast({ message: failureText(result) });
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    cancel();
  }
}
</script>

<template>
  <div class="rate" data-testid="usd-rate">
    <p v-if="model.state.value === 'loading'" class="rate__note" role="status" aria-busy="true">
      {{ t('state.loading') }}
    </p>

    <template v-else-if="model.state.value === 'error'">
      <span class="rate__note" role="alert">
        {{ translateDescribed(t, describePricingError('rate', model.error.value)) }}
      </span>
      <AppButton variant="secondary" size="xs" @click="model.load()">{{
        t('state.retry')
      }}</AppButton>
    </template>

    <template v-else-if="model.state.value === 'ready'">
      <form v-if="editing" class="rate__form" @submit.prevent="submit" @keydown="onKeydown">
        <label :for="inputId" class="rate__eq">{{ t('staffCost.rate.prefix') }}</label>
        <input
          :id="inputId"
          ref="field"
          v-model="draft"
          class="rate__input num"
          :class="{ 'rate__input--bad': problem !== null }"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          spellcheck="false"
          :disabled="model.busy.value"
          :aria-invalid="problem !== null ? 'true' : undefined"
          :aria-describedby="problem !== null ? hintId : undefined"
        />
        <span class="rate__eq">{{ t('common.currency') }}</span>
        <AppButton type="submit" size="xs" :loading="model.busy.value">
          {{ t('staffCost.rate.save') }}
        </AppButton>
        <AppButton variant="secondary" size="xs" :disabled="model.busy.value" @click="cancel">
          {{ t('common.cancel') }}
        </AppButton>
      </form>

      <template v-else>
        <button v-if="canEdit" type="button" class="rate__btn" @click="startEdit">
          <span v-if="model.rate.value?.rate" class="num">
            {{ t('staffCost.rate.prefix') }}
            <b>{{ formatRate(model.rate.value.rate) }}</b>
            {{ t('common.currency') }}
          </span>
          <span v-else>{{ t('staffCost.rate.set') }}</span>
          <StaffIcon name="pencil" :size="14" />
          <span class="sr-only">{{ t('staffCost.rate.edit') }}</span>
        </button>
        <span v-else class="rate__static num" data-testid="usd-rate-readonly">
          <template v-if="model.rate.value?.rate">
            {{ t('staffCost.rate.prefix') }}
            <b>{{ formatRate(model.rate.value.rate) }}</b>
            {{ t('common.currency') }}
          </template>
          <template v-else>{{ t('staffCost.rate.notSet') }}</template>
        </span>
      </template>

      <!-- Where the rate comes from and how long it holds: short lines beside the rate. -->
      <div v-if="hasInfo" class="rate__info">
        <p v-if="problem" :id="hintId" class="rate__problem" role="alert">{{ problem }}</p>
        <p v-else-if="manualAuthor" class="rate__meta">
          <i18n-t scope="global" keypath="staffCost.rate.sourceManualBy">
            <template #name>
              <PersonName :name="manualAuthor.name" :user-id="manualAuthor.userId" />
            </template>
            <template #date>{{ manualAuthor.date }}</template>
          </i18n-t>
        </p>
        <p v-else-if="source" class="rate__meta">{{ source }}</p>
        <p v-if="manualUntil && !manualWaiting" class="rate__meta" data-testid="rate-manual-until">
          {{ t('staffCost.rate.manualUntil', { date: manualUntil }) }}
        </p>
      </div>

      <div v-if="hasSide" class="rate__side">
        <p v-if="manualWaiting" class="rate__warn" role="status" data-testid="rate-manual-waiting">
          <StaffIcon name="alert" :size="14" />
          <span>{{ t('staffCost.rate.manualWaiting', { rate: manualWaiting }) }}</span>
        </p>
        <p
          v-if="channelFailedOn"
          class="rate__warn"
          role="status"
          data-testid="rate-channel-failed"
        >
          <StaffIcon name="alert" :size="14" />
          <span>{{ t('staffCost.rate.channelFailed', { date: channelFailedOn }) }}</span>
        </p>
        <p v-if="refreshFailedOn" class="rate__warn" role="status">
          <StaffIcon name="alert" :size="14" />
          <span>{{ t('staffCost.rate.refreshFailed', { date: refreshFailedOn }) }}</span>
        </p>
        <button
          v-if="offersFollow"
          type="button"
          class="rate__follow"
          :disabled="model.busy.value"
          :aria-busy="model.busy.value || undefined"
          data-testid="rate-follow"
          @click="follow"
        >
          <span v-if="model.busy.value" class="rate__spinner" aria-hidden="true" />
          <StaffIcon v-else name="refresh" :size="16" />
          {{ t('staffCost.rate.follow') }}
        </button>
      </div>

      <AppConfirmDialog
        :model-value="pending !== null"
        :title="t('staffCost.rate.confirmTitle')"
        :description="
          pending?.why === 'outsideBand'
            ? t('staffCost.rate.confirmOutsideBand')
            : t('staffCost.rate.confirmBigChange')
        "
        :confirm-label="t('staffCost.rate.confirmSave')"
        tone="danger"
        @update:model-value="pending = null"
        @confirm="confirmPending"
      >
        <dl class="rate__compare num" data-testid="rate-compare">
          <div>
            <dt>{{ t('staffCost.rate.confirmOld') }}</dt>
            <dd>{{ formatRate(model.rate.value?.rate ?? '0') }} {{ t('common.currency') }}</dd>
          </div>
          <div>
            <dt>{{ t('staffCost.rate.confirmNew') }}</dt>
            <dd>
              <b>{{ formatRate(pending?.value ?? '0') }} {{ t('common.currency') }}</b>
            </dd>
          </div>
        </dl>
      </AppConfirmDialog>
    </template>
  </div>
</template>

<style scoped>
/* One bar that reads from the left like a sentence: the rate, where it comes from, what needs
   attention, the action that answers it. Every piece is centred on its line. Nothing is pushed to
   the far end, so when the bar runs out of room the pieces simply continue on the next line from
   the left edge; no width decides between two different looks. */
.rate {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-width: 0;
}

/* The "Kurs $1 = ..." control as a v8 header button: 40px, white, hairline ring, 12px label. A
   read-only rate (the accountant) sits on the grey input fill instead, so it does not look
   clickable. */
.rate__btn,
.rate__static {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  color: var(--ink);
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rate__btn {
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
}

.rate__btn b,
.rate__static b {
  font-weight: 600;
}

.rate__btn :deep(svg) {
  color: var(--t2);
}

.rate__btn:hover {
  background: var(--f5);
}

.rate__btn:focus-visible,
.rate__follow:focus-visible {
  outline-color: var(--acc);
}

/* At least the 40px of the button it replaces, so the bar does not jump when editing starts. */
.rate__form {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px 4px 4px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.rate__eq {
  font-size: var(--fs-small);
  color: var(--ink);
}

.rate__input {
  width: 96px;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-size: var(--fs-small);
  font-weight: 600;
  text-align: right;
  outline: none;
}

.rate__input:focus-visible {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.rate__input--bad,
.rate__input--bad:focus-visible {
  box-shadow: inset 0 0 0 1px var(--red);
}

.rate__info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}

.rate__meta,
.rate__note {
  margin: 0;
  font-size: var(--fs-group);
  color: var(--t2);
}

.rate__problem {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--red);
}

/* What needs attention, then the action that answers it. The group moves to the next line as a
   whole when it does not fit beside the rate, and wraps inside itself only when one line is not
   enough for it either. */
.rate__side {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* A notice is a sentence (Russian is the longest): on a phone it wraps inside its own box. */
.rate__warn {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  margin: 0;
  padding: 6px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-meta);
}

.rate__warn :deep(svg) {
  flex: none;
}

/* The same 40px white page button as the actions above it (PricesPage .chip). */
.rate__follow {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
}

.rate__follow :deep(svg) {
  color: var(--t2);
}

.rate__follow:hover:not(:disabled) {
  background: var(--f5);
}

.rate__follow:disabled {
  color: var(--t2);
  cursor: progress;
}

.rate__spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--e8);
  border-top-color: var(--acc);
  border-radius: 50%;
  animation: rate-spin 0.8s linear infinite;
}

@keyframes rate-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rate__spinner {
    animation-duration: 2.4s;
  }
}

.rate__compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 0;
}

.rate__compare dt {
  font-size: var(--fs-meta);
  color: var(--t3);
}

.rate__compare dd {
  margin: 0;
  font-size: var(--fs-body);
}

/* Touch: every control of the bar is 44px, the same condition and height as AppButton. The edit
   form drops its 4px frame there, because its own buttons are already 44px: with the frame the bar
   grew to 52px and everything on the line moved when the rate was tapped. */
@media (pointer: coarse), (hover: none) {
  .rate__btn,
  .rate__static,
  .rate__follow,
  .rate__warn {
    min-height: 44px;
  }

  .rate__form {
    min-height: 44px;
    padding-block: 0;
  }

  .rate__input {
    height: 36px;
  }
}
</style>
