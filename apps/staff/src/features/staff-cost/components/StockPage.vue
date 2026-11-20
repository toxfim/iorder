<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type { StockOverviewItem } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppDropdown from '@core/components/ui/AppDropdown.vue';
import type { RowMenuItem } from '@/components/ui/RowContextMenu.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useMediaQuery } from '@/composables/use-media-query';
import type { PriceSaved, PriceTarget } from '@/features/pricing/components/PriceEditDialog.vue';
import PriceHistoryDrawer from '@/features/pricing/components/PriceHistoryDrawer.vue';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { isMoney } from '@core/lib/money';
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
  CATEGORY_NONE,
  categoryTabId,
  countCategories,
  filterByCategory,
} from '../domain/category-filter';
import {
  canEditPrices,
  canRunSheetSync,
  canViewPriceAdmin,
} from '@/features/staff-shell/price-access';
import { addQuantities, LOW_STOCK_BELOW } from '../domain/decimal';
import { DEFAULT_PAGE_SIZE, pageSlice, type PageSize } from '../domain/pagination';
import {
  BRAND_ALL,
  brandOptions,
  isNewDelivery,
  isStockPreset,
  isStockSort,
  matchesBrand,
  matchesPreset,
  NEW_DELIVERY_DAYS,
  sortStock,
  STOCK_PRESETS,
  STOCK_SORTS,
  type StockPreset,
  type StockSort,
} from '../domain/stock-views';
import { matchesSupplier, SUPPLIER_ALL, supplierOptions } from '../domain/supplier-filter';
import CategoryDropdown from './CategoryDropdown.vue';
import FilterMenu from './FilterMenu.vue';
import MegaReportButton from './MegaReportButton.vue';
import RemovalRequests from './RemovalRequests.vue';
import SheetSyncPanel from './SheetSyncPanel.vue';
import StockCard from './StockCard.vue';
import StockFilterSheet, { type SheetList } from './StockFilterSheet.vue';
import StockPager from './StockPager.vue';
import StockTable from './StockTable.vue';
import SupplyHistory from './SupplyHistory.vue';
import SupplyPartyDialog from './SupplyPartyDialog.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';

// "Qoldiq" (design «Qoldiq — yakuniy sahifa», approved 2026-11-19: F3 toolbar, the table by
// default and card B as an option, responsive at 1440 / 768 / 390): the stock aggregate per
// product, staff-only (manager, accountant, admin, purchasing manager). Read from the «Поставка»
// sheet, which nothing here writes to (hard rule 10). Jami is the sheet's figure, Band the holds
// of approved orders ([C] 2026-10-30), Mavjud the difference. A row opens the same side panel as
// the price list. "Narx qo'yish" / "O'zgartirish" open the same price dialog as Narxlar: its save
// publishes a new version at once (no drafts); a product with no stock may be priced too
// [C, 2026-10-28]. Narxlar's "Ostatokdan qo'shish" lands here on the "unpriced" view.
// Owner choices of 2026-11-19 over the design: the cost column (Tannarx) stays; the bottom tab
// bar and the new product sheet come in a later step.
// Loaded on first use, never statically: it imports the shared cost contracts, which live in
// THIS chunk (staff-finance, vite.config.ts). A static import made the chunks import each other,
// and the catalog chunk then read a contract schema before it existed (blank app on staging).
const PriceEditDialog = defineAsyncComponent(
  () => import('@/features/pricing/components/PriceEditDialog.vue'),
);

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { stockApi, pricingApi, currentUser, priceVersionStore, unpricedCountStore } = useServices();
const { formatQuantity, formatUsd } = useCostFormat();

const canDecide = computed(() => canEditPrices(currentUser.user.value?.staffRoles ?? []));
const canSync = computed(() => canRunSheetSync(currentUser.user.value?.staffRoles ?? []));
const seesPriceHistory = computed(() =>
  canViewPriceAdmin(currentUser.user.value?.staffRoles ?? []),
);
// The manager's alone ([C] 2026-10-30); the server enforces it, this only hides the button.
const canSetParty = computed(() => currentUser.user.value?.staffRoles.includes('MANAGER') === true);
const partyOpen = ref(false);
const moreOpen = ref(false);

