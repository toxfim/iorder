<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import type { ActivityEntry } from '@/features/activity/api/activity-api';
import { useFormat } from '@core/i18n/use-format';

const { t } = useI18n();
const { activityStore } = useServices();
const { formatTime } = useFormat();

// Role codes in an entry are translated here, so the stored event stays language-neutral.
function describe(entry: ActivityEntry): string {
  const params: Record<string, string> = { ...entry.params };
  if (entry.params.role) {
    const scope = entry.kind.startsWith('STAFF') ? 'staff' : 'organization';
    params.role = t(`roles.${scope}.${entry.params.role}`);
  }
  return t(`activity.${entry.kind}`, params);
}
</script>

<template>
  <section class="feed" :aria-label="t('dashboard.recent.title')">
    <h2 class="feed__title">{{ t('dashboard.recent.title') }}</h2>
    <ul class="feed__list">
      <li v-for="entry in activityStore.entries.value" :key="entry.id" class="feed__item">
        <span class="feed__time mono">{{ formatTime(entry.at) }}</span>
        <span class="feed__text">{{ describe(entry) }}</span>
      </li>
      <li v-if="activityStore.entries.value.length === 0" class="feed__empty">
        {{ t('dashboard.recent.empty') }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.feed {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.feed__title {
  margin: 0;
  padding: 20px 20px 14px;
  font-size: var(--fs-section);
  font-weight: 600;
}

.feed__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.feed__item {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-small);
}

.feed__time {
  flex: none;
  width: 42px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.feed__text {
  color: var(--ink);
  text-wrap: pretty;
}

.feed__empty {
  padding: 24px 20px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-small);
  color: var(--t2);
  text-align: center;
}
</style>
