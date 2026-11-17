<script setup lang="ts">
import {
  LOCALES,
  phoneSchema,
  STAFF_ROLES,
  telegramUserIdSchema,
  type Locale,
  type StaffRole,
} from '@iorder/shared';
import {
  isStaffLogin,
  newStaffPasswordSchema,
  type CreateStaffAccountRequest,
  type StaffAccountResponse,
} from '@iorder/shared/staff-auth';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { EXIT_MS } from '@core/components/ui/motion';
import { showToast } from '@core/composables/use-toast';
import { formatPhoneDigits, PHONE_MAX_DIGITS } from '@core/lib/phone';
import { assignableRoles } from '../domain/account-rules';
import { errorTextFor } from '../domain/error-text';
import OneTimePassword from './OneTimePassword.vue';
import PasswordInput from './PasswordInput.vue';
import TextField from '@core/components/ui/TextField.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';

const props = defineProps<{
  modelValue: boolean;
  /** The signed-in person's roles; decides which roles can be offered (UI convenience only). */
  viewerRoles: readonly StaffRole[];
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  created: [account: StaffAccountResponse];
}>();

const { t } = useI18n();
const { staffAccountsApi } = useServices();

const fullName = ref('');
const login = ref('');
const password = ref('');
const roles = ref<StaffRole[]>([]);
const languageOptions = computed(() =>
  LOCALES.map((code) => ({ value: code, label: t(`staffUsers.accounts.languages.${code}`) })),
);
const phone = ref('');
const language = ref<Locale>('UZ');
const telegramId = ref('');
const busy = ref(false);
const submitted = ref(false);
const serverError = ref<string | null>(null);
// Only a password this page generated is ever shown again, once, after saving.
const wasGenerated = ref(false);
const shownPassword = ref<string | null>(null);
// Which layout the dialog shows; kept apart from the secret so the secret can be wiped first.
const showingOnce = ref(false);

const offeredRoles = computed(() => assignableRoles(props.viewerRoles));

