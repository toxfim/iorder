<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppIcon from '@core/components/ui/AppIcon.vue';
import { readInitData, readLaunchUserId } from '@core/telegram/launch';
import { TELEGRAM_REFUSED } from '@/router/guards';
import { safeRedirect } from '../redirect';

// Telegram opened the app, but the launch did not sign the person in as staff. The server gives
// one answer for every reason (not linked, blocked, unknown, expired), so this screen lists what
// to do instead of guessing which one it was. It replaces the bare login form inside Telegram;
// the form itself stays one button away.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { currentUser } = useServices();

// Signed in, but without a staff role: a customer, or a launch that does not open the staff app.
const variant = computed<'unknown' | 'notStaff'>(() =>
  currentUser.user.value === null ? 'unknown' : 'notStaff',
);
const steps = computed(() =>
  variant.value === 'unknown'
    ? (['reopen', 'link', 'password'] as const)
    : (['staffButton', 'customerApp', 'password'] as const),
);
// Shown so the person can pass it to whoever links accounts. Unverified, display only.
const telegramId = readLaunchUserId(readInitData());

const busy = ref<'retry' | 'password' | null>(null);
const stillRefused = ref(false);

/** Asks the server again: the account may have been linked or unblocked a moment ago. */
async function retry(): Promise<void> {
  if (busy.value !== null) return;
  busy.value = 'retry';
  try {
    await currentUser.reload();
    // The guard brings a person who is still refused back here, and opens the page for the rest.
    await router.replace(safeRedirect(route.query.redirect) ?? '/');
    stillRefused.value = router.currentRoute.value.name === TELEGRAM_REFUSED;
  } finally {
    busy.value = null;
  }
}

/** Leaves the Telegram identity of this tab behind and opens the ordinary sign-in form. */
async function usePassword(): Promise<void> {
  if (busy.value !== null) return;
  busy.value = 'password';
  try {
    const redirect = safeRedirect(route.query.redirect);
    await currentUser.signOut();
    await router.replace({ name: 'login', query: redirect === null ? {} : { redirect } });
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <main class="refused">
    <section class="refused__card" role="alert" :data-variant="variant">
      <span class="refused__tile" aria-hidden="true">
        <AppIcon name="lock" :size="24" />
      </span>
      <h1 class="refused__title">{{ t(`auth.telegram.${variant}.title`) }}</h1>
      <p class="refused__lead">{{ t(`auth.telegram.${variant}.description`) }}</p>

      <div class="refused__steps">
        <h2 class="refused__steps-title">{{ t('auth.telegram.stepsTitle') }}</h2>
        <ol class="refused__list">
          <li v-for="step in steps" :key="step" :data-step="step">
            {{ t(`auth.telegram.steps.${step}`) }}
          </li>
        </ol>
      </div>

      <dl v-if="variant === 'unknown' && telegramId !== null" class="refused__id">
        <dt>{{ t('auth.telegram.yourId') }}</dt>
        <dd data-testid="telegram-id">{{ telegramId }}</dd>
      </dl>

      <p v-if="stillRefused" class="refused__again" role="status">
        {{ t('auth.telegram.stillRefused') }}
      </p>

      <div class="refused__actions">
        <AppButton
          variant="dark"
          size="xl"
          block
          :loading="busy === 'retry'"
          :disabled="busy !== null"
          data-testid="telegram-retry"
          @click="retry"
        >
          {{ t('auth.telegram.retry') }}
        </AppButton>
        <AppButton
          variant="outline"
          size="xl"
          block
          :loading="busy === 'password'"
          :disabled="busy !== null"
          data-testid="telegram-use-password"
          @click="usePassword"
        >
          {{ t('auth.telegram.usePassword') }}
        </AppButton>
      </div>
    </section>
  </main>
</template>

<style scoped>
.refused {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  /* Telegram's own controls and the phone's home indicator stay clear of the card. */
  padding: calc(16px + var(--safe-top, 0px)) 16px calc(16px + var(--safe-bottom, 0px));
  background: var(--page);
}

.refused__card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 420px;
  padding: 24px 20px;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  animation: viewIn 0.35s var(--ease) both;
}

.refused__tile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--r-panel);
  background: var(--hero-bg);
  color: var(--hero-fg);
}

.refused__title {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--ink);
}

.refused__lead {
  margin: 0;
  font-size: var(--fs-body);
  line-height: 1.5;
  color: var(--t2);
}

.refused__steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding: 14px 16px;
  border-radius: var(--r-row);
  background: var(--f5);
}

.refused__steps-title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--ink);
}

.refused__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-inline-start: 20px;
  font-size: var(--fs-body);
  line-height: 1.5;
  color: var(--ink);
}

/* The id and its label share one baseline; a long label wraps above the number, never beside
   a clipped one. */
.refused__id {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  margin: 0;
  padding: 12px 16px;
  border: 1px solid var(--e8);
  border-radius: var(--r-row);
}

.refused__id dt {
  font-size: var(--fs-small);
  color: var(--t2);
}

.refused__id dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-body-lg);
  font-weight: 500;
  color: var(--ink);
  /* One tap selects the whole number for copying. */
  user-select: all;
}

.refused__again {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--red);
}

.refused__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

/* The two actions are the whole point of the screen: full thumb height in every theme. */
.refused__actions :deep(.btn) {
  min-height: var(--tap-min);
}
</style>
