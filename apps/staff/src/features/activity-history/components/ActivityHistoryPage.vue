<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppCard from '@/components/ui/AppCard.vue';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import DataTable from '@/components/ui/DataTable.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import AppBadge from '@core/components/ui/AppBadge.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import {
  HISTORY_OBJECT_TYPES,
  type ActivityHistoryEntry,
  type ActivityHistoryResult,
  type HistoryValue,
} from '../api/activity-history-api';

// Design v8 "Faoliyat tarixi": a summary card, a searchable table and the details of the chosen
// record. The design's "retention policy", "export" and archive controls are left out: there is
// no backend behind them, and the history is never deleted (hard rules 3 and 12).

const { t } = useI18n();
const { formatDate, formatTime, formatMoneyWithCurrency } = useFormat();
const { activityHistoryApi } = useServices();

const view = useAsyncView<ActivityHistoryResult>(() => activityHistoryApi.list(), {
  isEmpty: (result) => result.available && result.entries.length === 0,
});

const unavailable = computed(() => view.data.value?.available === false);
const entries = computed<readonly ActivityHistoryEntry[]>(() => {
  const result = view.data.value;
  return result?.available ? result.entries : [];
});

interface Row {
  readonly entry: ActivityHistoryEntry;
  readonly date: string;
  readonly time: string;
  readonly actor: string;
  readonly actorRole: string;
  readonly object: string;
  readonly objectDetail: string;
  readonly action: string;
  readonly objectType: string;
  readonly before: string;
  readonly after: string;
  readonly note: string;
}

function valueText(value: HistoryValue): string {
  switch (value.kind) {
    case 'NONE':
      return t('activityHistory.values.none');
    case 'STATUS':
      return t(`orders.stages.${value.status}`);
    case 'MONEY':
      return formatMoneyWithCurrency(value.amount);
    case 'VERSION':
      return t('activityHistory.values.version', { number: value.number });
    case 'ROLE':
      return t(`roles.staff.${value.role}`);
    case 'ACTIVE':
      return t(value.active ? 'activityHistory.values.active' : 'activityHistory.values.inactive');
  }
}

function toRow(entry: ActivityHistoryEntry): Row {
  const actor = entry.actor;
  const objectType = t(`activityHistory.objects.${entry.object.type}`);
  return {
    entry,
    date: formatDate(entry.at),
    time: t('activityHistory.time', { time: formatTime(entry.at) }),
    actor: actor.kind === 'SYSTEM' ? t('activityHistory.actor.system') : actor.name,
    actorRole:
      actor.kind === 'STAFF'
        ? t(`roles.staff.${actor.role}`)
        : actor.kind === 'CUSTOMER'
          ? t('activityHistory.actor.customer', { organization: actor.organization })
          : t('activityHistory.actor.systemRole'),
    object: entry.object.label,
    objectDetail: entry.object.detail ?? objectType,
    action: t(`activityHistory.actions.${entry.action}`),
    objectType,
    before: valueText(entry.before),
    after: valueText(entry.after),
    note: entry.note ?? '',
  };
}

const rows = computed(() => entries.value.map(toRow));

const search = ref('');
const objectFilter = ref<string>('ALL');
const objectOptions = computed(() => [
  { value: 'ALL', label: t('activityHistory.filters.allObjects') },
  ...HISTORY_OBJECT_TYPES.map((type) => ({
    value: type,
    label: t(`activityHistory.objects.${type}`),
  })),
]);

// Filtering works on the rows already loaded; the texts searched are the ones on screen.
const shown = computed(() => {
  const query = search.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (objectFilter.value !== 'ALL' && row.entry.object.type !== objectFilter.value) return false;
    if (!query) return true;
    return [row.actor, row.actorRole, row.object, row.objectDetail, row.action, row.before]
      .concat([row.after, row.note, row.date])
      .some((text) => text.toLowerCase().includes(query));
  });
});

