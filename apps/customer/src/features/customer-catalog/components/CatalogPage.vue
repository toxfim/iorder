<script setup lang="ts">
import type { CustomerPriceListResponse } from '@iorder/shared';
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import AppIcon from '@core/components/ui/AppIcon.vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useInfiniteScroll } from '@core/composables/use-infinite-scroll';
import { showToast } from '@core/composables/use-toast';
import { useCustomerServices } from '@/features/customer-app/services';
import CartSummaryBar from '@/features/customer-cart/components/CartSummaryBar.vue';
import QuantityStepper from '@/features/customer-cart/components/QuantityStepper.vue';
import RemovalUndo from '@/features/customer-cart/components/RemovalUndo.vue';
import { useCartActions } from '@/features/customer-cart/composables/use-cart-actions';
import { useFormat } from '@core/i18n/use-format';
import { useLocale } from '@core/i18n/use-locale';
import { ApiNotFoundError } from '@core/lib/api-errors';
import {
  SELECT_ALL,
  chipTabKey,
  filterBySelection,
  groupByCategory,
  knownSelections,
  outOfStockLast,
  readStoredSelection,
  resolveSelection,
  scrollDeltaToListTop,
  selectionOf,
  writeStoredSelection,
} from '../domain/category-groups';
import CategoryChips from './CategoryChips.vue';
import CustomerSheet from '@/features/customer-app/components/CustomerSheet.vue';

const { t } = useI18n();
const { priceApi, cart } = useCustomerServices();
const { locale } = useLocale();
const { formatMoneyWithCurrency, formatDate, formatNumber, formatUnit } = useFormat();
const actions = useCartActions();

// "No price list yet" (404) is an empty screen, not a failure.
const view = useAsyncView<CustomerPriceListResponse | null>(
  () =>
    priceApi.getCurrent(locale.value).catch((caught: unknown) => {
      if (caught instanceof ApiNotFoundError) return null;
      throw caught;
    }),
  { isEmpty: (list) => list === null || list.items.length === 0 },
);
// The page stays alive between visits; prices older than this are read again on the way back.
const REFRESH_AFTER_MS = 5 * 60 * 1000;
let leftAt: number | null = null;
onDeactivated(() => {
  leftAt = Date.now();
});
onActivated(() => {
  if (leftAt !== null && Date.now() - leftAt > REFRESH_AFTER_MS) void view.reload();
  leftAt = null;
});

// Product names come in the person's language, so a language switch reloads the list.
watch(locale, () => void view.reload());

const query = ref('');
const allItems = computed(() => view.data.value?.items ?? []);
// Search narrows the list first; the category bar then shows how many matches each category has.
const matched = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle === ''
    ? allItems.value
    : allItems.value.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.productCode.toLowerCase().includes(needle),
      );
});

// ---- categories ---------------------------------------------------------------------------
const PANEL_ID = 'catalog-panel';
const TABS_PREFIX = 'catalog-cat';
const route = useRoute();
const router = useRouter();

// Chips come from the WHOLE list, so they do not appear and disappear while the person types.
const knownGroups = computed(() => groupByCategory(allItems.value, locale.value));
const known = computed(() => knownSelections(knownGroups.value));

// What the URL or the session asked for. It is untrusted: `selection` is only ever a category
// the loaded list really has. A URL with `?category=` is authoritative, even when invalid.
const urlCategory = (): string | undefined => {
  const raw = route.query.category;
  return raw === undefined ? undefined : typeof raw === 'string' ? raw : SELECT_ALL;
};
const requested = ref<string>(urlCategory() ?? readStoredSelection() ?? SELECT_ALL);
const selection = computed(() => resolveSelection(requested.value, known.value));

