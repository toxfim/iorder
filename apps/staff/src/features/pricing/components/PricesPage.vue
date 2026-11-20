<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type { PriceListCurrency } from '@iorder/shared';
import type { StaffPriceListWithRateResponse } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppDropdown from '@core/components/ui/AppDropdown.vue';
import AppSegmented from '@/components/ui/AppSegmented.vue';
import RowContextMenu, {
  type RowMenuItem,
  type RowMenuPoint,
} from '@/components/ui/RowContextMenu.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import type { ViewState } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { useFormat } from '@core/i18n/use-format';
import { ApiConflictError, ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { decimalSeparatorFor } from '@core/lib/format';
import { describePricingError } from '@core/lib/price-errors';
import { useMediaQuery } from '@/composables/use-media-query';
import CategoryDropdown from '@/features/staff-cost/components/CategoryDropdown.vue';
import FilterMenu from '@/features/staff-cost/components/FilterMenu.vue';
import StockFilterSheet, {
  type SheetList,
} from '@/features/staff-cost/components/StockFilterSheet.vue';
import StockPager from '@/features/staff-cost/components/StockPager.vue';
import SupplyHistory from '@/features/staff-cost/components/SupplyHistory.vue';
import UsdRateControl from '@/features/staff-cost/components/UsdRateControl.vue';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import { useCostColumns } from '@/features/staff-cost/composables/use-cost-columns';
import { useProductCategories } from '@/features/staff-cost/composables/use-product-categories';
import { useUrlState } from '@/features/staff-cost/composables/use-url-state';
import {
  CATEGORY_ALL,
  CATEGORY_NONE,
  categoryTabId,
  countCategories,
  filterByCategory,
} from '@/features/staff-cost/domain/category-filter';
import { formatTenthsPercent, priceHint } from '@/features/staff-cost/domain/price-hint';
import {
  DEFAULT_PAGE_SIZE,
  pageSlice,
  type PageSize,
} from '@/features/staff-cost/domain/pagination';
import { BRAND_ALL, brandOptions, matchesBrand } from '@/features/staff-cost/domain/stock-views';
import {
  canEditPrices,
  canManagePhotos,
  canViewCost,
  canViewPriceAdmin,
} from '@/features/staff-shell/price-access';
import ProductPhotoDialog from '@/features/product-images/components/ProductPhotoDialog.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import { changedAgo } from '../domain/changed-ago';
import { pickName } from '../domain/localized-name';
import type { PriceRowView, PriceStockTone } from '../domain/price-row-view';
import { alifUsd, amountsIn, toPriceRows, wholesaleUsd, type PriceRow } from '../domain/price-rows';
import { priceTargetOf } from '../domain/price-target';
import {
  isPricePreset,
  isPriceSort,
  isPriceType,
  matchesPreset,
  matchesPriceType,
  PRICE_PRESETS,
  PRICE_SORTS,
  PRICE_TYPES,
  sortPrices,
  type PricePreset,
  type PriceSort,
  type PriceType,
} from '../domain/price-views';
import { filterRows } from '../domain/row-filter';
import { savedMessage } from '../domain/saved-message';
import { translateDescribed } from '../domain/translate-error';
import ManualProductDialog, { type ManualProductCreated } from './ManualProductDialog.vue';
import MergeProductDialog, {
  type MergeSource,
  type MergeTargetHint,
  type ProductMerged,
} from './MergeProductDialog.vue';
import NewProductMenu from './NewProductMenu.vue';
import PriceCard from './PriceCard.vue';
import PriceEditDialog, { type PriceSaved, type PriceTarget } from './PriceEditDialog.vue';
import PriceHistoryDrawer from './PriceHistoryDrawer.vue';
import PriceImportDialog, { type PriceImported } from './PriceImportDialog.vue';
import PriceListShareActions from './PriceListShareActions.vue';
import PriceMobileRow from './PriceMobileRow.vue';
import PricesSubHeader from './PricesSubHeader.vue';
import PriceTable from './PriceTable.vue';

// "Narxlar" (design «Narxlar — yakuniy sahifa», approved 2026-11-19, at 1440 / 768 / 390): the
// published list with ready views, search, Kategoriya / Brend / Narx turi, USD · so'm (the rate
// always in sight), the table by default and the C3·a card as an option, pages and a back-to-top
// button. There are no drafts and no edit mode [C, 2026-10-28]: "Tahrirlash" opens "Narxni
// o'zgartirish" and its save publishes a new version at once. Products without a price are priced
// from Ostatok ("Ostatokdan qo'shish" opens it filtered to them). Owner choices of 2026-11-19
// over the design: the wholesale and Alif prices stay in USD in the so'm view (the api sends no
// so'm figure for them), the supplier filter and the cost column are gone (the cost is in the
// markup's hover), the history tab became the side panel ("Tarix").
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
const { formatMoney } = useFormat();
const { formatUsd, formatQuantity } = useCostFormat();

// UI convenience only: the server refuses every call a role may not make.
const roles = computed(() => currentUser.user.value?.staffRoles ?? []);
const costVisible = canViewCost(roles.value);
const canEdit = canEditPrices(roles.value);
const seesPriceAdmin = canViewPriceAdmin(roles.value);
const photosAllowed = canManagePhotos(roles.value);

// The design's breakpoints: below 1280 the cards are three a row, below 1024 the lists move into
// the "Filtrlar" sheet, below 600 the phone list remains. Alif and "O'zgargan" fold away below
// 1400, not 1280: beside the 232px menu the full table only fits from there (seen in the
// browser, 2026-11-20), and a table that scrolls sideways hides its actions.
const wide = useMediaQuery('(min-width: 1400px)', true);
const desktop = useMediaQuery('(min-width: 1024px)', true);
const phone = useMediaQuery('(max-width: 599px)', false);

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
const publishedAt = computed(() => published.value?.version.publishedAt ?? null);

// Staff-added products (generated codes) [C, 2026-11-09].
const generatedCount = computed(() => rows.value.filter((row) => row.codeGenerated).length);

// The list items carry no category; the catalog does. Read once per list for the generated rows
// (sheet products get theirs from the stock overview), only by the roles that may read it.
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
    // A missing category only leaves the product out of the category filter.
    if (mine === categoriesRun) generatedCategories.value = new Map();
  }
}
watch(generatedCount, () => void loadGeneratedCategories(), { immediate: true });

