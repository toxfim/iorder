<script setup lang="ts">
import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type { PriceListCurrency } from '@iorder/shared';
import type { StaffPriceListWithRateResponse } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppTabs from '@core/components/ui/AppTabs.vue';
import AppSegmented from '@/components/ui/AppSegmented.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import FilterCombobox from '@/components/ui/FilterCombobox.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import TableDensitySwitch from '@/components/ui/TableDensitySwitch.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import type { ViewState } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { useFormat } from '@core/i18n/use-format';
import { ApiConflictError, ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { decimalSeparatorFor } from '@core/lib/format';
import { compareMoney } from '@core/lib/money';
import { describePricingError } from '@core/lib/price-errors';
import CategoryDropdown from '@/features/staff-cost/components/CategoryDropdown.vue';
import CostCell from '@/features/staff-cost/components/CostCell.vue';
import StockCell from '@/features/staff-cost/components/StockCell.vue';
import SupplyHistory from '@/features/staff-cost/components/SupplyHistory.vue';
import UsdRateControl from '@/features/staff-cost/components/UsdRateControl.vue';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import { useCostColumns } from '@/features/staff-cost/composables/use-cost-columns';
import { useProductCategories } from '@/features/staff-cost/composables/use-product-categories';
import { useUrlState } from '@/features/staff-cost/composables/use-url-state';
import {
  CATEGORY_ALL,
  countCategories,
  filterByCategory,
} from '@/features/staff-cost/domain/category-filter';
import { formatTenthsPercent, priceHint } from '@/features/staff-cost/domain/price-hint';
import {
  matchesSupplier,
  SUPPLIER_ALL,
  supplierOptions,
} from '@/features/staff-cost/domain/supplier-filter';
import {
  canEditPrices,
  canManagePhotos,
  canViewCost,
  canViewPriceAdmin,
} from '@/features/staff-shell/price-access';
import ProductPhotoDialog from '@/features/product-images/components/ProductPhotoDialog.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';
import type { RowMenuItem } from '@/components/ui/RowContextMenu.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import { pickName } from '../domain/localized-name';
import { savedMessage } from '../domain/saved-message';
import { alifUsd, amountsIn, toPriceRows, wholesaleUsd, type PriceRow } from '../domain/price-rows';
import { priceTargetOf } from '../domain/price-target';
import { filterRows } from '../domain/row-filter';
import { translateDescribed } from '../domain/translate-error';
import ManualProductDialog, { type ManualProductCreated } from './ManualProductDialog.vue';
import MergeProductDialog, {
  type MergeSource,
  type MergeTargetHint,
  type ProductMerged,
} from './MergeProductDialog.vue';
import NewProductMenu from './NewProductMenu.vue';
import PriceEditDialog, { type PriceSaved, type PriceTarget } from './PriceEditDialog.vue';
import PriceHistoryBody from './PriceHistoryBody.vue';
import PriceImportDialog, { type PriceImported } from './PriceImportDialog.vue';
import PriceListShareActions from './PriceListShareActions.vue';
import PricesSubHeader from './PricesSubHeader.vue';

// Design v8 "Narxlar": the published list with stock, cost and markup, and a per-product price
// history. There are no drafts and no edit mode [C, 2026-10-28]: a row opens "Narxni
// o'zgartirish" and its save publishes a new version at once. Products that have no price yet are
// priced from Ostatok ("Ostatokdan qo'shish" opens it filtered to them).
const { t, locale: i18nLocale } = useI18n();
const {
  pricingApi,
  catalogApi,
  costApi,
  stockApi,
  priceVersionStore,
  unpricedCountStore,
  currentUser,
} = useServices();
const route = useRoute();
const router = useRouter();
const { formatMoney, formatMoneyWithCurrency } = useFormat();
const { formatUsd } = useCostFormat();

// UI convenience only: the server refuses every call a role may not make.
const roles = computed(() => currentUser.user.value?.staffRoles ?? []);
const costVisible = canViewCost(roles.value);
const canEdit = canEditPrices(roles.value);
const seesPriceAdmin = canViewPriceAdmin(roles.value);
const photosAllowed = canManagePhotos(roles.value);

// --- the published list ------------------------------------------------------------------------

const state = ref<ViewState>('loading');
const loadError = shallowRef<unknown>(null);
const published = shallowRef<StaffPriceListWithRateResponse | null>(null);
let loadRun = 0;

async function load(options: { silent?: boolean } = {}): Promise<void> {
  const mine = ++loadRun;
  if (!options.silent || published.value === null) state.value = 'loading';
  loadError.value = null;
  try {
    const list = await pricingApi.getCurrent();
    if (mine !== loadRun) return;
    published.value = list;
    state.value = 'ready';
  } catch (caught) {
    if (mine !== loadRun) return;
    // Nothing published yet is a normal state: the first price set in Ostatok publishes v1.
    if (caught instanceof ApiNotFoundError) {
      published.value = null;
      state.value = 'empty';
      return;
    }
    loadError.value = caught;
    state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
  }
}
void load();

// Stock and cost per product, the sheet category and the "not priced in the stock" count exist
// for the roles that may view cost; for everyone else none of these requests is made.
const costs = useCostColumns(costApi, () => costVisible);
const productCategories = useProductCategories(stockApi, () => costVisible);
// The count of the stock list that "Ostatokdan qo'shish" opens, so the number matches it.
const unpricedCount = computed(() => productCategories.unpricedInStock.value);

const rows = computed(() => toPriceRows(published.value));
const versionNumber = computed(() => published.value?.version.number ?? null);

// Staff-added products (generated codes) [C, 2026-11-09]: counted in the subtitle, their own tab.
const generatedRows = computed(() => rows.value.filter((row) => row.codeGenerated));
const generatedCount = computed(() => generatedRows.value.length);
// Without a wholesale sale price that tier's customers see the standard prices [P].
const noWholesaleRows = computed(() => rows.value.filter((row) => row.wholesalePrice === null));

const subtitle = computed(() => {
  if (!published.value) return t('prices.subtitle');
  const base = t('prices.listSummary', {
    number: published.value.version.number,
    count: published.value.items.length,
  });
  return generatedCount.value > 0
    ? `${base} · ${t('staffCost.manual.subtitleCount', { count: generatedCount.value })}`
    : base;
});

// The list items carry no category; the catalog does. Read once per list for the generated rows
// (sheet products get theirs from the stock overview below), only by the roles that may read it.
const generatedCategories = shallowRef<ReadonlyMap<string, string | null>>(new Map());
let categoriesRun = 0;
async function loadGeneratedCategories(): Promise<void> {
  const mine = ++categoriesRun;
  if (!seesPriceAdmin || generatedCount.value === 0) return;
  try {
    const { items } = await catalogApi.listProducts();
    if (mine !== categoriesRun) return;
    generatedCategories.value = new Map(
      items.filter((p) => p.codeGenerated).map((p) => [p.id, p.category]),
    );
  } catch {
    // A missing category only shortens the second line of the row.
    if (mine === categoriesRun) generatedCategories.value = new Map();
  }
}
watch(generatedCount, () => void loadGeneratedCategories(), { immediate: true });

// --- tabs, search, category --------------------------------------------------------------------

// `nowholesale`: the products without a «Оптовик/Партнер» price [C, owner 2026-11-11].
type Tab = 'list' | 'manual' | 'nowholesale' | 'history';
const tab = ref<Tab>('list');
const search = ref('');
const category = ref(CATEGORY_ALL);
const supplier = ref(SUPPLIER_ALL);
// Tab, category and search live in the address (reload and Back keep them).
useUrlState('tab', tab, {
  fallback: 'list',
  isValid: (value) => value === 'history' || value === 'manual' || value === 'nowholesale',
});
useUrlState('category', category, { fallback: CATEGORY_ALL });
useUrlState('q', search, { fallback: '', debounceMs: 300 });
useUrlState('supplier', supplier, { fallback: SUPPLIER_ALL });
const panelId = 'prices-panel';

// Prices are kept in USD [owner 2026-10-29]; the so'm view shows them at the current rate.
const shown = ref<PriceListCurrency>('USD');
useUrlState('currency', shown as Ref<string>, {
  fallback: 'USD',
  isValid: (value) => value === 'UZS',
});
const currencyOptions = computed(() => [
  { value: 'USD' as const, label: t('prices.currency.USD') },
  { value: 'UZS' as const, label: t('prices.currency.UZS') },
]);
const sign = computed(() => t(`prices.currency.${shown.value}`));
const amountsOf = (row: PriceRow) => amountsIn(row, shown.value);
const money = (amount: string): string =>
  shown.value === 'USD' ? formatUsd(amount) : formatMoney(amount);
const moneyWithCurrency = (amount: string): string =>
  shown.value === 'USD' ? formatUsd(amount) : formatMoneyWithCurrency(amount);

const tabs = computed(() => [
  { id: 'list', label: t('prices.tabs.all'), count: rows.value.length },
  // The tab exists only while there is such a product (the address falls back to the list).
  ...(generatedCount.value > 0
    ? [{ id: 'manual', label: t('staffCost.manual.tab'), count: generatedCount.value }]
    : []),
  { id: 'nowholesale', label: t('prices.tabs.noWholesale'), count: noWholesaleRows.value.length },
  { id: 'history', label: t('prices.historyLink') },
]);
function selectTab(id: string): void {
  tab.value = id === 'history' || id === 'manual' || id === 'nowholesale' ? id : 'list';
}

const categoryOf = (row: PriceRow): string | null =>
  row.codeGenerated
    ? (generatedCategories.value.get(row.productId) ?? null)
    : (productCategories.byProduct.value.get(row.productId) ?? null);
const tabRows = computed(() =>
  tab.value === 'manual'
    ? generatedRows.value
    : tab.value === 'nowholesale'
      ? noWholesaleRows.value
      : rows.value,
);
// A staff-added product has no delivery line, so it is under no supplier.
const suppliersOf = (row: PriceRow): readonly string[] =>
  row.codeGenerated ? [] : (costs.rows.value.get(row.productId)?.suppliers ?? []);
const searchedRows = computed(() => filterRows(tabRows.value, search.value));
// The supplier counts follow the search; the category counts follow the supplier too.
const supplierChoices = computed(() => supplierOptions(searchedRows.value.map(suppliersOf)));
const categorized = computed(() =>
  searchedRows.value
    .filter((row) => matchesSupplier(suppliersOf(row), supplier.value))
    .map((row) => ({
      ...row,
      category: categoryOf(row),
    })),
);
const visible = computed(() => filterByCategory(categorized.value, category.value));
const pricesIn = computed(() => t(`prices.pricesIn.${shown.value}`));
const footer = computed(() =>
  tab.value === 'manual'
    ? t('staffCost.manual.info', { count: visible.value.length, currency: pricesIn.value })
    : t(
        'prices.info',
        { count: visible.value.length, currency: pricesIn.value },
        visible.value.length,
      ),
);
const counts = computed(() => countCategories(categorized.value));
const filtered = computed(
  () =>
    search.value.trim() !== '' ||
    category.value !== CATEGORY_ALL ||
    supplier.value !== SUPPLIER_ALL,
);

function resetFilters(): void {
  search.value = '';
  category.value = CATEGORY_ALL;
  supplier.value = SUPPLIER_ALL;
}

type VisibleRow = PriceRow & { readonly category: string | null };

const nameOf = (row: PriceRow): string => pickName(row.names);
// A staff-added product has no deliveries: no stock, no cost, no markup (a dash in each column).
const costOf = (row: PriceRow) =>
  row.codeGenerated ? null : (costs.rows.value.get(row.productId) ?? null);
const markupOf = (row: PriceRow) => {
  const usd = amountsIn(row, 'USD').price;
  return usd === null ? null : priceHint(usd, costOf(row)?.usd ?? null);
};
const markupText = (row: PriceRow): string | null => {
  const hint = markupOf(row);
  return hint
    ? formatTenthsPercent(hint.markupTenths, decimalSeparatorFor(i18nLocale.value))
    : null;
};
// The «Оптовик/Партнер» prices stay in USD in both currency views: the api sends no so'm figure
// for them, and the page never converts money itself.
const wholesaleOf = (row: PriceRow) => wholesaleUsd(row);
const wholesaleMarkupText = (row: PriceRow): string | null => {
  const usd = wholesaleOf(row).price;
  const hint = usd === null ? null : priceHint(usd, costOf(row)?.usd ?? null);
  return hint
    ? formatTenthsPercent(hint.markupTenths, decimalSeparatorFor(i18nLocale.value))
    : null;
};

// The «Alif factoring» prices, also in USD [C, owner 2026-11-12]. Without one the product is not
// offered to that tier at all (no fallback), so the cell says so instead of "from standard".
const alifOf = (row: PriceRow) => alifUsd(row);

// The name column also holds the 40px photo and its 12px gap.
const NAME_MIN_PX = 220;
const columns = computed<DataTableColumn<VisibleRow>[]>(
  () =>
    [
      {
        key: 'product',
        label: t('prices.columns.product'),
        minWidth: `${NAME_MIN_PX}px`,
        text: nameOf,
        compare: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      },
      ...(costVisible
        ? [
            { key: 'stock', label: t('staffCost.stock.column'), align: 'end', width: '96px' },
            { key: 'cost', label: t('staffCost.cost.column'), align: 'end', width: '140px' },
          ]
        : []),
      {
        key: 'price',
        label: `${t('prices.columns.price')} ${sign.value}`,
        group: t('prices.columns.groupStandard'),
        align: 'end',
        width: '88px',
        compare: (a, b) => compareMoney(amountsOf(a).price ?? '0', amountsOf(b).price ?? '0'),
      },
      {
        key: 'deferred',
        label: `${t('prices.columns.deferredPrice')} ${sign.value}`,
        group: t('prices.columns.groupStandard'),
        align: 'end',
        width: '88px',
        compare: (a, b) =>
          compareMoney(amountsOf(a).deferredPrice ?? '0', amountsOf(b).deferredPrice ?? '0'),
      },
      {
        key: 'wholesale',
        label: `${t('prices.columns.price')} ${t('prices.currency.USD')}`,
        group: t('prices.columns.groupWholesale'),
        align: 'end',
        width: '88px',
        compare: (a, b) => compareMoney(wholesaleOf(a).price ?? '0', wholesaleOf(b).price ?? '0'),
        hasSortValue: (row) => wholesaleOf(row).price !== null,
      },
      {
        key: 'wholesaleDeferred',
        label: `${t('prices.columns.deferredPrice')} ${t('prices.currency.USD')}`,
        group: t('prices.columns.groupWholesale'),
        align: 'end',
        width: '88px',
      },
      {
        key: 'alif',
        label: `${t('prices.columns.price')} ${t('prices.currency.USD')}`,
        group: t('prices.columns.groupAlif'),
        align: 'end',
        width: '88px',
        compare: (a, b) => compareMoney(alifOf(a).price ?? '0', alifOf(b).price ?? '0'),
        hasSortValue: (row) => alifOf(row).price !== null,
      },
      {
        key: 'alifDeferred',
        label: `${t('prices.columns.deferredPrice')} ${t('prices.currency.USD')}`,
        group: t('prices.columns.groupAlif'),
        align: 'end',
        width: '88px',
      },
      ...(costVisible
        ? [{ key: 'markup', label: t('prices.columns.markup'), align: 'end', width: '104px' }]
        : []),
    ] as DataTableColumn<VisibleRow>[],
);
const tableMinWidth = computed(
  () =>
    `${columns.value.reduce((sum, c) => sum + (c.width ? Number.parseInt(c.width, 10) : 0), NAME_MIN_PX)}px`,
);

const loadErrorText = computed(() =>
  translateDescribed(t, describePricingError('load', loadError.value)),
);

// --- "Ostatokdan qo'shish": Ostatok, filtered to the products without a price -------------------

function goToStock(): void {
  void router.push({ name: 'staff-stock', query: { priced: 'unpriced' } });
}

// --- one product: the price dialog -----------------------------------------------------------

const dialogOpen = ref(false);
const target = shallowRef<PriceTarget | null>(null);

function targetOf(row: PriceRow): PriceTarget {
  return priceTargetOf(row, row, costOf(row)?.usd ?? null);
}

function openRow(row: PriceRow): void {
  if (canEdit) {
    target.value = targetOf(row);
    dialogOpen.value = true;
    return;
  }
  showHistory(row.productId);
}

/** A new version was published from this page: every figure that follows the list is re-read. */
function afterPublish(): void {
  void load({ silent: true });
  // The sidebar card and the home page show the published version too.
  void priceVersionStore.refresh();
  void costs.reload();
  void productCategories.reload();
  void unpricedCountStore.refresh();
}

function onSaved(result: PriceSaved): void {
  const row = rows.value.find((r) => r.productId === result.productId);
  showToast({ message: savedMessage(t, result, row ? nameOf(row) : null) });
  afterPublish();
}

// --- staff-added products [C, 2026-11-09]: add one, import a file, merge into a sheet product ---

const manualOpen = ref(false);
const importOpen = ref(false);
const mergeOpen = ref(false);
const mergeSource = shallowRef<MergeSource | null>(null);
const mergeTarget = shallowRef<MergeTargetHint | null>(null);
// The sheet categories offered in the add form (free text stays allowed).
const knownCategories = computed(() =>
  [...new Set([...productCategories.byProduct.value.values()])]
    .filter((value): value is string => value !== null)
    .sort((a, b) => a.localeCompare(b)),
);

function onManualCreated(result: ManualProductCreated): void {
  const base = t('staffCost.manual.created', {
    name: result.name,
    code: result.productCode,
    number: result.versionNumber,
  });
  const skipped = result.skippedInactiveCount;
  showToast({
    message: skipped > 0 ? `${base}, ${t('prices.skipped', { count: skipped }, skipped)}` : base,
  });
  afterPublish();
}

function onImported(result: PriceImported): void {
  showToast({
    message: t('staffCost.priceImport.done.title', { number: result.versionNumber }),
  });
  afterPublish();
}

/** Opens the merge for a generated-code row; the "Sheetda bor" badge pre-fills its sheet match. */
function startMerge(productId: string, target: MergeTargetHint | null = null): void {
  const row = rows.value.find((r) => r.productId === productId);
  if (!row) return;
  dialogOpen.value = false;
  mergeSource.value = { productId, productCode: row.productCode, name: nameOf(row) };
  mergeTarget.value = target ?? row.sheetMatch;
  mergeOpen.value = true;
}

function onMerged(result: ProductMerged): void {
  showToast({
    message:
      result.versionNumber === null
        ? t('staffCost.merge.mergedNoVersion', {
            source: result.sourceCode,
            target: result.targetCode,
          })
        : t('staffCost.merge.merged', {
            source: result.sourceCode,
            target: result.targetCode,
            number: result.versionNumber,
          }),
  });
  afterPublish();
}

// --- the row's context menu [owner 2026-11-12] -----------------------------------------------
// Right click, Shift+F10 or the touch "⋯" button: the actions of one product, only those the
// role may take (UI convenience; the server refuses the rest). Every item reuses an existing flow.

type RowMenuId = 'edit' | 'history' | 'photos' | 'stock' | 'copy' | 'merge' | 'remove';

function rowMenuOf(row: VisibleRow): RowMenuItem<RowMenuId>[] {
  const items: RowMenuItem<RowMenuId>[] = [];
  if (canEdit) items.push({ id: 'edit', label: t('prices.dialog.titleEdit'), icon: 'pencil' });
  items.push({ id: 'history', label: t('prices.historyLink'), icon: 'history' });
  if (photosAllowed) items.push({ id: 'photos', label: t('prices.rowMenu.photos'), icon: 'image' });
  // A staff-added product has no stock line in Ostatok.
  if (costVisible && !row.codeGenerated) {
    items.push({ id: 'stock', label: t('prices.rowMenu.stock'), icon: 'warehouse' });
  }
  items.push({ id: 'copy', label: t('prices.rowMenu.copyCode'), icon: 'copy' });
  if (canEdit && row.codeGenerated) {
    items.push({ id: 'merge', label: t('staffCost.merge.action'), icon: 'link' });
  }
  if (canEdit) {
    items.push({ id: 'remove', label: t('prices.dialog.remove'), icon: 'trash', tone: 'danger' });
  }
  return items.map((item) => ({ ...item, testId: `row-menu-${item.id}` }));
}

const rowMenuLabel = (row: VisibleRow): string =>
  t('prices.rowMenu.label', { code: row.productCode, name: nameOf(row) });

function onRowMenu(row: VisibleRow, id: string): void {
  switch (id as RowMenuId) {
    case 'edit':
      openRow(row);
      break;
    case 'history':
      showHistory(row.productId);
      break;
    case 'photos':
      photoProduct.value = { productCode: row.productCode, name: nameOf(row) };
      photoOpen.value = true;
      break;
    case 'stock':
      void router.push({ name: 'staff-stock', query: { q: row.productCode } });
      break;
    case 'copy':
      void copyCode(row.productCode);
      break;
    case 'merge':
      startMerge(row.productId);
      break;
    case 'remove':
      askRemove(row);
      break;
  }
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

const photoOpen = ref(false);
const photoProduct = shallowRef<{ readonly productCode: string; readonly name: string } | null>(
  null,
);

// "Price listdan olib tashlash" from the menu: the same one-removal publish as the price dialog's,
// on the page's base version, after a confirmation. A list published meanwhile (409
// PRICE_LIST_CHANGED) is re-read BEFORE the button unlocks and said so; the next press removes on
// the new base. When the product is gone from the re-read list (a colleague removed it), the
// dialog closes with a toast instead: a second publish would only make an empty version.
const removeRow = shallowRef<VisibleRow | null>(null);
const removeOpen = ref(false);
const removeBusy = ref(false);
const removeError = ref<string | null>(null);

function askRemove(row: VisibleRow): void {
  removeRow.value = row;
  removeError.value = null;
  removeOpen.value = true;
}

const stillListed = (productId: string): boolean =>
  rows.value.some((entry) => entry.productId === productId);

function closeAlreadyRemoved(row: VisibleRow): void {
  removeOpen.value = false;
  removeError.value = null;
  showToast({ message: t('prices.rowMenu.alreadyRemoved', { name: nameOf(row) }) });
}

async function confirmRemove(): Promise<void> {
  const row = removeRow.value;
  if (!row || removeBusy.value) return;
  if (!stillListed(row.productId)) {
    closeAlreadyRemoved(row);
    return;
  }
  removeBusy.value = true;
  removeError.value = null;
  try {
    const result = await pricingApi.publishChanges({
      baseVersionNumber: versionNumber.value,
      upserts: [],
      removedProductIds: [row.productId],
    });
    removeOpen.value = false;
    showToast({
      message: savedMessage(
        t,
        { versionNumber: result.number, skippedInactiveCount: result.skippedInactiveCount },
        nameOf(row),
      ),
    });
    afterPublish();
  } catch (caught) {
    removeError.value = translateDescribed(t, describePricingError('publish', caught));
    if (caught instanceof ApiConflictError && caught.reason === 'PRICE_LIST_CHANGED') {
      await load({ silent: true });
      // Only a list that was really re-read says the product is gone (not a failed reload).
      const reread = state.value === 'ready' || state.value === 'empty';
      if (reread && !stillListed(row.productId)) closeAlreadyRemoved(row);
    }
  } finally {
    removeBusy.value = false;
  }
}

// --- the history tab --------------------------------------------------------------------------

const selectedId = ref<string | null>(null);
const historyRows = computed(() => visible.value);
const selected = computed(
  () =>
    historyRows.value.find((row) => row.productId === selectedId.value) ??
    historyRows.value[0] ??
    null,
);

function showHistory(productId: string): void {
  dialogOpen.value = false;
  selectedId.value = productId;
  tab.value = 'history';
}

// `?history=<productId>` (from the Ctrl+K search) opens that product's history once the list is
// there, then drops the parameter so a reload or the back button does not reopen it.
watch(
  () => [state.value, route.query.history] as const,
  ([current, productId]) => {
    if (current !== 'ready' || typeof productId !== 'string') return;
    const { history: _opened, ...rest } = route.query;
    void _opened;
    void router.replace({ query: { ...rest, tab: 'history' } }).then(() => {
      selectedId.value = productId;
    });
  },
  { immediate: true },
);
</script>

<template>
  <section class="prices">
    <StateView
      :state="state"
      :title="state === 'empty' ? t('prices.empty.title') : undefined"
      :description="
        state === 'empty'
          ? t('prices.empty.description')
          : state === 'error'
            ? loadErrorText
            : undefined
      "
      @retry="load()"
    >
      <template #actions>
        <AppButton v-if="canEdit && costVisible" @click="goToStock">
          <StaffIcon name="plus" :size="16" />{{ t('prices.addFromStock') }}
        </AppButton>
        <!-- The first price may also come from a product the sheet does not have. -->
        <AppButton v-if="canEdit" variant="secondary" @click="manualOpen = true">
          <StaffIcon name="package" :size="16" />{{ t('staffCost.manual.add') }}
        </AppButton>
        <AppButton v-if="canEdit" variant="secondary" @click="importOpen = true">
          <StaffIcon name="upload" :size="16" />{{ t('staffCost.priceImport.action') }}
        </AppButton>
      </template>

      <PricesSubHeader :title="t('prices.title')" :subtitle="subtitle">
        <template #actions>
          <PriceListShareActions :can-post="canEdit" />
          <!-- Products the sheet does not have [C, 2026-11-09]: one by hand, or an Excel file. -->
          <NewProductMenu v-if="canEdit" @single="manualOpen = true" @import="importOpen = true" />
          <!-- The v8 orange action: N = active products without a published price. -->
          <button
            v-if="canEdit && costVisible"
            type="button"
            class="addbtn"
            :aria-label="
              unpricedCount > 0
                ? t('prices.addFromStockLabel', { count: unpricedCount })
                : undefined
            "
            data-testid="add-from-stock"
            @click="goToStock"
          >
            <StaffIcon name="plus" :size="16" />
            {{ t('prices.addFromStock') }}
            <span v-if="unpricedCount > 0" class="addbtn__count num">{{ unpricedCount }}</span>
          </button>
        </template>
      </PricesSubHeader>

      <div class="tabrow">
        <AppTabs
          class="tabrow__tabs"
          :model-value="tab"
          :tabs="tabs"
          :label="t('prices.tabs.ariaLabel')"
          id-prefix="prices"
          :panel-id="panelId"
          @update:model-value="selectTab"
        />
        <!-- The sibling pages of Narxlar: links at the end of the tab row, so the action row above
             keeps only what changes the price list and the table moves up. -->
        <div v-if="seesPriceAdmin" class="tablinks">
          <RouterLink class="tablink" :to="{ name: 'staff-price-versions' }">
            <StaffIcon name="archive" :size="14" />
            {{ t('prices.tabs.versions') }}
          </RouterLink>
          <RouterLink class="tablink" :to="{ name: 'staff-products' }">
            <StaffIcon name="package" :size="14" />
            {{ t('prices.tabs.products') }}
          </RouterLink>
          <!-- The newer-model pairs the customer home draws on [C, 2026-11-09]. -->
          <RouterLink
            class="tablink"
            :to="{ name: 'staff-newer-models' }"
            data-testid="newer-models-link"
          >
            <StaffIcon name="star" :size="14" />
            {{ t('newerModels.title') }}
          </RouterLink>
        </div>
      </div>

      <FilterPanel class="toolbar">
        <SearchField v-model="search" :placeholder="t('prices.search.placeholder')" label-hidden />
        <CategoryDropdown
          v-if="costVisible && productCategories.loaded.value"
          v-model="category"
          :counts="counts"
        />
        <!-- Supplier is cost-class data: only for the roles that load the cost columns. -->
        <div v-if="costVisible" class="toolbar__supplier">
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
        <!-- The rate every so'm figure below is derived from sits beside the $ / so'm switch. -->
        <UsdRateControl v-if="costVisible" class="toolbar__rate" :can-edit="canEdit" />
        <AppSegmented
          v-model="shown"
          class="currency"
          size="sm"
          :options="currencyOptions"
          :label="t('prices.currency.label')"
          data-currency-switch
        />
        <TableDensitySwitch v-if="tab !== 'history'" />
      </FilterPanel>

      <div :id="panelId" class="panel" role="tabpanel" :aria-labelledby="`prices-tab-${tab}`">
        <template v-if="tab !== 'history'">
          <p v-if="costs.state.value === 'error'" class="inline-error" role="alert">
            <StaffIcon name="alert" :size="15" />
            <span class="inline-error__text">{{ t('staffCost.cost.loadFailed') }}</span>
            <AppButton variant="secondary" size="xs" @click="costs.reload()">
              {{ t('state.retry') }}
            </AppButton>
          </p>
          <div class="surface" :style="{ '--dt-min-width': tableMinWidth }">
            <DataTable
              :columns="columns"
              :rows="visible"
              :row-key="(row: VisibleRow) => row.productId"
              :row-action="openRow"
              :row-label="
                (row: VisibleRow) =>
                  `${row.productCode} ${nameOf(row)}: ${canEdit ? t('prices.dialog.titleEdit') : t('prices.historyLink')}`
              "
              :row-tone="(row: VisibleRow) => (row.isActive ? undefined : 'muted')"
              :label="t('prices.tableLabel')"
              :empty-text="t('prices.noMatch')"
              :row-menu="rowMenuOf"
              :row-menu-label="rowMenuLabel"
              :density-toggle="false"
              @row-menu-choose="onRowMenu"
            >
              <template #lead="{ row }">
                <ProductThumb
                  :src="row.imageUrl"
                  :large-src="row.imageLargeUrl"
                  :alt="nameOf(row)"
                />
              </template>
              <template #cell-product="{ row }">
                <span class="product">
                  <span class="product__line">
                    <span class="name">{{ nameOf(row) }}</span>
                    <AppBadge v-if="!row.isActive" tone="warning">{{
                      t('prices.row.inactiveBadge')
                    }}</AppBadge>
                    <!-- A staff-added product: the sheet does not know it, so no stock is shown. -->
                    <AppBadge
                      v-if="row.codeGenerated"
                      tone="info"
                      :title="t('staffCost.manual.badgeHint')"
                      data-testid="manual-badge"
                      >{{ t('staffCost.manual.badge') }}</AppBadge
                    >
                    <!-- The sheet has a product with the same name: the likely merge target. -->
                    <button
                      v-if="row.codeGenerated && row.sheetMatch && canEdit"
                      type="button"
                      class="matchbtn"
                      :title="
                        t('staffCost.manual.sheetMatchHint', {
                          name: row.sheetMatch.name,
                          code: row.sheetMatch.productCode,
                        })
                      "
                      :aria-label="
                        t('staffCost.manual.sheetMatchHint', {
                          name: row.sheetMatch.name,
                          code: row.sheetMatch.productCode,
                        })
                      "
                      data-testid="sheet-match-badge"
                      @click.stop="startMerge(row.productId, row.sheetMatch)"
                    >
                      <AppBadge tone="accent">{{ t('staffCost.manual.sheetMatchBadge') }}</AppBadge>
                    </button>
                  </span>
                  <span class="meta">
                    <span class="mono code">{{ row.productCode }}</span>
                    <template v-if="row.codeGenerated">
                      <template v-if="row.category">
                        <span aria-hidden="true">·</span>
                        <span>{{ row.category }}</span>
                      </template>
                    </template>
                    <template v-else-if="costVisible">
                      <span aria-hidden="true">·</span>
                      <span>{{ row.category ?? t('staffCost.categories.none') }}</span>
                    </template>
                  </span>
                </span>
              </template>
              <template #cell-stock="{ row }">
                <StockCell
                  v-if="costOf(row)"
                  :quantity="costOf(row)?.stock ?? null"
                  :level="costOf(row)?.level ?? 'unknown'"
                  :unit="row.unit"
                />
                <span
                  v-else
                  class="muted"
                  :title="row.codeGenerated ? t('staffCost.manual.badgeHint') : undefined"
                  >—</span
                >
              </template>
              <template #cell-cost="{ row }">
                <CostCell
                  v-if="costOf(row)"
                  :usd="costOf(row)?.usd ?? null"
                  :uzs="costOf(row)?.uzs ?? null"
                  :rate="costOf(row)?.rate ?? null"
                  :recent="costOf(row)?.recent ?? []"
                  :product-code="row.productCode"
                />
                <span v-else class="muted">—</span>
              </template>
              <template #cell-price="{ row }">
                <b v-if="amountsOf(row).price !== null" class="num">{{
                  money(amountsOf(row).price ?? '')
                }}</b>
                <span v-else class="muted">—</span>
              </template>
              <template #cell-deferred="{ row }">
                <span v-if="amountsOf(row).deferredPrice !== null" class="num">{{
                  money(amountsOf(row).deferredPrice ?? '')
                }}</span>
                <span v-else class="muted">—</span>
              </template>
              <template #cell-wholesale="{ row }">
                <b v-if="wholesaleOf(row).price !== null" class="num" data-wholesale-price>{{
                  formatUsd(wholesaleOf(row).price ?? '')
                }}</b>
                <span
                  v-else
                  class="muted hint-standard"
                  :title="t('prices.row.fromStandardHint')"
                  data-from-standard
                  >{{ t('prices.row.fromStandard') }}</span
                >
              </template>
              <template #cell-wholesaleDeferred="{ row }">
                <span v-if="wholesaleOf(row).deferredPrice !== null" class="num">{{
                  formatUsd(wholesaleOf(row).deferredPrice ?? '')
                }}</span>
                <span
                  v-else-if="wholesaleOf(row).price === null"
                  class="muted hint-standard"
                  :title="t('prices.row.fromStandardHint')"
                  >{{ t('prices.row.fromStandard') }}</span
                >
                <span v-else class="muted">—</span>
              </template>
              <template #cell-alif="{ row }">
                <b v-if="alifOf(row).price !== null" class="num" data-alif-price>{{
                  formatUsd(alifOf(row).price ?? '')
                }}</b>
                <span
                  v-else
                  class="muted"
                  :title="t('prices.row.notOfferedAlifHint')"
                  data-not-offered-alif
                  >{{ t('prices.row.notOffered') }}</span
                >
              </template>
              <template #cell-alifDeferred="{ row }">
                <span v-if="alifOf(row).deferredPrice !== null" class="num">{{
                  formatUsd(alifOf(row).deferredPrice ?? '')
                }}</span>
                <span v-else class="muted">—</span>
              </template>
              <template #cell-markup="{ row }">
                <span
                  v-if="markupText(row) !== null"
                  class="num markup"
                  :class="{ 'markup--low': markupOf(row)?.belowCost }"
                  >{{ markupText(row) }}</span
                >
                <span v-else class="muted">—</span>
                <span v-if="markupText(row) !== null" class="muted num markup-tier">
                  / {{ wholesaleMarkupText(row) ?? '—' }}</span
                >
              </template>
              <template #card="{ row }">
                <!-- The card is the row's button: the photo is only a picture here, with an
                     empty alt (the card already says the name). -->
                <span class="card__main">
                  <ProductThumb :src="row.imageUrl" alt="" :zoomable="false" />
                  <span class="card__body">
                    <span class="card__top">
                      <b class="name">{{ nameOf(row) }}</b>
                      <StaffIcon name="right" :size="14" class="card__chevron" />
                    </span>
                    <span class="meta">
                      <span class="mono">{{ row.productCode }}</span>
                      <span v-if="costVisible && row.category">· {{ row.category }}</span>
                    </span>
                    <span class="card__bottom">
                      <b class="num card__price">{{
                        amountsOf(row).price !== null
                          ? moneyWithCurrency(amountsOf(row).price ?? '')
                          : '—'
                      }}</b>
                      <span v-if="amountsOf(row).deferredPrice !== null" class="num meta"
                        >{{ t('prices.dialog.deferredShort') }}:
                        {{ money(amountsOf(row).deferredPrice ?? '') }}</span
                      >
                      <span v-if="markupText(row) !== null" class="num markup">{{
                        markupText(row)
                      }}</span>
                    </span>
                    <span class="meta num" data-card-wholesale>
                      {{ t('prices.dialog.wholesaleShort') }}:
                      {{
                        wholesaleOf(row).price !== null
                          ? formatUsd(wholesaleOf(row).price ?? '')
                          : t('prices.row.fromStandard')
                      }}
                    </span>
                    <span class="meta num" data-card-alif>
                      {{ t('prices.dialog.alifShort') }}:
                      {{
                        alifOf(row).price !== null
                          ? formatUsd(alifOf(row).price ?? '')
                          : t('prices.row.notOffered')
                      }}
                    </span>
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
          <p class="list-count" data-testid="list-footer">{{ footer }}</p>
        </template>

        <!-- v8 "Narxlar tarixi": the products on the left, the chosen one's changes on the right. -->
        <div v-else class="history">
          <div class="history__list surface">
            <p v-if="historyRows.length === 0" class="history__empty">{{ t('prices.noMatch') }}</p>
            <ul v-else class="hlist">
              <li v-for="row in historyRows" :key="row.productId">
                <button
                  type="button"
                  class="hrow"
                  :class="{ 'hrow--on': selected?.productId === row.productId }"
                  :aria-pressed="selected?.productId === row.productId"
                  @click="selectedId = row.productId"
                >
                  <span class="hrow__text">
                    <span class="name">{{ nameOf(row) }}</span>
                    <span class="meta"
                      ><span class="mono">{{ row.productCode }}</span></span
                    >
                  </span>
                  <b class="num">{{
                    amountsOf(row).price !== null ? money(amountsOf(row).price ?? '') : '—'
                  }}</b>
                </button>
              </li>
            </ul>
          </div>

          <aside v-if="selected" class="history__panel surface" :aria-label="nameOf(selected)">
            <div class="hp__top">
              <ProductThumb
                :key="`p-${selected.productId}`"
                :src="selected.imageUrl"
                :large-src="selected.imageLargeUrl"
                :alt="nameOf(selected)"
                :size="56"
              />
              <div class="hp__head">
                <span class="hp__name">{{ nameOf(selected) }}</span>
                <span class="meta">
                  <span class="mono">{{ selected.productCode }}</span>
                  <template v-if="costVisible && selected.category">
                    · {{ selected.category }}</template
                  >
                </span>
              </div>
            </div>
            <dl class="facts">
              <div class="fact">
                <dt>{{ t('prices.columns.price') }}</dt>
                <dd class="num">
                  {{
                    amountsOf(selected).price !== null
                      ? moneyWithCurrency(amountsOf(selected).price ?? '')
                      : '—'
                  }}
                </dd>
                <dd v-if="amountsOf(selected).deferredPrice !== null" class="fact__sub num">
                  {{ t('prices.dialog.deferredShort') }}:
                  {{ money(amountsOf(selected).deferredPrice ?? '') }}
                </dd>
                <dd class="fact__sub num">
                  {{ t('prices.dialog.wholesaleShort') }}:
                  {{
                    wholesaleOf(selected).price !== null
                      ? formatUsd(wholesaleOf(selected).price ?? '')
                      : t('prices.row.fromStandard')
                  }}
                </dd>
                <dd class="fact__sub num">
                  {{ t('prices.dialog.alifShort') }}:
                  {{
                    alifOf(selected).price !== null
                      ? formatUsd(alifOf(selected).price ?? '')
                      : t('prices.row.notOffered')
                  }}
                </dd>
              </div>
              <div v-if="costVisible" class="fact">
                <dt>{{ t('staffCost.cost.column') }}</dt>
                <dd class="num">
                  <template v-if="costOf(selected)?.usd">
                    {{ formatUsd(costOf(selected)?.usd ?? '0') }}
                  </template>
                  <template v-else>—</template>
                </dd>
                <dd v-if="markupText(selected) !== null" class="fact__sub">
                  {{ t('prices.columns.markup') }} {{ markupText(selected) }}
                </dd>
              </div>
            </dl>
            <AppButton v-if="canEdit" variant="secondary" block @click="openRow(selected)">
              <StaffIcon name="pencil" :size="14" />{{ t('prices.dialog.titleEdit') }}
            </AppButton>
            <p class="rule" role="note">
              <StaffIcon name="lock" :size="15" />{{ t('prices.history.ruleNote') }}
            </p>
            <!-- The price history endpoint is for the people who change prices (403 otherwise). -->
            <PriceHistoryBody
              v-if="canEdit"
              :key="`h-${selected.productId}-${versionNumber}`"
              :product-id="selected.productId"
            />
            <SupplyHistory
              v-if="costVisible"
              :key="`s-${selected.productId}`"
              :product-id="selected.productId"
            />
          </aside>
        </div>
      </div>
    </StateView>

    <PriceEditDialog
      v-if="canEdit"
      v-model="dialogOpen"
      :product="target"
      :base-version-number="versionNumber"
      @saved="onSaved"
      @stale="load({ silent: true })"
      @history="showHistory"
      @merge="startMerge"
      @photos-changed="load({ silent: true })"
    />
    <template v-if="canEdit">
      <ManualProductDialog
        v-model="manualOpen"
        :base-version-number="versionNumber"
        :categories="knownCategories"
        @created="onManualCreated"
        @stale="load({ silent: true })"
      />
      <PriceImportDialog
        v-model="importOpen"
        :generated-count="generatedCount"
        :base-version-number="versionNumber"
        @imported="onImported"
        @stale="load({ silent: true })"
      />
      <MergeProductDialog
        v-model="mergeOpen"
        :source="mergeSource"
        :initial-target="mergeTarget"
        :base-version-number="versionNumber"
        @merged="onMerged"
        @stale="load({ silent: true })"
      />
      <AppConfirmDialog
        v-model="removeOpen"
        :title="t('prices.dialog.remove')"
        :description="t('prices.dialog.removeQuestion')"
        :confirm-label="t('prices.dialog.removeConfirm')"
        tone="danger"
        :loading="removeBusy"
        :error="removeError"
        @confirm="confirmRemove"
      >
        <p v-if="removeRow" class="remove-target" data-testid="remove-target">
          <span class="remove-target__name">{{ nameOf(removeRow) }}</span>
          <span class="mono remove-target__code">{{ removeRow.productCode }}</span>
        </p>
      </AppConfirmDialog>
    </template>
    <ProductPhotoDialog
      v-if="photosAllowed"
      v-model="photoOpen"
      :product="photoProduct"
      @changed="load({ silent: true })"
    />
  </section>
</template>

<style scoped>
.prices {
  display: flex;
  /* Fills the section, so the loading/empty/error state sits in the middle of the screen. */
  flex: 1 0 auto;
  flex-direction: column;
  gap: var(--gap-card);
  min-width: 0;
}

.addbtn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* v8 "Ostatokdan qo'shish": the orange 40px primary with a translucent count chip. */
.addbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.addbtn:hover {
  background: var(--acc-hover);
}

.addbtn__count {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc-hover);
  font-size: var(--fs-meta);
}

/* The underline tab row with the versions link at its right end, on one hairline. */
.tabrow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 24px;
  box-shadow: inset 0 -1px 0 var(--e8);
}