// "All" is the absence of the parameter: an empty `?category=` is as invalid as an unknown value.
function urlSaysSelection(value: string): boolean {
  return value === SELECT_ALL ? route.query.category === undefined : route.query.category === value;
}
function remember(value: string): void {
  writeStoredSelection(value);
  if (urlSaysSelection(value)) return;
  const nextQuery = { ...route.query };
  if (value === SELECT_ALL) delete nextQuery.category;
  else nextQuery.category = value;
  void router.replace({ query: nextQuery });
}
function select(value: string): void {
  requested.value = value;
  remember(value);
}
// A shorter list would otherwise leave the person scrolled past its top, looking at empty space.
async function keepListTopVisible(): Promise<void> {
  await nextTick();
  const panel = document.getElementById(PANEL_ID);
  if (!panel || !tools.value) return;
  const delta = scrollDeltaToListTop(
    panel.getBoundingClientRect().top,
    tools.value.getBoundingClientRect().bottom,
  );
  if (delta !== 0) window.scrollBy({ top: delta });
}
function choose(value: string): void {
  select(value);
  void keepListTopVisible();
}
// Back/forward and links that change only the query.
watch(
  () => route.query.category,
  () => {
    requested.value = urlCategory() ?? SELECT_ALL;
    settle();
  },
);
// Once the list is known, the URL and the session are made to say exactly what is shown: a deep
// link to an unknown category (or one that vanished in a new price list) ends up on "All", and a
// category restored from the session becomes a shareable link.
function settle(): void {
  if (view.state.value !== 'ready') return;
  const shown = selection.value;
  if (requested.value !== shown || !urlSaysSelection(shown)) select(shown);
}
watch(() => [view.state.value, selection.value], settle, { immediate: true });

