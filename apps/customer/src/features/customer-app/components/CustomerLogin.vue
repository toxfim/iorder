<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { TELEGRAM_BOT_USERNAME } from '@core/app/env';
import LoginLayout from '@core/components/auth/LoginLayout.vue';
import PasswordSignInForm from '@core/components/auth/PasswordSignInForm.vue';
import { handoffFailed, markHandoffFailed } from '@/features/customer-session/site-handoff';
import { useCustomerServices } from '../services';
const TelegramLoginWidget = defineAsyncComponent(
  () => import('@core/telegram/components/TelegramLoginWidget.vue'),
);
const { t } = useI18n();
const { auth, session, cart } = useCustomerServices();
const busy = ref(false);
const failed = ref(false);
async function signIn(
  credentials: { login: string; password: string } | null,
  payload?: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!auth || busy.value || (!payload && !credentials)) return;
  busy.value = true;
  failed.value = false;
  // The person signs in by hand now: the note about the automatic attempt has done its job.
  markHandoffFailed(false);
  try {
    if (payload) await auth.telegram(payload);
    else if (credentials) await auth.password(credentials.login, credentials.password);
    cart.clear();
    await session.load();
  } catch {
    failed.value = true;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <LoginLayout
    :audience="t('customer.auth.design.audience')"
    :title="t('customer.auth.design.title')"
    :subtitle="t('customer.auth.design.subtitle')"
    :note="t('customer.auth.firstLogin')"
    :footer="t('customer.auth.design.footer')"
    :hero-eyebrow="t('customer.auth.design.heroEyebrow')"
    :hero-title="t('customer.auth.design.heroTitle')"
    :hero-description="t('customer.auth.design.heroDescription')"
    :hero-note="t('customer.auth.design.heroNote')"
  >
    <p
      v-if="handoffFailed && !failed"
      class="auth-error"
      role="status"
      data-testid="handoff-failed"
    >
      {{ t('customer.auth.handoffFailed') }}
    </p>
    <PasswordSignInForm
      :busy="busy"
      :disabled="!auth"
      :recovery-hint="t('customer.auth.design.recoveryHint')"
      @submit="signIn($event)"
    />
    <p v-if="failed" class="auth-error" role="alert">{{ t('customer.auth.failed') }}</p>
    <div class="auth-divider">{{ t('signIn.or') }}</div>
    <div class="auth-telegram" :inert="busy || !auth">
      <h2>{{ t('customer.auth.telegram') }}</h2>
      <TelegramLoginWidget
        v-if="TELEGRAM_BOT_USERNAME"
        :bot-username="TELEGRAM_BOT_USERNAME"
        @auth="signIn(null, $event)"
      />
      <p v-else class="auth-telegram__unavailable" role="status">
        {{ t('customer.auth.telegramUnavailable') }}
      </p>
    </div>
  </LoginLayout>
</template>
