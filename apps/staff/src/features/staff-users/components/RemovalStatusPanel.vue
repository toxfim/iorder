<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge, { type BadgeTone } from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import { useRemovalStatus } from '../composables/use-removal-status';
import { errorTextFor } from '../domain/error-text';
import { isRetryable, maybeBanned, reasonKey } from '../domain/removal-reasons';

const props = withDefaults(
  defineProps<{
    userId: string;
    /** Retrying is offered only while the person is blocked: it blocks them again with the flag. */
    blocked: boolean;
    /** On a page that is not about a removal: draw nothing until the person has one. */
    hideWhenEmpty?: boolean;
  }>(),
  { hideWhenEmpty: false },
);

const { t } = useI18n();
const { staffUsersApi } = useServices();
const headingId = useId();

const status = useRemovalStatus(staffUsersApi, () => props.userId);

const TONES: Record<string, BadgeTone> = { PENDING: 'warning', DONE: 'success', FAILED: 'danger' };

const retryable = computed(() => (props.blocked ? status.items.value.filter(isRetryable) : []));
const visible = computed(
  () => !props.hideWhenEmpty || status.items.value.length > 0 || status.state.value === 'error',
);

const retrying = ref(false);
const retryNote = ref<string | null>(null);
const retryError = ref<string | null>(null);

function errorMessage(error: unknown): string {
  const text = errorTextFor(error);
  return t(`staffUsers.errors.${text.key}`, { ...text.params });
}

const readError = computed(() =>
  status.state.value === 'error' || status.state.value === 'denied'
    ? errorMessage(status.error.value)
    : null,
);

// Blocking again with the flag is how the server re-queues removals that FAILED; one that is
// waiting or done is not queued twice, so this is safe to press.
async function retry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  retryNote.value = null;
  retryError.value = null;
  try {
    const answer = await staffUsersApi.blockUser(props.userId, { removeFromGroups: true });
    const queued = answer.groupRemoval?.queued ?? 0;
    retryNote.value =
      queued > 0
        ? t('staffUsers.removal.retried', { count: queued })
        : t('staffUsers.removal.retryNone');
    await status.refresh();
  } catch (caught) {
    retryError.value = errorMessage(caught);
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <section v-if="visible" class="removal" :aria-labelledby="headingId" data-testid="removal-status">
    <header class="removal__head">
      <h3 :id="headingId" class="removal__title">{{ t('staffUsers.removal.title') }}</h3>
      <AppButton
        size="sm"
        variant="secondary"
        :loading="status.refreshing.value"
        data-testid="removal-refresh"
        @click="status.refresh()"
      >
        {{
          status.refreshing.value
            ? t('staffUsers.removal.refreshing')
            : t('staffUsers.removal.refresh')
        }}
      </AppButton>
    </header>

    <p v-if="status.watching.value" class="removal__note" role="status">
      {{ t('staffUsers.removal.watching') }}
    </p>
    <p v-if="status.stalled.value" class="removal__note" role="status">
      {{ t('staffUsers.removal.stalled') }}
    </p>
    <p v-if="readError" class="removal__error" role="alert">{{ readError }}</p>

    <ul
      v-if="status.items.value.length > 0"
      class="items"
      :aria-label="t('staffUsers.removal.list')"
    >
      <li v-for="item in status.items.value" :key="item.organizationId" class="item">
        <div class="item__line">
          <span class="item__name">{{ item.organizationName }}</span>
          <AppBadge :tone="TONES[item.status] ?? 'neutral'">
            {{ t(`staffUsers.removal.status.${item.status}`) }}
          </AppBadge>
        </div>
        <p v-if="item.status !== 'DONE' && item.errorCode !== null" class="item__reason">
          {{ t(`staffUsers.removal.reason.${reasonKey(item.errorCode)}`) }}
        </p>
        <p v-else-if="item.status === 'FAILED'" class="item__reason">
          {{ t('staffUsers.removal.reason.UNKNOWN') }}
        </p>
        <p v-if="maybeBanned(item)" class="item__warn" role="alert">
          {{ t('staffUsers.removal.banWarning') }}
        </p>
      </li>
    </ul>
    <p v-else-if="status.state.value === 'ready'" class="removal__note">
      {{ t('staffUsers.removal.empty') }}
    </p>

    <div v-if="retryable.length > 0" class="retry">
      <p class="removal__note">{{ t('staffUsers.removal.retryHint') }}</p>
      <AppButton
        size="md"
        variant="secondary"
        :loading="retrying"
        data-testid="removal-retry"
        @click="retry"
      >
        {{ retrying ? t('staffUsers.removal.retrying') : t('staffUsers.removal.retry') }}
      </AppButton>
    </div>
    <p v-if="retryNote" class="removal__note" role="status">{{ retryNote }}</p>
    <p v-if="retryError" class="removal__error" role="alert">{{ retryError }}</p>
  </section>
</template>

<style scoped>
.removal {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.removal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.removal__title {
  margin: 0;
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.removal__note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}

.removal__error {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--r-input);
  background: var(--f5);
}

.item__line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.item__name {
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.item__reason {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.item__warn {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-small);
}

.retry {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
</style>