const selectedId = ref<string | null>(null);
const selected = computed(
  () => shown.value.find((row) => row.entry.id === selectedId.value) ?? shown.value[0] ?? null,
);
watch(shown, (list) => {
  if (!list.some((row) => row.entry.id === selectedId.value)) selectedId.value = null;
});

const columns = computed((): DataTableColumn<Row>[] => [
  { key: 'at', label: t('activityHistory.columns.at'), width: '130px', text: (r) => r.date },
  { key: 'actor', label: t('activityHistory.columns.actor'), width: '170px', text: (r) => r.actor },
  {
    key: 'object',
    label: t('activityHistory.columns.object'),
    width: '160px',
    text: (r) => r.object,
  },
  {
    key: 'action',
    label: t('activityHistory.columns.action'),
    width: '190px',
    text: (r) => r.action,
  },
  {
    key: 'change',
    label: t('activityHistory.columns.change'),
    minWidth: '220px',
    text: (r) => `${r.before} → ${r.after}`,
  },
]);
</script>

<template>
  <div class="page">
    <header class="head">
      <h1 class="head__title">{{ t('activityHistory.title') }}</h1>
      <p class="head__info">{{ t('activityHistory.subtitle') }}</p>
    </header>

    <StateView
      v-if="unavailable"
      state="empty"
      :title="t('activityHistory.unavailable.title')"
      :description="t('activityHistory.unavailable.description')"
      data-testid="history-unavailable"
    />
    <StateView
      v-else
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('activityHistory.empty.title') : undefined"
      :description="
        view.state.value === 'empty' ? t('activityHistory.empty.description') : undefined
      "
      @retry="view.reload()"
    >
      <section class="info" data-testid="history-info">
        <span class="info__tile" aria-hidden="true"><StaffIcon name="history" :size="18" /></span>
        <div class="info__text">
          <h2 class="info__title">{{ t('activityHistory.info.title') }}</h2>
          <p class="info__summary">
            {{ t('activityHistory.info.summary', { count: entries.length }) }}
          </p>
        </div>
        <span class="info__chip">{{ t('activityHistory.info.retention') }}</span>
        <AppBadge tone="muted" dot>{{ t('activityHistory.info.noDelete') }}</AppBadge>
      </section>

      <FilterPanel :aria-label="t('activityHistory.filters.group')">
        <SearchField
          v-model="search"
          class="search"
          :placeholder="t('activityHistory.search')"
          :maxlength="100"
        />
        <FilterField :label="t('activityHistory.filters.object')">
          <AppDropdown
            v-model="objectFilter"
            :options="objectOptions"
            :label="t('activityHistory.filters.object')"
          />
        </FilterField>
        <span class="results" role="status">
          {{ t('activityHistory.results', { count: shown.length }) }}
        </span>
      </FilterPanel>

      <DataTable
        :columns="columns"
        :rows="shown"
        :row-key="(row) => row.entry.id"
        :row-action="(row) => (selectedId = row.entry.id)"
        :row-label="(row) => `${row.action} · ${row.object}`"
        :row-tone="(row) => (row.entry.id === selected?.entry.id ? 'accent' : undefined)"
        :label="t('activityHistory.tableLabel')"
        :empty-text="t('activityHistory.noMatch')"
        :density-toggle="false"
      >
        <template #cell-at="{ row }">
          <span class="two">
            <span>{{ row.date }}</span>
            <span class="two__sub">{{ row.time }}</span>
          </span>
        </template>
        <template #cell-actor="{ row }">
          <span class="two">
            <span>{{ row.actor }}</span>
            <span class="two__sub">{{ row.actorRole }}</span>
          </span>
        </template>
        <template #cell-object="{ row }">
          <span class="two">
            <span class="two__accent">{{ row.object }}</span>
            <span class="two__sub">{{ row.objectDetail }}</span>
          </span>
        </template>
        <template #cell-action="{ row }">
          <span class="two">
            <span class="two__strong">{{ row.action }}</span>
            <span class="two__sub">{{ row.objectType }}</span>
          </span>
        </template>
        <template #cell-change="{ row }">
          <span class="two">
            <span class="two__strong">{{ row.before }} → {{ row.after }}</span>
            <span v-if="row.note" class="two__sub">{{ row.note }}</span>
          </span>
        </template>
        <template #card="{ row }">
          <span class="card-row">
            <span class="two">
              <span class="two__strong">{{ row.action }}</span>
              <span class="two__sub">{{ row.date }}, {{ row.time }}</span>
            </span>
            <span class="two">
              <span class="two__accent">{{ row.object }} · {{ row.objectDetail }}</span>
              <span class="two__sub">{{ row.actor }} · {{ row.actorRole }}</span>
            </span>
            <span class="two__strong">{{ row.before }} → {{ row.after }}</span>
          </span>
        </template>
      </DataTable>
      <p class="footer">
        {{ t('activityHistory.footer', { shown: shown.length, total: entries.length }) }}
      </p>

      <AppCard
        v-if="selected"
        :title="t('activityHistory.detail.title', { action: selected.action.toLowerCase() })"
        :subtitle="
          t('activityHistory.detail.meta', {
            date: selected.date,
            time: selected.time,
            actor: selected.actor,
          })
        "
        data-testid="history-detail"
      >
        <template #actions>
          <AppBadge tone="accent" dot>{{ selected.objectType }}</AppBadge>
        </template>
        <div class="detail">
          <div class="detail__object">
            <span class="detail__label">{{ t('activityHistory.detail.object') }}</span>
            <span class="detail__name">{{ selected.object }}</span>
            <span class="detail__label">{{ selected.objectDetail }}</span>
          </div>
          <div class="detail__change">
            <div class="value">
              <span class="value__key">{{ t('activityHistory.detail.before') }}</span>
              <span class="value__text">{{ selected.before }}</span>
            </div>
            <StaffIcon name="arrow" :size="18" class="detail__arrow" />
            <div class="value value--new">
              <span class="value__key">{{ t('activityHistory.detail.after') }}</span>
              <span class="value__text">{{ selected.after }}</span>
            </div>
          </div>
          <div class="detail__note">
            <span class="detail__note-title">{{ t('activityHistory.detail.note') }}</span>
            <span class="detail__label">{{
              selected.note || t('activityHistory.detail.noNote')
            }}</span>
          </div>
        </div>
      </AppCard>
    </StateView>
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

