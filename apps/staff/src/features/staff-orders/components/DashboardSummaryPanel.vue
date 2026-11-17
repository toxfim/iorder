<script setup lang="ts">
import { computed, onMounted, onScopeDispose, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, type RouteLocationRaw } from 'vue-router';
import type {
  DashboardQueue,
  DashboardQueueKey,
  StaffDashboardSummary,
} from '@iorder/shared/staff-orders';
import { USD_RATE_BANK_MARKUP_UZS } from '@iorder/shared';
import { useServices } from '@/app/services';
import { readsAllOrders } from '@/features/staff-shell/orders-access';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { StaffIconName } from '@/components/ui/staff-icons';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useFormat } from '@core/i18n/use-format';
import { SUMMARY_REFRESH_MS } from '../composables/dashboard-summary-store';
import {
  SHEET_SYNC_STALE_HOURS,
  ageMessage,
  formatCalendarDate,
  queueLink,
  sheetSyncHealth,
} from '../domain/dashboard-summary-presentation';

// What is waiting for this role right now, straight from the server's summary. A section the
// server left out is simply not drawn: the screen never decides what a role may see.
// `card` is the dashboard's "Xulosa" card (design v8); `compact` sits on top of the role queue
// pages, where the design shows the queue tiles only (the other figures stay, in a quiet row).
const props = withDefaults(
  defineProps<{ exclude?: readonly string[]; variant?: 'card' | 'compact' }>(),
  { exclude: () => [], variant: 'compact' },
);

const { t } = useI18n();
const route = useRoute();
const {
  dashboardSummaryStore: store,
  currentUser,
  waitingOrganizationsStore,
  unpricedCountStore,
  clock,
} = useServices();
const { formatMoney, formatTime, formatDateTime } = useFormat();

const roles = computed(() => currentUser.user.value?.staffRoles ?? []);
const summary = computed(() => store.summary.value);
const refreshSeconds = Math.round(SUMMARY_REFRESH_MS / 1000);

onMounted(() => {
  void store.refresh();
  const stop = store.startAutoRefresh();
  onScopeDispose(stop);
});

// The sidebar badges show the same two numbers; when the summary has them they are fresher than
// the badge's own read, so hand them over (a role without the section never reaches here).
watch(summary, (next) => {
  if (!next) return;
  if (next.organizationsAwaitingActivationCount !== undefined) {
    waitingOrganizationsStore.set(next.organizationsAwaitingActivationCount);
  }
  if (next.unpricedProductsCount !== undefined) {
    unpricedCountStore.set(next.unpricedProductsCount);
  }
});

/** How a figure's value is coloured (v8: orange when something waits, green/red for the sync). */
type ValueTone = 'ink' | 'accent' | 'ok' | 'warn';

interface SummaryCard {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly sub: string | null;
  readonly to: RouteLocationRaw | null;
  readonly linkLabel: string;
  readonly tone: ValueTone;
  /** Needs attention: the sub line says why, the value turns red. */
  readonly warn?: boolean;
}

interface QueueTile extends SummaryCard {
  readonly icon: StaffIconName;
  readonly active: boolean;
}

const QUEUE_ICONS: Record<DashboardQueueKey, StaffIconName> = {
  AWAITING_MANAGER: 'usercheck',
  AWAITING_ACCOUNTING: 'calc',
  SKIPPED_ACCOUNTING_TO_REVIEW: 'alert',
  TO_PREPARE: 'calc',
  TO_RELEASE: 'warehouse',
  TO_RETURN: 'alert',
  TO_DELIVER: 'truck',
};

const ageText = (minutes: number): string => {
  const { key, params } = ageMessage(minutes);
  return t(`orders.summary.age.${key}`, params);
};

const countText = (count: number): string => t('orders.summary.countValue', { count }, count);

// A link to the page the person is already on goes nowhere (F-25): the tile keeps its count only.
function pointsHere(target: RouteLocationRaw | null): boolean {
  return (
    target !== null && typeof target === 'object' && 'name' in target && target.name === route.name
  );
}

function queueTile(queue: DashboardQueue): QueueTile {
  const target = queueLink(queue.key, roles.value);
  return {
    id: queue.key,
    icon: QUEUE_ICONS[queue.key],
    active: queue.count > 0,
    label: t(`orders.summary.queues.${queue.key}`),
    value: String(queue.count),
    sub:
      queue.oldestAgeMinutes === null
        ? t('orders.summary.queueEmpty')
        : t('orders.summary.oldest', { age: ageText(queue.oldestAgeMinutes) }),
    to: pointsHere(target) ? null : target,
    linkLabel: t('orders.summary.open'),
    tone: 'ink',
  };
}

const IN_PROGRESS_STATUSES = ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED'] as const;