// --- filters, all of them in the address (reload, Back and a pasted link keep the view) ---------

// Older links: the tabs became ready views, the history tab the side panel.
const legacyTab = route.query.tab;
if (typeof legacyTab === 'string') {
  const { tab: _legacy, ...rest } = route.query;
  void _legacy;
  const preset =
    legacyTab === 'manual' ? 'byOrder' : legacyTab === 'nowholesale' ? 'noWholesale' : null;
  void router.replace({ query: preset ? { ...rest, preset } : rest });
}

const preset = ref<PricePreset>('all');
const search = ref('');
const category = ref(CATEGORY_ALL);
const brand = ref(BRAND_ALL);
const priceType = ref<PriceType>('all');
const sort = ref<PriceSort>('changed');
type Layout = 'table' | 'cards';
const layout = ref<Layout>('table');
// Prices are kept in USD [owner 2026-10-29]; the so'm view shows them at the current rate.
const shown = ref<PriceListCurrency>('USD');
// A pasted "Tannarxdan past" link means nothing to a role without the cost: it falls back to all.
useUrlState('preset', preset, {
  fallback: 'all',
  isValid: (value) => isPricePreset(value) && (costVisible || value !== 'belowCost'),
});
useUrlState('q', search, { fallback: '', debounceMs: 300 });
useUrlState('category', category, { fallback: CATEGORY_ALL });
useUrlState('brand', brand, { fallback: BRAND_ALL });
useUrlState('type', priceType, { fallback: 'all', isValid: isPriceType });
useUrlState('sort', sort, { fallback: 'changed', isValid: isPriceSort });
useUrlState('layout', layout, { fallback: 'table', isValid: (value) => value === 'cards' });
useUrlState('currency', shown as Ref<string>, {
  fallback: 'USD',
  isValid: (value) => value === 'UZS',
});

// --- per row facts -------------------------------------------------------------------------------

const nameOf = (row: PriceRow): string => pickName(row.names);
const categoryOf = (row: PriceRow): string | null =>
  row.codeGenerated
    ? (generatedCategories.value.get(row.productId) ?? null)
    : (productCategories.byProduct.value.get(row.productId) ?? null);
// A staff-added product has no deliveries: no stock, no cost, no markup.
const costOf = (row: PriceRow) =>
  row.codeGenerated ? null : (costs.rows.value.get(row.productId) ?? null);
const hintOf = (row: PriceRow) => {
  const usd = amountsIn(row, 'USD').price;
  return usd === null ? null : priceHint(usd, costOf(row)?.usd ?? null);
};

interface FilterRow extends PriceRow {
  readonly category: string | null;
  readonly belowCost: boolean;
  readonly usdPrice: string | null;
  readonly markupTenths: bigint | null;
  readonly changedAt: string | null;
}

const filterable = computed<FilterRow[]>(() =>
  rows.value.map((row) => {
    const hint = hintOf(row);
    return {
      ...row,
      category: categoryOf(row),
      belowCost: hint?.belowCost ?? false,
      usdPrice: amountsIn(row, 'USD').price,
      markupTenths: hint?.markupTenths ?? null,
      changedAt: row.lastChange?.changedAt ?? null,
    };
  }),
);

// The design's search also finds a brand ("Nomi, Товар_ID yoki brend").
const searched = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (needle === '') return filterable.value;
  const byText = new Set(filterRows(filterable.value, search.value));
  return filterable.value.filter(
    (row) => byText.has(row) || (row.brand?.toLowerCase().includes(needle) ?? false),
  );
});
// The option counts of each list follow the search only; the rows follow every filter.
const brandChoices = computed(() => brandOptions(searched.value.map((row) => row.brand)));
const typeChoices = computed(() =>
  PRICE_TYPES.filter((type) => type !== 'all').map((type) => ({
    value: type,
    label: t(`prices.page.priceType.${type}`),
    count: searched.value.filter((row) => matchesPriceType(row, type)).length,
  })),
);
const byBrand = computed(() =>
  searched.value.filter((row) => matchesBrand(row.brand, brand.value)),
);
const byType = computed(() =>
  byBrand.value.filter((row) => matchesPriceType(row, priceType.value)),
);
const byPreset = computed(() => byType.value.filter((row) => matchesPreset(row, preset.value)));
const filtered = computed(() => filterByCategory(byPreset.value, category.value));
const sorted = computed(() => sortPrices(filtered.value, sort.value, nameOf));
const counts = computed(() => countCategories(byPreset.value));

