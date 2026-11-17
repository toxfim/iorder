<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
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
import { rejectReasonCode } from '../domain/reject-reason';
import { makeInvisibleVisible } from '../domain/visible-text';
import SheetSyncResultDialog, { type SheetSyncOutcome } from './SheetSyncResultDialog.vue';

// The v8 source card of Qoldiq: where the stock comes from (the «Поставка» sheet, read only) and
// how the last sync went. The full report (data-model §6.4: counts, rejected rows by header and
// reason, skipped suppliers, new products, cost mismatches) folds out below; it opens by itself
// only on a failed run. Rejected rows are normal in the real sheet, and an open report would push
// the stock table off the screen (v8 keeps the source card compact). The report never holds cell
// contents or costs.
//
// "Sync now" (owner request 2026-10-28, manager and admin): the api only queues a run for the
// worker and answers at once, so the card polls the last run until a newer one appears, then
// tells the page to reload the stock and opens a dialog that says how the run ended (owner
// 2026-11-09: a toast was too easy to miss). The sheet is never written to.
const props = defineProps<{ canRun: boolean }>();
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

const COUNT_KEYS = [
  'rowsRead',
  'created',
  'updated',
  'unchanged',
  'rejected',
  'skippedRows',
  'createdProducts',
  'mismatches',
] as const;
// Shown only when something happened: they are rare and would clutter a healthy report.
const RARE_COUNT_KEYS = [
  'staleRefs',
  'removalsRequested',
  'removalsDismissed',
  'reappearedAfterRemoval',
] as const;

const counts = computed(() => {
  const current = run.value?.counts;
  if (!current) return [];
  return [
    ...COUNT_KEYS.map((key) => ({ key, value: current[key] })),
    ...RARE_COUNT_KEYS.filter((key) => current[key] > 0).map((key) => ({
      key,
      value: current[key],
    })),
  ];
});

// The report is folded by default; each run decides anew: a failed one opens it, a good one folds
// it again (an open report pushes the stock table down). The dialog's "view report" opens it too.
const reportOpen = ref(false);
const report = ref<HTMLDetailsElement | null>(null);
watch(
  () => run.value?.id,
  () => {
    reportOpen.value = run.value?.status === 'FAILED';
  },
  { immediate: true },
);

function onReportToggle(event: Event): void {
  reportOpen.value = (event.target as HTMLDetailsElement).open;
}

function showReport(): void {
  reportOpen.value = true;
  report.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

const nearMisses = computed(
  () => run.value?.skippedSuppliers.filter((s) => s.hasInvisibleCharacters) ?? [],
);
</script>

<template>
  <section class="sync" :aria-label="t('staffCost.sync.title')" data-testid="sync-panel">
    <div class="sync__summary">
      <span class="sync__mark" aria-hidden="true"><StaffIcon name="archive" :size="16" /></span>
      <div class="sync__text">
        <h2 class="sync__title">{{ t('staffCost.sync.source') }}</h2>
        <p v-if="run" class="sync__line">
          <span class="sync__when">{{
            t('staffCost.sync.lastRun', { time: formatDateTime(run.finishedAt) })
          }}</span>
          <span aria-hidden="true">·</span>
          <span class="sync__trigger">{{ t(`staffCost.sync.trigger.${run.trigger}`) }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ t('staffCost.sync.sourceHelp') }}</span>
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
      <AppBadge v-if="run" dot :tone="run.status === 'OK' ? 'success' : 'danger'">
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
      <AppButton
        v-if="props.canRun && view.state.value !== 'loading'"
        variant="secondary"
        size="xs"
        :loading="requesting"
        :disabled="waiting"
        :aria-busy="waiting ? 'true' : undefined"
        data-testid="sync-now"
        @click="syncNow"
      >
        {{ waiting ? t('staffCost.sync.running') : t('staffCost.sync.runNow') }}
      </AppButton>
    </div>

    <template v-if="run">
      <p v-if="run.status === 'FAILED'" class="sync__failed" role="alert">
        {{ t('staffCost.sync.failed') }}
        <span class="mono">{{ run.errorCode }}</span>
      </p>

      <div v-if="nearMisses.length > 0" class="sync__warn" role="alert">
        {{ t('staffCost.sync.nearMiss', { count: nearMisses.length }, nearMisses.length) }}
      </div>

      <details ref="report" class="sync__details" :open="reportOpen" @toggle="onReportToggle">
        <summary class="sync__toggle">
          <StaffIcon name="down" :size="14" class="sync__chevron" />
          {{ t('staffCost.sync.details') }}
        </summary>
        <div class="sync__body">
          <dl class="sync__counts">
            <div v-for="entry in counts" :key="entry.key" class="count">
              <dt>{{ t(`staffCost.sync.counts.${entry.key}`) }}</dt>
              <dd class="num">{{ entry.value }}</dd>
            </div>
          </dl>

          <section v-if="run.rejectedRows.length > 0" class="block">
            <h4 class="block__title">{{ t('staffCost.sync.rejectedTitle') }}</h4>
            <ul class="block__list">
              <li v-for="(row, index) in run.rejectedRows" :key="index" class="item">
                <span class="item__main">{{ row.header }}</span>
                <span class="item__reason" :title="row.reason">{{
                  t(`staffCost.sync.rejectReason.${rejectReasonCode(row.reason)}`)
                }}</span>
                <span v-if="row.productCode" class="mono item__meta">{{ row.productCode }}</span>
                <span v-if="row.deliveryRef" class="mono item__meta">{{ row.deliveryRef }}</span>
              </li>
            </ul>
          </section>

          <section v-if="run.skippedSuppliers.length > 0" class="block">
            <h4 class="block__title">{{ t('staffCost.sync.skippedTitle') }}</h4>
            <ul class="block__list">
              <li
                v-for="skipped in run.skippedSuppliers"
                :key="skipped.supplier + skipped.reason"
                class="item"
                :class="{ 'item--warn': skipped.hasInvisibleCharacters }"
              >
                <span class="item__main mono">{{ makeInvisibleVisible(skipped.supplier) }}</span>
                <span class="item__reason">{{
                  t(`staffCost.sync.skipReason.${skipped.reason}`)
                }}</span>
                <span class="item__meta num">{{
                  t('staffCost.sync.rowsCount', { count: skipped.count }, skipped.count)
                }}</span>
                <AppBadge v-if="skipped.hasInvisibleCharacters" tone="warning">
                  {{ t('staffCost.sync.invisibleBadge') }}
                </AppBadge>
              </li>
            </ul>
          </section>

          <section v-if="run.createdProducts.length > 0" class="block">
            <h4 class="block__title">
              {{
                t(
                  'staffCost.sync.createdTitle',
                  { count: run.createdProducts.length },
                  run.createdProducts.length,
                )
              }}
            </h4>
            <p class="block__help">{{ t('staffCost.sync.createdHelp') }}</p>
            <ul class="codes">
              <li v-for="code in run.createdProducts" :key="code" class="mono code">{{ code }}</li>
            </ul>
          </section>

          <section v-if="run.costMismatches.length > 0" class="block">
            <h4 class="block__title">{{ t('staffCost.sync.mismatchTitle') }}</h4>
            <ul class="block__list">
              <li
                v-for="mismatch in run.costMismatches"
                :key="mismatch.productCode + mismatch.deliveryRef"
                class="item"
              >
                <span class="mono item__main">{{ mismatch.productCode }}</span>
                <span class="mono item__meta">{{ mismatch.deliveryRef }}</span>
                <span class="item__reason num">
                  {{
                    mismatch.differencePercent === null
                      ? t('staffCost.sync.mismatchUnknown')
                      : t('staffCost.sync.mismatchPercent', { percent: mismatch.differencePercent })
                  }}
                </span>
              </li>
            </ul>
          </section>
        </div>
      </details>
    </template>

    <SheetSyncResultDialog
      v-model="outcomeOpen"
      :outcome="outcome"
      @report="showReport"
      @retry="waitLonger"
    />
  </section>
