<script setup lang="ts">
import {
  isStaffLogin,
  newStaffPasswordSchema,
  type SetStaffCredentialsRequest,
  type StaffAccountResponse,
} from '@iorder/shared/staff-auth';
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { EXIT_MS } from '@core/components/ui/motion';
import { showToast } from '@core/composables/use-toast';
import { errorTextFor } from '../domain/error-text';
import OneTimePassword from './OneTimePassword.vue';
import PasswordInput from './PasswordInput.vue';
import TextField from '@core/components/ui/TextField.vue';

const props = defineProps<{ modelValue: boolean; account: StaffAccountResponse }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [login: string];
}>();

const { t } = useI18n();
const { staffAccountsApi } = useServices();

const login = ref('');
const password = ref('');
const busy = ref(false);
const wasGenerated = ref(false);
const shownPassword = ref<string | null>(null);
// Which layout the dialog shows; kept apart from the secret so the secret can be wiped first.
const showingOnce = ref(false);
const loginError = ref<string | null>(null);
const passwordError = ref<string | null>(null);
const formError = ref<string | null>(null);
const serverError = ref<string | null>(null);

function reset(): void {
  login.value = '';
  password.value = '';
  busy.value = false;
  wasGenerated.value = false;
  shownPassword.value = null;
  showingOnce.value = false;
  loginError.value = null;
  passwordError.value = null;
  formError.value = null;
  serverError.value = null;
}
// Opening starts blank. Closing wipes the secrets at once, but the layout (the one-time panel)
// stays until the exit animation is over, so the panel does not flip to an empty form while it
// fades out.
let resetTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.modelValue,
  (open) => {
    clearTimeout(resetTimer);
    if (open) {
      reset();
      return;
    }
    password.value = '';
    shownPassword.value = null;
    resetTimer = setTimeout(reset, EXIT_MS);
  },
);
onBeforeUnmount(() => {
  clearTimeout(resetTimer);
  reset();
});

function onPasswordInput(value: string): void {
  password.value = value;
  wasGenerated.value = false;
}

async function submit(): Promise<void> {
  if (busy.value) return;
  const nextLogin = login.value.trim().toLowerCase();
  const nextPassword = password.value;
  loginError.value = null;
  passwordError.value = null;
  formError.value = null;
  if (nextLogin === '' && nextPassword === '') {
    formError.value = t('staffUsers.accounts.credentialsDialog.nothing');
    return;
  }
  if (nextLogin !== '' && !isStaffLogin(nextLogin)) {
    loginError.value = t('staffUsers.accounts.create.errors.login');
  }
  if (nextPassword !== '' && !newStaffPasswordSchema.safeParse(nextPassword).success) {
    passwordError.value = t('staffUsers.accounts.create.errors.password');
  }
  if (loginError.value || passwordError.value) return;

  busy.value = true;
  serverError.value = null;
  const generated = wasGenerated.value && nextPassword !== '';
  const body: SetStaffCredentialsRequest = {
    ...(nextLogin !== '' ? { login: nextLogin } : {}),
    ...(nextPassword !== '' ? { password: nextPassword } : {}),
  };
  // A typed password leaves the form at submit; a generated one is shown once after saving.
  if (!generated) password.value = '';
  try {
    const result = await staffAccountsApi.setCredentials(props.account.id, body);
    emit('saved', result.login);
    if (generated) {
      shownPassword.value = nextPassword;
      showingOnce.value = true;
      password.value = '';
    } else {
      showToast({ message: t('staffUsers.accounts.credentialsDialog.saved') });
      emit('update:modelValue', false);
    }
  } catch (caught) {
    const text = errorTextFor(caught);
    serverError.value = t(`staffUsers.errors.${text.key}`, { ...text.params });
  } finally {
    busy.value = false;
  }
}

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('staffUsers.accounts.credentialsDialog.title', { name: account.fullName })"
    :description="!showingOnce ? t('staffUsers.accounts.credentialsDialog.description') : undefined"
    max-width="520px"
    @update:model-value="(open) => (open ? emit('update:modelValue', true) : close())"
  >
    <OneTimePassword v-if="showingOnce" :password="shownPassword ?? ''" @done="close" />
    <form v-else class="form" novalidate @submit.prevent="submit">
      <TextField
        v-model="login"
        inputmode="email"
        :label="t('staffUsers.accounts.credentialsDialog.newLogin')"
        :hint="t('staffUsers.accounts.create.loginHint')"
        :error="loginError"
        :disabled="busy"
      />
      <PasswordInput
        :model-value="password"
        :label="t('staffUsers.accounts.credentialsDialog.newPassword')"
        :hint="t('staffUsers.accounts.create.passwordHint')"
        :error="passwordError"
        :disabled="busy"
        @update:model-value="onPasswordInput"
        @generated="wasGenerated = true"
      />
      <p v-if="formError" class="error" role="alert">{{ formError }}</p>
      <p v-if="serverError" class="error" role="alert">{{ serverError }}</p>
      <div class="actions">
        <AppButton variant="secondary" size="lg" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton type="submit" size="lg" :loading="busy" data-testid="credentials-save">
          {{ t('staffUsers.accounts.credentialsDialog.save') }}
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
  justify-content: flex-end;
  gap: 8px;
}
</style>