function managementCards(data: StaffDashboardSummary): SummaryCard[] {
  const cards: SummaryCard[] = [];
  const plain = { to: null, linkLabel: '', tone: 'ink' as const };

  // "In progress" is the manager's and admin's overview of what has left their queue.
  if (data.queues.some((q) => q.key === 'AWAITING_MANAGER')) {
    const inProgress = IN_PROGRESS_STATUSES.reduce(
      (sum, status) => sum + (data.ordersByStatus[status] ?? 0),
      0,
    );
    cards.push({
      ...plain,
      id: 'inProgress',
      label: t('orders.summary.inProgress'),
      value: countText(inProgress),
      sub: t('orders.summary.inProgressHint'),
    });
  }
  if (data.today) {
    cards.push({
      id: 'today',
      label: t('orders.summary.today'),
      value: countText(data.today.count),
      sub: t('orders.summary.todayHint', { sum: formatMoney(data.today.totalAmount) }),
      to: readsAllOrders(roles.value) ? { name: 'staff-orders', query: { period: 'today' } } : null,
      linkLabel: t('orders.summary.viewList'),
      tone: 'ink',
    });
  }
  if (data.unpaidDeliveredCount !== undefined) {
    // No link: the list's debt filter (released and later, still open) counts differently
    // from this server figure (DELIVERED and RECEIVED, unpaid), so a link would mislead.
    cards.push({
      ...plain,
      id: 'unpaidDelivered',
      label: t('orders.summary.unpaidDelivered'),
      value: countText(data.unpaidDeliveredCount),
      sub: null,
    });
  }
  if (data.organizationsAwaitingActivationCount !== undefined) {
    const count = data.organizationsAwaitingActivationCount;
    cards.push({
      id: 'organizations',
      label: t('orders.summary.organizations'),
      value: countText(count),
      sub: null,
      to: { name: 'staff-organizations' },
      linkLabel: t('orders.summary.organizationsHint'),
      tone: count > 0 ? 'accent' : 'ink',
    });
  }
  if (data.unpricedProductsCount !== undefined) {
    const count = data.unpricedProductsCount;
    cards.push({
      id: 'unpriced',
      label: t('orders.summary.unpriced'),
      value: countText(count),
      sub: null,
      to: { name: 'staff-prices', query: { tab: 'unpriced' } },
      linkLabel: t('orders.summary.unpricedHint'),
      tone: count > 0 ? 'accent' : 'ink',
    });
  }
  if (data.lastSheetSync !== undefined) {
    const run = data.lastSheetSync;
    const health = sheetSyncHealth(run, clock.now());
    const time = run === null ? '' : formatDateTime(run.finishedAt);
    const value =
      health === 'never'
        ? t('orders.summary.sheetSyncNever')
        : health === 'failed'
          ? t('orders.summary.sheetSyncFailed', { time })
          : health === 'stale'
            ? // A red "successful" headline read as a contradiction: say it is old instead.
              t('orders.summary.sheetSyncOld', { time })
            : t('orders.summary.sheetSyncOk', { time });
    cards.push({
      id: 'sheetSync',
      label: t('orders.summary.sheetSync'),
      value,
      // A warning says what is wrong in words and where to look, not only in colour.
      sub:
        health === 'stale'
          ? t('orders.summary.sheetSyncStale', { hours: SHEET_SYNC_STALE_HOURS })
          : health === 'ok'
            ? null
            : t('orders.summary.sheetSyncProblem'),
      to: health === 'ok' ? null : { name: 'staff-stock' },
      linkLabel: t('orders.summary.sheetSyncOpen'),
      tone: health === 'ok' ? 'ok' : 'warn',
      warn: health !== 'ok',
    });
  }
  if (data.usdRate !== undefined) {
    const rate = data.usdRate;
    cards.push({
      ...plain,
      id: 'usdRate',
      label: t('orders.summary.rate'),
      value:
        rate === null
          ? t('orders.summary.rateNone')
          : t('orders.summary.rateValue', { rate: formatMoney(rate.rate) }),
      sub:
        rate === null
          ? null
          : rate.source === 'MANUAL' || rate.rateDate === null
            ? t('orders.summary.rateSourceManual')
            : rate.source === 'CHANNEL'
              ? t('orders.summary.rateSourceChannel', { date: formatCalendarDate(rate.rateDate) })
              : t('orders.summary.rateSourceCbu', {
                  date: formatCalendarDate(rate.rateDate),
                  markup: USD_RATE_BANK_MARKUP_UZS,
                }),
    });
  }
  return cards;
}

const shown = (card: SummaryCard): boolean => !props.exclude.includes(card.id);

const queueTiles = computed<QueueTile[]>(() => {
  const data = summary.value;
  if (!data) return [];
  // A queue the role has no page for is a count of orders it cannot open (the warehouse seeing
  // "to deliver"): not drawn, so no tile leads nowhere (F-25).
  return data.queues
    .filter((queue) => queueLink(queue.key, roles.value) !== null)
    .map(queueTile)
    .filter(shown);
});

const stats = computed<SummaryCard[]>(() =>
  summary.value ? managementCards(summary.value).filter(shown) : [],
);

const updatedLine = computed(() => {
  const parts = [t('orders.summary.autoRefresh', { seconds: refreshSeconds })];
  if (summary.value) {
    parts.push(t('orders.summary.updatedAt', { time: formatTime(summary.value.generatedAt) }));
  }
  return parts.join(' · ');
});
</script>

