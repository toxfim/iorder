<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { showToast } from '@core/composables/use-toast';
import { errorTextFor } from '../domain/error-text';
import RemovalStatusPanel from './RemovalStatusPanel.vue';

const props = defineProps<{
  modelValue: boolean;
  userId: string;
  name: string;
  /** Names of the Telegram groups the person belongs to, from data the page already holds. */
  groups: readonly string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** The block went through; `removalRequested` tells whether the group removal was asked for. */
  blocked: [removalRequested: boolean];
}>();

const { t } = useI18n();
const { staffUsersApi } = useServices();
const radioName = useId();

type Choice = 'only' | 'remove';
// Default is the safer, smaller action: blocking alone.
const choice = ref<Choice>('only');
const busy = ref(false);
const error = ref<string | null>(null);
const stage = ref<'choose' | 'done'>('choose');
const note = ref<string | null>(null);
const doneBlock = ref<HTMLElement | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    choice.value = 'only';
    busy.value = false;
    error.value = null;
    stage.value = 'choose';
    note.value = null;
  },
);

// The button that was pressed leaves the page with the question; without this, focus falls to
// <body> behind the dialog and a keyboard or screen reader user loses their place.
watch(stage, async (next) => {
  if (next !== 'done') return;
  await nextTick();
  doneBlock.value?.focus();
});

const confirmLabel = computed(() =>
  choice.value === 'remove' ? t('staffUsers.block.confirmRemove') : t('staffUsers.block.confirm'),
);

function setOpen(value: boolean): void {
  // Closing while the request runs would hide its outcome.
  if (!value && busy.value) return;
  emit('update:modelValue', value);
}

async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  const removal = choice.value === 'remove';
  try {
    const answer = await staffUsersApi.blockUser(props.userId, { removeFromGroups: removal });
    emit('blocked', removal);
    if (!removal) {
      showToast({ message: t('staffUsers.block.blockedToast', { name: props.name }) });
      busy.value = false;
      emit('update:modelValue', false);
      return;
    }
    const removalInfo = answer.groupRemoval;
    note.value =
      removalInfo && removalInfo.queued === 0
        ? t(
            removalInfo.alreadyRequested > 0
              ? 'staffUsers.block.alreadyRequested'
              : 'staffUsers.block.nothingQueued',
          )
        : null;
    stage.value = 'done';
  } catch (caught) {
    const text = errorTextFor(caught);
    error.value = t(`staffUsers.errors.${text.key}`, { ...text.params });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="
      stage === 'done'
        ? t('staffUsers.block.blockedTitle', { name })
        : t('staffUsers.block.title', { name })
    "
    :description="stage === 'choose' ? t('staffUsers.block.description') : undefined"
    max-width="520px"
    @update:model-value="setOpen"
  >
    <div v-if="stage === 'choose'" class="block" data-testid="block-choose">
      <section class="groups">
        <h3 class="groups__title">{{ t('staffUsers.block.groupsTitle') }}</h3>
        <ul v-if="groups.length > 0" class="groups__list">
          <li v-for="group in groups" :key="group">{{ group }}</li>
        </ul>
        <p v-else class="muted">{{ t('staffUsers.block.noGroups') }}</p>
      </section>

      <fieldset class="choice" :disabled="busy">
        <legend class="choice__legend">{{ t('staffUsers.block.question') }}</legend>
        <label class="option" :class="{ 'option--on': choice === 'only' }">
          <input v-model="choice" type="radio" :name="radioName" value="only" />
          <span class="option__text">
            <span class="option__label">{{ t('staffUsers.block.optionOnly') }}</span>
            <span class="muted">{{ t('staffUsers.block.optionOnlyHint') }}</span>
          </span>
        </label>
        <label class="option" :class="{ 'option--on': choice === 'remove' }">
          <input v-model="choice" type="radio" :name="radioName" value="remove" />
          <span class="option__text">
            <span class="option__label">{{ t('staffUsers.block.optionRemove') }}</span>
            <span class="muted">{{ t('staffUsers.block.optionRemoveHint') }}</span>
          </span>
        </label>
      </fieldset>

      <p class="consequence">{{ t('staffUsers.block.consequence') }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>

    <div v-else ref="doneBlock" class="block" tabindex="-1" data-testid="block-done">
      <p v-if="note" class="muted" role="status">{{ note }}</p>
      <RemovalStatusPanel :user-id="userId" blocked />
    </div>

    <template #footer>
      <template v-if="stage === 'choose'">
        <AppButton variant="secondary" size="lg" :disabled="busy" @click="setOpen(false)">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton
          variant="danger"
          size="lg"
          :loading="busy"
          data-testid="block-confirm"
          @click="submit"
        >
          {{ confirmLabel }}
        </AppButton>
      </template>
      <AppButton v-else variant="primary" size="lg" @click="setOpen(false)">
        {{ t('staffUsers.block.close') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.block:focus {
  outline: none;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.groups__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--t2);
}

.groups__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-weight: 600;
}

.muted {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}

.choice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

.choice__legend {
  padding: 0;
  margin-bottom: 8px;
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: var(--tap-min);
  padding: 10px 12px;
  border-radius: var(--r-row);
  box-shadow: inset 0 0 0 1px var(--e8);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    box-shadow 0.18s ease;
}

/* v8 picked option: accent tint with an accent ring (as the payment-method choice). */
.option--on {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.option input {
  margin-top: 3px;
  accent-color: var(--acc);
}

.option__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.option__label {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.consequence {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-small);
}

.error {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}
</style>
