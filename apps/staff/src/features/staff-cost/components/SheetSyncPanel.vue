<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { useFormat } from '@core/i18n/use-format';
import SheetSyncResultDialog, { type SheetSyncOutcome } from './SheetSyncResultDialog.vue';

// The v8 source card of Qoldiq: where the stock comes from (the «Поставка» sheet, read only) and
// how the last sync went. The detailed report (counts, rejected rows, skipped suppliers, new
// products, cost mismatches) is not shown any more (owner 2026-11-19); a failed run still says so
// on its own line.
//
// "Sync now" (owner request 2026-10-28, manager and admin): the api only queues a run for the
// worker and answers at once, so the card polls the last run until a newer one appears, then
// tells the page to reload the stock and opens a dialog that says how the run ended (owner
// 2026-11-09: a toast was too easy to miss). The sheet is never written to.
// Design «Qoldiq — yakuniy sahifa» (2026-11-19): the card is the line under the page title and
// its "sync now" button sits with the page actions (`actionsTo`: a selector of the page's
// header).
const props = withDefaults(defineProps<{ canRun: boolean; actionsTo?: string | null }>(), {
  actionsTo: null,
});
const emit = defineEmits<{ synced: [] }>();

const { t } = useI18n();
const { stockApi } = useServices();
const { formatDateTime } = useFormat();

// A new installation has never synced: `null` is the empty state, not an error.
const view = useAsyncView(() => stockApi.getLastSyncRun(), { isEmpty: (run) => run === null });

const run = computed(() => view.data.value);

/** How often and how long the card looks for the run the worker was asked for. */
const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 3 * 60_000;

const requesting = ref(false);
const waiting = ref(false);
// How the sync this person started ended; the dialog shows it until it is closed.
const outcome = shallowRef<SheetSyncOutcome | null>(null);
const outcomeOpen = ref(false);

function announce(result: SheetSyncOutcome): void {
  outcome.value = result;
  outcomeOpen.value = true;
}
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollUntil = 0;
// The card is gone: a poll whose request is still in flight must not start another one.
let disposed = false;
// The run that was the last one when the sync was asked for (null: none yet). The worker's queue
// holds at most one job, so the next run to appear after it is the one this request waits for.
// Kept after the waiting time ran out, so "check again" looks for the same run.
let awaited: { readonly afterRunId: string | null } | null = null;

function stopPolling(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  waiting.value = false;
}

function poll(): void {
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    let latest: Awaited<ReturnType<typeof stockApi.getLastSyncRun>> = null;
    try {
      latest = await stockApi.getLastSyncRun();
    } catch {
      /* A failed poll is retried on the next tick; the deadline bounds it. */
    }
    if (disposed || awaited === null) return;
    if (latest && latest.id !== awaited.afterRunId) {
      stopPolling();
      awaited = null;
      view.data.value = latest;
      announce({ kind: 'RUN', run: latest });
      emit('synced');
      return;
    }
    if (Date.now() >= pollUntil) {
      // Not an error: the worker may still be reading a large sheet. Say so instead of going quiet.
      stopPolling();
      announce({ kind: 'TIMEOUT' });
      return;
    }
    poll();
  }, POLL_EVERY_MS);
}

function startPolling(): void {
  waiting.value = true;
  pollUntil = Date.now() + POLL_FOR_MS;
  poll();
}

async function syncNow(): Promise<void> {
  if (requesting.value || waiting.value) return;
  requesting.value = true;
  try {
    // Read here, not taken from the card: the card may have failed to load, and with nothing to
    // compare against an old run would be presented as the result of this request.
    const last = await stockApi.getLastSyncRun();
    const { outcome } = await stockApi.requestSyncRun();
    showToast({
      message: t(outcome === 'QUEUED' ? 'staffCost.sync.queued' : 'staffCost.sync.alreadyQueued'),
    });
    awaited = { afterRunId: last?.id ?? null };
    startPolling();
  } catch (caught) {
    // 409 SHEET_SYNC_QUEUE_UNAVAILABLE (worker off) has its own text in the shared error map.
    showToast({ message: translateDescribed(t, describePricingError('stock', caught)) });
  } finally {
    requesting.value = false;
  }
}

/** "Check again" of the dialog: the waiting time ran out, the run may still arrive. */
function waitLonger(): void {
  if (awaited === null || waiting.value) return;
  startPolling();
}

onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
});
const errorText = computed(() =>
  translateDescribed(t, describePricingError('load', view.error.value)),
);

// "12 daqiqa oldin": re-read every minute so the line does not freeze.
const nowMs = ref(Date.now());
const clock = setInterval(() => {
  nowMs.value = Date.now();
}, 60_000);
onBeforeUnmount(() => clearInterval(clock));