// "Tannarxdan past" and the markup sort need the cost: only for the roles that see it.
const presetKeys = computed(() =>
  PRICE_PRESETS.filter((key) => costVisible || key !== 'belowCost'),
);
const presets = computed(() => {
  const pool = filterByCategory(byType.value, category.value);
  return presetKeys.value.map((key) => ({
    key,
    count: pool.filter((row) => matchesPreset(row, key)).length,
    warn: key === 'noWholesale' || key === 'belowCost',
  }));
});
const sortOptions = computed(() =>
  PRICE_SORTS.filter((value) => costVisible || value !== 'markup').map((value) => ({
    value,
    label: t(`prices.page.sort.${value}`),
  })),
);
// The cost word of "Tannarxdan past" lives in the staff-cost catalog (the bundle check).
const presetLabel = (key: PricePreset): string =>
  key === 'belowCost' ? t('staffCost.pricesPage.belowCost') : t(`prices.page.presets.${key}`);
function setPriceType(value: string): void {
  if (isPriceType(value)) priceType.value = value;
}
function setSort(value: string | null): void {
  if (value !== null && isPriceSort(value)) sort.value = value;
}

// --- active filters as chips -------------------------------------------------------------------

const categoryLabel = (id: string): string =>
  id === CATEGORY_NONE
    ? t('staffCost.categories.none')
    : (counts.value.categories.find((c) => categoryTabId(c.category) === id)?.category ??
      id.slice(2));

type ChipKey = 'preset' | 'category' | 'brand' | 'type' | 'search';
interface Chip {
  readonly key: ChipKey;
  readonly label: string;
  readonly value: string;
}
const chips = computed<Chip[]>(() => {
  const list: Chip[] = [];
  // On a phone the ready views live in the sheet, so the chosen one is a chip too.
  if (phone.value && preset.value !== 'all')
    list.push({
      key: 'preset',
      label: t('prices.page.presets.label'),
      value: presetLabel(preset.value),
    });
  if (category.value !== CATEGORY_ALL)
    list.push({
      key: 'category',
      label: t('staffCost.stock.chip.category'),
      value: categoryLabel(category.value),
    });
  if (brand.value !== BRAND_ALL)
    list.push({ key: 'brand', label: t('staffCost.stock.chip.brand'), value: brand.value });
  if (priceType.value !== 'all')
    list.push({
      key: 'type',
      label: t('prices.page.priceType.label'),
      value: t(`prices.page.priceType.${priceType.value}`),
    });
  if (search.value.trim() !== '')
    list.push({
      key: 'search',
      label: t('staffCost.stock.chip.search'),
      value: search.value.trim(),
    });
  return list;
});

function removeChip(key: ChipKey): void {
  if (key === 'preset') preset.value = 'all';
  if (key === 'category') category.value = CATEGORY_ALL;
  if (key === 'brand') brand.value = BRAND_ALL;
  if (key === 'type') priceType.value = 'all';
  if (key === 'search') search.value = '';
}

/** "Tozalash": the lists, the search and the ready view (the design's "clear all"). */
function clearFilters(): void {
  search.value = '';
  category.value = CATEGORY_ALL;
  brand.value = BRAND_ALL;
  priceType.value = 'all';
  preset.value = 'all';
}

// --- the filter sheet below 1024px -------------------------------------------------------------

const sheetOpen = ref(false);
const sheetLists = computed<SheetList[]>(() => {
  const all = t('staffCost.categories.all');
  return [
    {
      key: 'category',
      label: t('staffCost.stock.chip.category'),
      selected: category.value,
      current: category.value === CATEGORY_ALL ? all : categoryLabel(category.value),
      choices: [
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
      ],
    },
    {
      key: 'brand',
      label: t('staffCost.stock.chip.brand'),
      selected: brand.value,
      current: brand.value === BRAND_ALL ? all : brand.value,
      choices: [{ value: BRAND_ALL, label: all }, ...brandChoices.value],
    },
    {
      key: 'type',
      label: t('prices.page.priceType.label'),
      selected: priceType.value,
      current: t(`prices.page.priceType.${priceType.value}`),
      choices: [{ value: 'all', label: all }, ...typeChoices.value],
    },
  ];
});
// The phone keeps the ready views in the sheet; the currency is in the sheet on every size.
const sheetLead = computed<SheetList[]>(() =>
  phone.value
    ? [
        {
          key: 'preset',
          label: t('prices.page.presets.label'),
          selected: preset.value,
          current: presetLabel(preset.value),
          choices: presets.value.map((view) => ({
            value: view.key,
            label: presetLabel(view.key),
            count: view.count,
          })),
        },
      ]
    : [],
);
const sheetTail = computed<SheetList[]>(() => [
  {
    key: 'currency',
    label: t('prices.page.sheet.currency'),
    selected: shown.value,
    current: t(`prices.currency.${shown.value}`),
    choices: [
      { value: 'USD', label: 'USD' },
      { value: 'UZS', label: t('prices.currency.UZS') },
    ],
  },
]);

function pickFromSheet(key: string, value: string): void {
  if (key === 'category') category.value = value;
  if (key === 'brand') brand.value = value;
  if (key === 'type' && isPriceType(value)) priceType.value = value;
  if (key === 'preset' && isPricePreset(value)) preset.value = value;
  if (key === 'currency') shown.value = value === 'UZS' ? 'UZS' : 'USD';
}

// --- pages ---------------------------------------------------------------------------------------

const page = ref(0);
const pageSize = ref<PageSize>(DEFAULT_PAGE_SIZE);
// Any change of what is listed starts again at the first page.
watch([preset, search, category, brand, priceType, sort], () => {
  page.value = 0;
});
const slice = computed(() => pageSlice(sorted.value.length, page.value, pageSize.value));
const pageRows = computed(() => sorted.value.slice(slice.value.start, slice.value.end));

