<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StockOverviewItem } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import DataTable from '@/components/ui/DataTable.vue';
import FilterCombobox from '@/components/ui/FilterCombobox.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import TableDensitySwitch from '@/components/ui/TableDensitySwitch.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import type { PriceSaved, PriceTarget } from '@/features/pricing/components/PriceEditDialog.vue';
import PriceHistoryDrawer from '@/features/pricing/components/PriceHistoryDrawer.vue';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { compareMoney, isMoney } from '@core/lib/money';
import { filterRows } from '@/features/pricing/domain/row-filter';
import { pickName } from '@/features/pricing/domain/localized-name';
import { savedMessage } from '@/features/pricing/domain/saved-message';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { amountsIn, toPriceRows, type PriceRow } from '@/features/pricing/domain/price-rows';
import { priceTargetOf } from '@/features/pricing/domain/price-target';
import { useCostFormat } from '../composables/use-cost-format';
import { useUrlState } from '../composables/use-url-state';
import { useStockOverview } from '../composables/use-stock-overview';
import {
  CATEGORY_ALL,
  countCategories,
  countsFromResponse,
  filterByCategory,
} from '../domain/category-filter';
import {
  canEditPrices,
  canRunSheetSync,
  canViewPriceAdmin,
} from '@/features/staff-shell/price-access';
import { stockLevel, toScaled } from '../domain/decimal';
import { matchesSupplier, SUPPLIER_ALL, supplierOptions } from '../domain/supplier-filter';
import CategoryDropdown from './CategoryDropdown.vue';
import MegaReportButton from './MegaReportButton.vue';
import RemovalRequests from './RemovalRequests.vue';
import SheetSyncPanel from './SheetSyncPanel.vue';
import StockCell from './StockCell.vue';
import SupplyHistory from './SupplyHistory.vue';
import SupplyPartyDialog from './SupplyPartyDialog.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';

// "Qoldiq" (design v8 "Ostatok"): the stock aggregate per product, staff-only (manager,
// accountant, admin). Read from the «Поставка» sheet, which nothing here writes to (hard rule 10).
// Jami is the sheet's figure, Band the holds of approved orders ([C] 2026-10-30), Mavjud the
// difference: no warehouse or shelf (the sheet has neither). A row opens the same side
// panel as the price list. "Narx qo'yish" opens the same price dialog as Narxlar: its save
// publishes a new version at once (no drafts). A product with no stock may be priced too
// [C, 2026-10-28]. Narxlar's "Ostatokdan qo'shish" lands here with `priced=unpriced`.
// Loaded on first use, never statically: it imports the shared cost contracts, which live in
// THIS chunk (staff-finance, vite.config.ts). A static import made the chunks import each other,
// and the catalog chunk then read a contract schema before it existed (blank app on staging).
const PriceEditDialog = defineAsyncComponent(
  () => import('@/features/pricing/components/PriceEditDialog.vue'),
);

const { t } = useI18n();
const { stockApi, pricingApi, currentUser, priceVersionStore, unpricedCountStore } = useServices();
const { formatDate, formatQuantity, formatUsd, formatUzs } = useCostFormat();

const canDecide = computed(() => canEditPrices(currentUser.user.value?.staffRoles ?? []));
const canSync = computed(() => canRunSheetSync(currentUser.user.value?.staffRoles ?? []));
const seesPriceHistory = computed(() =>
  canViewPriceAdmin(currentUser.user.value?.staffRoles ?? []),
);
// The manager's alone ([C] 2026-10-30); the server enforces it, this only hides the button.
const canSetParty = computed(() => currentUser.user.value?.staffRoles.includes('MANAGER') === true);
const partyOpen = ref(false);

type PricedFilter = 'all' | 'priced' | 'unpriced';
const PRICED_FILTERS: readonly PricedFilter[] = ['all', 'priced', 'unpriced'];

const search = ref('');
const inStockOnly = ref(false);
const category = ref(CATEGORY_ALL);
const priced = ref<PricedFilter>('all');
const supplier = ref(SUPPLIER_ALL);
// Category, price status and search live in the address (reload and Back keep them).
useUrlState('category', category, { fallback: CATEGORY_ALL });
useUrlState('priced', priced, {
  fallback: 'all',
  isValid: (value) => value === 'priced' || value === 'unpriced',
});
useUrlState('q', search, { fallback: '', debounceMs: 300 });
useUrlState('supplier', supplier, { fallback: SUPPLIER_ALL });

