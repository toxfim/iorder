<script setup lang="ts">
import type { StaffProductDetailResponse } from '@iorder/shared/staff-cost';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { filterRows } from '@/features/pricing/domain/row-filter';
import { ruleSummaryKey } from '../domain/category-form';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import { canEditPrices } from '@/features/staff-shell/price-access';
import ProductFormDialog from './ProductFormDialog.vue';

const { t } = useI18n();
const { catalogApi, currentUser } = useServices();
// The purchasing manager reads this page; the server refuses every change anyway.
const canEdit = computed(() => canEditPrices(currentUser.user.value?.staffRoles ?? []));

const view = useAsyncView(() => catalogApi.listProducts(), {
  isEmpty: (list) => list.items.length === 0,
});

// Local copy so a saved product replaces its row without refetching the whole list.
const overrides = ref(new Map<string, StaffProductDetailResponse>());
const added = ref<StaffProductDetailResponse[]>([]);

const products = computed(() => {
  const base = (view.data.value?.items ?? []).map((p) => overrides.value.get(p.id) ?? p);
  return [...added.value, ...base].sort((a, b) => a.productCode.localeCompare(b.productCode));
});

const search = ref('');
const rows = computed(() =>
  filterRows(
    products.value.map((p) => ({ ...p, names: p.translations })),
    search.value,
  ),
);

type ProductRow = (typeof rows.value)[number];

const columns = computed<DataTableColumn<ProductRow>[]>(() => [
  {
    key: 'code',
    label: t('prices.columns.productCode'),
    width: '120px',
    text: (p) => p.productCode,
    compare: (a, b) => a.productCode.localeCompare(b.productCode),
  },
  {
    key: 'name',
    label: t('prices.columns.name'),
    text: (p) => p.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    key: 'category',
    label: t('products.columns.category'),
    width: '160px',
    hideOnCard: true,
    text: (p) => p.category ?? '',
    hasSortValue: (p) => p.category !== null && p.category !== '',
    compare: (a, b) => (a.category ?? '').localeCompare(b.category ?? ''),
  },
  {
    key: 'rule',
    label: t('products.columns.rule'),
    width: '160px',
    hideOnCard: true,
    text: (p) => t(ruleSummaryKey(p)),
  },
  { key: 'status', label: t('products.columns.status'), width: '130px', hideOnCard: true },
  ...(canEdit.value
    ? [
        {
          key: 'actions',
          label: t('products.columns.actions'),
          width: '240px',
          hideOnCard: true,
        },
      ]
    : []),
]);

function describe(key: 'createProduct' | 'updateProduct', error: unknown): string {
  return translateDescribed(t, describePricingError(key, error));
}

const errorText = computed(() =>
  translateDescribed(t, describePricingError('load', view.error.value)),
);

// --- form dialog -----------------------------------------------------------------------------

const formOpen = ref(false);
const editTarget = ref<StaffProductDetailResponse | null>(null);

function openCreate(): void {
  editTarget.value = null;
  formOpen.value = true;
}

function openEdit(id: string): void {
  editTarget.value = products.value.find((p) => p.id === id) ?? null;
  if (editTarget.value) formOpen.value = true;
}

function onSaved(saved: StaffProductDetailResponse, created: boolean): void {
  if (created) added.value = [...added.value, saved];
  else overrides.value = new Map(overrides.value).set(saved.id, saved);
  showToast({ message: t(created ? 'products.toast.created' : 'products.toast.updated') });
}

// --- activate / deactivate --------------------------------------------------------------------

const deactivateId = ref<string | null>(null);
const deactivateOpen = computed({
  get: () => deactivateId.value !== null,
  set: (open: boolean) => {
    if (!open) deactivateId.value = null;
  },
});
const busy = ref(false);
const actionError = ref<string | null>(null);

async function setActive(id: string, isActive: boolean): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const saved = await catalogApi.updateProduct(id, { isActive });
    overrides.value = new Map(overrides.value).set(saved.id, saved);
    deactivateId.value = null;
    showToast({ message: t(isActive ? 'products.toast.activated' : 'products.toast.deactivated') });
  } catch (caught) {
    actionError.value = describe('updateProduct', caught);
    if (deactivateId.value === null) showToast({ message: actionError.value });
  } finally {
    busy.value = false;
  }
}

function toggle(product: StaffProductDetailResponse): void {
  // Deactivating hides the product from customers: ask first. Activating is harmless.
  if (product.isActive) {
    actionError.value = null;
    deactivateId.value = product.id;
  } else {
    void setActive(product.id, true);
  }
}
</script>

