<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import { compareMoney } from '@core/lib/money';
import { pickName } from '../domain/localized-name';
import { toPriceRows, type PriceRow } from '../domain/price-rows';
import { useHistoryDrawer } from '../composables/use-history-drawer';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '../domain/translate-error';
import { filterRows } from '../domain/row-filter';
import { versionStatusTone } from '../domain/version-status';
import { useListPriceFormat } from '../composables/use-list-price-format';
import PriceHistoryDrawer from './PriceHistoryDrawer.vue';
import PricesSubHeader from './PricesSubHeader.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const route = useRoute();
const { pricingApi } = useServices();
const { formatDateTime } = useFormat();
// A version shows its prices as stored: USD, or so'm for one published before 2026-10-29.
const { listPrice } = useListPriceFormat();

const versionId = String(route.params.id ?? '');
const view = useAsyncView(() => pricingApi.getVersion(versionId), {
  isEmpty: () => false,
});

const search = ref('');
const version = computed(() => view.data.value?.version ?? null);
const rows = computed(() => toPriceRows(view.data.value));
const visibleRows = computed(() => filterRows(rows.value, search.value));
const history = useHistoryDrawer(rows);

const nameOf = (row: PriceRow): string => pickName(row.names);
const columns = computed<DataTableColumn<PriceRow>[]>(() => [
  {
    key: 'code',
    label: t('prices.columns.productCode'),
    width: '160px',
    text: (row) => row.productCode,
    compare: (a, b) => a.productCode.localeCompare(b.productCode),
  },
  {
    key: 'name',
    label: t('prices.columns.name'),
    minWidth: '240px',
    text: nameOf,
    compare: (a, b) => nameOf(a).localeCompare(nameOf(b)),
  },
  {
    key: 'price',
    label: t('prices.columns.price'),
    align: 'end',
    width: '150px',
    text: (row) => listPrice(row.price, row.currency),
    compare: (a, b) => compareMoney(a.price, b.price),
  },
  {
    key: 'deferred',
    label: t('prices.columns.deferredPrice'),
    align: 'end',
    width: '150px',
    text: (row) => (row.deferredPrice === null ? '—' : listPrice(row.deferredPrice, row.currency)),
    compare: (a, b) => compareMoney(a.deferredPrice ?? '0', b.deferredPrice ?? '0'),
  },
]);

const errorText = computed(() =>
  translateDescribed(t, describePricingError('load', view.error.value)),
);
</script>

<template>
  <StateView
    :state="view.state.value"
    :description="view.state.value === 'error' ? errorText : undefined"
    @retry="view.reload"
  >
    <div v-if="version" class="detail">
      <PricesSubHeader
        :title="t('prices.version', { number: version.number })"
        :back-to="{ name: 'staff-price-versions' }"
        :back-label="t('prices.versions.title')"
      >
        <template #badge>
          <AppBadge dot :tone="versionStatusTone(version.status)">
            {{ t(`prices.versions.status.${version.status}`) }}
          </AppBadge>
        </template>
        <p class="meta">
          <template v-if="version.publishedAt">
            {{ t('prices.publishedAt', { date: formatDateTime(version.publishedAt) }) }}
            <template v-if="version.publishedBy"
              >· <PersonName :name="version.publishedBy" :user-id="version.publishedByUserId"
            /></template>
          </template>
          <template v-else>
            {{ t('prices.versions.createdAt', { date: formatDateTime(version.createdAt) }) }}
          </template>
          · {{ t('prices.info', { count: rows.length }, rows.length) }}
        </p>
        <p v-if="version.note" class="meta meta--note">{{ version.note }}</p>
      </PricesSubHeader>

      <!-- Published versions are immutable (hard rule 5): said once, as a v8 neutral notice. -->
      <p class="readonly" role="note">
        <StaffIcon name="lock" :size="15" class="readonly__icon" />
        {{ t('prices.versions.readOnly') }}
      </p>

      <FilterPanel class="toolbar">
        <SearchField v-model="search" :placeholder="t('prices.search.placeholder')" />
      </FilterPanel>

      <DataTable
        :columns="columns"
        :rows="visibleRows"
        :row-key="(row: PriceRow) => row.productId"
        :row-action="(row: PriceRow) => history.openFor(row.productId)"
        :row-label="(row: PriceRow) => `${row.productCode} ${nameOf(row)}: ${t('prices.openRow')}`"
        :label="t('prices.tableLabel')"
        :empty-text="t('prices.noMatch')"
      >
        <template #card="{ row }">
          <span class="card">
            <span class="mono card__code">{{ row.productCode }}</span>
            <span class="card__name">{{ nameOf(row) }}</span>
            <b class="num">{{ listPrice(row.price, row.currency) }}</b>
          </span>
        </template>
      </DataTable>

      <PriceHistoryDrawer
        v-model="history.open.value"
        :product-id="history.productId.value"
        :product-code="history.info.value.productCode"
        :name="history.info.value.name"
      />
    </div>
  </StateView>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.meta {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
  overflow-wrap: anywhere;
}

.meta--note {
  color: var(--ink);
}

.readonly {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.readonly__icon {
  flex: none;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card__code {
  font-size: var(--fs-group);
  color: var(--t2);
}

.card__name {
  overflow-wrap: anywhere;
}

.toolbar :deep(.search) {
  flex: 1 1 220px;
  max-width: 280px;
}

@media (max-width: 720px) {
  .toolbar :deep(.search) {
    max-width: none;
  }
}
</style>