const stock = useStockOverview(stockApi, inStockOnly);

// The selling price column: the published list, read once. Without a published list (404) or on
// a failure the column shows "—"; the stock itself does not depend on it.
// The version number is the base of a price set here (optimistic concurrency of the publish).
// Rows of the published list by product: the column shows the USD sale price, and the price dialog
// starts from both USD prices.
const priceRows = shallowRef<ReadonlyMap<string, PriceRow>>(new Map());
const versionNumber = shallowRef<number | null>(null);
async function loadSellingPrices(): Promise<void> {
  try {
    const list = await pricingApi.getCurrent();
    priceRows.value = new Map(toPriceRows(list).map((row) => [row.productId, row]));
    versionNumber.value = list.version.number;
  } catch {
    priceRows.value = new Map();
    versionNumber.value = null;
  }
}
void loadSellingPrices();

const matchesPriced = (item: StockOverviewItem, filter: PricedFilter): boolean =>
  filter === 'all' || item.isPriced === (filter === 'priced');

const searchedAll = computed(() => filterRows(stock.response.value?.items ?? [], search.value));
// The supplier counts follow the search only; every other filter counts within the supplier.
const supplierChoices = computed(() => supplierOptions(searchedAll.value.map((i) => i.suppliers)));
const searched = computed(() =>
  searchedAll.value.filter((i) => matchesSupplier(i.suppliers, supplier.value)),
);
const byPriced = computed(() => searched.value.filter((i) => matchesPriced(i, priced.value)));
const visible = computed(() => filterByCategory(byPriced.value, category.value));

// The endpoint's own counts follow `inStock`; with a search or a price status chosen the counts
// are taken from the filtered rows, because only those filters run on the client.
const counts = computed(() => {
  const answer = stock.response.value;
  return answer !== null &&
    search.value.trim() === '' &&
    priced.value === 'all' &&
    supplier.value === SUPPLIER_ALL
    ? countsFromResponse(answer)
    : countCategories(byPriced.value);
});
// Every category of the answer stays in the menu (empty ones dimmed at the bottom).
const knownCategories = computed(
  () => stock.response.value?.categories.map((entry) => entry.category) ?? [],
);
const knownUncategorized = computed(() => (stock.response.value?.uncategorizedCount ?? 0) > 0);

const pricedOptions = computed(() =>
  PRICED_FILTERS.map((value) => ({
    value,
    label: t(`staffCost.stock.filter.${value}`),
    count: searched.value.filter((item) => matchesPriced(item, value)).length,
  })),
);
const unpricedVisible = computed(() => visible.value.filter((item) => !item.isPriced).length);
const filtered = computed(
  () =>
    search.value.trim() !== '' ||
    priced.value !== 'all' ||
    category.value !== CATEGORY_ALL ||
    supplier.value !== SUPPLIER_ALL,
);

function resetFilters(): void {
  search.value = '';
  priced.value = 'all';
  category.value = CATEGORY_ALL;
  supplier.value = SUPPLIER_ALL;
}

const nameOf = (item: StockOverviewItem): string => pickName(item.names);

function scaledOf(quantity: string | null): bigint | null {
  if (quantity === null) return null;
  try {
    return toScaled(quantity, 3);
  } catch {
    return null;
  }
}
function compareScaled(a: string | null, b: string | null): number {
  const x = scaledOf(a) ?? 0n;
  const y = scaledOf(b) ?? 0n;
  return x < y ? -1 : x > y ? 1 : 0;
}
/** More is held than the sheet shows: the sheet may already show the shipment. A look, not an error. */
const overHeld = (item: StockOverviewItem): boolean =>
  (scaledOf(item.heldQuantity) ?? 0n) > (scaledOf(item.stockQuantity) ?? 0n);
const deliveredAt = (item: StockOverviewItem): number =>
  item.latestDelivery ? Date.parse(item.latestDelivery.deliveredAt) : Number.NaN;