// The design's breakpoints: below 1280 the category and supplier columns fold into the product
// cell, below 1024 the lists move into the "Filtrlar" sheet, below 640 only the cards remain.
const wideDesktop = useMediaQuery('(min-width: 1280px)', true);
const desktop = useMediaQuery('(min-width: 1024px)', true);
const phone = useMediaQuery('(max-width: 639px)', false);

// --- filters, all of them in the address (reload, Back and a pasted link keep the view) ---------

// The link of Narxlar's "Ostatokdan qo'shish" (and older bookmarks) said `priced=unpriced`.
if (route.query.priced === 'unpriced' && route.query.preset === undefined) {
  const { priced: _legacy, ...rest } = route.query;
  void _legacy;
  void router.replace({ query: { ...rest, preset: 'unpriced' } });
}

const preset = ref<StockPreset>('all');
const search = ref('');
const category = ref(CATEGORY_ALL);
const brand = ref(BRAND_ALL);
const supplier = ref(SUPPLIER_ALL);
const sort = ref<StockSort>('latest');
type Layout = 'table' | 'cards';
const layout = ref<Layout>('table');
useUrlState('preset', preset, { fallback: 'all', isValid: isStockPreset });
useUrlState('q', search, { fallback: '', debounceMs: 300 });
useUrlState('category', category, { fallback: CATEGORY_ALL });
useUrlState('brand', brand, { fallback: BRAND_ALL });
useUrlState('supplier', supplier, { fallback: SUPPLIER_ALL });
useUrlState('sort', sort, { fallback: 'latest', isValid: isStockSort });
useUrlState('layout', layout, { fallback: 'table', isValid: (value) => value === 'cards' });

const stock = useStockOverview(stockApi);

// The selling price column: the published list, read once. Without a published list (404) or on
// a failure the column shows "—"; the stock itself does not depend on it.
// The version number is the base of a price set here (optimistic concurrency of the publish).
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

const nameOf = (item: StockOverviewItem): string => pickName(item.names);
const items = computed(() => stock.response.value?.items ?? []);
const nowMs = computed(() => stock.loadedAt.value);

// The design's search also finds a brand ("Nomi, Товар_ID yoki brend").
const searched = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (needle === '') return items.value;
  const byText = new Set(filterRows(items.value, search.value));
  return items.value.filter(
    (item) => byText.has(item) || (item.brand?.toLowerCase().includes(needle) ?? false),
  );
});
// The option counts of each list follow the search only; the rows follow every filter.
const supplierChoices = computed(() => supplierOptions(searched.value.map((i) => i.suppliers)));
const brandChoices = computed(() => brandOptions(searched.value.map((i) => i.brand)));
const bySupplier = computed(() =>
  searched.value.filter((i) => matchesSupplier(i.suppliers, supplier.value)),
);
const byBrand = computed(() => bySupplier.value.filter((i) => matchesBrand(i.brand, brand.value)));
const byPreset = computed(() =>
  byBrand.value.filter((i) => matchesPreset(i, preset.value, nowMs.value)),
);
const filtered = computed(() => filterByCategory(byPreset.value, category.value));
const sorted = computed(() => sortStock(filtered.value, sort.value, nameOf));

const counts = computed(() => countCategories(byPreset.value));
// Every category of the answer stays in the menu (empty ones dimmed at the bottom).
const knownCategories = computed(
  () => stock.response.value?.categories.map((entry) => entry.category) ?? [],
);
const knownUncategorized = computed(() => (stock.response.value?.uncategorizedCount ?? 0) > 0);

const presets = computed(() => {
  const pool = filterByCategory(byBrand.value, category.value);
  return STOCK_PRESETS.map((key) => ({
    key,
    count: pool.filter((item) => matchesPreset(item, key, nowMs.value)).length,
    // The two views that ask for work carry the accent count.
    warn: key === 'unpriced' || key === 'low',
    caption: t(`staffCost.stock.presets.${key}Cap`, {
      below: LOW_STOCK_BELOW,
      days: NEW_DELIVERY_DAYS,
    }),
  }));
});

const sortOptions = computed(() =>
  STOCK_SORTS.map((value) => ({ value, label: t(`staffCost.stock.sort.${value}`) })),
);
function setSort(value: string | null): void {
  if (value !== null && isStockSort(value)) sort.value = value;
}