</template>

<style scoped>
/* v8 source card, compacted to a status bar above the stock table: the green tile, the title and
   its grey line on one line, the status pill and the action on the right, the report toggle at the
   end of the same line. A warning or a failure takes its own slim line below; the open report
   spans the whole width. */
.sync {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--container-pad) var(--gap-card);
  min-width: 0;
  padding: var(--container-pad) var(--gap-card);
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.sync__summary {
  display: flex;
  flex: 1 1 520px;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--container-pad) var(--gap-card);
  min-width: 0;
}

.sync__mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-btn-sm);
  background: var(--green-bg);
  color: var(--green);
}

.sync__text {
  display: flex;
  flex: 1 1 220px;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  min-width: 0;
}

.sync__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.sync__line {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin: 0;
  font-size: var(--fs-meta);
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

.sync__warn {
  flex: 1 1 100%;
  order: 2;
  padding: 6px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-meta);
  font-weight: 600;
}

/* Visually right after the summary (its toggle ends the status line); in the DOM it stays after the
   warning, which holds no control, so the focus order still follows what the eye sees. */
.sync__details {
  flex: 0 0 auto;
  order: 1;
}

.sync__details[open] {
  flex-basis: 100%;
  padding-top: var(--container-pad);
  border-top: 1px solid var(--e8);
}

.sync__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--t2);
  cursor: pointer;
  list-style: none;
}

.sync__toggle::-webkit-details-marker {
  display: none;
}

.sync__toggle:hover {
  color: var(--ink);
}

.sync__toggle:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

.sync__chevron {
  transform: rotate(-90deg);
  transition: transform 0.2s ease;
}

.sync__details[open] .sync__chevron {
  transform: none;
}

/* The open report scrolls inside the card: the real sheet has many rejected rows, and an unbounded
   report would push the stock table far below the fold. */
.sync__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: min(420px, 50vh);
  padding-top: 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.sync__counts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
  margin: 0;
}

/* Small v8 stat tiles on the grey fill. */
.count {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.count dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.count dd {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.block__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.block__help {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* Hairline-ruled rows, like the rows of a v8 card. */
.block__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 10px 0;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-small);
}

.item--warn {
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
}

.item__main {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.item__reason {
  color: var(--t2);
}

.item__meta {
  color: var(--t3);
}

.codes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.code {
  padding: 4px 8px;
  border-radius: var(--r-pill);
  background: var(--ef);
  font-size: var(--fs-group);
}

@media (pointer: coarse) {
  .sync__toggle {
    min-height: 44px;
  }
}
</style>