// A phone always gets the compact list (the design: no table, no card grid).
const shownLayout = computed<Layout | 'list'>(() => (phone.value ? 'list' : layout.value));

// --- what a row shows ------------------------------------------------------------------------

const usdTiers = computed(() => shown.value === 'UZS');
const money = (amount: string): string =>
  shown.value === 'USD' ? formatUsd(amount) : formatMoney(amount);
/** The magnitude only ("4,0%"): the row puts its own "+" or "▼" in front. */
const percent = (tenths: bigint): string =>
  formatTenthsPercent(
    tenths < 0n ? -tenths : tenths,
    decimalSeparatorFor(i18nLocale.value),
  ).replace(/^[+-]/, '');

function stockOf(row: PriceRow): { text: string; tone: PriceStockTone } | null {
  const cost = costOf(row);
  if (!cost || cost.stock === null || cost.level === 'unknown') return null;
  if (cost.level === 'out') return { text: t('prices.page.stockOut'), tone: 'out' };
  return {
    text: t('prices.page.stockPieces', { count: formatQuantity(cost.stock) }),
    tone: cost.level,
  };
}

/** "bugun 09:41", "kecha", "5 kun oldin" ... (Tashkent days); null for a malformed instant. */
function agoText(instant: string): string | null {
  const ago = changedAgo(instant, new Date());
  if (!ago) return null;
  if (ago.kind === 'today') return t('prices.page.changed.today', { time: ago.time });
  if (ago.kind === 'yesterday') return t('prices.page.changed.yesterday');
  return t(`prices.page.changed.${ago.kind}`, { count: ago.count }, ago.count);
}
const publishedWhen = computed(() => (publishedAt.value ? agoText(publishedAt.value) : null));

function changedOf(row: PriceRow): PriceRowView['changed'] {
  const change = row.lastChange;
  const when = change ? agoText(change.changedAt) : null;
  if (!change || !when) return null;
  return { when, who: change.changedBy };
}

function viewOf(row: FilterRow): PriceRowView {
  const standard = amountsIn(row, shown.value);
  const standardUsd = amountsIn(row, 'USD');
  const wholesale = wholesaleUsd(row);
  const alif = alifUsd(row);
  const hint = costVisible ? hintOf(row) : null;
  const markupText = hint ? percent(hint.markupTenths) : null;
  return {
    row,
    name: nameOf(row),
    stock: costVisible ? stockOf(row) : null,
    sale: standard.price === null ? null : money(standard.price),
    deferred: standard.deferredPrice === null ? null : money(standard.deferredPrice),
    belowCost: hint?.belowCost ?? false,
    wholesale:
      wholesale.price === null
        ? {
            price: standardUsd.price === null ? null : formatUsd(standardUsd.price),
            deferred:
              standardUsd.deferredPrice === null ? null : formatUsd(standardUsd.deferredPrice),
            fromStandard: true,
          }
        : {
            price: formatUsd(wholesale.price),
            deferred: wholesale.deferredPrice === null ? null : formatUsd(wholesale.deferredPrice),
            fromStandard: false,
          },
    alif:
      alif.price === null
        ? null
        : {
            price: formatUsd(alif.price),
            deferred: alif.deferredPrice === null ? null : formatUsd(alif.deferredPrice),
          },
    markup:
      hint && markupText !== null
        ? {
            short: hint.belowCost ? `▼ ${markupText}` : `+${markupText}`,
            full: hint.belowCost
              ? t('staffCost.pricesPage.markupBelow', { value: `-${markupText}` })
              : t('prices.page.markupUp', { value: `+${markupText}` }),
          }
        : null,
    changed: changedOf(row),
  };
}
const pageViews = computed(() => pageRows.value.map(viewOf));

const shownText = computed(() =>
  t(
    shown.value === 'UZS' ? 'prices.page.shownUzs' : 'prices.page.shown',
    { count: sorted.value.length },
    sorted.value.length,
  ),
);

const loadErrorText = computed(() =>
  translateDescribed(t, describePricingError('load', loadError.value)),
);

// --- "Ostatokdan qo'shish": Ostatok, filtered to the products without a price -------------------

function goToStock(): void {
  void router.push({ name: 'staff-stock', query: { preset: 'unpriced' } });
}

// --- one product: the price dialog -----------------------------------------------------------

const dialogOpen = ref(false);
const target = shallowRef<PriceTarget | null>(null);

function openEdit(row: PriceRow): void {
  if (!canEdit) {
    showHistory(row.productId);
    return;
  }
  // A drawer and a modal are never stacked.
  panelOpen.value = false;
  target.value = priceTargetOf(row, row, costOf(row)?.usd ?? null);
  dialogOpen.value = true;
}