// --- active filters as chips -------------------------------------------------------------------

const categoryLabel = (id: string): string =>
  id === CATEGORY_NONE
    ? t('staffCost.categories.none')
    : (knownCategories.value.find((name) => categoryTabId(name) === id) ?? id.slice(2));

interface Chip {
  readonly key: 'category' | 'brand' | 'supplier' | 'search';
  readonly label: string;
  readonly value: string;
}
const chips = computed<Chip[]>(() => {
  const list: Chip[] = [];
  if (category.value !== CATEGORY_ALL)
    list.push({
      key: 'category',
      label: t('staffCost.stock.chip.category'),
      value: categoryLabel(category.value),
    });
  if (brand.value !== BRAND_ALL)
    list.push({ key: 'brand', label: t('staffCost.stock.chip.brand'), value: brand.value });
  if (supplier.value !== SUPPLIER_ALL)
    list.push({
      key: 'supplier',
      label: t('staffCost.stock.chip.supplier'),
      value: supplier.value,
    });
  if (search.value.trim() !== '')
    list.push({
      key: 'search',
      label: t('staffCost.stock.chip.search'),
      value: search.value.trim(),
    });
  return list;
});

function removeChip(key: Chip['key']): void {
  if (key === 'category') category.value = CATEGORY_ALL;
  if (key === 'brand') brand.value = BRAND_ALL;
  if (key === 'supplier') supplier.value = SUPPLIER_ALL;
  if (key === 'search') search.value = '';
}

/** "Tozalash": the lists and the search; the ready view stays. */
function clearFilters(): void {
  search.value = '';
  category.value = CATEGORY_ALL;
  brand.value = BRAND_ALL;
  supplier.value = SUPPLIER_ALL;
}

/** The empty result's button: everything, the ready view too. */
function resetAll(): void {
  clearFilters();
  preset.value = 'all';
}

// --- the filter sheet below 1024px -------------------------------------------------------------

const sheetOpen = ref(false);
const sheetLists = computed<SheetList[]>(() => {
  const all = t('staffCost.categories.all');
  const categoryChoices = [
    { value: CATEGORY_ALL, label: all },
    ...counts.value.categories.map((c) => ({
      value: categoryTabId(c.category),
      label: c.category,
      count: c.count,
    })),
    ...(counts.value.uncategorized > 0
      ? [
          {
            value: CATEGORY_NONE,
            label: t('staffCost.categories.none'),
            count: counts.value.uncategorized,
          },
        ]
      : []),
  ];
  return [
    {
      key: 'category',
      label: t('staffCost.stock.chip.category'),
      selected: category.value,
      current: category.value === CATEGORY_ALL ? all : categoryLabel(category.value),
      choices: categoryChoices,
    },
    {
      key: 'brand',
      label: t('staffCost.stock.chip.brand'),
      selected: brand.value,
      current: brand.value === BRAND_ALL ? all : brand.value,
      choices: [{ value: BRAND_ALL, label: all }, ...brandChoices.value],
    },
    {
      key: 'supplier',
      label: t('staffCost.stock.chip.supplier'),
      selected: supplier.value,
      current: supplier.value === SUPPLIER_ALL ? all : supplier.value,
      choices: [{ value: SUPPLIER_ALL, label: all }, ...supplierChoices.value],
    },
  ];
});

function pickFromSheet(key: string, value: string): void {
  if (key === 'category') category.value = value;
  if (key === 'brand') brand.value = value;
  if (key === 'supplier') supplier.value = value;
}

// --- pages ---------------------------------------------------------------------------------------

const page = ref(0);
const pageSize = ref<PageSize>(DEFAULT_PAGE_SIZE);
// Any change of what is listed starts again at the first page.
watch([preset, search, category, brand, supplier, sort], () => {
  page.value = 0;
});
const slice = computed(() => pageSlice(sorted.value.length, page.value, pageSize.value));
const pageRows = computed(() => sorted.value.slice(slice.value.start, slice.value.end));

// A phone always gets the cards (the design: two columns, no table).
const shownLayout = computed<Layout>(() => (phone.value ? 'cards' : layout.value));

// --- figures -----------------------------------------------------------------------------------