const costUzs = (item: StockOverviewItem): string | null => {
  const uzs = item.latestDelivery?.costUzs ?? null;
  return uzs !== null && isMoney(uzs) ? uzs : null;
};
const priceRowOf = (item: StockOverviewItem): PriceRow | null =>
  priceRows.value.get(item.productId) ?? null;
/** The sale price in USD [owner 2026-10-29]; null = not priced (or an older so'm price). */
const sellingPrice = (item: StockOverviewItem): string | null => {
  const row = priceRowOf(item);
  const price = row ? amountsIn(row, 'USD').price : null;
  return price !== null && isMoney(price) ? price : null;
};
// Only an active product without a price is work for the people who set prices.
const canPrice = (item: StockOverviewItem): boolean =>
  canDecide.value && !item.isPriced && item.isActive;

// The name column also holds the 40px photo and its 12px gap.
const NAME_MIN_PX = 260;
const columns = computed<DataTableColumn<StockOverviewItem>[]>(() => [
  {
    key: 'product',
    label: t('staffCost.stock.product'),
    minWidth: `${NAME_MIN_PX}px`,
    text: nameOf,
    compare: (a, b) => nameOf(a).localeCompare(nameOf(b)),
  },
  {
    key: 'total',
    label: t('staffCost.stock.total'),
    align: 'end',
    width: '80px',
    hasSortValue: (i) => scaledOf(i.stockQuantity) !== null,
    compare: (a, b) => compareScaled(a.stockQuantity, b.stockQuantity),
  },
  {
    key: 'held',
    label: t('staffCost.stock.held'),
    align: 'end',
    width: '72px',
    compare: (a, b) => compareScaled(a.heldQuantity, b.heldQuantity),
  },
  {
    key: 'stock',
    label: t('staffCost.stock.available'),
    align: 'end',
    width: '100px',
    hasSortValue: (i) => scaledOf(i.availableQuantity) !== null,
    compare: (a, b) => compareScaled(a.availableQuantity, b.availableQuantity),
  },
  {
    key: 'cost',
    label: t('staffCost.cost.column'),
    align: 'end',
    width: '104px',
    hasSortValue: (i) => costUzs(i) !== null,
    compare: (a, b) => compareMoney(costUzs(a) ?? '0', costUzs(b) ?? '0'),
  },
  {
    key: 'price',
    label: `${t('prices.columns.price')} ${t('prices.currency.USD')}`,
    align: 'end',
    width: '92px',
    hasSortValue: (i) => sellingPrice(i) !== null,
    compare: (a, b) => compareMoney(sellingPrice(a) ?? '0', sellingPrice(b) ?? '0'),
  },
  {
    key: 'date',
    label: t('staffCost.stock.lastDelivery'),
    align: 'end',
    width: '104px',
    hasSortValue: (i) => Number.isFinite(deliveredAt(i)),
    compare: (a, b) => deliveredAt(a) - deliveredAt(b),
  },
  {
    key: 'count',
    label: t('staffCost.stock.deliveryCount'),
    align: 'end',
    width: '96px',
    text: (i) => String(i.deliveryCount),
    compare: (a, b) => a.deliveryCount - b.deliveryCount,
  },
  { key: 'priced', label: t('staffCost.stock.priced'), width: '128px' },
]);
const tableMinWidth = computed(
  () =>
    `${columns.value.reduce((sum, c) => sum + (c.width ? Number.parseInt(c.width, 10) : 0), NAME_MIN_PX)}px`,
);

const errorText = computed(() =>
  translateDescribed(t, describePricingError('stock', stock.error.value)),
);

// --- pricing a product: the save publishes a new version with this one price (hard rule 5) ---

const dialogOpen = ref(false);
const target = shallowRef<PriceTarget | null>(null);

function setPrice(item: StockOverviewItem): void {
  // A drawer and a modal are never stacked.
  panelOpen.value = false;
  target.value = priceTargetOf(item, priceRowOf(item), item.latestDelivery?.costUsd ?? null);
  dialogOpen.value = true;
}

