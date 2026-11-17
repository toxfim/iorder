<script setup lang="ts">
import type { ByOrderOpenStatus, ByOrderProduct } from '@iorder/shared/staff-cost';
import { computed, defineAsyncComponent, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppDrawer from '@/components/ui/AppDrawer.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { ManualProductCreated } from '@/features/pricing/components/ManualProductDialog.vue';
import NewProductMenu from '@/features/pricing/components/NewProductMenu.vue';
import type { PriceImported } from '@/features/pricing/components/PriceImportDialog.vue';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { canEditPrices } from '@/features/staff-shell/price-access';
import AppBadge, { type BadgeTone } from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { ApiNotFoundError } from '@core/lib/api-errors';
import { useFormat } from '@core/i18n/use-format';
import { describePricingError } from '@core/lib/price-errors';
import { useCostFormat } from '../composables/use-cost-format';
import { byOrderSummary, matchesByOrderSearch } from '../domain/by-order';
import { toScaled } from '../domain/decimal';

// "Buyurtma orqali" (owner, 2026-11-09): the products staff added without a sheet «Товар_ID» are
// not kept in the warehouse, they are brought when an order arrives. The stock page cannot say
// how many are needed (they have no stock), so this page does: per product, the pieces open
// orders wait for and those orders. STAFF VOCABULARY ONLY: the customer never sees this type.
// UI convenience only: the api answers the roles of the stock page and nobody else.
const { t } = useI18n();
const { byOrderApi, pricingApi, currentUser } = useServices();
const { formatUsd, formatUzsWithCurrency, formatQuantity } = useCostFormat();
const { formatDateTime } = useFormat();

const view = useAsyncView(() => byOrderApi.list(), {
  isEmpty: (answer) => answer.items.length === 0,
});
const items = computed<readonly ByOrderProduct[]>(() => view.data.value?.items ?? []);

// --- adding by-order products here (owner, 2026-11-10) ------------------------------------------
// The same two ways as on Narxlar: one product, or the Excel template (a row without «Tovar ID»
// becomes a by-order product). Both publish the next price list version, so they need the
// published version number; it is read only for the roles that may change prices (manager,
// admin). UI convenience only: the server refuses everybody else.
const canEdit = canEditPrices(currentUser.user.value?.staffRoles ?? []);
// Loaded on demand: they live in the Narxlar route group, and a static import from this page put
// the two lazy chunks into an import cycle (the staff bundle check refuses one).
const ManualProductDialog = defineAsyncComponent(
  () => import('@/features/pricing/components/ManualProductDialog.vue'),
);
const PriceImportDialog = defineAsyncComponent(
  () => import('@/features/pricing/components/PriceImportDialog.vue'),
);
const manualOpen = ref(false);
const importOpen = ref(false);
const baseVersionNumber = ref<number | null>(null);
/** The by-order products of the published list: what the filled template holds. */
const generatedCount = ref(0);

async function loadVersion(): Promise<void> {
  if (!canEdit) return;
  try {
    const list = await pricingApi.getCurrent();
    baseVersionNumber.value = list.version.number;
    generatedCount.value = list.items.filter((item) => item.codeGenerated).length;
  } catch (caught) {
    // Nothing published yet: the first product added here publishes version 1.
    if (caught instanceof ApiNotFoundError) {
      baseVersionNumber.value = null;
      generatedCount.value = 0;
    }
    // Any other failure surfaces in the dialog itself: its request is refused as stale.
  }
}
void loadVersion();

/** The categories by-order products already have, offered while one is typed. */
const knownCategories = computed(() =>
  [...new Set(items.value.map((item) => item.category))]
    .filter((value): value is string => value !== null)
    .sort((a, b) => a.localeCompare(b)),
);

function afterAdd(): void {
  void view.reload();
  void loadVersion();
}

function onManualCreated(result: ManualProductCreated): void {
  showToast({
    message: t('staffCost.manual.created', {
      name: result.name,
      code: result.productCode,
      number: result.versionNumber,
    }),
  });
  afterAdd();
}

function onImported(result: PriceImported): void {
  showToast({ message: t('staffCost.priceImport.done.title', { number: result.versionNumber }) });
  afterAdd();
}

const search = ref('');
// The server's order stays: products needed now first, the longest wait at the top.
const visible = computed(() =>
  items.value.filter((item) => matchesByOrderSearch(item, search.value)),
);

const summary = computed(() => byOrderSummary(items.value));
const subtitle = computed(() => {
  if (view.state.value !== 'ready') return undefined;
  return summary.value.products > 0
    ? t('staffCost.byOrder.subtitleNeeded', {
        products: summary.value.products,
        pieces: formatQuantity(summary.value.pieces),
        orders: summary.value.orders,
      })
    : t('staffCost.byOrder.subtitleIdle', { count: items.value.length });
});

const errorText = computed(() =>
  translateDescribed(t, describePricingError('load', view.error.value)),
);

const pieces = (quantity: string): string =>
  t('staffCost.byOrder.pieces', { count: formatQuantity(quantity) });
const waits = (item: ByOrderProduct): boolean => item.openOrderCount > 0;
/** A legacy so'm item shows in so'm; every by-order product added today is priced in dollars. */
const money = (item: ByOrderProduct, value: string): string =>
  item.currency === 'UZS' ? formatUzsWithCurrency(value) : formatUsd(value);

// The three statuses an order can wait in; the same tones as the order lists.
const STATUS_TONES: Record<ByOrderOpenStatus, BadgeTone> = {
  SUBMITTED: 'accent',
  MANAGER_APPROVED: 'accent',
  ACCOUNTING_CLEARED: 'info',
};

const compareText = (a: string, b: string): number => a.localeCompare(b);
const columns = computed<DataTableColumn<ByOrderProduct>[]>(() => [
  {
    key: 'product',
    label: t('staffCost.byOrder.columns.product'),
    minWidth: '260px',
    text: (row) => row.name,
    compare: (a, b) => compareText(a.name, b.name),
  },
  {
    key: 'brand',
    label: t('staffCost.byOrder.columns.brand'),
    width: '150px',
    text: (row) => row.brandName ?? t('staffCost.byOrder.noBrand'),
    compare: (a, b) => compareText(a.brandName ?? '', b.brandName ?? ''),
    hasSortValue: (row) => row.brandName !== null,
  },
  {
    key: 'price',
    label: t('staffCost.byOrder.columns.price'),
    align: 'end',
    width: '150px',
    compare: (a, b) => {
      const left = toScaled(a.basePrice ?? '0', 2);
      const right = toScaled(b.basePrice ?? '0', 2);
      return left === right ? 0 : left < right ? -1 : 1;
    },
    hasSortValue: (row) => row.basePrice !== null,
  },
  {
    key: 'waiting',
    label: t('staffCost.byOrder.columns.waiting'),
    align: 'end',
    width: '160px',
    compare: (a, b) => {
      const left = toScaled(a.openQuantity, 3);
      const right = toScaled(b.openQuantity, 3);
      return left === right ? 0 : left < right ? -1 : 1;
    },
  },
  {
    key: 'orders',
    label: t('staffCost.byOrder.columns.orders'),
    align: 'end',
    width: '120px',
    compare: (a, b) => a.openOrderCount - b.openOrderCount,
  },
]);

// The side panel: the orders that wait for one product. Kept by id, so a reload refreshes it.
const panelId = ref<string | null>(null);
const panelOpen = ref(false);
const panelItem = computed(() => items.value.find((item) => item.productId === panelId.value));
function openPanel(item: ByOrderProduct): void {
  panelId.value = item.productId;
  panelOpen.value = true;
}
</script>

<template>
  <section class="by-order">
    <PricesSubHeader :title="t('staffCost.byOrder.title')" :subtitle="subtitle">
      <template v-if="canEdit" #actions>
        <NewProductMenu @single="manualOpen = true" @import="importOpen = true" />
      </template>
    </PricesSubHeader>

    <p class="note" role="note">
      <StaffIcon name="package" :size="16" class="note__icon" />
      <span>{{ t('staffCost.byOrder.explanation') }}</span>
    </p>

    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('staffCost.byOrder.empty.title') : undefined"
      :description="
        view.state.value === 'empty'
          ? t('staffCost.byOrder.empty.description')
          : view.state.value === 'error'
            ? errorText
            : undefined
      "
      @retry="view.reload()"
    >
      <template v-if="canEdit" #actions>
        <AppButton variant="secondary" data-testid="by-order-add-single" @click="manualOpen = true">
          <StaffIcon name="package" :size="16" />{{ t('staffCost.manual.add') }}
        </AppButton>
        <AppButton variant="secondary" data-testid="by-order-import" @click="importOpen = true">
          <StaffIcon name="upload" :size="16" />{{ t('staffCost.priceImport.action') }}
        </AppButton>
      </template>
      <div class="list">
        <FilterPanel class="toolbar">
          <SearchField v-model="search" :placeholder="t('staffCost.byOrder.search')" label-hidden />
        </FilterPanel>

        <DataTable
          :columns="columns"
          :rows="visible"
          :row-key="(item: ByOrderProduct) => item.productId"
          :row-action="openPanel"
          :row-label="
            (item: ByOrderProduct) =>
              t('staffCost.byOrder.open', { product: `${item.productCode} ${item.name}` })
          "
          :row-tone="(item: ByOrderProduct) => (waits(item) ? 'accent' : undefined)"
          :label="t('staffCost.byOrder.tableLabel')"
          :empty-text="t('staffCost.byOrder.noMatch')"
          :density-toggle="false"
        >
          <template #cell-product="{ row }">
            <span class="product">
              <span class="product__line">
                <span class="name">{{ row.name }}</span>
                <AppBadge
                  v-if="!row.isActive"
                  tone="warning"
                  :title="t('staffCost.byOrder.inactiveHint')"
                  data-testid="by-order-inactive"
                  >{{ t('staffCost.byOrder.inactive') }}</AppBadge
                >
              </span>
              <span class="meta">
                <span class="mono code">{{ row.productCode }}</span>
                <template v-if="row.category !== null">
                  <span aria-hidden="true">·</span>
                  <span>{{ row.category }}</span>
                </template>
              </span>
            </span>
          </template>
          <template #cell-brand="{ row }">
            <span :class="{ muted: row.brandName === null }">{{
              row.brandName ?? t('staffCost.byOrder.noBrand')
            }}</span>
          </template>
          <template #cell-price="{ row }">
            <span v-if="row.basePrice !== null" class="money">
              <span class="money__main">{{ money(row, row.basePrice) }}</span>
              <span v-if="row.deferredPrice !== null" class="money__sub">{{
                t('staffCost.byOrder.deferred', { price: money(row, row.deferredPrice) })
              }}</span>
            </span>
            <span v-else class="muted">{{ t('staffCost.byOrder.notPriced') }}</span>
          </template>
          <template #cell-waiting="{ row }">
            <b v-if="waits(row)" class="waiting" data-testid="by-order-waiting">{{
              pieces(row.openQuantity)
            }}</b>
            <span v-else class="muted">—</span>
          </template>
          <template #cell-orders="{ row }">
            <span v-if="waits(row)">{{
              t('staffCost.byOrder.ordersCount', { count: row.openOrderCount })
            }}</span>
            <span v-else class="muted">—</span>
          </template>
          <template #card="{ row }">
            <!-- The card is the row's button: one tap opens the orders that wait. -->
            <span class="card__top">
              <b class="name">{{ row.name }}</b>
              <AppBadge v-if="!row.isActive" tone="warning">{{
                t('staffCost.byOrder.inactive')
              }}</AppBadge>
            </span>
            <span class="meta">
              <span class="mono code">{{ row.productCode }}</span>
              <template v-if="row.brandName !== null">
                <span aria-hidden="true">·</span>
                <span>{{ row.brandName }}</span>
              </template>
              <template v-if="row.category !== null">
                <span aria-hidden="true">·</span>
                <span>{{ row.category }}</span>
              </template>
            </span>
            <span class="card__grid">
              <span class="card__cell">
                <span class="card__label">{{ t('staffCost.byOrder.columns.waiting') }}</span>
                <b v-if="waits(row)" class="waiting">{{ pieces(row.openQuantity) }}</b>
                <span v-else class="muted">—</span>
              </span>
              <span class="card__cell">
                <span class="card__label">{{ t('staffCost.byOrder.columns.orders') }}</span>
                <span v-if="waits(row)" class="num">{{
                  t('staffCost.byOrder.ordersCount', { count: row.openOrderCount })
                }}</span>
                <span v-else class="muted">—</span>
              </span>
              <span class="card__cell">
                <span class="card__label">{{ t('staffCost.byOrder.columns.price') }}</span>
                <span v-if="row.basePrice !== null" class="num">{{
                  money(row, row.basePrice)
                }}</span>
                <span v-else class="muted">{{ t('staffCost.byOrder.notPriced') }}</span>
              </span>
            </span>
          </template>
        </DataTable>

        <p class="list-count">{{ t('staffCost.byOrder.listCount', { count: visible.length }) }}</p>
      </div>
    </StateView>

    <template v-if="canEdit">
      <ManualProductDialog
        v-model="manualOpen"
        :base-version-number="baseVersionNumber"
        :categories="knownCategories"
        @created="onManualCreated"
        @stale="loadVersion()"
      />
      <PriceImportDialog
        v-model="importOpen"
        :generated-count="generatedCount"
        :base-version-number="baseVersionNumber"
        @imported="onImported"
        @stale="loadVersion()"
      />
    </template>

    <AppDrawer v-model="panelOpen" :title="panelItem?.name ?? ''">
      <div v-if="panelItem" class="panel" data-testid="by-order-panel">
        <dl class="facts">
          <div class="facts__row">
            <dt>{{ t('staffCost.byOrder.panel.code') }}</dt>
            <dd class="mono">{{ panelItem.productCode }}</dd>
          </div>
          <div class="facts__row">
            <dt>{{ t('staffCost.byOrder.panel.brand') }}</dt>
            <dd :class="{ muted: panelItem.brandName === null }">
              {{ panelItem.brandName ?? t('staffCost.byOrder.noBrand') }}
            </dd>
          </div>
          <div v-if="panelItem.category !== null" class="facts__row">
            <dt>{{ t('staffCost.byOrder.panel.category') }}</dt>
            <dd>{{ panelItem.category }}</dd>
          </div>
          <div class="facts__row">
            <dt>{{ t('staffCost.byOrder.panel.price') }}</dt>
            <dd v-if="panelItem.basePrice !== null" class="num">
              {{ money(panelItem, panelItem.basePrice) }}
            </dd>
            <dd v-else class="muted">{{ t('staffCost.byOrder.notPriced') }}</dd>
          </div>
          <div v-if="panelItem.deferredPrice !== null" class="facts__row">
            <dt>{{ t('staffCost.byOrder.panel.deferredPrice') }}</dt>
            <dd class="num">{{ money(panelItem, panelItem.deferredPrice) }}</dd>
          </div>
        </dl>
        <p v-if="!panelItem.isActive" class="panel__note" role="note">
          {{ t('staffCost.byOrder.inactiveHint') }}
        </p>

        <section class="waitlist" :aria-label="t('staffCost.byOrder.panel.waiting')">
          <header class="waitlist__head">
            <h3 class="waitlist__title">{{ t('staffCost.byOrder.panel.waiting') }}</h3>
            <span
              v-if="waits(panelItem)"
              class="waitlist__total num"
              data-testid="by-order-total"
              >{{
                t('staffCost.byOrder.panel.total', {
                  pieces: formatQuantity(panelItem.openQuantity),
                  orders: panelItem.openOrderCount,
                })
              }}</span
            >
          </header>
          <p v-if="!waits(panelItem)" class="waitlist__none" data-testid="by-order-none">
            {{ t('staffCost.byOrder.panel.none') }}
          </p>
          <ul v-else class="orders">
            <li
              v-for="order in panelItem.orders"
              :key="order.orderId"
              class="order"
              data-testid="by-order-order"
            >
              <span class="order__main">
                <RouterLink
                  class="order__link mono"
                  :to="{ name: 'staff-order', params: { orderId: order.orderId } }"
                  :aria-label="
                    t('staffCost.byOrder.panel.openOrder', { number: order.orderNumber })
                  "
                  >{{ order.orderNumber }}</RouterLink
                >
                <span class="order__customer">{{ order.organizationName }}</span>
                <span class="order__date num">{{ formatDateTime(order.submittedAt) }}</span>
              </span>
              <span class="order__side">
                <b class="order__qty num">{{ pieces(order.quantity) }}</b>
                <AppBadge :tone="STATUS_TONES[order.status]" dot>{{
                  t(`orders.stages.${order.status}`)
                }}</AppBadge>
              </span>
            </li>
          </ul>
          <p v-if="waits(panelItem)" class="waitlist__note">
            {{ t('staffCost.byOrder.panel.waitingNote') }}
          </p>
        </section>
      </div>
    </AppDrawer>
  </section>
</template>

<style scoped>
.by-order {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* The same grey explanation box as the brands page. */
.note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  color: var(--t2);
  font-size: var(--fs-small);
  line-height: 1.5;
}

.note__icon {
  flex: none;
  margin-top: 1px;
  color: var(--acc);
}

.toolbar {
  align-items: center;
}

.toolbar :deep(.search) {
  flex: 1 1 240px;
}

/* v8 product cell: the name over a small grey line "code · category" (code in mono). */
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

.code,
.mono {
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

.money__sub {
  font-size: var(--fs-group);
  color: var(--t3);
}

/* The figure the page exists for: what has to be brought. */
.waiting {
  font-weight: 600;
  color: var(--acc-fg);
  font-variant-numeric: tabular-nums;
}

.list-count {
  margin: -4px 0 0;
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

/* --- phone card: title row, grey meta line, three figures on the grey fill ------------------- */

.card__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
}

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

.card__label {
  font-size: var(--fs-group);
  color: var(--t2);
}

/* --- side panel ------------------------------------------------------------------------------ */

.panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.facts {
  display: flex;
  flex-direction: column;
  margin: 0;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

/* Label left, value right, on one baseline; a long value wraps under itself, not under the label. */
.facts__row {
  display: grid;
  grid-template-columns: minmax(96px, 40%) minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding: 10px 14px;
  font-size: var(--fs-small);
}

.facts__row + .facts__row {
  border-top: 1px solid var(--e8);
}

.facts__row dt {
  color: var(--t2);
}

.facts__row dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

.panel__note {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-small);
  line-height: 1.45;
}

.waitlist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.waitlist__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.waitlist__title {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}

.waitlist__total {
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--acc-fg);
}

.waitlist__none,
.waitlist__note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.waitlist__note {
  font-size: var(--fs-group);
}

.orders {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  list-style: none;
}

/* One order: number, customer and date on the left; pieces over the status on the right. Both
   sides start on the same line, so the number and the pieces read as one row. */
.order {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 12px 14px;
}

.order + .order {
  border-top: 1px solid var(--e8);
}

.order__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.order__link {
  align-self: flex-start;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--acc-fg);
  text-decoration: none;
}

.order__link:hover {
  text-decoration: underline;
}

.order__link:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: 2px;
}

.order__customer {
  font-size: var(--fs-small);
  overflow-wrap: anywhere;
}

.order__date {
  font-size: var(--fs-group);
  color: var(--t2);
}

.order__side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.order__qty {
  font-size: var(--fs-small);
  font-weight: 600;
}

@media (pointer: coarse), (hover: none) {
  /* A thumb-sized target for the order link without moving the text. */
  .order__link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    margin: -12px 0;
  }
}
</style>