const totals = computed(() => {
  const list = items.value;
  const sum = (values: readonly (string | null)[]): string =>
    addQuantities(values.filter((v): v is string => v !== null));
  return {
    total: formatQuantity(sum(list.map((i) => i.stockQuantity))),
    held: formatQuantity(sum(list.map((i) => i.heldQuantity))),
    available: formatQuantity(sum(list.map((i) => i.availableQuantity))),
  };
});

const priceRowOf = (item: StockOverviewItem): PriceRow | null =>
  priceRows.value.get(item.productId) ?? null;
/** The sale price in USD [owner 2026-10-29]; null = not priced (or an older so'm price). */
const sellingPrice = (item: StockOverviewItem): string | null => {
  const row = priceRowOf(item);
  const price = row ? amountsIn(row, 'USD').price : null;
  return price !== null && isMoney(price) ? price : null;
};
const formattedPrice = (item: StockOverviewItem): string | null => {
  const price = sellingPrice(item);
  return price === null ? null : formatUsd(price);
};
const isNew = (item: StockOverviewItem): boolean => isNewDelivery(item, nowMs.value);
// Only an active product is priced from here; the server still checks the role.
const canPrice = (item: StockOverviewItem): boolean => canDecide.value && item.isActive;
const errorText = computed(() =>
  translateDescribed(t, describePricingError('stock', stock.error.value)),
);

// --- the row menu ("⋯", right click, long press) -----------------------------------------------

type RowMenuId = 'panel' | 'price' | 'copy';
function rowMenuOf(item: StockOverviewItem): RowMenuItem<RowMenuId>[] {
  const menu: RowMenuItem<RowMenuId>[] = [
    { id: 'panel', label: t('staffCost.stock.rowMenu.history'), icon: 'history' },
  ];
  if (canPrice(item))
    menu.push({
      id: 'price',
      label: item.isPriced
        ? t('staffCost.stock.rowMenu.changePrice')
        : t('staffCost.stock.setPrice'),
      icon: 'tags',
    });
  menu.push({ id: 'copy', label: t('staffCost.stock.rowMenu.copyCode'), icon: 'copy' });
  return menu;
}
function onRowMenu(item: StockOverviewItem, id: string): void {
  if (id === 'panel') openPanel(item);
  else if (id === 'price') setPrice(item);
  else if (id === 'copy') void copyCode(item.productCode);
}

// The clipboard may be unavailable (insecure context, denied permission): the toast then shows
// the code, so it can still be read off.
async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    showToast({ message: t('prices.rowMenu.copied', { code }) });
  } catch {
    showToast({ message: t('prices.rowMenu.copyFailed', { code }) });
  }
}

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
  const item = items.value.find((i) => i.productId === result.productId);
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
  () => items.value.find((item) => item.productId === panelId.value) ?? null,
);

function openPanel(item: StockOverviewItem): void {
  panelId.value = item.productId;
  panelOpen.value = true;
}
</script>