/** Re-reads the list and gives the open dialog the fresh product (its fields merge it in). */
async function reloadForDialog(): Promise<void> {
  await load({ silent: true });
  const open = target.value;
  if (!dialogOpen.value || !open) return;
  const row = rows.value.find((r) => r.productId === open.productId);
  if (row) target.value = priceTargetOf(row, row, costOf(row)?.usd ?? null);
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
function startMerge(productId: string, hint: MergeTargetHint | null = null): void {
  const row = rows.value.find((r) => r.productId === productId);
  if (!row) return;
  dialogOpen.value = false;
  panelOpen.value = false;
  mergeSource.value = { productId, productCode: row.productCode, name: nameOf(row) };
  mergeTarget.value = hint ?? row.sheetMatch;
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

// --- the row menu [owner 2026-11-12] -----------------------------------------------------------
// Right click, Shift+F10 or "⋯": the actions of one product, only those the role may take (UI
// convenience; the server refuses the rest). Every item reuses an existing flow.

type RowMenuId = 'edit' | 'history' | 'photos' | 'stock' | 'copy' | 'merge' | 'remove';

function rowMenuOf(view: PriceRowView): RowMenuItem<RowMenuId>[] {
  const row = view.row;
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

function onRowMenu(view: PriceRowView, id: string): void {
  const row = view.row;
  switch (id as RowMenuId) {
    case 'edit':
      openEdit(row);
      break;
    case 'history':
      showHistory(row.productId);
      break;
    case 'photos':
      photoProduct.value = { productCode: row.productCode, name: view.name };
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

// The card grid has no table to hold the menu: one menu for every card, anchored to its "⋯".
type MenuHandle = {
  open: (at: RowMenuPoint, focusAfter: HTMLElement | null) => Promise<void>;
  close: (giveFocusBack: boolean) => void;
};
const cardMenu = ref<MenuHandle | null>(null);
const cardMenuView = shallowRef<PriceRowView | null>(null);
let cardMenuAnchor: HTMLElement | null = null;

function openCardMenu(view: PriceRowView, anchor: HTMLElement): void {
  if (cardMenuView.value?.row.productId === view.row.productId && cardMenuAnchor === anchor) {
    cardMenu.value?.close(true);
    return;
  }
  cardMenuView.value = view;
  cardMenuAnchor = anchor;
  const rect = anchor.getBoundingClientRect();
  void nextTick(() => cardMenu.value?.open({ x: rect.left, y: rect.bottom }, anchor));
}

// Right click, long press or the Context Menu key on a card: the menu opens at that point.
function openCardMenuAt(
  view: PriceRowView,
  at: RowMenuPoint,
  focusAfter: HTMLElement | null,
): void {
  cardMenuView.value = view;
  cardMenuAnchor = focusAfter;
  void nextTick(() => cardMenu.value?.open(at, focusAfter));
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
const removeRow = shallowRef<PriceRow | null>(null);
const removeOpen = ref(false);
const removeBusy = ref(false);
const removeError = ref<string | null>(null);

function askRemove(row: PriceRow): void {
  removeRow.value = row;
  removeError.value = null;
  removeOpen.value = true;
}

const stillListed = (productId: string): boolean =>
  rows.value.some((entry) => entry.productId === productId);

function closeAlreadyRemoved(row: PriceRow): void {
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

// --- the side panel ("Tarix"): price history, supply history, the photo ---------------------------

const panelOpen = ref(false);
// The id, not a copy of the row: after a reload (a new photo, a price) the panel shows the
// current row.
const panelId = ref<string | null>(null);
const panelRow = computed<PriceRow | null>(
  () => rows.value.find((row) => row.productId === panelId.value) ?? null,
);

function showHistory(productId: string): void {
  dialogOpen.value = false;
  panelId.value = productId;
  panelOpen.value = true;
}

// `?history=<productId>` (from the Ctrl+K search) opens that product's panel once the list is
// there, then drops the parameter so a reload or the back button does not reopen it.
watch(
  () => [state.value, route.query.history] as const,
  ([current, productId]) => {
    if (current !== 'ready' || typeof productId !== 'string') return;
    const { history: _opened, ...rest } = route.query;
    void _opened;
    void router.replace({ query: rest }).then(() => showHistory(productId));
  },
  { immediate: true },
);

// --- back to top ---------------------------------------------------------------------------------

const showTop = ref(false);
let scroller: Element | Document | null = null;
function onScroll(event: Event): void {
  const source = event.target;
  const element =
    source instanceof Document
      ? source.scrollingElement
      : source instanceof Element
        ? source
        : null;
  if (!element) return;
  scroller = source instanceof Document ? source : element;
  showTop.value = element.scrollTop > 400;
}
function toTop(): void {
  const element = scroller instanceof Document ? scroller.scrollingElement : scroller;
  element?.scrollTo({ top: 0, behavior: 'smooth' });
}
onMounted(() => document.addEventListener('scroll', onScroll, { capture: true, passive: true }));
onBeforeUnmount(() => document.removeEventListener('scroll', onScroll, { capture: true }));

// --- the phone's "⋯" header menu ---------------------------------------------------------------

const moreOpen = ref(false);
</script>

<template>
  <section class="prices">
    <PricesSubHeader class="prices-head" :title="t('prices.title')">
      <!-- The design's line under the title: the published version, when, and the rate every so'm
           figure is derived from. -->
      <div class="subline">
        <span v-if="versionNumber !== null" class="vpill" data-testid="list-version">{{
          t('prices.page.published', { number: versionNumber })
        }}</span>
        <span v-if="publishedWhen" class="subline__when">{{ publishedWhen }}</span>
      </div>
      <!-- The design's header: Versiyalar · Guruhlarga yuborish · Excel · the orange "Ostatokdan
           qo'shish"; "Yangi tovar" and the sibling pages (Tovarlar, Yangi modellar) in "⋯". A
           tablet shows the first three as icons, a phone puts everything in "⋯". The menu stays
           mounted (v-show): the share and add actions own dialogs. -->
      <template #actions>
        <span class="head-actions">
          <template v-if="!phone">
            <RouterLink
              v-if="seesPriceAdmin"
              class="hbtn"
              :to="{ name: 'staff-price-versions' }"
              :title="t('prices.tabs.versions')"
            >
              <StaffIcon name="archive" :size="16" /><span class="hbtn__label">{{
                t('prices.tabs.versions')
              }}</span>
            </RouterLink>
            <PriceListShareActions :can-post="canEdit" />
          </template>
          <!-- The orange action: N = active stock products without a published price. -->
          <button
            v-if="canEdit && costVisible && !phone"
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
            <span class="addbtn__label">{{ t('prices.addFromStock') }}</span>
            <span v-if="unpricedCount > 0" class="addbtn__count num">{{ unpricedCount }}</span>
          </button>
          <span v-if="seesPriceAdmin || canEdit || !desktop" class="head-more-wrap">
            <button
              type="button"
              class="head-more"
              :aria-label="t('prices.page.moreActions')"
              aria-haspopup="true"
              :aria-expanded="moreOpen"
              data-testid="head-more"
              @click="moreOpen = !moreOpen"
            >
              <StaffIcon name="more" :size="20" />
            </button>
            <button
              v-if="moreOpen"
              type="button"
              class="head-away"
              tabindex="-1"
              :aria-label="t('common.close')"
              @click="moreOpen = false"
            />
            <span v-show="moreOpen" class="head-menu" data-testid="head-menu">
              <button
                v-if="canEdit && costVisible && phone"
                type="button"
                class="hbtn menu-add"
                :aria-label="
                  unpricedCount > 0
                    ? t('prices.addFromStockLabel', { count: unpricedCount })
                    : undefined
                "
                data-testid="add-from-stock"
                @click="goToStock"
              >
                <span class="menu-add__label">{{ t('prices.addFromStock') }}</span>
                <span v-if="unpricedCount > 0" class="menu-add__count num">{{
                  unpricedCount
                }}</span>
              </button>
              <template v-if="phone">
                <RouterLink
                  v-if="seesPriceAdmin"
                  class="hbtn"
                  :to="{ name: 'staff-price-versions' }"
                >
                  <StaffIcon name="archive" :size="16" />{{ t('prices.tabs.versions') }}
                </RouterLink>
                <PriceListShareActions :can-post="canEdit" />
              </template>
              <!-- Products the sheet does not have [C, 2026-11-09]: one by hand, or an Excel file. -->
              <NewProductMenu
                v-if="canEdit"
                @single="manualOpen = true"
                @import="importOpen = true"
              />
              <template v-if="seesPriceAdmin">
                <RouterLink class="hbtn" :to="{ name: 'staff-products' }">
                  <StaffIcon name="package" :size="16" />{{ t('prices.tabs.products') }}
                </RouterLink>
                <!-- The newer-model pairs the customer home draws on [C, 2026-11-09]. -->
                <RouterLink
                  class="hbtn"
                  :to="{ name: 'staff-newer-models' }"
                  data-testid="newer-models-link"
                >
                  <StaffIcon name="star" :size="16" />{{ t('newerModels.title') }}
                </RouterLink>
              </template>
            </span>
          </span>
        </span>
      </template>
    </PricesSubHeader>
    <!-- The rate every so'm figure is derived from, always in sight; a bar of its own under the
         header, as its source and notices take up to three lines (owner 2026-11-09). -->
    <UsdRateControl v-if="costVisible" class="ratebar" :can-edit="canEdit" />

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

      <div class="list">
        <!-- Ready views: one task each, with its count (on a phone they are in the sheet). -->
        <section v-if="!phone" class="block" aria-labelledby="prices-presets-label">
          <h2 id="prices-presets-label" class="block__label">
            {{ t('prices.page.presets.label') }}
          </h2>
          <div class="views" role="group" aria-labelledby="prices-presets-label">
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
                <span class="view__name">{{ presetLabel(view.key) }}</span>
                <span class="view__count num">{{ view.count }}</span>
              </span>
              <span class="view__cap">{{ t(`prices.page.presets.${view.key}Cap`) }}</span>
            </button>
          </div>
        </section>

        <section class="block block--filters" aria-labelledby="prices-filters-label">
          <h2 id="prices-filters-label" class="block__label">
            {{ t('prices.page.filtersLabel') }}
          </h2>
          <div class="frow">
            <SearchField
              v-model="search"
              class="frow__search"
              :placeholder="t('prices.page.searchPlaceholder')"
              label-hidden
            />
            <template v-if="desktop">
              <CategoryDropdown
                v-if="costVisible && productCategories.loaded.value"
                v-model="category"
                :prefix="t('staffCost.stock.chip.category')"
                :counts="counts"
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
                :model-value="priceType"
                :options="typeChoices"
                all-value="all"
                :all-label="t('prices.page.priceType.all')"
                :label="t('prices.page.priceType.label')"
                :search-placeholder="t('prices.page.priceType.search')"
                :no-match-text="t('prices.page.priceType.noMatch')"
                :clear-label="t('prices.page.priceType.clear')"
                :unknown-label="t('prices.page.priceType.all')"
                :count-text="
                  (count: number) => t('staffCost.supplierFilter.productsCount', { count }, count)
                "
                data-testid="price-type-filter"
                @update:model-value="setPriceType"
              />
              <AppSegmented
                v-model="shown"
                class="currency"
                :options="[
                  { value: 'USD', label: 'USD' },
                  { value: 'UZS', label: t('prices.currency.UZS') },
                ]"
                :label="t('prices.currency.label')"
                data-currency-switch
              />
            </template>
            <!-- The phone's one-tap currency switch beside the search (the design's 390). -->
            <button
              v-if="phone"
              type="button"
              class="frow__cur"
              :aria-label="`${t('prices.currency.label')}: ${shown === 'USD' ? 'USD' : t('prices.currency.UZS')}`"
              data-testid="currency-toggle"
              @click="shown = shown === 'USD' ? 'UZS' : 'USD'"
            >
              {{ shown === 'USD' ? 'USD' : t('prices.currency.UZS') }}
            </button>
            <button
              v-if="!desktop"
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

        <p v-if="costs.state.value === 'error'" class="inline-error" role="alert">
          <StaffIcon name="alert" :size="15" />
          <span class="inline-error__text">{{ t('staffCost.cost.loadFailed') }}</span>
          <AppButton variant="secondary" size="xs" @click="costs.reload()">
            {{ t('state.retry') }}
          </AppButton>
        </p>

        <div class="rbar">
          <span class="rbar__count" role="status" data-testid="list-footer">
            {{ shownText }}
            <span v-if="usdTiers" class="rbar__note">· {{ t('prices.page.tiersInUsd') }}</span>
          </span>
          <span v-if="!phone" class="rbar__tools">
            <AppDropdown
              :model-value="sort"
              :options="sortOptions"
              :label="t('prices.page.sort.label')"
              align="right"
              data-testid="prices-sort"
              @update:model-value="setSort"
            >
              <template #value="{ selected }">
                <span class="sortv"
                  ><span class="sortv__k">{{ t('prices.page.sort.label') }}:</span>
                  <b>{{ selected?.label }}</b></span
                >
              </template>
            </AppDropdown>
            <span class="toggle" role="group" :aria-label="t('staffCost.stock.layout.label')">
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
          <StaffIcon name="tags" :size="32" class="nomatch__icon" />
          <b>{{ t('prices.page.noMatch') }}</b>
          <AppButton variant="secondary" size="xs" @click="clearFilters">
            {{ t('staffCost.stock.resetFilters') }}
          </AppButton>
        </div>

        <PriceTable
          v-else-if="shownLayout === 'table'"
          :rows="pageViews"
          :wide="wide"
          :desktop="desktop"
          :show-markup="costVisible"
          :can-edit="canEdit"
          :menu-of="rowMenuOf"
          :label="t('prices.page.tableLabel')"
          @open="(view) => showHistory(view.row.productId)"
          @edit="(view) => openEdit(view.row)"
          @history="(view) => showHistory(view.row.productId)"
          @merge="(view) => startMerge(view.row.productId, view.row.sheetMatch)"
          @menu="onRowMenu"
        />

        <ul
          v-else-if="shownLayout === 'cards'"
          class="grid"
          :aria-label="t('prices.page.tableLabel')"
        >
          <li v-for="view in pageViews" :key="view.row.productId" class="grid__item">
            <PriceCard
              :view="view"
              :can-edit="canEdit"
              :show-tag-deferred="shown === 'USD'"
              :menu-open="cardMenuView?.row.productId === view.row.productId"
              @open="showHistory(view.row.productId)"
              @edit="openEdit(view.row)"
              @more="(anchor) => openCardMenu(view, anchor)"
              @menu="(at, focusAfter) => openCardMenuAt(view, at, focusAfter)"
            />
          </li>
        </ul>

        <ul v-else class="plist" :aria-label="t('prices.page.tableLabel')">
          <li v-for="view in pageViews" :key="view.row.productId">
            <PriceMobileRow
              :view="view"
              :can-edit="canEdit"
              @press="canEdit ? openEdit(view.row) : showHistory(view.row.productId)"
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

    <div v-if="showTop" class="topw">
      <button
        type="button"
        class="totop"
        :aria-label="t('prices.page.toTop')"
        data-testid="to-top"
        @click="toTop"
      >
        <StaffIcon name="down" :size="20" class="totop__icon" />
      </button>
    </div>

    <RowContextMenu
      ref="cardMenu"
      :label="
        cardMenuView
          ? t('prices.rowMenu.label', {
              code: cardMenuView.row.productCode,
              name: cardMenuView.name,
            })
          : ''
      "
      :items="cardMenuView ? rowMenuOf(cardMenuView) : []"
      @choose="(id: string) => cardMenuView && onRowMenu(cardMenuView, id)"
      @close="cardMenuView = null"
    />

    <StockFilterSheet
      v-if="!desktop"
      v-model="sheetOpen"
      :lists="sheetLists"
      :lead-groups="sheetLead"
      :tail-groups="sheetTail"
      :lists-label="t('prices.page.sheet.lists')"
      chevron-right
      :sorts="sortOptions"
      :sort="sort"
      :count="sorted.length"
      @pick="pickFromSheet"
      @sort="setSort"
      @clear="clearFilters"
    />

    <PriceHistoryDrawer
      v-model="panelOpen"
      :product-id="panelRow?.productId ?? null"
      :product-code="panelRow?.productCode ?? ''"
      :name="panelRow ? nameOf(panelRow) : ''"
      :show-price-history="seesPriceAdmin"
    >
      <ProductThumb
        v-if="panelRow?.imageUrl"
        :key="panelRow.productId"
        class="panel-photo"
        :src="panelRow.imageUrl"
        :large-src="panelRow.imageLargeUrl"
        :alt="nameOf(panelRow)"
        :size="96"
      />
      <AppButton
        v-if="panelRow && canEdit"
        class="panel-edit"
        @click="panelRow && openEdit(panelRow)"
      >
        <StaffIcon name="pencil" :size="15" />{{ t('prices.dialog.titleEdit') }}
      </AppButton>
      <SupplyHistory
        v-if="panelRow && costVisible && !panelRow.codeGenerated"
        :key="`s-${panelRow.productId}`"
        :product-id="panelRow.productId"
      />
    </PriceHistoryDrawer>

    <PriceEditDialog
      v-if="canEdit"
      v-model="dialogOpen"
      :product="target"
      :base-version-number="versionNumber"
      @saved="onSaved"
      @stale="reloadForDialog"
      @merge="startMerge"
      @photos-changed="reloadForDialog"
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

.list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.mono {
  font-family: var(--font-mono);
}

/* --- header -------------------------------------------------------------------------------- */

/* The design keeps the buttons on the title's right: the text side shrinks instead of pushing
   them to a line of their own. */
.prices-head {
  flex-wrap: nowrap;
  align-items: flex-start;
}

.prices-head :deep(.head__text) {
  flex: 1 0 auto;
  min-width: 150px;
}

.prices-head :deep(.head__actions) {
  position: relative;
  flex: 0 1 auto;
  width: auto;
  min-width: 0;
}

.prices-head :deep(.head__title) {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.subline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin-top: 6px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.vpill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--green-bg);
  color: var(--green);
  font-size: var(--fs-group);
  font-weight: 500;
  white-space: nowrap;
}

.subline__when {
  white-space: nowrap;
}

.ratebar {
  align-self: flex-start;
  max-width: 100%;
}

.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.head-more-wrap {
  position: relative;
  display: inline-flex;
}

.hbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: var(--r-btn-sm);
  background: var(--w);
  color: var(--ink);
  font-size: var(--fs-small);
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}

.hbtn:hover {
  background: var(--hov);
}

.hbtn:focus-visible,
.addbtn:focus-visible,
.head-more:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* The orange "Ostatokdan qo'shish" with a translucent count chip. */
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

.head-away {
  position: fixed;
  inset: 0;
  z-index: 21;
  border: 0;
  background: transparent;
}

.head-menu {
  position: absolute;
  top: 50px;
  right: 0;
  z-index: 22;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-width: 240px;
  padding: 6px;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: var(--sh-dropdown);
}

.head-menu .hbtn,
.head-menu .addbtn,
.prices .head-menu :deep(.chip) {
  justify-content: flex-start;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border: 0;
  box-shadow: none;
}

.head-menu .hbtn {
  background: transparent;
}

.head-menu .hbtn:hover {
  background: var(--hov);
}

.head-menu :deep(.chipmenu) {
  width: 100%;
}

/* The phone menu's first item: «Ostatokdan qo'shish» with the orange count. */
.menu-add {
  gap: 10px;
  font-weight: 600;
}

.menu-add__count {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-meta);
}

/* --- ready views and filters (the Qoldiq page's design system) ------------------------------ */

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
  min-width: 170px;
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

.frow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.frow__search {
  flex: 1 1 220px;
  min-width: 0;
}

.frow :deep(.catdd__field) {
  height: 44px;
}

.frow :deep(.catdd__value) {
  font-weight: 600;
}

.frow :deep(.catdd) {
  flex: 0 1 210px;
  min-width: 170px;
}

.frow :deep(.fmenu) {
  flex: 0 1 210px;
  min-width: 170px;
}

.currency {
  flex: none;
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

.frow__cur {
  flex: none;
  height: 48px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: var(--r-btn-sm);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  cursor: pointer;
}

.frow__cur:focus-visible,
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
.toggle button:focus-visible,
.totop:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.inline-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-input);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.inline-error__text {
  flex: 1;
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

.rbar__note {
  color: var(--t3);
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

.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.grid__item {
  display: flex;
  min-width: 0;
}

.grid__item > * {
  flex: 1;
}

.plist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Back to top: sticks to the bottom right of the page while it scrolls. */
.topw {
  position: sticky;
  bottom: 0;
  z-index: 17;
  display: flex;
  justify-content: flex-end;
  height: 0;
  pointer-events: none;
}

.totop {
  position: relative;
  top: -72px;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-right: 8px;
  border: 1px solid var(--e8);
  border-radius: 50%;
  background: var(--w);
  color: var(--ink);
  box-shadow: var(--sh-dropdown);
  cursor: pointer;
  pointer-events: auto;
}

.totop__icon {
  transform: rotate(180deg);
}

.totop:hover {
  background: var(--hov);
}

.panel-edit {
  align-self: stretch;
}

.panel-photo {
  align-self: flex-start;
}

.remove-target {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}

.remove-target__name {
  font-weight: 600;
}

.remove-target__code {
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 1439px) {
  .head-actions > .hbtn .hbtn__label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .head-actions > .hbtn {
    width: 40px;
    padding: 0;
  }

  .head-actions > :deep(.chipmenu > .chip),
  .head-actions > :deep(.chip) {
    gap: 0;
    min-width: 40px;
    padding-right: 0;
    padding-left: 0;
    justify-content: center;
    font-size: 0;
  }

  .head-actions > :deep(.chipmenu > .chip .chip__caret) {
    display: none;
  }
}

@media (max-width: 1279px) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

/* Tablet: the views become pills (the chosen one dark), the header buttons icon-only. */
@media (max-width: 1023px) {
  .list {
    gap: 14px;
  }

  .block__label,
  .view__cap,
  .chips__count {
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
    min-height: 36px;
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
    gap: 12px;
  }

  .totop {
    top: -140px;
  }
}

/* Phone: the search and the filter button first, the chips scroll sideways, the compact list. */
@media (max-width: 599px) {
  .prices-head :deep(.head__title) {
    font-size: 20px;
  }

  .subline__when {
    display: none;
  }

  .list {
    gap: 10px;
  }

  .frow__sheet {
    width: 48px;
    height: 48px;
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
}

@media (pointer: coarse) {
  .view,
  .chip__x {
    min-height: 44px;
  }

  .chip__x {
    min-width: 44px;
  }
}
</style>