.tabrow__tabs {
  flex: 0 1 auto;
  min-width: 0;
}

.tablinks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 20px;
  margin-left: auto;
}

.tablink {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 42px;
  color: var(--t2);
  font-size: var(--fs-small);
  text-decoration: none;
  white-space: nowrap;
}

.tablink:hover {
  color: var(--ink);
}

.tablink:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

/* One compact row: search and category on the left; the rate, the $ / so'm switch and the table
   density on the right. */
.toolbar {
  align-items: center;
  padding: var(--container-pad) var(--gap-card);
}

.toolbar__rate {
  margin-left: auto;
}

.toolbar__supplier {
  flex: 0 1 220px;
  min-width: 160px;
}

.toolbar :deep(.search) {
  flex: 1 1 220px;
  max-width: 360px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--gap-card);
  min-width: 0;
}

/* The table is the page: once scrolled under the top bar it fills the window and scrolls inside. */
.surface {
  min-width: 0;
  --dt-max-h: calc(100vh - var(--topbar-h) - var(--safe-top, 0px) - var(--gap-card));
}

/* The dynamic viewport height leaves out a phone browser's bars; older browsers keep 100vh. */
@supports (height: 100dvh) {
  .surface {
    --dt-max-h: calc(100dvh - var(--topbar-h) - var(--safe-top, 0px) - var(--gap-card));
  }
}