<template>
  <section class="stock">
    <PricesSubHeader class="stock-head" :title="t('staffCost.stock.title')">
      <!-- The design's line under the title: where the stock comes from, when it was read, the
           totals. The sync button goes up to the page actions. -->
      <div class="subline">
        <SheetSyncPanel
          :can-run="canSync"
          actions-to="#stock-sync-action"
          @synced="stock.reload({ silent: true })"
        />
        <!-- Hard rule 10: the stock is read from the sheet and reserves nothing. -->
        <p class="note" role="note" :title="t('staffCost.stock.indicative')">
          <span class="sr-only">{{ t('staffCost.stock.indicative') }}</span>
          <span v-if="items.length > 0" class="note__totals num" data-testid="stock-totals">{{
            t('staffCost.stock.totals', totals)
          }}</span>
        </p>
      </div>
      <template #actions>
        <!-- A phone: the design's one "⋯" button; the same buttons open under it as a menu. -->
        <button
          v-if="phone"
          type="button"
          class="head-more"
          :aria-label="t('staffCost.stock.moreActions')"
          aria-haspopup="true"
          :aria-expanded="moreOpen"
          data-testid="head-more"
          @click="moreOpen = !moreOpen"
        >
          <StaffIcon name="more" :size="20" />
        </button>
        <button
          v-if="phone && moreOpen"
          type="button"
          class="head-away"
          tabindex="-1"
          :aria-label="t('common.close')"
          @click="moreOpen = false"
        />
        <span
          class="head-actions"
          :class="{ 'head-actions--menu': phone, 'head-actions--open': phone && moreOpen }"
          @click="moreOpen = false"
        >
          <span id="stock-sync-action" class="head-actions__sync" />
          <MegaReportButton />
          <AppButton
            v-if="canSetParty"
            variant="secondary"
            class="head-actions__party"
            :aria-label="t('staffCost.party.button')"
            :title="t('staffCost.party.button')"
            data-testid="party-open"
            @click="partyOpen = true"
          >
            <StaffIcon name="plus" :size="16" /><span class="head-actions__label">{{
              t('staffCost.party.button')
            }}</span>
          </AppButton>
        </span>
      </template>
    </PricesSubHeader>
    <SupplyPartyDialog v-if="canSetParty" v-model="partyOpen" />

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
        <!-- Ready views: one daily task each, with its count. -->
        <section class="block" aria-labelledby="stock-presets-label">
          <h2 id="stock-presets-label" class="block__label">
            {{ t('staffCost.stock.presets.label') }}
          </h2>
          <div class="views" role="group" aria-labelledby="stock-presets-label">
            <button
              v-for="view in presets"
              :key="view.key"
              type="button"
              class="view"
              :class="{ 'view--on': preset === view.key, 'view--warn': view.warn }"
              :aria-pressed="preset === view.key"
              :data-preset="view.key"
              @click="preset = view.key"
            >
              <span class="view__top">
                <span class="view__name">{{ t(`staffCost.stock.presets.${view.key}`) }}</span>
                <span class="view__count num">{{ view.count }}</span>
              </span>
              <span class="view__cap">{{ view.caption }}</span>
            </button>
          </div>
        </section>

        <section class="block block--filters" aria-labelledby="stock-filters-label">
          <h2 id="stock-filters-label" class="block__label">
            {{ t('staffCost.stock.filtersLabel') }}
          </h2>
          <div class="frow">
            <SearchField
              v-model="search"
              class="frow__search"
              :placeholder="t('staffCost.stock.searchPlaceholder')"
              label-hidden
            />
            <template v-if="desktop">
              <CategoryDropdown
                v-model="category"
                :prefix="t('staffCost.stock.chip.category')"
                :counts="counts"
                :also-known="knownCategories"
                :also-uncategorized="knownUncategorized"
              />
              <FilterMenu
                v-model="brand"
                :options="brandChoices"
                :all-value="BRAND_ALL"
                :all-label="t('staffCost.categories.all')"
                :label="t('staffCost.stock.chip.brand')"
                :search-placeholder="t('staffCost.brandFilter.search')"
                :no-match-text="t('staffCost.brandFilter.noMatch')"
                :clear-label="t('staffCost.brandFilter.clear')"
                :unknown-label="t('staffCost.brandFilter.unknown')"
                :count-text="
                  (count: number) => t('staffCost.supplierFilter.productsCount', { count }, count)
                "
                data-testid="brand-filter"
              />
              <FilterMenu
                v-model="supplier"
                :options="supplierChoices"
                :all-value="SUPPLIER_ALL"
                :all-label="t('staffCost.categories.all')"
                :label="t('staffCost.stock.chip.supplier')"
                :search-placeholder="t('staffCost.supplierFilter.search')"
                :no-match-text="t('staffCost.supplierFilter.noMatch')"
                :clear-label="t('staffCost.supplierFilter.clear')"
                :unknown-label="t('staffCost.supplierFilter.unknown')"
                :count-text="
                  (count: number) => t('staffCost.supplierFilter.productsCount', { count }, count)
                "
                data-testid="supplier-filter"
              />
            </template>
            <button
              v-else
              type="button"
              class="frow__sheet"
              :aria-label="t('staffCost.stock.filtersButton', { count: chips.length })"
              aria-haspopup="dialog"
              data-testid="filter-sheet-open"
              @click="sheetOpen = true"
            >
              <StaffIcon name="filter" :size="20" />
              <span v-if="chips.length > 0" class="frow__badge num" aria-hidden="true">{{
                chips.length
              }}</span>
            </button>
          </div>
          <div
            v-if="chips.length > 0"
            class="chips"
            role="group"
            :aria-label="t('staffCost.stock.activeFilters')"
          >
            <span class="chips__count">{{
              t('staffCost.stock.activeCount', { count: chips.length }, chips.length)
            }}</span>
            <span v-for="chip in chips" :key="chip.key" class="chip" :data-chip="chip.key">
              <span
                >{{ chip.label }}: <b>{{ chip.value }}</b></span
              >
              <button
                type="button"
                class="chip__x"
                :aria-label="t('staffCost.stock.chip.remove', { label: chip.label })"
                @click="removeChip(chip.key)"
              >
                <StaffIcon name="x" :size="12" />
              </button>
            </span>
            <button type="button" class="chips__clear" @click="clearFilters">
              {{ t('staffCost.stock.clearFilters') }}
            </button>
          </div>
        </section>

        <div class="rbar">
          <span class="rbar__count" role="status" data-testid="stock-count">
            {{ t('staffCost.stock.info', { count: sorted.length }, sorted.length) }}
          </span>
          <span class="rbar__tools">
            <AppDropdown
              v-if="!phone"
              :model-value="sort"
              :options="sortOptions"
              :label="t('staffCost.stock.sort.label')"
              align="right"
              data-testid="stock-sort"
              @update:model-value="setSort"
            >
              <template #value="{ selected }">
                <span class="sortv"
                  ><span class="sortv__k">{{ t('staffCost.stock.sort.label') }}:</span>
                  <b>{{ selected?.label }}</b></span
                >
              </template>
            </AppDropdown>
            <span
              v-if="!phone"
              class="toggle"
              role="group"
              :aria-label="t('staffCost.stock.layout.label')"
            >
              <button
                type="button"
                :class="{ 'toggle--on': layout === 'table' }"
                :aria-pressed="layout === 'table'"
                data-layout="table"
                @click="layout = 'table'"
              >
                <StaffIcon name="sheet" :size="14" />{{ t('staffCost.stock.layout.table') }}
              </button>
              <button
                type="button"
                :class="{ 'toggle--on': layout === 'cards' }"
                :aria-pressed="layout === 'cards'"
                data-layout="cards"
                @click="layout = 'cards'"
              >
                <StaffIcon name="package" :size="14" />{{ t('staffCost.stock.layout.cards') }}
              </button>
            </span>
          </span>
        </div>

        <div v-if="sorted.length === 0" class="nomatch" role="status">
          <StaffIcon name="package" :size="32" class="nomatch__icon" />
          <b>{{ t('staffCost.stock.noMatch') }}</b>
          <AppButton variant="secondary" size="xs" @click="resetAll">
            {{ t('staffCost.stock.resetFilters') }}
          </AppButton>
        </div>

        <div
          v-else-if="shownLayout === 'table'"
          class="surface"
          :class="{ 'surface--refreshing': stock.refreshing.value }"
        >
          <StockTable
            :rows="pageRows"
            :wide="wideDesktop"
            :desktop="desktop"
            :name-of="nameOf"
            :price-of="formattedPrice"
            :is-new="isNew"
            :can-price="canPrice"
            :menu-of="rowMenuOf"
            :label="t('staffCost.stock.tableLabel')"
            @open="openPanel"
            @price="setPrice"
            @menu="onRowMenu"
          />
        </div>

        <ul v-else class="grid" :aria-label="t('staffCost.stock.tableLabel')">
          <li v-for="row in pageRows" :key="row.productId" class="grid__item">
            <StockCard
              :item="row"
              :name="nameOf(row)"
              :price="formattedPrice(row)"
              @open="openPanel(row)"
            />
          </li>
        </ul>

        <StockPager
          v-if="sorted.length > 0"
          v-model:page="page"
          v-model:size="pageSize"
          :total="sorted.length"
        />
      </div>
    </StateView>

    <RemovalRequests :can-decide="canDecide" @decided="stock.reload({ silent: true })" />

    <StockFilterSheet
      v-if="!desktop"
      v-model="sheetOpen"
      :lists="sheetLists"
      :sorts="sortOptions"
      :sort="sort"
      :count="sorted.length"
      @pick="pickFromSheet"
      @sort="setSort"
      @clear="clearFilters"
    />

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
        {{
          panelItem.isPriced
            ? t('staffCost.stock.rowMenu.changePrice')
            : t('staffCost.stock.setPrice')
        }}
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
  gap: 16px;
  min-width: 0;
}

