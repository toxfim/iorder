<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  PARTY_NUMBER_MAX_LENGTH,
  type PartyConflictAnswer,
  type SetSupplyPartyRequest,
  type SetSupplyPartyResponse,
  type SupplyPartyConflictDetails,
  type SupplySummary,
} from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import TextField from '@core/components/ui/TextField.vue';
import { showToast } from '@core/composables/use-toast';
import { ApiConflictError, PermissionDeniedError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import {
  changedDetailsOf,
  conflictDetailsOf,
  conflictKindOf,
  notAvailableRefsOf,
  withCurrentParties,
} from '../domain/supply-party';
import SupplyCombobox from './SupplyCombobox.vue';

// "Partiya biriktirish" ([C] 2026-10-30): one party number on several supplies. The server decides
// every conflict and answers with what the manager has to see; this dialog only asks and resends.

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
const { stockApi } = useServices();

const selected = ref<readonly SupplySummary[]>([]);
const partyNumber = ref('');
const supplyError = ref<string | null>(null);
const partyError = ref<string | null>(null);
const notice = ref<string | null>(null);
const failure = ref<string | null>(null);
const saving = ref(false);
const conflict = ref<SupplyPartyConflictDetails | null>(null);
const partyAnswer = ref<PartyConflictAnswer>('ADD');

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    selected.value = [];
    partyNumber.value = '';
    supplyError.value = null;
    partyError.value = null;
    notice.value = null;
    failure.value = null;
    conflict.value = null;
    partyAnswer.value = 'ADD';
  },
);

const trimmedParty = computed(() => partyNumber.value.trim());
const conflictKind = computed(() => (conflict.value ? conflictKindOf(conflict.value) : null));
const replacingMembers = computed(
  () => (conflict.value?.partyMembers.length ?? 0) > 0 && partyAnswer.value === 'REPLACE_MEMBERS',
);
const confirmLabel = computed(() => {
  if (conflictKind.value === 'SUPPLY') return t('staffCost.party.conflict.replace');
  if (conflictKind.value === 'BOTH') return t('staffCost.party.conflict.apply');
  return replacingMembers.value
    ? t('staffCost.party.conflict.replaceMembers')
    : t('staffCost.party.conflict.add');
});
const confirmTitle = computed(() =>
  t(`staffCost.party.conflict.title${conflictKind.value ?? 'SUPPLY'}`, {
    party: trimmedParty.value,
  }),
);

function close(): void {
  if (!saving.value) emit('update:modelValue', false);
}

function validate(): boolean {
  supplyError.value = selected.value.length === 0 ? t('staffCost.party.supplyRequired') : null;
  partyError.value = trimmedParty.value === '' ? t('staffCost.party.partyRequired') : null;
  return supplyError.value === null && partyError.value === null;
}

function report(result: SetSupplyPartyResponse): void {
  const count = result.changed.length;
  if (result.outcome === 'NOTHING_TO_DO') {
    showToast({ message: t('staffCost.party.nothingToDo', { party: result.partyNumber }) });
    return;
  }
  const parts = [t('staffCost.party.saved', { party: result.partyNumber, count }, count)];
  if (result.alreadySet.length > 0) {
    parts.push(t('staffCost.party.savedAlready', { count: result.alreadySet.length }));
  }
  if (result.removedFromParty.length > 0) {
    parts.push(t('staffCost.party.savedRemoved', { count: result.removedFromParty.length }));
  }
  showToast({ message: parts.join(' ') });
}

function onRefused(caught: ApiConflictError): boolean {
  if (caught.reason === 'SUPPLY_PARTY_CONFLICT') {
    const details = conflictDetailsOf(caught.details);
    if (details === null) return false;
    selected.value = withCurrentParties(
      selected.value,
      details.supplyConflicts.map((row) => ({
        deliveryRef: row.deliveryRef,
        partyNumber: row.partyNumber,
      })),
    );
    conflict.value = details;
    partyAnswer.value = 'ADD';
    return true;
  }
  if (caught.reason === 'SUPPLY_PARTY_CHANGED') {
    const details = changedDetailsOf(caught.details);
    if (details === null) return false;
    selected.value = withCurrentParties(selected.value, details.parties);
    conflict.value = null;
    notice.value = t('staffCost.party.changedNotice');
    return true;
  }
  if (caught.reason === 'SUPPLY_NOT_AVAILABLE') {
    const refs = notAvailableRefsOf(caught.details);
    if (refs === null) return false;
    selected.value = selected.value.filter((supply) => !refs.includes(supply.deliveryRef));
    conflict.value = null;
    notice.value = t('staffCost.party.goneNotice', { ids: refs.join(', ') });
    return true;
  }
  return false;
}