<template>
  <StateView v-if="store.state.value === 'loading'" state="loading" />
  <!-- A refusal or failure stays a small line: the queue on the page below must remain usable. -->
  <p
    v-else-if="store.state.value === 'denied'"
    class="notice"
    role="status"
    data-testid="summary-denied"
  >
    {{ t('orders.summary.denied') }}
  </p>
  <div
    v-else-if="store.state.value === 'error'"
    class="notice"
    role="alert"
    data-testid="summary-error"
  >
    {{ t('orders.summary.unavailable') }}
    <AppButton variant="secondary" size="xs" @click="store.refresh()">
      {{ t('orders.summary.refresh') }}
    </AppButton>
  </div>
  <section
    v-else
    class="summary"
    :class="`summary--${variant}`"
    aria-labelledby="summary-title"
    data-testid="dashboard-summary"
  >
    <header class="summary__head">
      <div class="summary__heading">
        <h2 id="summary-title" class="summary__title" :class="{ 'sr-only': variant === 'compact' }">
          {{ t('orders.summary.title') }}
        </h2>
        <span class="summary__time">{{ updatedLine }}</span>
      </div>
      <AppButton
        variant="secondary"
        size="xs"
        :loading="store.refreshing.value"
        data-testid="summary-refresh"
        @click="store.refresh()"
      >
        <StaffIcon v-if="!store.refreshing.value" name="refresh" :size="14" class="summary__ico" />
        {{ t('orders.summary.refresh') }}
      </AppButton>
    </header>

    <p v-if="store.stale.value" class="summary__stale" role="status" data-testid="summary-stale">
      {{ t('orders.summary.stale') }}
    </p>

    <ul v-if="queueTiles.length > 0" class="queues">
      <li
        v-for="tile in queueTiles"
        :key="tile.id"
        class="tile"
        :class="{ 'tile--active': tile.active }"
        :data-testid="`summary-${tile.id}`"
      >
        <component
          :is="tile.to ? RouterLink : 'div'"
          class="tile__body"
          :class="{ 'tile__body--link': tile.to }"
          v-bind="tile.to ? { to: tile.to } : {}"
        >
          <span class="tile__top">
            <StaffIcon :name="tile.icon" :size="15" class="tile__icon" />
            <span class="tile__label">{{ tile.label }}</span>
          </span>
          <b class="tile__value num">{{ tile.value }}</b>
          <span v-if="tile.sub" class="tile__sub">{{ tile.sub }}</span>
        </component>
      </li>
    </ul>

    <ul v-if="stats.length > 0" class="stats">
      <li
        v-for="stat in stats"
        :key="stat.id"
        class="stat"
        :class="{ 'tile--warn': stat.warn }"
        :data-testid="`summary-${stat.id}`"
      >
        <span class="stat__label">{{ stat.label }}</span>
        <b class="stat__value num" :class="`stat__value--${stat.tone}`">{{ stat.value }}</b>
        <span v-if="stat.sub" class="stat__sub">{{ stat.sub }}</span>
        <RouterLink v-if="stat.to" class="stat__link" :to="stat.to">
          {{ stat.linkLabel }} <span aria-hidden="true">{{ '↗' }}</span>
          <span class="sr-only">: {{ stat.label }}</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Design v8 "Xulosa": a white hairline card, queue tiles on --f5, then a hairline row of figures. */
.summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.summary--card {
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.summary__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.summary--compact .summary__head {
  order: 3;
}

.summary__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.summary__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.summary__time {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.summary__ico {
  color: var(--t2);
}

.notice,
.summary__stale {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--r-row);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  color: var(--t2);
}

.queues,
.stats {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.queues {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr));
  gap: 12px;
}

.summary--compact .queues {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
}

.tile {
  display: flex;
  min-width: 0;
}

.tile__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 14px;
  border-radius: var(--r-row);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  text-decoration: none;
}

.summary--compact .tile__body {
  background: var(--w);
}

.tile__body--link:hover {
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.tile__body--link:focus-visible {
  outline: none;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.tile__top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tile__icon {
  flex: none;
  color: var(--t2);
}

.tile--active .tile__icon {
  color: var(--acc);
}

.tile__label {
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.tile__value {
  font-size: 22px;
  font-weight: 400;
  line-height: 1.2;
}

.tile__sub {
  font-size: 10px;
  color: var(--t2);
}

.stats {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr));
  gap: 16px 12px;
  padding-top: 16px;
  border-top: 1px solid var(--e8);
}

.summary--compact .stats {
  padding: 16px;
  border: 0;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.stat__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.stat__value {
  font-size: var(--fs-body-lg);
  font-weight: 500;
  color: var(--ink);
}

.stat__value--accent {
  color: var(--acc-fg);
}

.stat__value--ok {
  color: var(--green);
}

.stat__value--warn {
  color: var(--red);
}

.stat__sub {
  font-size: 10px;
  color: var(--t3);
}

.stat__link {
  align-self: flex-start;
  margin-top: 2px;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--acc-fg);
  text-decoration: none;
}

.stat__link:hover {
  color: var(--acc-hover);
}

.stat__link:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

@media (pointer: coarse) {
  .stat__link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
}
</style>