/* The v8 page subtitle slot: 12px secondary text under the title, the totals after it. */
.note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.note__totals {
  white-space: nowrap;
}

.note__totals::before {
  content: '· ';
}

/* The design keeps the buttons on the title's right: the text side shrinks instead of pushing
   them to a line of their own. */
.stock-head {
  flex-wrap: nowrap;
  align-items: flex-start;
}

.stock-head :deep(.head__text) {
  flex: 1 1 0;
  min-width: 0;
}

.stock-head :deep(.head__actions) {
  position: relative;
  flex: none;
  width: auto;
}

/* The design's title: 24px bold (20px on a phone). */
.stock-head :deep(.head__title) {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

/* Under the title, one line: the sync dot and time, then the totals. */
.subline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}

.subline :deep(.sync) {
  flex: 0 1 auto;
  min-width: 0;
}

/* The phone's "⋯" and the menu its buttons open in. */
.head-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--e8);
  border-radius: var(--r-btn-sm);
  background: var(--w);
  color: var(--ink);
  cursor: pointer;
}

.head-more:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.head-away {
  position: fixed;
  inset: 0;
  z-index: 21;
  border: 0;
  background: transparent;
}

.head-actions--menu {
  position: absolute;
  top: 50px;
  right: 0;
  z-index: 22;
  display: none;
  flex-direction: column;
  align-items: stretch;
  min-width: 220px;
  padding: 6px;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: var(--sh-dropdown);
}