function onPriced(result: PriceSaved): void {
  const item = stock.response.value?.items.find((i) => i.productId === result.productId);
  showToast({ message: savedMessage(t, result, item ? nameOf(item) : null) });
  void stock.reload({ silent: true });
  void loadSellingPrices();
  // The sidebar card, the home page and the nav badge follow the published list.
  void priceVersionStore.refresh();
  void unpricedCountStore.refresh();
}

// --- the side panel --------------------------------------------------------------------------

const panelOpen = ref(false);
// The id, not a copy of the row: after a reload (a new photo, a price) the panel shows the
// current row.
const panelId = ref<string | null>(null);
const panelItem = computed<StockOverviewItem | null>(
  () => stock.response.value?.items.find((item) => item.productId === panelId.value) ?? null,
);

function openPanel(item: StockOverviewItem): void {
  panelId.value = item.productId;
  panelOpen.value = true;
}
</script>

<template>
  <section class="stock">
    <PricesSubHeader :title="t('staffCost.stock.title')">
      <!-- Hard rule 10: the stock is read from the sheet and reserves nothing. -->
      <p class="note" role="note">{{ t('staffCost.stock.indicative') }}</p>
      <template #actions>
        <MegaReportButton />
        <AppButton v-if="canSetParty" data-testid="party-open" @click="partyOpen = true">
          <StaffIcon name="plus" :size="16" />{{ t('staffCost.party.button') }}
        </AppButton>
      </template>
    </PricesSubHeader>
    <SupplyPartyDialog v-if="canSetParty" v-model="partyOpen" />

    <SheetSyncPanel :can-run="canSync" @synced="stock.reload({ silent: true })" />

    <StateView
      :state="stock.state.value"
      :title="stock.state.value === 'empty' ? t('staffCost.stock.empty') : undefined"
      :description="
        stock.state.value === 'empty'
          ? t('staffCost.stock.emptyHelp')
          : stock.state.value === 'error'
            ? errorText
            : undefined
      "
      @retry="stock.reload()"
    >
      <div class="list" :aria-busy="stock.refreshing.value">
        <!-- One toolbar row above the table: the status pills, search, the stock filter, the
             category and the table density. -->
        <FilterPanel class="toolbar">
          <!-- v8: separate pill buttons, the chosen one dark; the last carries the accent dot. -->
          <div class="status" role="group" :aria-label="t('staffCost.stock.filter.label')">
            <button
              v-for="option in pricedOptions"
              :key="option.value"
              type="button"
              class="status__item"
              :class="{ 'status__item--on': priced === option.value }"
              :aria-pressed="priced === option.value"
              :data-filter="option.value"
              @click="priced = option.value"
            >
              <span v-if="option.value === 'unpriced'" class="status__dot" aria-hidden="true" />
              {{ option.label }}
              <span class="status__count num">{{ option.count }}</span>
            </button>
          </div>
          <SearchField
            v-model="search"
            :placeholder="t('prices.search.placeholder')"
            label-hidden
          />
          <!-- In the slot of the design's "all warehouses" select: the sheet has no warehouses,
               the app's real stock filter (server side) sits here instead. -->
          <label class="check">
            <input v-model="inStockOnly" type="checkbox" class="check__box" />
            <span>{{ t('staffCost.stock.inStockOnly') }}</span>
          </label>
          <CategoryDropdown
            v-model="category"
            :counts="counts"
            :also-known="knownCategories"
            :also-uncategorized="knownUncategorized"
          />
          <div class="toolbar__supplier">
            <FilterCombobox
              v-model="supplier"
              :options="supplierChoices"
              :all-value="SUPPLIER_ALL"
              :all-label="t('staffCost.supplierFilter.all')"
              :label="t('staffCost.supplierFilter.label')"
              :placeholder="t('staffCost.supplierFilter.search')"
              :no-match-text="t('staffCost.supplierFilter.noMatch')"
              :clear-label="t('staffCost.supplierFilter.clear')"
              :unknown-label="t('staffCost.supplierFilter.unknown')"
              :count-text="
                (count: number) => t('staffCost.supplierFilter.productsCount', { count }, count)
              "
              data-testid="supplier-filter"
            />
          </div>
          <TableDensitySwitch class="toolbar__density" />
        </FilterPanel>

        <div
          class="surface"
          :class="{ 'surface--refreshing': stock.refreshing.value }"
          :style="{ '--dt-min-width': tableMinWidth }"
        >
          <DataTable
            :columns="columns"
            :rows="visible"
            :row-key="(item: StockOverviewItem) => item.productId"
            :row-action="openPanel"
            :row-label="
              (item: StockOverviewItem) =>
                `${item.productCode} ${nameOf(item)}: ${t('staffCost.stock.openPanel')}`
            "
            :row-tone="(item: StockOverviewItem) => (item.isActive ? undefined : 'muted')"
            :label="t('staffCost.stock.tableLabel')"
            :empty-text="t('prices.noMatch')"
            :density-toggle="false"
          >
            <template #lead="{ row }">
              <ProductThumb :src="row.imageUrl" :large-src="row.imageLargeUrl" :alt="nameOf(row)" />
            </template>
            <template #cell-product="{ row }">
              <span class="product">
                <span class="product__line">
                  <span class="name">{{ nameOf(row) }}</span>
                  <AppBadge v-if="!row.isActive" tone="warning">{{
                    t('prices.row.inactiveBadge')
                  }}</AppBadge>
                </span>
                <span class="meta">
                  <span class="mono code">{{ row.productCode }}</span>
                  <span aria-hidden="true">·</span>
                  <span v-if="row.category !== null">{{ row.category }}</span>
                  <span v-else>{{ t('staffCost.categories.none') }}</span>
                </span>
              </span>
            </template>
            <template #cell-total="{ row }">
              <span v-if="row.stockQuantity !== null" class="num">{{
                formatQuantity(row.stockQuantity)
              }}</span>
              <span v-else class="muted">—</span>
            </template>
            <template #cell-held="{ row }">
              <span class="held num" :class="{ 'held--over': overHeld(row) }">{{
                formatQuantity(row.heldQuantity)
              }}</span>
              <AppBadge v-if="overHeld(row)" tone="warning">{{
                t('staffCost.stock.overHeld')
              }}</AppBadge>
            </template>
            <template #cell-stock="{ row }">
              <StockCell
                :quantity="row.availableQuantity"
                :level="stockLevel(row.availableQuantity)"
                :unit="row.unit"
              />
            </template>
            <template #cell-cost="{ row }">
              <span v-if="costUzs(row) !== null && row.latestDelivery" class="money">
                <span class="money__main money__main--cost">{{
                  formatUzs(costUzs(row) ?? '')
                }}</span>
                <span class="money__sub">{{ formatUsd(row.latestDelivery.costUsd) }}</span>
              </span>
              <span v-else class="muted">—</span>
            </template>
            <template #cell-price="{ row }">
              <span v-if="sellingPrice(row) !== null" class="money__main">{{
                formatUsd(sellingPrice(row) ?? '')
              }}</span>
              <span v-else class="muted">—</span>
            </template>
            <template #cell-date="{ row }">
              <span v-if="row.latestDelivery" class="num">{{
                formatDate(row.latestDelivery.deliveredAt)
              }}</span>
              <span v-else class="muted">—</span>
            </template>
            <template #cell-count="{ row }">
              <span class="num deliveries">{{ row.deliveryCount }}</span>
            </template>
            <template #cell-priced="{ row }">
              <span v-if="row.isPriced" class="pill pill--on">
                <StaffIcon name="check" :size="12" />{{ t('staffCost.stock.pricedYes') }}
              </span>
              <button
                v-else-if="canPrice(row)"
                type="button"
                class="setprice"
                :aria-label="
                  t('staffCost.stock.setPriceLabel', {
                    product: `${row.productCode} ${nameOf(row)}`,
                  })
                "
                @click.stop="setPrice(row)"
              >
                <StaffIcon name="tags" :size="13" />{{ t('staffCost.stock.setPrice') }}
              </button>
              <span v-else class="pill pill--off">{{ t('staffCost.stock.pricedNo') }}</span>
            </template>
            <template #card="{ row }">
              <!-- The card is the row's button: the photo is only a picture here; the side
                   panel shows it large. -->
              <span class="card__head">
                <ProductThumb :src="row.imageUrl" alt="" :zoomable="false" />
                <span class="card__titles">
                  <span class="card__top">
                    <b class="name">{{ nameOf(row) }}</b>
                    <span v-if="row.isPriced" class="pill pill--on">
                      <StaffIcon name="check" :size="11" />{{ t('staffCost.stock.pricedYes') }}
                    </span>
                    <span v-else class="pill pill--off">{{ t('staffCost.stock.pricedNo') }}</span>
                  </span>
                  <span class="card__line meta">
                    <span class="mono code">{{ row.productCode }}</span>
                    <span v-if="row.category !== null">· {{ row.category }}</span>
                    <AppBadge v-if="!row.isActive" tone="warning">{{
                      t('prices.row.inactiveBadge')
                    }}</AppBadge>
                  </span>
                </span>
              </span>
              <span class="card__grid">
                <span class="card__cell">
                  <span class="card__label">{{ t('staffCost.stock.available') }}</span>
                  <StockCell
                    :quantity="row.availableQuantity"
                    :level="stockLevel(row.availableQuantity)"
                    :unit="row.unit"
                  />
                  <span class="card__sub num">
                    {{ t('staffCost.stock.total') }}
                    {{ row.stockQuantity !== null ? formatQuantity(row.stockQuantity) : '—' }} ·
                    {{ t('staffCost.stock.held') }} {{ formatQuantity(row.heldQuantity) }}
                  </span>
                  <AppBadge v-if="overHeld(row)" tone="warning">{{
                    t('staffCost.stock.overHeld')
                  }}</AppBadge>
                </span>
                <span class="card__cell">
                  <span class="card__label">{{ t('staffCost.cost.column') }}</span>
                  <span class="num">{{
                    costUzs(row) !== null ? formatUzs(costUzs(row) ?? '') : '—'
                  }}</span>
                </span>
                <span class="card__cell">
                  <span class="card__label">{{ t('prices.columns.price') }}</span>
                  <b class="num">{{
                    sellingPrice(row) !== null ? formatUsd(sellingPrice(row) ?? '') : '—'
                  }}</b>
                </span>
              </span>
            </template>
          </DataTable>
          <div v-if="visible.length === 0 && filtered" class="reset">
            <AppButton variant="secondary" size="xs" @click="resetFilters">
              {{ t('staffCost.stock.resetFilters') }}
            </AppButton>
          </div>
        </div>

        <p class="list-count">
          {{ t('staffCost.stock.info', { count: visible.length }, visible.length) }}
          <template v-if="unpricedVisible > 0">
            · {{ t('staffCost.stock.infoUnpriced', { count: unpricedVisible }, unpricedVisible) }}
          </template>
        </p>
      </div>
    </StateView>

    <RemovalRequests :can-decide="canDecide" @decided="stock.reload({ silent: true })" />

    <PriceHistoryDrawer
      v-model="panelOpen"
      :product-id="panelItem?.productId ?? null"
      :product-code="panelItem?.productCode ?? ''"
      :name="panelItem ? nameOf(panelItem) : ''"
      :show-price-history="seesPriceHistory"
    >
      <!-- Phones reach the photo and the price from the panel (a card cannot hold a button). -->
      <ProductThumb
        v-if="panelItem?.imageUrl"
        :key="panelItem.productId"
        class="panel-photo"
        :src="panelItem.imageUrl"
        :large-src="panelItem.imageLargeUrl"
        :alt="nameOf(panelItem)"
        :size="96"
      />
      <AppButton
        v-if="panelItem && canPrice(panelItem)"
        class="panel-price"
        @click="panelItem && setPrice(panelItem)"
      >
        <StaffIcon name="tags" :size="15" />
        {{ t('staffCost.stock.setPrice') }}
      </AppButton>
      <SupplyHistory
        v-if="panelItem"
        :key="panelItem.productId"
        :product-id="panelItem.productId"
      />
    </PriceHistoryDrawer>

    <PriceEditDialog
      v-if="canDecide"
      v-model="dialogOpen"
      :product="target"
      :base-version-number="versionNumber"
      @saved="onPriced"
      @stale="loadSellingPrices"
      @photos-changed="stock.reload({ silent: true })"
    />
  </section>
