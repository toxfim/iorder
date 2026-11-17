<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import { describePricingError } from '@core/lib/price-errors';
import {
  createBotNotificationsReminder,
  receivesBotNotifications,
} from '../composables/bot-notifications';

// [C] 2026-10-25: a staff member the bot cannot reach is asked, on every staff page, to connect
// it. Pressing the button opens the one-time t.me link; after Start in Telegram the person comes
// back and the status is read again (window focus), which hides the reminder.

const { t } = useI18n();
const { staffNotificationsApi, currentUser } = useServices();
const reminder = createBotNotificationsReminder(staffNotificationsApi);
const { status, connecting, linkOpened, connectError } = reminder;

const applies = computed(() => receivesBotNotifications(currentUser.user.value?.staffRoles ?? []));
const visible = computed(
  () => applies.value && status.value !== null && !status.value.botConnected,
);
const bodyText = computed(() =>
  linkOpened.value
    ? t('botNotifications.pressStart')
    : status.value?.telegramLinked
      ? t('botNotifications.notConnected')
      : t('botNotifications.notLinked'),
);
const errorText = computed(() =>
  connectError.value === null ? null : t(describePricingError('load', connectError.value).key),
);

function onReturn(): void {
  if (document.visibilityState === 'visible' && visible.value) void reminder.refresh();
}

onMounted(() => {
  if (!applies.value) return;
  void reminder.refresh();
  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', onReturn);
});
onBeforeUnmount(() => {
  window.removeEventListener('focus', onReturn);
  document.removeEventListener('visibilitychange', onReturn);
});
</script>

<template>
  <!-- A slim bar on every staff page: always visible until the bot is connected ([C], no dismiss).
       One line on wide screens, so the page under it (a table) keeps the room; on narrow screens
       the text takes a second line, because it says what to do (press Start, come back). -->
  <section v-if="visible" class="reminder" role="status" data-testid="bot-reminder">
    <div class="reminder__text" :title="bodyText">
      <h2 class="reminder__title">{{ t('botNotifications.title') }}</h2>
      <p class="reminder__body">{{ bodyText }}</p>
    </div>
    <div class="reminder__actions">
      <AppButton size="sm" :loading="connecting" @click="reminder.connect()">
        {{ t('botNotifications.connect') }}
      </AppButton>
      <AppButton v-if="linkOpened" size="sm" variant="secondary" @click="reminder.refresh()">
        {{ t('botNotifications.check') }}
      </AppButton>
    </div>
    <p v-if="errorText" class="reminder__error" role="alert">{{ errorText }}</p>
  </section>
</template>

<style scoped>
.reminder {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--container-pad) var(--gap-card);
  padding: 6px 8px 6px 14px;
  border-radius: var(--r-panel);
  background: var(--amber-bg);
  color: var(--amber);
}

/* Title and text on one line; the text gives way first, then the title, each with an ellipsis. */
.reminder__text {
  display: flex;
  flex: 1 1 0;
  align-items: baseline;
  gap: var(--container-pad);
  min-width: 0;
}

.reminder__title,
.reminder__body {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reminder__title {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--fs-small);
  font-weight: 700;
}

.reminder__body {
  flex: 1 1 0;
  min-width: 0;
  font-size: var(--fs-small);
}

.reminder__actions {
  display: flex;
  flex: none;
  gap: 8px;
}

/* Narrow screens: one line has room for little more than the title and the button, so the text
   wraps onto a second line under the title instead of being cut. */
@media (max-width: 720px) {
  .reminder__text {
    flex-wrap: wrap;
    row-gap: 2px;
  }

  .reminder__body {
    flex-basis: 100%;
    overflow: visible;
    white-space: normal;
  }
}

/* A failed connect gets its own line under the bar. */
.reminder__error {
  flex: 1 1 100%;
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}
</style>