.head-actions--open {
  display: flex;
}

/* The design's header buttons: 44px, white with a hairline; icon-only below 1024px. */
.head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.head-actions__sync {
  display: contents;
}

.head-actions :deep(.chip),
.head-actions :deep(.sync__run),
.head-actions__party {
  min-height: 44px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.block__label {
  margin: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t2);
}

/* --- ready views: cards with a count and the task they stand for ----------------------------- */

.views {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 2px;
}

.view {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 150px;
  min-height: 64px;
  padding: 10px 14px;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.view:hover {
  border-color: var(--d9);
}

.view:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.view__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  font-size: var(--fs-body);
  font-weight: 600;
}

.view__count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--ef);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--t2);
}

.view--warn .view__count {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.view__cap {
  font-size: var(--fs-small);
  color: var(--t2);
}

.view--on {
  border-color: var(--acc);
  background: var(--acc-bg3);
  box-shadow: 0 0 0 1px var(--acc);
}

.view--on .view__count {
  background: var(--acc);
  color: var(--acc-on);
}

/* --- search and lists ------------------------------------------------------------------------ */

.frow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.frow__search {
  flex: 1 1 300px;
  min-width: 0;
}

/* The design's list buttons: "Brend  Xiaomi", 44px, the value bold. */
.frow :deep(.catdd__field) {
  height: 44px;
}

.frow :deep(.catdd__value) {
  font-weight: 600;
}

.frow :deep(.catdd) {
  flex: 0 1 230px;
  min-width: 190px;
}

.frow :deep(.search__box) {
  height: 44px;
}

.frow__sheet {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--e8);
  border-radius: var(--r-btn-sm);
  background: var(--w);
  color: var(--ink);
  cursor: pointer;
}

.frow__sheet:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.frow__badge {
  position: absolute;
  top: -4px;
  right: -4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.chips__count {
  margin-right: 2px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 6px 0 12px;
  border: 1px solid var(--e8);
  border-radius: 999px;
  background: var(--w);
  font-size: var(--fs-small);
  font-weight: 500;
}

.chip b {
  font-weight: 600;
}

.chip__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 50%;
  background: var(--ef);
  color: var(--t2);
  cursor: pointer;
}

.chips__clear {
  height: 32px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  cursor: pointer;
}

.chip__x:focus-visible,
.chips__clear:focus-visible,
.toggle button:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* --- result bar: count, sort, table / cards -------------------------------------------------- */

.rbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.rbar__count {
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.rbar__tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sortv {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sortv__k {
  color: var(--t2);
}

.toggle {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--r-btn-sm);
  background: var(--ef);
}

.toggle button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: calc(var(--r-btn-sm) - 2px);
  background: transparent;
  color: var(--t2);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  cursor: pointer;
}