</template>

<style scoped>
.stock {
  display: flex;
  flex-direction: column;
  gap: var(--gap-card);
  min-width: 0;
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-card);
  min-width: 0;
}

/* The v8 page subtitle slot: 12px secondary text under the title. */
.note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* v8 status filter: 36px pills with an 8px radius and a hairline ring; the chosen one is dark. */
.status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status__item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  cursor: pointer;
}

.status__item:hover:not(.status__item--on) {
  background: var(--hov);
}

.status__item:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.status__item--on {
  /* The ink pair tokens keep the dark pill readable in both themes. */
  background: var(--btn-ink-bg);
  box-shadow: inset 0 0 0 1px var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.status__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--acc);
}

.status__count {
  font-weight: 500;
}

/* The v8 toolbar card, compact: the status pills, search, the stock filter, the category dropdown
   and the density switch on one line where the width allows. */
.toolbar {
  align-items: center;
  padding: var(--container-pad) var(--gap-card);
}

.toolbar :deep(.search) {
  flex: 1 1 160px;
  /* Its input would otherwise keep it wider than the basis and push the density switch down. */
  min-width: 0;
}

.toolbar__density {
  margin-left: auto;
}

/* Few suppliers, but the combobox keeps the toolbar's field look and its type-to-find. */
.toolbar__supplier {
  flex: 0 1 220px;
  min-width: 160px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  cursor: pointer;
}

