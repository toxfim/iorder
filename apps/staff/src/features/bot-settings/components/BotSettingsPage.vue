<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppCard from '@/components/ui/AppCard.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import StaffBotConnection from '@/features/profile/components/StaffBotConnection.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import { TELEGRAM_BOT_USERNAME } from '@core/app/env';

// Design v8 "Bot sozlamalari", limited to what the app really knows: the bot username this build
// was configured with, the signed-in person's own bot connection, and the notification rules
// (order-lifecycle 6.1 and the customer echo), shown as fixed rules. The api has no bot settings
// route: no token, webhook state, ping, profile editing or per-message switches. Those parts of
// the design are left out or say where the setting lives instead; nothing here pretends to save.

// Tests pass the username; the route leaves it out and the build's value is used.
const props = defineProps<{ botUsername?: string | null }>();

const { t } = useI18n();

const username = computed(() =>
  props.botUsername === undefined ? TELEGRAM_BOT_USERNAME : props.botUsername,
);
const botLink = computed(() =>
  username.value ? `https://t.me/${encodeURIComponent(username.value)}` : null,
);
const RULES = ['staff', 'customer'] as const;
</script>

<template>
  <div class="page">
    <header class="head">
      <h1 class="head__title">{{ t('botSettings.title') }}</h1>
      <p class="head__info">{{ t('botSettings.subtitle') }}</p>
    </header>

    <div class="grid">
      <div class="col">
        <AppCard
          :title="t('botSettings.connection.title')"
          :subtitle="t('botSettings.connection.subtitle')"
        >
          <template #actions>
            <StaffIcon name="key" :size="18" class="muted-icon" />
          </template>
          <div class="body">
            <div class="facts">
              <div class="fact">
                <span class="fact__label">{{ t('botSettings.connection.username') }}</span>
                <a
                  v-if="botLink"
                  class="fact__link"
                  :href="botLink"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="bot-username"
                >
                  {{ `@${username} ↗` }}
                </a>
                <span v-else class="fact__value fact__value--muted" data-testid="bot-username">
                  {{ t('botSettings.connection.usernameMissing') }}
                </span>
              </div>
              <div class="fact">
                <span class="fact__label">{{ t('botSettings.connection.token') }}</span>
                <span class="fact__value fact__value--muted">
                  {{ t('botSettings.connection.tokenHidden') }}
                </span>
              </div>
            </div>
            <p class="notice" data-testid="bot-check-unavailable">
              {{ t('botSettings.connection.checkUnavailable') }}
            </p>
          </div>
        </AppCard>

        <AppCard
          :title="t('botSettings.appearance.title')"
          :subtitle="t('botSettings.appearance.subtitle')"
        >
          <div class="body">
            <p class="notice">{{ t('botSettings.appearance.unavailable') }}</p>
          </div>
        </AppCard>

        <AppCard :title="t('botSettings.rules.title')" :subtitle="t('botSettings.rules.subtitle')">
          <ul class="rules" data-testid="bot-rules">
            <li v-for="rule in RULES" :key="rule" class="rule">
              <div class="rule__text">
                <span class="rule__title">{{ t(`botSettings.rules.${rule}.title`) }}</span>
                <span class="rule__body">{{ t(`botSettings.rules.${rule}.body`) }}</span>
              </div>
              <AppBadge tone="muted">{{ t('botSettings.rules.fixed') }}</AppBadge>
            </li>
          </ul>
        </AppCard>
      </div>

      <div class="col">
        <StaffBotConnection
          :title="t('botSettings.own.title')"
          :subtitle="t('botSettings.own.subtitle')"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* v8 page title, the same on every staff page: 28px regular. */
.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__info {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* v8: the settings column beside a 410px status column. */
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 410px;
  align-items: start;
  gap: 24px;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.muted-icon {
  color: var(--t2);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0 20px 20px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.fact__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.fact__value,
.fact__link {
  font-size: var(--fs-small);
  overflow-wrap: anywhere;
}

.fact__link {
  color: var(--acc-fg);
}

.fact__value--muted {
  color: var(--t2);
}

/* "Not available here" facts: the grey info strip, not a warning. */
.notice {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.rules {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin: 0;
  padding: 0 20px 20px;
  list-style: none;
}

.rule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.rule__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.rule__title {
  font-size: var(--fs-small);
  font-weight: 500;
}

.rule__body {
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
