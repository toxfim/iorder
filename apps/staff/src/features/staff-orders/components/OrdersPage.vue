<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import DataTable from '@/components/ui/DataTable.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import OrdersFilterSheet from './OrdersFilterSheet.vue';
import OrdersStatusTabs from './OrdersStatusTabs.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useInfiniteScroll } from '@core/composables/use-infinite-scroll';
import { useFormat } from '@core/i18n/use-format';
import { compareMoney } from '@core/lib/money';
import { rememberedListQuery } from '../composables/orders-list-memory';
import { useOrderAge } from '../composables/use-order-age';
import { usePagedOrders } from '../composables/use-paged-orders';
import { hasValidTotal } from '../domain/order-sort';
import {
  hasOrderFilters,
  NO_ORDER_FILTERS,
  orderFiltersToQuery,
  orderListRequest,
  ownStageFor,
  parseOrderFilters,
  secondaryFilterCount,
  stageStatuses,
  stageTabCounts,
  totalsOf,
  type OrderFilters,
  type StageFilter,
} from '../domain/order-filters';
import {
  FULFILLMENT_STAGES,
  isClosedWithoutDelivery,
  isFullSummary,
  stageIndex,
  totalOf,
  type OrderSummary,
} from '../domain/order-model';
import { paymentTone, stageTone } from '../domain/order-presentation';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { ordersApi, ordersStore, clock, currentUser } = useServices();
const { formatMoney, formatShortDateTime } = useFormat();
const { ageText, ageMinutes } = useOrderAge(clock);

const filters = computed(() => parseOrderFilters(route.query));
// The order page links back with these filters.
watch(filters, (value) => (rememberedListQuery.value = orderFiltersToQuery(value)), {
  immediate: true,
});
// The server filters and pages (newest first); the counts over the same filters give the tabs,
// the count and the sum, which the loaded pages alone could not.
const request = computed(() => orderListRequest(filters.value));
const paged = usePagedOrders(ordersApi, () => request.value, { changes: ordersStore.revision });
const list = paged.orders;
const totals = computed(() =>
  totalsOf(
    paged.counts.value,
    stageStatuses(filters.value.stage ?? 'all').filter((s) => request.value.countable.includes(s)),
  ),
);
const listEnd = ref<HTMLElement | null>(null);
useInfiniteScroll(listEnd, () => paged.loadMore());

// The filters live in the URL, so a quick filter in the sidebar, a link from the home page, a
// reload and the browser's back button from an order all land on the same list.
function setFilters(next: OrderFilters): void {
  void router.replace({ query: orderFiltersToQuery(next) });
}

// The text box types freely; the URL (and so the list) follows after a short pause, written with
// replace so Back leaves the page instead of stepping through every letter.
const SEARCH_PAUSE_MS = 300;
const search = ref(filters.value.text ?? '');
let pause: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(pause);
  pause = setTimeout(() => {
    const text = value.trim() === '' ? null : value.trim();
    if (text !== filters.value.text) setFilters({ ...filters.value, text });
  }, SEARCH_PAUSE_MS);
});
// A change that did not come from typing (the clear button, a link) is shown in the box.
watch(
  () => filters.value.text,
  (text) => {
    if ((text ?? '') !== search.value.trim()) search.value = text ?? '';
  },
);
onBeforeUnmount(() => clearTimeout(pause));

const stageValue = computed(() => filters.value.stage ?? 'all');
const ownStage = computed(() => ownStageFor(currentUser.user.value?.staffRoles ?? []));
const tabCounts = computed(() => stageTabCounts(paged.counts.value, request.value.countable));

const pickStage = (value: string): void =>
  setFilters({ ...filters.value, stage: value === 'all' ? null : (value as StageFilter) });

// Payment and period sit in one "Filters" sheet; the button shows how many are on.
const sheetOpen = ref(false);
const secondaryCount = computed(() => secondaryFilterCount(filters.value));
const resetSecondary = (): void => setFilters({ ...filters.value, payment: null, period: null });