.check:has(.check__box:focus-visible) {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.check__box {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--acc);
}

/* The table is the page: once scrolled under the top bar it fills the window and scrolls inside. */
.surface {
  display: flex;
  flex-direction: column;
  min-width: 0;
  --dt-max-h: calc(100vh - var(--topbar-h) - var(--safe-top, 0px) - var(--gap-card));
}

/* The dynamic viewport height leaves out a phone browser's bars; older browsers keep 100vh. */
@supports (height: 100dvh) {
  .surface {
    --dt-max-h: calc(100dvh - var(--topbar-h) - var(--safe-top, 0px) - var(--gap-card));
  }
}

/* While "Omborda bor" reloads, the old rows stay and only fade a little (no skeleton swap). */
.surface--refreshing {
  cursor: progress;
  pointer-events: none;
}

.reset {
  display: flex;
  justify-content: center;
  padding: 0 0 12px;
}

.list-count {
  margin: -4px 0 0;
  padding: 0 4px;
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

/* v8 product cell: the 12px/500 name over a 10px grey line "SKU · category" (SKU in mono). */
.product {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-weight: 400;
}

.product__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-group);
  font-weight: 400;
  color: var(--t2);
}

.code {
  font-family: var(--font-mono);
}

.muted {
  color: var(--t3);
}

