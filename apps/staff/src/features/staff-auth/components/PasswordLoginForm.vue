<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import PasswordSignInForm from '@core/components/auth/PasswordSignInForm.vue';
defineProps<{ busy: boolean; waitSeconds: number; disabled?: boolean }>();
const emit = defineEmits<{ submit: [credentials: { login: string; password: string }] }>();
const { t } = useI18n();
</script>
<template>
  <PasswordSignInForm
    :busy="busy"
    :wait-seconds="waitSeconds"
    :disabled="disabled"
    :recovery-hint="t('auth.login.design.recoveryHint')"
    @submit="emit('submit', $event)"
  />
</template>
