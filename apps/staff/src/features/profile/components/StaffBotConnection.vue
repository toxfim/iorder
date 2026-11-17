<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppCard from '@/components/ui/AppCard.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import { describePricingError } from '@core/lib/price-errors';
import {
  createBotNotificationsReminder,
  receivesBotNotifications,
} from '@/features/staff-notifications/composables/bot-notifications';

// The signed-in person's own bot connection ([C] 2026-10-25), read from the same endpoint as the
// shell reminder: whether a Telegram id is on the account and whether the bot reaches them. The
// connect button opens the same one-time t.me link. An administrator gets no order messages, so
// the endpoint (which refuses ADMIN) is not even asked.

defineProps<{ title: string; subtitle?: string }>();

const { t } = useI18n();
const { staffNotificationsApi, currentUser } = useServices();
const reminder = createBotNotificationsReminder(staffNotificationsApi);
const { status, connecting, linkOpened, connectError } = reminder;

const applies = computed(() => receivesBotNotifications(currentUser.user.value?.staffRoles ?? []));
const loading = ref(true);

async function refresh(): Promise<void> {
  loading.value = true;
  await reminder.refresh();
  loading.value = false;
}

// The composable keeps the last good answer and swallows a failed read; with no answer at all the
// card says it could not read the state instead of guessing.
const failed = computed(() => !loading.value && status.value === null);
const errorText = computed(() =>
  connectError.value === null ? null : t(describePricingError('load', connectError.value).key),
);

onMounted(() => {
  if (applies.value) void refresh();
  else loading.value = false;
});
</script>

<template>
  <AppCard :title="title" :subtitle="subtitle" data-testid="own-bot-connection">
    <div class="body">
      <p v-if="!applies" class="note" data-testid="bot-admin-note">
        {{ t('staffProfile.bot.adminNote') }}
      </p>
      <p v-else-if="loading && status === null" class="note" role="status">
        {{ t('state.loading') }}
      </p>
      <div v-else-if="failed" class="note note--error" role="alert">
        <span>{{ t('staffProfile.bot.loadError') }}</span>
        <AppButton size="xs" variant="secondary" @click="refresh()">
          {{ t('staffProfile.bot.retry') }}
        </AppButton>
      </div>
      <template v-else-if="status">
        <dl class="facts">
          <div class="fact">
            <dt>{{ t('staffProfile.bot.telegram') }}</dt>
            <dd>
              <AppBadge :tone="status.telegramLinked ? 'success' : 'muted'" dot>
                {{
                  status.telegramLinked
                    ? t('staffProfile.bot.linked')
                    : t('staffProfile.bot.notLinked')
                }}
              </AppBadge>
            </dd>
          </div>
          <div class="fact">
            <dt>{{ t('staffProfile.bot.botState') }}</dt>
            <dd>
              <AppBadge
                :tone="status.botConnected ? 'success' : 'muted'"
                dot
                data-testid="bot-state"
              >
                {{
                  status.botConnected
                    ? t('staffProfile.bot.connected')
                    : t('staffProfile.bot.notConnected')
                }}
              </AppBadge>
            </dd>
          </div>
        </dl>
        <p v-if="status.botConnected" class="note">{{ t('staffProfile.bot.connectedHint') }}</p>
        <template v-else>
          <p class="note">
            {{
              linkOpened
                ? t('botNotifications.pressStart')
                : status.telegramLinked
                  ? t('botNotifications.notConnected')
                  : t('botNotifications.notLinked')
            }}
          </p>
          <p v-if="errorText" class="note note--error" role="alert">{{ errorText }}</p>
          <div class="actions">
            <AppButton size="sm" :loading="connecting" @click="reminder.connect()">
              {{ t('botNotifications.connect') }}
            </AppButton>
            <AppButton v-if="linkOpened" size="sm" variant="secondary" @click="refresh()">
              {{ t('botNotifications.check') }}
            </AppButton>
          </div>
        </template>
      </template>
    </div>
  </AppCard>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 20px 20px;
}

.facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 0;
}

.fact {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.fact dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.fact dd {
  margin: 0;
}

.note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.note--error {
  color: var(--red);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