<template>
  <div class="page">
    <PricesSubHeader
      :title="t('prices.tabs.products')"
      :subtitle="t('products.subtitle')"
      :back-to="{ name: 'staff-prices' }"
      :back-label="t('prices.title')"
    >
      <template #actions>
        <RouterLink class="head__link" :to="{ name: 'staff-product-categories' }">
          <StaffIcon name="tags" :size="16" class="head__icon" />
          {{ t('products.categoriesLink') }}
        </RouterLink>
        <AppButton v-if="canEdit" @click="openCreate">
          <StaffIcon name="plus" :size="16" />
          {{ t('products.add') }}
        </AppButton>
      </template>
    </PricesSubHeader>

    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('products.empty') : undefined"
      :description="view.state.value === 'error' ? errorText : undefined"
      @retry="view.reload"
    >
      <template v-if="canEdit" #actions>
        <AppButton @click="openCreate">{{ t('products.add') }}</AppButton>
      </template>

      <section class="products">
        <FilterPanel>
          <SearchField v-model="search" :placeholder="t('prices.search.placeholder')" />
        </FilterPanel>

        <DataTable
          :columns="columns"
          :rows="rows"
          :row-key="(p: ProductRow) => p.id"
          :label="t('prices.tabs.products')"
          :empty-text="t('prices.noMatch')"
        >
          <template #cell-code="{ row }">
            <span class="mono row__code">{{ row.productCode }}</span>
          </template>
          <template #cell-name="{ row }">
            <span class="row__name">{{ row.name }}</span>
          </template>
          <template #cell-status="{ row }">
            <AppBadge dot :tone="row.isActive ? 'success' : 'warning'">
              {{ row.isActive ? t('products.active') : t('prices.row.inactiveBadge') }}
            </AppBadge>
          </template>
          <template #cell-actions="{ row }">
            <span class="actions">
              <AppButton
                variant="secondary"
                size="xs"
                :aria-label="`${t('products.edit')}: ${row.productCode}`"
                @click="openEdit(row.id)"
              >
                {{ t('products.edit') }}
              </AppButton>
              <AppButton
                variant="ghost"
                size="xs"
                :disabled="busy"
                :aria-label="`${row.isActive ? t('products.deactivate') : t('products.activate')}: ${row.productCode}`"
                @click="toggle(row)"
              >
                {{ row.isActive ? t('products.deactivate') : t('products.activate') }}
              </AppButton>
            </span>
          </template>
          <template #card="{ row }">
            <span class="card__top">
              <b>{{ row.name }}</b>
              <AppBadge dot :tone="row.isActive ? 'success' : 'warning'">
                {{ row.isActive ? t('products.active') : t('prices.row.inactiveBadge') }}
              </AppBadge>
            </span>
            <span class="card__line">
              <span class="mono row__code">{{ row.productCode }}</span>
              <template v-if="row.category"> · {{ row.category }}</template>
              · {{ t(ruleSummaryKey(row)) }}
            </span>
            <span v-if="canEdit" class="actions">
              <AppButton
                variant="secondary"
                size="xs"
                :aria-label="`${t('products.edit')}: ${row.productCode}`"
                @click="openEdit(row.id)"
              >
                {{ t('products.edit') }}
              </AppButton>
              <AppButton
                variant="ghost"
                size="xs"
                :disabled="busy"
                :aria-label="`${row.isActive ? t('products.deactivate') : t('products.activate')}: ${row.productCode}`"
                @click="toggle(row)"
              >
                {{ row.isActive ? t('products.deactivate') : t('products.activate') }}
              </AppButton>
            </span>
          </template>
        </DataTable>
      </section>

      <ProductFormDialog v-model="formOpen" :product="editTarget" @saved="onSaved" />

      <AppConfirmDialog
        v-model="deactivateOpen"
        tone="danger"
        :title="t('products.deactivateConfirm.title')"
        :description="t('products.deactivateConfirm.description')"
        :confirm-label="t('products.deactivate')"
        :loading="busy"
        :error="actionError"
        @confirm="deactivateId && setActive(deactivateId, false)"
      />
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

.products {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* A v8 header action: 40px white button with a hairline ring and a grey icon. */
.head__link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-size: var(--fs-small);
  font-weight: 600;
  text-decoration: none;
}

.head__link:hover {
  background: var(--f5);
  color: var(--ink);
}

.head__link:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.head__icon {
  color: var(--t2);
}

.row__name {
  font-weight: 500;
}

.row__code {
  font-size: var(--fs-group);
  color: var(--t3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card__line {
  font-size: var(--fs-meta);
  color: var(--t2);
}
</style>
