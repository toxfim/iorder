<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '../domain/translate-error';
import { versionStatusTone } from '../domain/version-status';
import PricesSubHeader from './PricesSubHeader.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const { pricingApi } = useServices();
const { formatDateTime } = useFormat();

const view = useAsyncView(() => pricingApi.listVersions(), {
  isEmpty: (list) => list.items.length === 0,
});

const versions = computed(() => view.data.value?.items ?? []);

type VersionListItem = NonNullable<typeof view.data.value>['items'][number];

function whenText(v: VersionListItem): string {
  if (!v.publishedAt) return t('prices.versions.createdAt', { date: formatDateTime(v.createdAt) });
  return v.publishedBy
    ? `${formatDateTime(v.publishedAt)} · ${v.publishedBy}`
    : formatDateTime(v.publishedAt);
}
const itemsText = (v: VersionListItem): string =>
  t('prices.versions.items', { count: v.itemCount }, v.itemCount);

const columns = computed<DataTableColumn<VersionListItem>[]>(() => [
  {
    key: 'number',
    label: t('prices.versions.columns.number'),
    width: '110px',
    text: (v) => `v${v.number}`,
    compare: (a, b) => a.number - b.number,
  },
  { key: 'status', label: t('prices.versions.columns.status'), width: '170px' },
  {
    key: 'when',
    label: t('prices.versions.columns.when'),
    text: whenText,
    hasSortValue: (v) => Number.isFinite(Date.parse(v.publishedAt ?? v.createdAt)),
    compare: (a, b) =>
      Date.parse(a.publishedAt ?? a.createdAt) - Date.parse(b.publishedAt ?? b.createdAt),
  },
  {
    key: 'note',
    label: t('prices.versions.columns.note'),
    truncate: true,
    text: (v) => v.note ?? '',
  },
  {
    key: 'items',
    label: t('prices.versions.columns.items'),
    align: 'end',
    width: '140px',
    text: itemsText,
    compare: (a, b) => a.itemCount - b.itemCount,
  },
]);

const errorText = computed(() =>
  translateDescribed(t, describePricingError('load', view.error.value)),
);
</script>

<template>
  <div class="page">
    <PricesSubHeader
      :title="t('prices.versions.title')"
      :back-to="{ name: 'staff-prices' }"
      :back-label="t('prices.title')"
      :subtitle="t('prices.versions.subtitle')"
    />
    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('prices.versions.empty') : undefined"
      :description="view.state.value === 'error' ? errorText : undefined"
      @retry="view.reload"
    >
      <DataTable
        :columns="columns"
        :rows="versions"
        :row-key="(v: VersionListItem) => v.id"
        :row-to="(v: VersionListItem) => ({ name: 'staff-price-version', params: { id: v.id } })"
        :label="t('prices.versions.title')"
        :empty-text="t('prices.versions.empty')"
        :density-toggle="false"
      >
        <template #cell-number="{ row }">
          <span class="mono version">{{ `v${row.number}` }}</span>
        </template>
        <template #cell-when="{ row }">
          <template v-if="row.publishedAt && row.publishedBy"
            >{{ formatDateTime(row.publishedAt) }} ·
            <PersonName :name="row.publishedBy" :user-id="row.publishedByUserId"
          /></template>
          <template v-else>{{ whenText(row) }}</template>
        </template>
        <template #cell-status="{ row }">
          <AppBadge dot :tone="versionStatusTone(row.status)">
            {{ t(`prices.versions.status.${row.status}`) }}
          </AppBadge>
        </template>
        <template #card="{ row }">
          <span class="card__top">
            <span class="mono card__number">{{ `v${row.number}` }}</span>
            <AppBadge dot :tone="versionStatusTone(row.status)">
              {{ t(`prices.versions.status.${row.status}`) }}
            </AppBadge>
          </span>
          <span class="card__line">
            <template v-if="row.publishedAt && row.publishedBy"
              >{{ formatDateTime(row.publishedAt) }} ·
              <PersonName :name="row.publishedBy" :user-id="row.publishedByUserId"
            /></template>
            <template v-else>{{ whenText(row) }}</template>
          </span>
          <span v-if="row.note" class="card__line">{{ row.note }}</span>
          <span class="card__line">{{ itemsText(row) }}</span>
        </template>
      </DataTable>
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

.version {
  font-size: var(--fs-small);
  font-weight: 600;
}

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card__number {
  font-size: var(--fs-small);
  font-weight: 600;
}

.card__line {
  font-size: var(--fs-meta);
  color: var(--t2);
}
</style>