interface Chip {
  readonly key: keyof OrderFilters;
  readonly label: string;
}
// A chip per applied sheet filter. The stage is the pressed tab and the text is in the search
// box, so they are not repeated here; "Clear all" still resets everything.
const chips = computed<Chip[]>(() => {
  const f = filters.value;
  const out: Chip[] = [];
  if (f.payment)
    out.push({
      key: 'payment',
      label: `${t('orders.filters.payment')}: ${t(`orders.payment.${f.payment}`)}`,
    });
  if (f.period)
    out.push({
      key: 'period',
      label: `${t('orders.filters.period')}: ${t(`orders.filters.${f.period}`)}`,
    });
  return out;
});
const dropFilter = (key: keyof OrderFilters): void => setFilters({ ...filters.value, [key]: null });
const resultText = computed(() =>
  t('table.resultCount', { count: totals.value.count }, totals.value.count),
);

// The server's DTO decides what exists: a warehouse or driver list carries no money or payment
// fields at all, so those columns are simply not drawn (no role check in the client).
const hasMoney = computed(() => list.value.some(isFullSummary));
const stageRank = (order: OrderSummary): number => {
  const index = stageIndex(order.status);
  return index === -1 ? FULFILLMENT_STAGES.length : index;
};

// Column order of the v8 list: number, customer, status, placed by, payment, total, lines,
// submitted, age.
const columns = computed<DataTableColumn<OrderSummary>[]>(() => [
  {
    key: 'number',
    label: t('orders.columns.number'),
    width: '110px',
    text: (o) => o.orderNumber,
    compare: (a, b) => (a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0),
  },
  {
    key: 'organization',
    label: t('orders.columns.organization'),
    truncate: true,
    minWidth: '130px',
    text: (o) => o.organizationName,
    compare: (a, b) => a.organizationName.localeCompare(b.organizationName),
  },
  {
    key: 'stage',
    label: t('orders.columns.stage'),
    width: '150px',
    text: (o) => t(`orders.stages.${o.status}`),
    compare: (a, b) => stageRank(a) - stageRank(b),
  },
  {
    key: 'placedBy',
    label: t('orders.columns.placedBy'),
    truncate: true,
    minWidth: '120px',
    hidden: !hasMoney.value,
    text: (o) => (isFullSummary(o) ? o.placedBy.fullName : ''),
  },
  {
    key: 'payment',
    label: t('orders.columns.payment'),
    width: '130px',
    hidden: !hasMoney.value,
    // Empty for a closed order, so the slot falling back to this text shows nothing either.
    text: (o) =>
      isFullSummary(o) && !isClosedWithoutDelivery(o.status)
        ? t(`orders.payment.${o.paymentStatus}`)
        : '',
  },
  {
    key: 'total',
    label: t('orders.columns.total', { currency: t('common.currency') }),
    align: 'end',
    width: '130px',
    hidden: !hasMoney.value,
    // The currency is in the header, so the cell carries the figure only (v8).
    text: (o) => {
      const total = totalOf(o);
      return total === null ? '' : formatMoney(total);
    },
    hasSortValue: (o) => hasValidTotal(totalOf(o)),
    compare: (a, b) => compareMoney(totalOf(a) ?? '0', totalOf(b) ?? '0'),
  },
  {
    key: 'items',
    label: t('orders.columns.items'),
    align: 'end',
    width: '72px',
    text: (o) => String(o.itemCount),
    compare: (a, b) => a.itemCount - b.itemCount,
  },
  {
    key: 'submitted',
    label: t('orders.columns.submitted'),
    width: '130px',
    text: (o) => formatShortDateTime(o.submittedAt),
    hasSortValue: (o) => Number.isFinite(Date.parse(o.submittedAt)),
    compare: (a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt),
  },
  {
    key: 'age',
    label: t('orders.columns.age'),
    hint: t('orders.columns.ageHint'),
    width: '130px',
    text: (o) => ageText(o),
    // Finished, closed and invalid ones have no age: they sort last in both directions.
    hasSortValue: (o) => ageMinutes(o) >= 0,
    compare: (a, b) => ageMinutes(a) - ageMinutes(b),
  },
]);