.toggle .toggle--on {
  background: var(--w);
  color: var(--ink);
  box-shadow: var(--sh-dropdown);
}

/* --- results --------------------------------------------------------------------------------- */

.nomatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 56px 16px;
  border: 1px solid var(--e8);
  border-radius: var(--r-panel);
  background: var(--w);
  text-align: center;
}

.nomatch__icon {
  color: var(--t3);
}

/* The table scrolls with the page (one scroll, no box of its own). */
.surface {
  min-width: 0;
}

.surface--refreshing {
  cursor: progress;
  pointer-events: none;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.grid__item {
  display: flex;
  min-width: 0;
}

.panel-price {
  align-self: stretch;
}

.panel-photo {
  align-self: flex-start;
}

/* Tablet: the views become pills (the chosen one dark) and the cards three columns. */
@media (max-width: 1023px) {
  .list {
    gap: 14px;
  }

  .block__label,
  .view__cap,
  .note__totals {
    display: none;
  }

  .frow {
    flex-wrap: nowrap;
  }

  .frow__search {
    flex: 1 1 0;
  }

  .view {
    flex: none;
    flex-direction: row;
    align-items: center;
    min-width: 0;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 999px;
  }

  .view__top {
    gap: 6px;
    width: auto;
    font-size: var(--fs-small);
    font-weight: 500;
    white-space: nowrap;
  }

  .view__count,
  .view--warn .view__count {
    padding: 0;
    background: transparent;
    color: var(--t2);
  }

  .view--on {
    border-color: var(--btn-ink-bg);
    background: var(--btn-ink-bg);
    color: var(--btn-ink-fg);
    box-shadow: none;
  }

  .view--on .view__count {
    background: transparent;
    color: inherit;
  }

  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  /* The design's icon-only header buttons; the text stays for screen readers. */
  .head-actions :deep(.chip > span:last-of-type),
  .head-actions__label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .head-actions :deep(.chip),
  .head-actions :deep(.sync__run),
  .head-actions__party {
    min-width: 44px;
    padding-right: 0;
    padding-left: 0;
    justify-content: center;
  }
}

/* Phone: the views in two rows that fit, the chips scroll sideways, two card columns. */
@media (max-width: 639px) {
  .stock-head :deep(.head__title) {
    font-size: 20px;
  }

  /* In the "⋯" menu every action has its name again. */
  .head-actions--menu .head-actions__label,
  .head-actions--menu :deep(.chip > span:last-of-type),
  .head-actions--menu :deep(.sync__runlabel) {
    position: static;
    width: auto;
    height: auto;
    overflow: visible;
    clip-path: none;
  }

  /* .stock: above the staff app's ring on secondary buttons. */
  .stock .head-actions--menu :deep(.chip),
  .stock .head-actions--menu :deep(.sync__run),
  .stock .head-actions--menu .head-actions__party {
    justify-content: flex-start;
    width: 100%;
    padding: 0 12px;
    box-shadow: none;
    border: 0;
  }

  .list {
    gap: 10px;
  }

  .views {
    display: grid;
    grid-template-columns: repeat(20, minmax(0, 1fr));
    overflow: visible;
    padding: 0;
  }

  .view {
    min-height: 44px;
    padding: 0 8px 0 10px;
    overflow: hidden;
    border-radius: var(--r-card);
  }

  .view:nth-child(-n + 2) {
    grid-column: span 10;
  }

  .view:nth-child(3),
  .view:nth-child(5) {
    grid-column: span 7;
  }

  .view:nth-child(4) {
    grid-column: span 6;
  }

  .view__top {
    justify-content: space-between;
    width: 100%;
    min-width: 0;
  }

  .view__name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .frow__sheet {
    width: 48px;
    height: 48px;
  }

  /* The design's phone order: the search and the filter button first, then the ready views. */
  .block--filters {
    order: -1;
  }

  .chips {
    flex-wrap: nowrap;
    margin: 0 -16px;
    padding: 0 16px;
    overflow-x: auto;
  }

  .chip,
  .chips__clear {
    flex: none;
  }

  .chips__count {
    display: none;
  }

  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
}

@media (pointer: coarse) {
  .setprice,
  .view,
  .chip__x {
    min-height: 44px;
  }

  .chip__x {
    min-width: 44px;
  }
}
</style>