async function send(answers: Partial<SetSupplyPartyRequest>): Promise<void> {
  saving.value = true;
  failure.value = null;
  notice.value = null;
  try {
    report(
      await stockApi.setSupplyParty({
        deliveryRefs: selected.value.map((supply) => supply.deliveryRef),
        partyNumber: trimmedParty.value,
        seenParties: selected.value.map((supply) => ({
          deliveryRef: supply.deliveryRef,
          partyNumber: supply.partyNumber,
        })),
        ...answers,
      }),
    );
    conflict.value = null;
    saving.value = false;
    emit('update:modelValue', false);
  } catch (caught) {
    saving.value = false;
    if (caught instanceof ApiConflictError && onRefused(caught)) return;
    failure.value =
      caught instanceof PermissionDeniedError
        ? t('staffCost.party.denied')
        : translateDescribed(t, describePricingError('stock', caught));
  }
}

function submit(): void {
  if (validate()) void send({});
}

function answerConflict(): void {
  const details = conflict.value;
  if (details === null) return;
  void send({
    ...(details.supplyConflicts.length > 0 ? { onSupplyConflict: 'REPLACE' as const } : {}),
    ...(details.partyMembers.length > 0
      ? { onPartyConflict: partyAnswer.value, seenPartyMembers: details.partyMembers }
      : {}),
  });
}

function dismissConflict(open: boolean): void {
  if (!open) {
    conflict.value = null;
    failure.value = null;
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('staffCost.party.title')"
    :description="t('staffCost.party.description')"
    max-width="520px"
    @update:model-value="close"
  >
    <form class="party" novalidate @submit.prevent="submit">
      <SupplyCombobox v-model="selected" :error="supplyError" />
      <TextField
        v-model="partyNumber"
        :label="t('staffCost.party.partyLabel')"
        :hint="t('staffCost.party.partyHint', { max: PARTY_NUMBER_MAX_LENGTH })"
        :maxlength="PARTY_NUMBER_MAX_LENGTH"
        :error="partyError"
      />
      <p v-if="notice" class="party__notice" role="status" data-testid="party-notice">
        {{ notice }}
      </p>
      <p v-if="failure && conflict === null" class="party__failure" role="alert">{{ failure }}</p>
    </form>
    <template #footer>
      <AppButton variant="secondary" size="lg" :disabled="saving" @click="close">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton size="lg" :loading="saving" data-testid="party-save" @click="submit">
        {{ t('staffCost.party.save', { count: selected.length }, selected.length) }}
      </AppButton>
    </template>
  </AppModal>

  <AppConfirmDialog
    :model-value="conflict !== null"
    :title="confirmTitle"
    :confirm-label="confirmLabel"
    :tone="replacingMembers ? 'danger' : 'primary'"
    :loading="saving"
    :error="failure"
    @update:model-value="dismissConflict"
    @confirm="answerConflict"
  >
    <div v-if="conflict" class="ask" data-testid="party-conflict">
      <section v-if="conflict.supplyConflicts.length > 0" class="ask__part">
        <p class="ask__text">{{ t('staffCost.party.conflict.supplyText') }}</p>
        <ul class="ask__list">
          <li v-for="row in conflict.supplyConflicts" :key="row.deliveryRef">
            <span class="ask__ref">{{ row.deliveryRef }}</span>
            {{ t('staffCost.party.conflict.fromTo', { from: row.partyNumber, to: trimmedParty }) }}
          </li>
        </ul>
      </section>
      <section v-if="conflict.partyMembers.length > 0" class="ask__part">
        <p class="ask__text">
          {{ t('staffCost.party.conflict.partyText', { party: trimmedParty }) }}
        </p>
        <ul class="ask__list">
          <li v-for="member in conflict.partyMembers" :key="member">
            <span class="ask__ref">{{ member }}</span>
          </li>
        </ul>
        <fieldset class="ask__choice">
          <legend class="sr-only">{{ t('staffCost.party.conflict.choice') }}</legend>
          <label class="ask__option">
            <input v-model="partyAnswer" type="radio" value="ADD" name="party-answer" />
            <span>{{ t('staffCost.party.conflict.addOption') }}</span>
          </label>
          <label class="ask__option">
            <input v-model="partyAnswer" type="radio" value="REPLACE_MEMBERS" name="party-answer" />
            <span>{{ t('staffCost.party.conflict.replaceOption') }}</span>
          </label>
        </fieldset>
      </section>
    </div>
  </AppConfirmDialog>
</template>

<style scoped>
.party {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.party__notice,
.party__failure {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-input);
  background: var(--acc-bg);
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

.party__failure {
  color: var(--red);
}

.ask {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ask__part {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ask__text {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.ask__list {
  max-height: 140px;
  margin: 0;
  padding: 8px 12px;
  overflow-y: auto;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  list-style: none;
}

.ask__ref {
  font-family: var(--font-mono);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.ask__choice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.ask__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 32px;
  font-size: var(--fs-small);
  cursor: pointer;
}
</style>