const footer = computed(() =>
  t(
    hasMoney.value ? 'orders.page.footerMoney' : 'orders.page.footer',
    { count: totals.value.count, currency: t('common.currency') },
    totals.value.count,
  ),
);

const pageState = computed(() => (paged.state.value === 'empty' ? 'ready' : paged.state.value));
</script>

<template>
  <StateView :state="pageState" @retry="paged.reload()">
    <div class="orders">
      <header class="head">
        <h1 class="head__title">{{ t('orders.page.title') }}</h1>
        <span class="head__info">
          {{
            t(
              'orders.page.info',
              {
                count: totals.count,
                sum: formatMoney(totals.sum ?? '0'),
                currency: t('common.currency'),
              },
              totals.count,
            )
          }}
        </span>
      </header>

      <div class="list">
        <OrdersStatusTabs
          :model-value="stageValue"
          :counts="tabCounts"
          :own-stage="ownStage"
          @update:model-value="pickStage"
        />

        <FilterPanel class="bar" :aria-label="t('orders.filters.group')">
          <SearchField
            v-model="search"
            class="search"
            :placeholder="t('orders.filters.searchPlaceholder')"
          />
          <AppButton
            variant="secondary"
            size="sm"
            class="more"
            :aria-label="
              secondaryCount > 0
                ? t('orders.filters.moreActive', { count: secondaryCount })
                : undefined
            "
            @click="sheetOpen = true"
          >
            <StaffIcon name="filter" :size="14" class="more__icon" />
            {{ t('orders.filters.more') }}
            <span v-if="secondaryCount > 0" class="more__badge" aria-hidden="true">{{
              secondaryCount
            }}</span>
          </AppButton>
          <div v-if="hasOrderFilters(filters)" class="applied">
            <ul
              v-if="chips.length > 0"
              class="applied__chips"
              :aria-label="t('table.appliedFilters')"
            >
              <li v-for="chip in chips" :key="chip.key">
                <button
                  type="button"
                  class="chip"
                  :aria-label="t('table.removeFilter', { filter: chip.label })"
                  @click="dropFilter(chip.key)"
                >
                  {{ chip.label }}
                  <StaffIcon name="x" :size="12" />
                  <span class="sr-only">{{ '×' }}</span>
                </button>
              </li>
            </ul>
            <button type="button" class="clear" @click="setFilters(NO_ORDER_FILTERS)">
              {{ t('orders.page.clear') }}
            </button>
          </div>
          <span class="result-count" role="status">{{ resultText }}</span>
        </FilterPanel>

        <OrdersFilterSheet
          v-model="sheetOpen"
          :filters="filters"
          :show-money="hasMoney"
          :result-count="totals.count"
          @update:filters="setFilters"
          @reset="resetSecondary"
        />

        <DataTable
          :class="{ refreshing: paged.refreshing.value }"
          :aria-busy="paged.refreshing.value"
          :columns="columns"
          :rows="list"
          :row-key="(o: OrderSummary) => o.id"
          :row-to="(o: OrderSummary) => ({ name: 'staff-order', params: { orderId: o.id } })"
          :label="t('orders.page.list')"
          :empty-text="t('orders.page.empty')"
          :style="{ '--dt-min-width': hasMoney ? '1040px' : '680px' }"
        >
          <template #cell-number="{ row }">
            <span class="number">{{ row.orderNumber }}</span>
          </template>
          <template #cell-stage="{ row }">
            <AppBadge :tone="stageTone(row.status)" dot>{{
              t(`orders.stages.${row.status}`)
            }}</AppBadge>
          </template>
          <template #cell-placedBy="{ row }">
            <PersonName
              v-if="isFullSummary(row)"
              :name="row.placedBy.fullName"
              :user-id="row.placedBy.userId"
            />
          </template>
          <template #cell-payment="{ row }">
            <AppBadge
              v-if="isFullSummary(row) && !isClosedWithoutDelivery(row.status)"
              :tone="paymentTone(row.paymentStatus)"
              dot
            >
              {{ t(`orders.payment.${row.paymentStatus}`) }}
            </AppBadge>
          </template>
          <template #cell-submitted="{ row }">
            <span class="muted">{{ formatShortDateTime(row.submittedAt) }}</span>
          </template>
          <template #cell-age="{ row }">
            <span class="muted" :title="t('orders.columns.ageHint')">{{
              ageText(row) || '—'
            }}</span>
          </template>
          <template #card="{ row }">
            <span class="card__top">
              <span class="number">{{ row.orderNumber }}</span>
              <AppBadge :tone="stageTone(row.status)" dot>{{
                t(`orders.stages.${row.status}`)
              }}</AppBadge>
            </span>
            <span class="card__org">{{ row.organizationName }}</span>
            <span class="card__bottom">
              <b v-if="totalOf(row) !== null" class="num">
                {{ formatMoney(totalOf(row)!) }} {{ t('common.currency') }}
              </b>
              <AppBadge
                v-if="isFullSummary(row) && !isClosedWithoutDelivery(row.status)"
                :tone="paymentTone(row.paymentStatus)"
                dot
              >
                {{ t(`orders.payment.${row.paymentStatus}`) }}
              </AppBadge>
              <span class="muted" :title="ageText(row) ? t('orders.columns.ageHint') : undefined">{{
                ageText(row) || formatShortDateTime(row.submittedAt)
              }}</span>
            </span>
          </template>
        </DataTable>

        <AppButton
          v-if="list.length === 0 && hasOrderFilters(filters)"
          variant="secondary"
          class="empty-clear"
          @click="setFilters(NO_ORDER_FILTERS)"
        >
          {{ t('orders.page.clear') }}
        </AppButton>
        <div v-if="paged.nextCursor.value !== null" ref="listEnd" class="more-rows">
          <p v-if="paged.moreError.value" class="more-rows__error" role="alert">
            {{ t('orders.page.moreFailed') }}
          </p>
          <AppButton
            variant="secondary"
            :loading="paged.loadingMore.value"
            @click="paged.loadMore()"
          >
            {{ t('orders.page.loadMore') }}
          </AppButton>
        </div>
        <p v-if="list.length > 0" class="foot">{{ footer }}</p>
      </div>
    </div>
  </StateView>