function reset(): void {
  fullName.value = '';
  login.value = '';
  password.value = '';
  roles.value = [];
  phone.value = '';
  language.value = 'UZ';
  telegramId.value = '';
  busy.value = false;
  submitted.value = false;
  serverError.value = null;
  wasGenerated.value = false;
  shownPassword.value = null;
  showingOnce.value = false;
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

const trimmedLogin = computed(() => login.value.trim().toLowerCase());
const errors = computed(() => ({
  fullName:
    fullName.value.trim().length === 0 ? t('staffUsers.accounts.create.errors.fullName') : null,
  login: isStaffLogin(trimmedLogin.value) ? null : t('staffUsers.accounts.create.errors.login'),
  password: newStaffPasswordSchema.safeParse(password.value).success
    ? null
    : t('staffUsers.accounts.create.errors.password'),
  roles:
    roles.value.length >= 1 && roles.value.length <= STAFF_ROLES.length
      ? null
      : t('staffUsers.accounts.create.errors.roles'),
  phone:
    phone.value === '' || phoneSchema.safeParse(`+${phone.value}`).success
      ? null
      : t('staffUsers.accounts.create.errors.phone'),
  // Mandatory: without an id the bot would take the person for a customer in a Telegram group.
  telegramId: telegramUserIdSchema.safeParse(telegramId.value).success
    ? null
    : t('staffUsers.accounts.create.errors.telegramId'),
}));
const shown = (key: keyof typeof errors.value): string | null =>
  submitted.value ? errors.value[key] : null;
const valid = computed(() => Object.values(errors.value).every((e) => e === null));

function toggleRole(role: StaffRole): void {
  roles.value = roles.value.includes(role)
    ? roles.value.filter((r) => r !== role)
    : [...roles.value, role];
}

function onPasswordInput(value: string): void {
  password.value = value;
  // Typing over a generated password makes it a chosen one: nothing to show afterwards.
  wasGenerated.value = false;
}

async function submit(): Promise<void> {
  if (busy.value) return;
  submitted.value = true;
  if (!valid.value) return;
  busy.value = true;
  serverError.value = null;
  const sent = password.value;
  const generated = wasGenerated.value;
  const body: CreateStaffAccountRequest = {
    fullName: fullName.value.trim(),
    login: trimmedLogin.value,
    password: sent,
    roles: [...roles.value],
    language: language.value,
    ...(phone.value !== '' ? { phone: `+${phone.value}` } : {}),
    telegramUserId: telegramId.value,
  };
  // The typed password leaves the form at submit. A generated one is kept (it was never typed by
  // a person, so a retry would otherwise lose it) and is shown once on success.
  if (!generated) password.value = '';
  try {
    const account = await staffAccountsApi.create(body);
    emit('created', account);
    if (generated) {
      shownPassword.value = sent;
      showingOnce.value = true;
      password.value = '';
    } else {
      showToast({
        message: t('staffUsers.accounts.created.text', {
          name: account.fullName,
          login: account.login ?? '',
        }),
      });
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
  if (busy.value) return;
  emit('update:modelValue', false);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="
      showingOnce ? t('staffUsers.accounts.created.title') : t('staffUsers.accounts.create.title')
    "
    :description="!showingOnce ? t('staffUsers.accounts.create.description') : undefined"
    max-width="520px"
    @update:model-value="(open) => (open ? emit('update:modelValue', true) : close())"
  >
    <OneTimePassword v-if="showingOnce" :password="shownPassword ?? ''" @done="close" />
    <form v-else class="form" novalidate data-testid="create-account-form" @submit.prevent="submit">
      <TextField
        v-model="fullName"
        :label="t('staffUsers.accounts.create.fullName')"
        :error="shown('fullName')"
        :disabled="busy"
        :maxlength="200"
        autocomplete="off"
      />
      <TextField
        v-model="login"
        :label="t('staffUsers.accounts.create.login')"
        :hint="t('staffUsers.accounts.create.loginHint')"
        :error="shown('login')"
        :disabled="busy"
        inputmode="email"
        autocomplete="off"
      />
      <PasswordInput
        :model-value="password"
        :label="t('staffUsers.accounts.create.password')"
        :hint="t('staffUsers.accounts.create.passwordHint')"
        :error="shown('password')"
        :disabled="busy"
        @update:model-value="onPasswordInput"
        @generated="wasGenerated = true"
      />
      <fieldset class="roles">
        <legend class="roles__legend">{{ t('staffUsers.accounts.create.roles') }}</legend>
        <!-- v8 choice chips; the real checkbox stays in each chip for keyboard and screen readers. -->
        <label
          v-for="role in offeredRoles"
          :key="role"
          class="role"
          :class="{ 'role--on': roles.includes(role), 'role--disabled': busy }"
        >
          <input
            type="checkbox"
            class="role__input"
            :checked="roles.includes(role)"
            :disabled="busy"
            :data-role="role"
            @change="toggleRole(role)"
          />
          <StaffIcon v-if="roles.includes(role)" name="check" :size="13" :stroke-width="2.2" />
          <span>{{ t(`roles.staff.${role}`) }}</span>
        </label>
        <span class="roles__hint">{{ t('staffUsers.accounts.create.rolesHint') }}</span>
        <span v-if="shown('roles')" class="roles__error" role="alert">{{ shown('roles') }}</span>
      </fieldset>
      <TextField
        v-model="phone"
        digits-only
        prefix="+"
        :format="formatPhoneDigits"
        :max-digits="PHONE_MAX_DIGITS"
        autocomplete="tel-national"
        :label="t('staffUsers.accounts.create.phone')"
        :hint="t('staffUsers.accounts.create.phoneHint')"
        :error="shown('phone')"
        :disabled="busy"
      />
      <div class="select">
        <span class="select__label">{{ t('staffUsers.accounts.create.language') }}</span>
        <AppDropdown
          v-model="language"
          :options="languageOptions"
          :label="t('staffUsers.accounts.create.language')"
          min-width="100%"
        />
      </div>
      <TextField
        v-model="telegramId"
        digits-only
        :maxlength="20"
        :label="t('staffUsers.accounts.create.telegramId')"
        :hint="t('staffUsers.accounts.create.telegramHint')"
        :error="shown('telegramId')"
        :disabled="busy"
      />
      <p v-if="serverError" class="error" role="alert">{{ serverError }}</p>
      <div class="actions">
        <AppButton variant="secondary" size="lg" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton type="submit" size="lg" :loading="busy" data-testid="create-account-submit">
          {{ t('staffUsers.accounts.create.submit') }}
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
  max-height: 70vh;
  overflow-y: auto;
  /* The focus ring is a 2px outline with a 2px offset: this box scrolls, so it clips whatever
     leaves it. Room for the ring inside, cancelled outside so the layout stays the same. */
  padding: 6px;
  margin: -6px;
}

.roles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.roles__legend {
  width: 100%;
  padding: 0;
  margin-bottom: 6px;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

/* v8 chip: 32px, fully rounded, hairline ring; picked = accent tint, accent ring and text. */
.role {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-size: var(--fs-small);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    box-shadow 0.18s ease,
    color 0.18s ease;
}

.role:hover {
  background: var(--hov);
}

.role--on,
.role--on:hover {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc-fg);
}

/* Muted by tokens, not opacity: a see-through chip loses contrast in the dark theme. */
.role--disabled {
  cursor: default;
  background: var(--f5);
  color: var(--t3);
}

.role:has(.role__input:focus-visible) {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.role__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.roles__hint {
  width: 100%;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.roles__error {
  width: 100%;
  font-size: var(--fs-meta);
  color: var(--red);
}

.select {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.select__label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
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