function agoText(iso: string): string {
  const minutes = Math.max(0, Math.floor((nowMs.value - Date.parse(iso)) / 60_000));
  if (minutes < 1) return t('staffCost.sync.ago.now');
  if (minutes < 60) return t('staffCost.sync.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('staffCost.sync.ago.hours', { count: hours });
  return t('staffCost.sync.ago.days', { count: Math.floor(hours / 24) });
}
</script>

<template>
  <section class="sync" :aria-label="t('staffCost.sync.title')" data-testid="sync-panel">
    <div class="sync__summary">
      <span
        class="sync__mark"
        :class="{ 'sync__mark--failed': run?.status === 'FAILED' }"
        aria-hidden="true"
      />
      <div class="sync__text">
        <h2 class="sync__title">{{ t('staffCost.sync.source') }}</h2>
        <p v-if="run" class="sync__line">
          <!-- The design's line: synced with the sheet, how long ago (the exact time on hover). -->
          <span class="sync__when" :title="formatDateTime(run.finishedAt)">{{
            t('staffCost.sync.syncedAgo', { ago: agoText(run.finishedAt) })
          }}</span>
          <span class="sync__extra">{{
            t('staffCost.sync.lastRun', { time: formatDateTime(run.finishedAt) })
          }}</span>
          <span class="sync__extra" aria-hidden="true">·</span>
          <span class="sync__trigger sync__extra">{{
            t(`staffCost.sync.trigger.${run.trigger}`)
          }}</span>
          <span class="sync__extra" aria-hidden="true">·</span>
          <span class="sync__extra">{{ t('staffCost.sync.sourceHelp') }}</span>
        </p>
        <p v-else-if="view.state.value === 'empty'" class="sync__line">
          <strong class="sync__never">{{ t('staffCost.sync.never') }}</strong>
          <span>{{ t('staffCost.sync.neverHelp') }}</span>
        </p>
        <p v-else-if="view.state.value === 'loading'" class="sync__line" aria-busy="true">
          {{ t('state.loading') }}
        </p>
        <p v-else class="sync__line sync__line--error" role="alert">{{ errorText }}</p>
      </div>
      <!-- A good run is the green dot (spoken); a failed one keeps its red pill. -->
      <span v-if="run && run.status === 'OK'" class="sr-only">{{
        t('staffCost.sync.status.OK')
      }}</span>
      <AppBadge v-else-if="run" dot tone="danger">
        {{ t(`staffCost.sync.status.${run.status}`) }}
      </AppBadge>
      <AppButton
        v-else-if="view.state.value === 'error' || view.state.value === 'denied'"
        variant="secondary"
        size="xs"
        @click="view.reload"
      >
        {{ t('state.retry') }}
      </AppButton>
      <Teleport defer :to="props.actionsTo ?? 'body'" :disabled="props.actionsTo === null">
        <AppButton
          v-if="props.canRun && view.state.value !== 'loading'"
          class="sync__run"
          variant="secondary"
          :loading="requesting"
          :disabled="waiting"
          :aria-busy="waiting ? 'true' : undefined"
          :aria-label="waiting ? t('staffCost.sync.running') : t('staffCost.sync.runNow')"
          :title="waiting ? t('staffCost.sync.running') : t('staffCost.sync.runNow')"
          data-testid="sync-now"
          @click="syncNow"
        >
          <StaffIcon name="refresh" :size="16" /><span class="sync__runlabel">{{
            waiting ? t('staffCost.sync.running') : t('staffCost.sync.runNow')
          }}</span>
        </AppButton>
      </Teleport>
    </div>

    <template v-if="run">
      <p v-if="run.status === 'FAILED'" class="sync__failed" role="alert">
        {{ t('staffCost.sync.failed') }}
        <span class="mono">{{ run.errorCode }}</span>
      </p>
    </template>

    <SheetSyncResultDialog v-model="outcomeOpen" :outcome="outcome" @retry="waitLonger" />
  </section>
</template>

<style scoped>
/* The design's line under the page title: a green dot, where the stock comes from and when it was
   read. No card: it belongs to the title. */
.sync {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  min-width: 0;
}

.sync__summary {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}

.sync__mark {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
}

.sync__mark--failed {
  background: var(--red);
}

.sync__text {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  min-width: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.sync__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--t2);
}

/* The design's line names the sheet itself ("«Поставка» bilan sinxron"); the heading stays for
   screen readers. */
.sync__title {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* With the page actions: the label hides on a tablet (the design's icon-only buttons). */
.sync__run {
  white-space: nowrap;
}

/* The design's line says where and when only; how it ran and the read-only note are still read
   by screen readers. */
.sync__extra {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 1023px) {
  .sync__runlabel {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
}

.sync__line {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.sync__line--error {
  color: var(--red);
}

.sync__when {
  color: var(--ink);
}

.sync__never {
  font-weight: 600;
  color: var(--ink);
}

.sync__failed {
  flex: 1 1 100%;
  order: 2;
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}
</style>