.money {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.money__main {
  font-weight: 600;
}

.money__main--cost {
  font-weight: 400;
  color: var(--t2);
}

.money__sub {
  font-size: var(--fs-group);
  color: var(--t3);
}

/* v8 pills: 6px radius, 4px 8px, 11px/600; green "in the list", accent "no price yet". */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-meta);
  font-weight: 600;
  white-space: nowrap;
}

.pill--on {
  background: var(--green-bg);
  color: var(--green);
}

.pill--off {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

/* v8 "Narx qo'yish": a 30px orange button with a 7px radius. */
.setprice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--acc);
  color: var(--acc-on);
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.setprice:hover {
  background: var(--acc-hover);
}

.setprice:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.card__top,
.card__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
}

.card__line {
  justify-content: flex-start;
}

/* The v8 phone card: three figures on the grey fill. */
.card__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.card__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.card__label,
.card__sub {
  font-size: var(--fs-group);
  color: var(--t2);
}

.held--over {
  font-weight: 600;
  color: var(--ink);
}

.panel-price {
  align-self: stretch;
}

.card__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.card__titles {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.panel-photo {
  align-self: flex-start;
}

@media (max-width: 720px) {
  .check {
    flex: 1 1 auto;
  }

  /* Phones: the search keeps a line of its own, so its placeholder stays readable. */
  .toolbar :deep(.search) {
    flex-basis: 100%;
  }
}

@media (pointer: coarse) {
  .check,
  .status__item {
    min-height: 44px;
  }

  .setprice {
    min-height: 44px;
  }
}
</style>