/* v8 summary card: 38px accent tile, title and counts, then the retention facts. */
.info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 18px 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.info__tile {
  display: grid;
  flex: none;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  color: var(--acc);
}

.info__text {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.info__title {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}

.info__summary {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* A fact, not a control: the v8 select look without the chevron. */
.info__chip {
  display: inline-flex;
  align-items: center;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
}

.search {
  flex: 1 1 240px;
  max-width: 316px;
}

.results {
  margin-left: auto;
  align-self: center;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.two {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: var(--fs-small);
}

.two__sub {
  font-size: var(--fs-group);
  color: var(--t2);
}

.two__accent {
  color: var(--acc-fg);
}

.two__strong {
  font-weight: 500;
}

.card-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.footer {
  margin: -16px 0 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 24px;
  padding: 0 20px 20px;
}

.detail__object {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 220px;
  max-width: 100%;
}

.detail__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.detail__name {
  font-size: var(--fs-body);
  font-weight: 600;
}

.detail__change {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px;
}

.detail__arrow {
  color: var(--acc);
}

.value {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 172px;
  padding: 16px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.value--new {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.value__key {
  font-size: var(--fs-group);
  text-transform: uppercase;
  color: var(--t2);
}

.value--new .value__key {
  color: var(--acc-fg);
}

.value__text {
  font-size: 19px;
  font-weight: 500;
}

.detail__note {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.detail__note-title {
  font-size: var(--fs-small);
  font-weight: 600;
}

@media (max-width: 480px) {
  .value {
    min-width: 0;
    flex: 1 1 100%;
  }

  .detail__arrow {
    transform: rotate(90deg);
  }

  .results {
    margin-left: 0;
  }
}
</style>
