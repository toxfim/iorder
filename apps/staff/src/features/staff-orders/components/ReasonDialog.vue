<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';

/** The grey box of the approved design: what is being rejected or cancelled. */
export interface ReasonSummary {
  readonly orderNumber: string;
  /** Formatted; absent for a role that sees no money. */
  readonly total?: string;
  readonly client: string;
  /** The payment plan, in words. */
  readonly plan?: string;
}

const props = defineProps<{
  modelValue: boolean;
  /** Rejecting and cancelling share the dialog; the reason is required for both (lifecycle §3). */
  kind: 'reject' | 'cancel';
  busy?: boolean;
  summary?: ReasonSummary | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [reason: string];
}>();

const { t } = useI18n();
const reason = ref('');
const fieldId = useId();

// Every opening starts with an empty reason.
watch(
  () => props.modelValue,
  (open) => {
    if (open) reason.value = '';
  },
);

const QUICK_REASONS = ['outOfStock', 'stalePrice', 'customerRequest'] as const;
const quick = computed(() =>
  QUICK_REASONS.map((key) => ({ key, label: t(`orders.reasonDialog.quick.${key}`) })),
);
const canConfirm = computed(() => reason.value.trim() !== '' && !props.busy);

function submit(): void {
  if (canConfirm.value) emit('confirm', reason.value.trim());
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t(`orders.reasonDialog.${kind}Question`)"
    :description="t(`orders.reasonDialog.${kind}Hint`)"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="summary" class="sum" data-testid="reason-summary">
      <span class="sum__row">
        <b class="sum__id mono">{{ summary.orderNumber }}</b>
        <b v-if="summary.total" class="mono">{{ summary.total }}</b>
      </span>
      <span class="sum__who">{{ summary.client }}</span>
      <span v-if="summary.plan" class="sum__plan">{{ summary.plan }}</span>
    </div>
    <div class="quick">
      <button
        v-for="item in quick"
        :key="item.key"
        type="button"
        class="chip"
        :class="{ 'chip--on': reason === item.label }"
        :aria-pressed="reason === item.label"
        @click="reason = item.label"
      >
        {{ item.label }}
      </button>
    </div>
    <label :for="fieldId" class="sr-only">{{ t('orders.reasonDialog.placeholder') }}</label>
    <textarea
      :id="fieldId"
      v-model="reason"
      class="field"
      rows="3"
      required
      :placeholder="t('orders.reasonDialog.placeholder')"
    />
    <template #footer>
      <AppButton variant="secondary" size="lg" @click="emit('update:modelValue', false)">
        {{ t('orders.approveDialog.back') }}
      </AppButton>
      <!-- The design draws the negative, final step in ink, the positive one in the accent. -->
      <AppButton variant="dark" size="lg" :disabled="!canConfirm" @click="submit">
        {{ t(`orders.reasonDialog.${kind}Ok`) }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
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

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* v8 quick reason: a round 32px hairline pill; the chosen one orange-tinted. */
.chip {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 16px;
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  color: var(--ink);
  cursor: pointer;
}

.chip:hover {
  background: var(--hov);
}

.chip--on,
.chip--on:hover {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc-fg);
}

.field {
  width: 100%;
  margin-top: 12px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  /* 16px keeps iOS from zooming into the field on a phone. */
  font-size: 16px;
  color: var(--ink);
  resize: vertical;
}

.field:focus {
  outline: none;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

@media (hover: hover) and (pointer: fine) {
  .field {
    font-size: var(--fs-small);
  }
}

@media (pointer: coarse), (hover: none) {
  .chip {
    min-height: 44px;
  }
}
</style>