</template>

<style scoped>
.orders {
  display: flex;
  flex-direction: column;
  gap: var(--gap-block);
  animation: viewIn 0.35s var(--ease) both;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* v8 page title: 28px regular; the summary line under it 12px secondary. */
.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__info {
  font-size: var(--fs-small);
  color: var(--t2);
}

/* Tabs, toolbar, table and footer read as one block (v8 draws them in one card; DataTable is a
   card of its own, so they are stacked tight instead of nested). */
.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.search {
  flex: 1 1 240px;
  max-width: 316px;
}

.more {
  flex: 0 0 auto;
  height: 38px;
}

.more__icon {
  color: var(--t2);
}

.more__badge {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-group);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.applied {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  min-height: 38px;
}

.applied__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* v8 filter chip: orange tint, 30px high, the remove cross on the right. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 8px 0 10px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--acc-bg);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--acc-fg);
  cursor: pointer;
}

.chip:hover {
  box-shadow: inset 0 0 0 1px var(--acc);
}

.clear {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: var(--fs-meta);
  color: var(--acc-fg);
  cursor: pointer;
}

.clear:hover {
  text-decoration: underline;
}

.result-count {
  align-self: center;
  margin-left: auto;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.number {
  font-weight: 500;
  color: var(--acc-fg);
}

.empty-clear {
  align-self: center;
}

/* The end of the loaded rows: the next page loads on its own when this comes near. */
/* The rows of the previous filters while the new ones load. */
.refreshing {
  color: var(--t3);
  transition: color 0.15s var(--ease);
}

.more-rows {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.more-rows__error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--red);
}

.foot {
  margin: 0;
  padding: 0 4px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.muted {
  color: var(--t2);
  white-space: nowrap;
}

.card__top,
.card__bottom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
}

.card__org {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.card__bottom {
  justify-content: flex-start;
  font-size: var(--fs-small);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (pointer: coarse), (hover: none) {
  .chip,
  .clear {
    min-height: 44px;
  }
}
</style>