const chips = computed(() => {
  const counts = new Map<string, number>();
  for (const item of matched.value) {
    const key = selectionOf(item.category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [
    { value: SELECT_ALL, label: t('customer.catalog.categories.all'), count: matched.value.length },
    ...knownGroups.value.map((group) => ({
      value: selectionOf(group.category),
      label: group.category ?? t('customer.catalog.categories.other'),
      count: counts.get(selectionOf(group.category)) ?? 0,
    })),
  ];
});
const activeTabId = computed(() => {
  const index = chips.value.findIndex((chip) => chip.value === selection.value);
  return `${TABS_PREFIX}-tab-${chipTabKey(Math.max(index, 0))}`;
});

const items = computed(() => filterBySelection(matched.value, selection.value));
// "All" is browsed grouped under headings; one chosen category needs no heading. Within a group the
// out-of-stock products come last, by the LIST's figure: the cart's fresher figure (`stockOf`)
// must not reorder the cards under the person's finger.
const groups = computed(() =>
  groupByCategory(items.value, locale.value).map((group) => ({
    ...group,
    items: outOfStockLast(group.items),
  })),
);

// The whole list is loaded at once (search and the category counts need it), but the cards are
// put on the page a batch at a time as the person scrolls: a phone then builds and downloads
// photos only for what is near the screen. Any filter change starts again from the top batch.
const CARD_BATCH = 24;
const shownCount = ref(CARD_BATCH);
watch([items, selection], () => {
  shownCount.value = CARD_BATCH;
});
const shownGroups = computed(() => {
  let left = shownCount.value;
  const shown: { category: string | null; total: number; items: typeof items.value }[] = [];
  for (const group of groups.value) {
    if (left <= 0) break;
    shown.push({
      category: group.category,
      total: group.items.length,
      items: group.items.slice(0, left),
    });
    left -= group.items.length;
  }
  return shown;
});
const hasMoreCards = computed(() => shownCount.value < items.value.length);
const listEnd = ref<HTMLElement | null>(null);
useInfiniteScroll(listEnd, () => {
  if (!hasMoreCards.value) return false;
  shownCount.value += CARD_BATCH;
  return true;
});

// Cards show the small photo (thumb); a tap opens the large one.
type CatalogItem = (typeof items.value)[number];
// The photo stays set after closing, so the dialog keeps it during its closing animation.
const photo = ref<{ name: string; url: string } | null>(null);
const photoOpen = ref(false);
function openPhoto(item: CatalogItem): void {
  const url = item.imageLargeUrl ?? item.imageUrl;
  if (url === null) return;
  photo.value = { name: item.name, url };
  photoOpen.value = true;
}
const showHeadings = computed(() => selection.value === SELECT_ALL);
const canClear = computed(() => query.value.trim() !== '' || selection.value !== SELECT_ALL);
function clearFilters(): void {
  query.value = '';
  choose(SELECT_ALL);
}

// The group headings stick right under the search and category bar, whose height varies.
const tools = ref<HTMLElement | null>(null);
const toolsHeight = ref(0);
let resizeObserver: ResizeObserver | undefined;
// The element exists only once the list is ready, hence a watch instead of onMounted.
watch(tools, (el) => {
  resizeObserver?.disconnect();
  if (!el) return;
  toolsHeight.value = el.offsetHeight;
  if (typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    toolsHeight.value = el.offsetHeight;
  });
  resizeObserver.observe(el);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const version = computed(() => {
  const found = view.data.value?.version;
  return found
    ? t('customer.catalog.version', {
        number: found.number,
        date: formatDate(found.publishedAt),
      })
    : '';
});

// How many pieces can be ordered now; 0 = out of stock; null = show nothing and no limit. A
// product in the cart takes the cart's figure: every cart answer refreshes it, while the list may
// be minutes old.
function stockOf(item: CatalogItem): number | null {
  const inCart = cart.stockLimitOf(item.productId);
  return inCart === undefined ? item.orderableStock : inCart;
}
const stockLineId = (item: CatalogItem): string => `catalog-stock-${item.productId}`;
/** The add button: the first piece, or, out of stock, the reason why not (never a silent press). */
function addFirst(item: CatalogItem): void {
  if (stockOf(item) === 0) {
    showToast({ message: t('apiErrors.stockLimitExceededNone') });
    return;
  }
  void actions.setQuantity(item.productId, item.name, '1');
}

// The stepper sends a quantity, or null to remove the line.
const commitFor =
  (productId: string, name: string) =>
  (quantity: string | null): Promise<boolean> =>
    quantity === null
      ? actions.remove(productId, name)
      : actions.setQuantity(productId, name, quantity);

const hasCart = computed(() => cart.itemCount.value > 0);
const categoryOpen = ref(false);
const categoryQuery = ref('');
watch(categoryOpen, () => {
  categoryQuery.value = '';
});
const selectedCategoryLabel = computed(
  () => chips.value.find((chip) => chip.value === selection.value)?.label ?? '',
);
const visibleCategories = computed(() =>
  chips.value.filter((chip) =>
    chip.label.toLocaleLowerCase().includes(categoryQuery.value.trim().toLocaleLowerCase()),
  ),
);
function chooseCategory(value: string): void {
  choose(value);
  categoryOpen.value = false;
  categoryQuery.value = '';
}
</script>

<template>
  <section
    class="catalog"
    :class="{ 'catalog--with-bar': hasCart }"
    :style="{ '--tools-h': `${toolsHeight}px` }"
  >
    <header class="head">
      <h1 class="head__title">{{ t('customer.presentation.products') }}</h1>
      <p v-if="version" class="head__meta">{{ version }}</p>
    </header>

    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('customer.catalog.noPriceList.title') : undefined"
      :description="
        view.state.value === 'empty' ? t('customer.catalog.noPriceList.description') : undefined
      "
      @retry="view.reload()"
    >
      <!-- Search and the column heads stay in view while the list scrolls. -->
      <div ref="tools" class="tools">
        <div class="tools__search">
          <SearchField v-model="query" :placeholder="t('customer.catalog.search')" />
          <p class="tools__count">{{ t('customer.catalog.count', { count: items.length }) }}</p>
        </div>
        <button
          type="button"
          class="category-trigger"
          aria-haspopup="dialog"
          :aria-expanded="categoryOpen"
          @click="categoryOpen = true"
        >
          <span>{{ t('customer.presentation.category', { name: selectedCategoryLabel }) }}</span
          ><AppIcon name="chevron" :size="14" aria-hidden="true" />
        </button>
        <div class="desktop-categories">
          <CategoryChips
            :model-value="selection"
            :chips="chips"
            :label="t('customer.catalog.categories.label')"
            :id-prefix="TABS_PREFIX"
            :panel-id="PANEL_ID"
            @update:model-value="choose"
          />
        </div>
        <div class="category-results">
          <span>{{ t('customer.catalog.count', { count: items.length }) }}</span>
          <span>{{ t('customer.presentation.pricesInUzs') }}</span>
        </div>
      </div>

      <RemovalUndo
        v-if="actions.removed.value"
        :line="actions.removed.value"
        :error="actions.restoreError.value"
        @restore="actions.restore()"
        @dismiss="actions.dismissUndo()"
      />

      <div
        :id="PANEL_ID"
        role="tabpanel"
        class="panel"
        :aria-labelledby="activeTabId"
        tabindex="-1"
      >
        <section
          v-for="(group, index) in shownGroups"
          :key="selectionOf(group.category)"
          class="group"
          data-testid="catalog-group"
        >
          <h2 v-if="showHeadings" :id="`catalog-group-${index}`" class="group__title">
            {{ group.category ?? t('customer.catalog.categories.other') }}
            <span class="group__count">{{ group.total }}</span>
          </h2>
          <ul
            class="grid"
            role="list"
            :aria-labelledby="showHeadings ? `catalog-group-${index}` : undefined"
            :aria-label="
              showHeadings ? undefined : (group.category ?? t('customer.catalog.categories.other'))
            "
          >
            <li
              v-for="item in group.items"
              :key="item.productId"
              class="card"
              :class="{ 'card--out': stockOf(item) === 0 }"
              role="listitem"
            >
              <button
                v-if="item.imageUrl !== null"
                type="button"
                class="card__photo"
                :aria-label="t('customer.catalog.photo.open', { name: item.name })"
                @click="openPhoto(item)"
              >
                <img
                  class="card__img"
                  :src="item.imageUrl"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width="256"
                  height="256"
                />
              </button>
              <div v-else class="card__photo card__photo--none" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor">
                  <rect x="3" y="4" width="18" height="16" rx="3" stroke-width="1.5" />
                  <circle cx="9" cy="10" r="2" stroke-width="1.5" />
                  <path d="m21 16-5-5-9 9" stroke-width="1.5" />
                </svg>
              </div>
              <h3 class="card__name">{{ item.name }}</h3>
              <p class="card__meta">
                <span class="card__code">{{ item.productCode }}</span> ·
                <span>{{ formatUnit(item.unit) }}</span>
              </p>
              <p class="card__price">
                {{ formatMoneyWithCurrency(item.price) }}
              </p>
              <!-- Only when the server gives a figure: a product without one shows nothing here,
                   and looks like any other product. Zero is said in words: out of stock. -->
              <p
                v-if="stockOf(item) !== null"
                :id="stockLineId(item)"
                class="card__stock"
                :class="{ 'card__stock--out': stockOf(item) === 0 }"
                data-testid="card-stock"
              >
                {{
                  stockOf(item) === 0
                    ? t('customer.stock.out')
                    : t('customer.stock.available', {
                        count: formatNumber(String(stockOf(item))),
                        unit: formatUnit(item.unit),
                      })
                }}
              </p>
              <div class="card__action">
                <QuantityStepper
                  v-if="cart.quantityOf(item.productId) !== null"
                  :model-value="cart.quantityOf(item.productId) ?? '1'"
                  :label="t('customer.quantity.label', { name: item.name })"
                  :name="item.name"
                  :commit="commitFor(item.productId, item.name)"
                  :max="stockOf(item)"
                  :unit="item.unit"
                />
                <!-- Out of stock: the control is off (soft, so it stays reachable) with the reason
                     right above it, and a press says why instead of doing nothing. -->
                <AppButton
                  v-else
                  variant="dark"
                  size="lg"
                  block
                  :soft-disabled="stockOf(item) === 0"
                  :aria-describedby="stockOf(item) === 0 ? stockLineId(item) : undefined"
                  :loading="cart.isPending(item.productId)"
                  :aria-label="`${t('customer.catalog.add')}: ${item.name}`"
                  @click="addFirst(item)"
                >
                  <span aria-hidden="true">{{ '+' }}</span> {{ t('customer.catalog.add') }}
                </AppButton>
              </div>
            </li>
          </ul>
        </section>
        <div v-if="hasMoreCards" ref="listEnd" class="more">
          <AppButton variant="secondary" size="lg" block @click="shownCount += CARD_BATCH">
            {{ t('customer.catalog.showMore') }}
          </AppButton>
        </div>
        <div v-if="groups.length === 0" class="none">
          <p class="none__text">{{ t('customer.catalog.noResults') }}</p>
          <AppButton v-if="canClear" variant="secondary" size="lg" @click="clearFilters()">
            {{ t('customer.catalog.categories.clear') }}
          </AppButton>
        </div>
      </div>
    </StateView>

    <CartSummaryBar />
    <AppModal v-model="photoOpen" :title="photo?.name ?? ''" max-width="720px">
      <img v-if="photo" class="photo-view" :src="photo.url" :alt="photo.name" decoding="async" />
      <template #footer>
        <AppButton variant="secondary" size="lg" @click="photoOpen = false">
          {{ t('customer.catalog.photo.close') }}
        </AppButton>
      </template>
    </AppModal>
    <CustomerSheet
      v-model="categoryOpen"
      variant="categories"
      :title="t('customer.catalog.categories.label')"
    >
      <SearchField
        v-model="categoryQuery"
        class="category-search"
        :placeholder="t('customer.presentation.categorySearch')"
      />
      <div class="category-options">
        <button
          v-for="chip in visibleCategories"
          :key="chip.value"
          type="button"
          :aria-pressed="chip.value === selection"
          :class="{ selected: chip.value === selection }"
          @click="chooseCategory(chip.value)"
        >
          <span>{{ chip.label }}</span
          ><span v-if="chip.value === selection" aria-hidden="true">{{ '✓' }}</span>
        </button>
      </div>
      <p v-if="visibleCategories.length === 0">{{ t('customer.catalog.noResults') }}</p>
    </CustomerSheet>
    <p class="sr-only" role="status" aria-live="polite">
      <span :key="actions.announcementSeq.value">{{ actions.announcement.value }}</span>
    </p>
  </section>
</template>

<style scoped>
.category-trigger {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--gap-card);
  width: 100%;
  min-height: var(--customer-category-trigger-h);
  padding: 0 var(--gap-card);
  background: var(--w);
  color: var(--ink);
  border: 0;
  border-radius: var(--r-btn-sm);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  line-height: var(--customer-category-leading);
  cursor: pointer;
}
.category-trigger > span:last-child {
  color: var(--acc-fg);
  font-size: var(--customer-category-chevron-size);
}
.category-results {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--gap-card);
  margin-top: var(--r-panel);
  color: var(--t3);
  font-size: var(--fs-meta);
  line-height: var(--customer-category-leading);
}
.category-results > span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 500;
}
.category-results > span:last-child {
  flex: none;
  font-size: var(--fs-group);
}
.category-search {
  max-width: none;
  flex: none;
}
.category-search :deep(.search__label) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.category-search :deep(.search__box) {
  height: var(--customer-category-search-h);
  border: 0;
  background: var(--page);
  padding-inline: var(--gap-card);
  gap: var(--r-btn-sm);
}
.category-search :deep(.search__input) {
  font-size: var(--fs-small);
  line-height: var(--customer-category-leading);
}
.desktop-categories {
  display: none;
}
.category-options {
  display: grid;
  margin-top: var(--r-panel);
}
.category-options button {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-card);
  align-items: center;
  text-align: start;
  min-height: var(--customer-category-option-h);
  padding: var(--gap-card);
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body);
  line-height: var(--customer-category-leading);
  overflow-wrap: anywhere;
  cursor: pointer;
}
.category-options .selected {
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-weight: 600;
}
@media (min-width: 960px) {
  .category-trigger,
  .category-results {
    display: none;
  }
  .desktop-categories {
    display: block;
  }
}
.catalog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Keeps the last rows clear of the bar that sits above the bottom menu. */
.catalog--with-bar {
  padding-bottom: 72px;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.head__title {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.head__meta {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}

/* The search label is redundant next to its placeholder, but stays for screen readers. */
.tools {
  position: sticky;
  top: var(--customer-content-top);
  z-index: var(--z-sticky);
  margin: 0 -16px;
  padding: 8px 16px 0;
  background: var(--page);
}

.tools__search {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding-bottom: 8px;
}

.tools__search :deep(.search) {
  max-width: none;
}

.tools__search :deep(.search__label) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.tools__count {
  flex: none;
  margin: 0 0 12px;
  font-size: var(--fs-small);
  color: var(--t3);
  white-space: nowrap;
}

/* Cards: two columns on a phone (design "Two-column photo grid"), more as the screen widens. */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 12px;
  border-radius: var(--r-panel);
  background: var(--w);
}

/* Square photo area; the photo is fitted inside, never cropped. */
.card__photo {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  width: 100%;
  margin: 0 0 10px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  cursor: zoom-in;
}

.card__photo:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.card__photo--none {
  background: var(--f5);
  color: var(--d9);
  cursor: default;
}

.card__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.card__name {
  margin: 0;
  font-size: var(--fs-body-lg);
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.card__meta {
  margin: 4px 0 0;
  font-size: var(--fs-meta);
  color: var(--t3);
  overflow-wrap: anywhere;
}

.card__code {
  font-family: var(--font-mono);
}

.card__price {
  margin: 8px 0 0;
  font-size: var(--fs-body-lg);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* Secondary to the price: small, at normal text contrast. Absent for most products, so it sits in
   the flow above the control (which is pinned to the bottom) and never shifts the buttons. */
.card__stock {
  margin: 2px 0 0;
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
  overflow-wrap: anywhere;
}

/* Out of stock: an honest, quiet state. The name and the price step back to the muted text
   token (never a fractional opacity: its contrast is controlled by no token, see the dark-mode
   audit) and the photo loses its colour; the reason keeps its weight so it is read before the
   greyed button under it. */
.card__stock--out {
  font-weight: 600;
}

.card--out .card__name,
.card--out .card__price {
  color: var(--t3);
}

.card--out .card__photo {
  filter: grayscale(1);
}

/* The control sits at the bottom, so the buttons of one row line up whatever the name length. */
.card__action {
  margin-top: auto;
  padding-top: 10px;
}

/* In a card the stepper fills the width, in the accent tint of the design. */
.card__action :deep(.stepper) {
  align-items: stretch;
}

.card__action :deep(.stepper__box) {
  width: 100%;
  border-color: transparent;
  background: var(--acc-bg);
}

.card__action :deep(.stepper__btn) {
  background: transparent;
  color: var(--acc-fg);
  font-weight: 600;
}

.card__action :deep(.stepper__input) {
  flex: 1;
  width: auto;
  color: var(--acc-fg);
}

/* At the stock limit the plus is muted here too (the tint above would otherwise keep it loud). */
.card__action :deep(.stepper__btn--limit) {
  background: transparent;
  color: var(--b5);
}

/* The note may be longer than the narrow card's default cap: it wraps inside the card. */
.card__action :deep(.stepper__note) {
  max-width: none;
}

.more {
  margin-top: 4px;
}

.photo-view {
  display: block;
  width: 100%;
  max-height: 70vh;
  object-fit: contain;
}

.none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin: 24px 0;
  color: var(--t3);
}

.none__text {
  margin: 0;
}

.panel {
  display: grid;
  gap: 8px;
  outline: none;
}

/* Sticky under the search and category bar; the tools bar is measured because it can wrap. */
.group__title {
  position: sticky;
  top: calc(var(--customer-content-top) + var(--tools-h, 0px));
  z-index: calc(var(--z-sticky) - 1);
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 8px 0 6px;
  border-bottom: 1px solid var(--e8);
  background: var(--page);
  font-size: var(--fs-small);
  font-weight: 650;
  color: var(--t2);
}

.group__count {
  font-weight: 500;
  color: var(--t3);
  font-variant-numeric: tabular-nums;
}

@media (min-width: 640px) {
  .tools {
    margin: 0 -24px;
    padding-right: 24px;
    padding-left: 24px;
  }

  .grid {
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 16px;
  }
}

@media (min-width: 960px) {
  .tools {
    /* Under the header AND the top menu (both sticky), not behind the menu. */
    top: var(--customer-content-top);
    margin: 0;
    padding: 8px 0 0;
  }

  /* Category subheader: under the header, the top menu and the tools bar. */
  .group__title {
    top: calc(var(--customer-content-top) + var(--tools-h, 0px));
    margin-bottom: 12px;
    padding: 8px 12px;
    background: var(--f5);
  }

  .card:hover {
    box-shadow: 0 0 0 1px var(--e8);
  }

  /* A desktop row holds four or five roomy cards instead of six narrow ones; the photo, name and
     price read at a glance and a short category no longer looks like a lone thumbnail. */
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 20px;
  }

  .catalog--with-bar {
    padding-bottom: 80px;
  }
}
</style>

<style scoped>
@media (max-width: 959px) {
  .tools__count {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .group__title {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .tools {
    display: flex;
    flex-direction: column;
    gap: var(--r-panel);
    padding-top: 0;
  }
  .tools__search {
    padding-bottom: 0;
  }
  .category-results {
    margin-top: 0;
  }
  .catalog {
    gap: var(--r-panel);
  }
  /* The category headings are hidden here, so the cards of all categories flow in ONE grid
     (no half-empty row at the end of each category). The roles keep the list semantics. */
  .panel {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }
  .group,
  .grid {
    display: contents;
  }
  .more,
  .none {
    grid-column: 1 / -1;
  }
}
</style>
