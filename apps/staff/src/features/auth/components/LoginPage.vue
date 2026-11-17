<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { STAFF_TELEGRAM_BOT_USERNAME } from '@/features/staff-auth/staff-login-bot';
import { useServices } from '@/app/services';
import LoginLayout from '@core/components/auth/LoginLayout.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import { clearSiteHint } from '@core/lib/site-hint';
import PasswordLoginForm from '@/features/staff-auth/components/PasswordLoginForm.vue';
import TelegramLoginWidget from '@/features/staff-auth/components/TelegramLoginWidget.vue';
import { useStaffSignIn } from '@/features/staff-auth/composables/use-staff-sign-in';
import { homeFor, resolveAccess } from '@/router/guards';
import type { CurrentUser } from '../api/auth-api';
import { safeRedirect } from '../redirect';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { authApi, currentUser } = useServices();

// This page shows exactly when nobody is signed in here (after a sign-out, an ended session, or a
// first visit), so the hint that lets the customer site continue with a dashboard sign-in is taken
// back: without a session there is nothing to continue with.
onMounted(() => clearSiteHint());

const identities = computed(() => authApi.listDemoIdentities?.() ?? []);
const pendingId = ref<string | null>(null);
const signInFailed = ref(false);

// Which real methods exist is decided by the adapter (the fake offers none of them).
const hasPassword = authApi.signInWithPassword !== undefined;
// The widget needs both the adapter method and a configured bot; otherwise no script is loaded.
const widgetBot =
  authApi.signInWithTelegramWidget !== undefined ? STAFF_TELEGRAM_BOT_USERNAME : null;

function roleLabel(identity: (typeof identities.value)[number]): string {
  const staff = identity.staffRoles.map((role) => t(`roles.staff.${role}`));
  if (staff.length > 0) return staff.join(', ');
  return identity.organizationRole ? t(`roles.organization.${identity.organizationRole}`) : '';
}

async function goAfterSignIn(user: CurrentUser): Promise<void> {
  const target = safeRedirect(route.query.redirect);
  // Honour the remembered page only if this user may open it; otherwise start at home
  // instead of landing on a permission-denied screen.
  const allowed = target !== null && resolveAccess(router.resolve(target), user) === true;
  await router.replace(allowed && target ? target : homeFor(user));
}

const staffSignIn = useStaffSignIn(goAfterSignIn);

async function signInDemo(identityId: string): Promise<void> {
  pendingId.value = identityId;
  signInFailed.value = false;
  try {
    await goAfterSignIn(await currentUser.signIn(identityId));
  } catch (caught) {
    // Stay on the login screen with the buttons usable again, and say what happened.
    console.error(caught);
    signInFailed.value = true;
  } finally {
    pendingId.value = null;
  }
}

const failureText = computed(() => {
  switch (staffSignIn.failure.value) {
    case 'rateLimited':
      return t('auth.login.rateLimited');
    case 'failed':
      return t('auth.login.failed');
    default:
      return null;
  }
});
</script>

<template>
  <main>
    <LoginLayout
      :audience="t('auth.login.design.audience')"
      :title="t('auth.login.design.title')"
      :subtitle="t('auth.login.design.subtitle')"
      :note="t('auth.login.design.note')"
      :footer="t('auth.login.design.footer')"
      :hero-eyebrow="t('auth.login.design.heroEyebrow')"
      :hero-title="t('auth.login.design.heroTitle')"
      :hero-description="t('auth.login.design.heroDescription')"
      :hero-note="t('auth.login.design.heroNote')"
    >
      <PasswordLoginForm
        :disabled="!hasPassword"
        :busy="staffSignIn.busy.value"
        :wait-seconds="staffSignIn.waitSeconds.value"
        @submit="staffSignIn.withPassword"
      />
      <p v-if="staffSignIn.widgetIgnored.value" class="auth-error" role="status">
        {{ t('auth.login.telegram.ignored') }}
      </p>
      <div v-if="failureText !== null" class="auth-error" role="alert">
        <span>{{ failureText }}</span>
        <span v-if="staffSignIn.waitSeconds.value > 0" aria-hidden="true">
          {{ t('auth.login.retryIn', { seconds: staffSignIn.waitSeconds.value }) }}</span
        >
      </div>
      <div class="auth-divider">{{ t('signIn.or') }}</div>
      <section
        class="auth-telegram"
        :inert="staffSignIn.busy.value || staffSignIn.waitSeconds.value > 0"
        :aria-label="t('auth.login.telegram.title')"
      >
        <h2>{{ t('signIn.telegram') }}</h2>
        <TelegramLoginWidget
          v-if="widgetBot !== null"
          :bot-username="widgetBot"
          @auth="staffSignIn.withTelegramWidget"
        />
        <p v-else class="auth-telegram__unavailable" role="status">
          {{ t('signIn.telegramUnavailable') }}
        </p>
      </section>
      <details v-if="identities.length > 0" class="login__identities">
        <summary class="login__identities-title">{{ t('demo.identities') }}</summary>
        <AppButton
          v-for="identity in identities"
          :key="identity.id"
          variant="secondary"
          size="lg"
          block
          :loading="pendingId === identity.id"
          :disabled="pendingId !== null"
          @click="signInDemo(identity.id)"
        >
          <span class="login__who">{{ identity.displayName }}</span
          ><span class="login__role">{{ roleLabel(identity) }}</span>
        </AppButton>
      </details>
      <div v-if="signInFailed" class="auth-error" role="alert">
        <strong>{{ t('state.error.title') }}</strong> {{ t('state.error.description') }}
      </div>
    </LoginLayout>
  </main>
</template>
<style scoped>
.login__identities {
  display: flex;
  flex-direction: column;
  gap: var(--gap-row);
}
.login__identities-title {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
  cursor: pointer;
  min-height: var(--tap-min);
  align-content: center;
}
.login__who {
  flex: 1;
  text-align: start;
}
.login__role {
  font-size: var(--fs-meta);
  color: var(--t3);
}
</style>
