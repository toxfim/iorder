<script setup lang="ts">
import type { SheetSyncRun } from '@iorder/shared/staff-cost';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useFormat } from '@core/i18n/use-format';

/** How a "sync now" request ended: a run the worker wrote, or no run within the waiting time. */
export type SheetSyncOutcome =
  { readonly kind: 'RUN'; readonly run: SheetSyncRun } | { readonly kind: 'TIMEOUT' };

// The answer to "did my sync work?" (owner 2026-11-09): the run takes a while in the worker and a
// toast was easy to miss, so the end of a manually started sync opens this dialog. It says in plain
// words what changed in the stock. Rows the sync could not read are normal in the real sheet, so
// they are a quiet line; deliveries that vanished from the sheet wait for a decision, so they are
// the one warning.
const props = defineProps<{ modelValue: boolean; outcome: SheetSyncOutcome | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; retry: [] }>();

const { t } = useI18n();
const { formatDateTime } = useFormat();

const run = computed(() => (props.outcome?.kind === 'RUN' ? props.outcome.run : null));
const kind = computed<'ok' | 'failed' | 'timeout'>(() => {
  if (props.outcome?.kind === 'TIMEOUT') return 'timeout';
  return run.value?.status === 'FAILED' ? 'failed' : 'ok';
});

const CHANGE_KEYS = ['created', 'updated', 'createdProducts'] as const;
const changes = computed(() => {
  const counts = run.value?.counts;
  return counts ? CHANGE_KEYS.map((key) => ({ key, value: counts[key] })) : [];
});
const changed = computed(() => changes.value.some((entry) => entry.value > 0));

const title = computed(() => t(`staffCost.sync.result.${kind.value}Title`));
const description = computed(() => {
  if (kind.value === 'timeout') return t('staffCost.sync.result.timeoutText');
  if (kind.value === 'failed') return t('staffCost.sync.result.failedText');
  return t(changed.value ? 'staffCost.sync.result.okChanged' : 'staffCost.sync.result.okUnchanged');
});

const ICONS = { ok: 'circlecheck', failed: 'alert', timeout: 'clock' } as const;

function close(): void {
  emit('update:modelValue', false);
}

function checkAgain(): void {
  close();
  emit('retry');
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="title"
    :description="description"
    max-width="460px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #title>
      <span class="result__mark" :class="`result__mark--${kind}`" aria-hidden="true">
        <StaffIcon :name="ICONS[kind]" :size="18" />
      </span>
      {{ title }}
    </template>

    <!-- No body at all without a run: an empty one would still take the dialog's gap. -->
    <template v-if="run" #default>
      <div class="result" data-testid="sync-result">
        <dl v-if="kind === 'ok' && changed" class="result__counts">
          <div v-for="entry in changes" :key="entry.key" class="result__count">
            <dt>{{ t(`staffCost.sync.result.${entry.key}`) }}</dt>
            <dd class="num">{{ entry.value }}</dd>
          </div>
        </dl>

        <p v-if="kind === 'failed'" class="result__code">
          {{ t('staffCost.sync.result.errorCode') }}
          <span class="mono">{{ run.errorCode }}</span>
        </p>

        <template v-if="kind === 'ok'">
          <p
            v-if="run.counts.removalsRequested > 0"
            class="result__note result__note--warn"
            data-testid="sync-result-removals"
          >
            {{
              t(
                'staffCost.sync.result.removals',
                { count: run.counts.removalsRequested },
                run.counts.removalsRequested,
              )
            }}
          </p>
          <p v-if="run.counts.rejected > 0" class="result__note" data-testid="sync-result-rejected">
            {{
              t(
                'staffCost.sync.result.rejected',
                { count: run.counts.rejected },
                run.counts.rejected,
              )
            }}
          </p>
        </template>

        <p class="result__when">
          {{ t('staffCost.sync.result.finishedAt', { time: formatDateTime(run.finishedAt) }) }}
        </p>
      </div>
    </template>

    <template #footer>
      <template v-if="run">
        <AppButton size="lg" @click="close">{{ t('common.close') }}</AppButton>
      </template>
      <!-- No run yet: the only useful next step is to keep looking, so that is the main button. -->
      <template v-else>
        <AppButton variant="secondary" size="lg" @click="close">{{ t('common.close') }}</AppButton>
        <AppButton size="lg" @click="checkAgain">
          {{ t('staffCost.sync.result.checkAgain') }}
        </AppButton>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
/* The same 32px tinted tile as the source card's mark, in the colour of the outcome. */
.result__mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-btn-sm);
}

.result__mark--ok {
  background: var(--green-bg);
  color: var(--green);
}

.result__mark--failed {
  background: var(--red-bg);
  color: var(--red);
}

.result__mark--timeout {
  background: var(--amber-bg);
  color: var(--amber);
}

.result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.result__counts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

/* Small stat tiles for the run's figures. */
.result__count {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.result__count dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.result__count dd {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

/* A quiet fact by default; the warning tone is kept for what waits for a decision. */
.result__note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  color: var(--t2);
  font-size: var(--fs-small);
}

.result__note--warn {
  background: var(--amber-bg);
  color: var(--amber);
}

.result__code {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
  overflow-wrap: anywhere;
}

.result__when {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 420px) {
  .result__counts {
    grid-template-columns: minmax(0, 1fr);
  }

  .result__count {
    flex-direction: row;
    align-items: baseline;
  }
}
</style>