.product {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.product__line {
  display: flex;
  /* The badges wrap under a long name instead of widening the column past 1440px. */
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  min-width: 0;
}

.name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: var(--fs-group);
  color: var(--t2);
}

.muted {
  color: var(--t3);
}

/* The "Sheetda bor" pill is a button: it opens the merge with that sheet product filled in. */
.matchbtn {
  display: inline-flex;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.matchbtn:hover {
  filter: brightness(0.96);
}

.matchbtn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.markup {
  font-weight: 500;
  color: var(--green);
}

.markup--low {
  color: var(--acc-fg);
}

/* A missing wholesale price: that tier's customers see the standard one. */
.hint-standard {
  font-size: var(--fs-meta);
  font-style: italic;
}

.markup-tier {
  font-size: var(--fs-meta);
}

.card__main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.card__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.card__top,
.card__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.card__bottom {
  align-items: flex-end;
  margin-top: 8px;
}

.card__chevron {
  flex: none;
  color: var(--t3);
}

.card__price {
  font-size: var(--fs-body);
}

.reset {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.list-count {
  margin: -4px 0 0;
  padding: 0 4px;
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.inline-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.inline-error__text {
  flex: 1 1 200px;
}

/* The product a menu removal is about, inside its confirmation. */
.remove-target {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.remove-target__name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.remove-target__code {
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* --- history tab --- */
.history {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 20px;
}

.history__list,
.history__panel {
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  overflow: hidden;
}

.history__list {
  flex: 999 1 460px;
}

.history__panel {
  position: sticky;
  top: 96px;
  display: flex;
  flex: 1 1 340px;
  flex-direction: column;
  gap: 14px;
  max-width: 100%;
  padding: 20px;
}

.history__empty {
  margin: 0;
  padding: 40px 20px;
  text-align: center;
  color: var(--t2);
  font-size: var(--fs-small);
}

.hlist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.hlist li + li {
  border-top: 1px solid var(--e8);
}

.hrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 10px 20px;
  border: 0;
  background: var(--w);
  color: var(--ink);
  font-size: var(--fs-small);
  text-align: left;
  cursor: pointer;
}

.hrow:hover {
  background: var(--f5);
}

.hrow:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.hrow--on,
.hrow--on:hover {
  background: var(--acc-bg);
  box-shadow: inset 3px 0 0 var(--acc);
}

.hrow__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hp__top {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.hp__head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.hp__name {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 0;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.fact dt {
  font-size: var(--fs-group);
  color: var(--t2);
}

.fact dd {
  margin: 0;
  font-weight: 600;
}

.fact .fact__sub {
  font-size: var(--fs-group);
  font-weight: 400;
  color: var(--t2);
}

.rule {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.rule :deep(svg) {
  flex: none;
}

@media (max-width: 720px) {
  .addbtn {
    flex: 1 1 auto;
    justify-content: center;
  }

  .toolbar :deep(.search) {
    max-width: none;
  }

  .toolbar__rate {
    margin-left: 0;
  }

  .history__panel {
    position: static;
  }
}

@media (pointer: coarse) {
  .addbtn,
  .tablink {
    min-height: 44px;
  }
}
</style>
