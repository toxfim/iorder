<script setup lang="ts">
import { telegramUserIdSchema } from '@iorder/shared';
import type { StaffAccountResponse } from '@iorder/shared/staff-auth';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { showToast } from '@core/composables/use-toast';
import { errorTextFor } from '../domain/error-text';
import TextField from '@core/components/ui/TextField.vue';

const props = defineProps<{ modelValue: boolean; account: StaffAccountResponse }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [account: StaffAccountResponse];
}>();

const { t } = useI18n();
const { staffAccountsApi } = useServices();

const telegramId = ref('');
const busy = ref(false);
const fieldError = ref<string | null>(null);
const serverError = ref<string | null>(null);

// The api never returns a Telegram id, so the field always starts empty.
watch(
  () => props.modelValue,
  () => {
    telegramId.value = '';
    busy.value = false;
    fieldError.value = null;
    serverError.value = null;
  },
);

async function send(value: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  serverError.value = null;
  try {
    const account = await staffAccountsApi.setTelegram(props.account.id, value);
    emit('saved', account);
    showToast({ message: t('staffUsers.accounts.telegramDialog.saved') });
    emit('update:modelValue', false);
  } catch (caught) {
    const text = errorTextFor(caught);
    serverError.value = t(`staffUsers.errors.${text.key}`, { ...text.params });
  } finally {
    busy.value = false;
  }
}

// The id can only be replaced, never removed: an unlinked staff member would be taken for a
// customer in a Telegram group. So an empty field is a mistake, not a request to unlink.
function save(): void {
  const value = telegramId.value.trim();
  if (!telegramUserIdSchema.safeParse(value).success) {
    fieldError.value = t('staffUsers.accounts.telegramDialog.error');
    return;
  }
  fieldError.value = null;
  void send(value);
}

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('staffUsers.accounts.telegramDialog.title', { name: account.fullName })"
    :description="t('staffUsers.accounts.telegramDialog.description')"
    @update:model-value="(open) => (open ? emit('update:modelValue', true) : close())"
  >
    <form class="form" novalidate @submit.prevent="save">
      <p class="current">
        {{
          t('staffUsers.accounts.telegramDialog.current', {
            state: account.telegramLinked
              ? t('staffUsers.accounts.telegram.linked')
              : t('staffUsers.accounts.telegram.notLinked'),
          })
        }}
      </p>
      <TextField
        v-model="telegramId"
        digits-only
        :maxlength="20"
        :label="t('staffUsers.accounts.telegramDialog.id')"
        :hint="t('staffUsers.accounts.telegramDialog.hint')"
        :error="fieldError"
        :disabled="busy"
      />
      <p v-if="serverError" class="error" role="alert">{{ serverError }}</p>
      <div class="actions">
        <AppButton type="submit" size="lg" :loading="busy" data-testid="telegram-save">
          {{ t('staffUsers.accounts.telegramDialog.save') }}
        </AppButton>
      </div>
    </form>
  </AppModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.current {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.error {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
</style>
