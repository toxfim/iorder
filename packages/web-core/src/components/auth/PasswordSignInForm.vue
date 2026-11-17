<script setup lang="ts">
import { ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
const props = withDefaults(
  defineProps<{ busy: boolean; waitSeconds?: number; disabled?: boolean; recoveryHint: string }>(),
  { waitSeconds: 0, disabled: false },
);
const emit = defineEmits<{ submit: [credentials: { login: string; password: string }] }>();
const { t } = useI18n();
const id = useId();
const login = ref('');
const password = ref('');
const visible = ref(false);
function submit(): void {
  if (
    props.busy ||
    props.disabled ||
    props.waitSeconds > 0 ||
    !login.value.trim() ||
    !password.value
  )
    return;
  const credentials = { login: login.value.trim(), password: password.value };
  password.value = '';
  visible.value = false;
  emit('submit', credentials);
}
</script>
<template>
  <form class="auth-password pw" @submit.prevent="submit">
    <div class="auth-field">
      <label :for="`${id}-login`">{{ t('signIn.login') }}</label>
      <input
        :id="`${id}-login`"
        v-model="login"
        type="text"
        name="username"
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        :spellcheck="false"
        maxlength="64"
        required
        :disabled="busy || disabled"
        :placeholder="t('signIn.loginPlaceholder')"
      />
    </div>
    <div class="auth-field">
      <label :for="`${id}-password`">{{ t('signIn.password') }}</label>
      <div class="auth-field__secret">
        <input
          :id="`${id}-password`"
          v-model="password"
          :type="visible ? 'text' : 'password'"
          name="password"
          autocomplete="current-password"
          maxlength="256"
          required
          :disabled="busy || disabled"
          :placeholder="t('signIn.passwordPlaceholder')"
        />
        <button
          type="button"
          class="auth-visibility"
          :aria-label="t(visible ? 'signIn.hidePassword' : 'signIn.showPassword')"
          :aria-pressed="visible"
          :aria-controls="`${id}-password`"
          :disabled="busy || disabled"
          @click="visible = !visible"
        >
          <span aria-hidden="true">{{ visible ? t('signIn.hide') : t('signIn.show') }}</span>
        </button>
      </div>
    </div>
    <details class="auth-recovery">
      <summary>{{ t('signIn.forgotPassword') }}</summary>
      <p>{{ recoveryHint }}</p>
    </details>
    <AppButton
      type="submit"
      size="xl"
      block
      :loading="busy"
      :disabled="busy || disabled || waitSeconds > 0"
      >{{
        waitSeconds > 0 ? t('signIn.wait', { seconds: waitSeconds }) : t('signIn.submit')
      }}</AppButton
    >
  </form>
</template>
