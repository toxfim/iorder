<script setup lang="ts">
import type { ProductCategoryResponse } from '@iorder/shared/staff-cost';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import DataTable from '@/components/ui/DataTable.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { describeCatalogError, ruleSummaryKey, type CodeRule } from '../domain/category-form';
import CategoryFormDialog from './CategoryFormDialog.vue';
import SheetCategoriesPanel from './SheetCategoriesPanel.vue';
import { canEditPrices } from '@/features/staff-shell/price-access';

// Product categories ([C] 2026-10-25): templates of the per-unit code rule. Manager and admin
// (the route guard is convenience; the api checks UPDATE_PRICE_LIST on every call).

const { t } = useI18n();
const { catalogApi, currentUser } = useServices();
// The purchasing manager reads this page; the server refuses every change anyway.
const canEdit = computed(() => canEditPrices(currentUser.user.value?.staffRoles ?? []));

const view = useAsyncView(() => catalogApi.listCategories(), {
  isEmpty: (list) => list.items.length === 0,
});

// Saved rows replace their list entry without refetching (product counts change only on create).
const overrides = ref(new Map<string, ProductCategoryResponse>());
const added = ref<ProductCategoryResponse[]>([]);
const categories = computed(() => {
  const base = (view.data.value?.items ?? []).map((c) => overrides.value.get(c.id) ?? c);
  // Active first, then by name.
  return [...added.value, ...base].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name),
  );
});

const defaultRule = (c: ProductCategoryResponse): CodeRule => ({
  trackingType: c.trackingTypeDefault,
  markingRequired: c.markingRequiredDefault,
});

const columns = computed<DataTableColumn<ProductCategoryResponse>[]>(() => [
  {
    key: 'name',
    label: t('products.categories.columns.name'),
    text: (c) => c.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    key: 'rule',
    label: t('products.categories.columns.rule'),
    width: '200px',
    text: (c) => t(ruleSummaryKey(defaultRule(c))),
  },
  {
    key: 'products',
    label: t('products.categories.columns.products'),
    width: '130px',
    text: (c) => String(c.productCount),
    compare: (a, b) => a.productCount - b.productCount,
  },
  { key: 'status', label: t('products.categories.columns.status'), width: '120px' },
  ...(canEdit.value
    ? [{ key: 'actions', label: t('products.categories.columns.actions'), width: '220px' }]
    : []),
]);

const errorText = computed(() =>
  translateDescribed(t, describeCatalogError('load', view.error.value)),
);

// --- dialog ----------------------------------------------------------------------------------

const formOpen = ref(false);
const editTarget = ref<ProductCategoryResponse | null>(null);

function openCreate(): void {
  editTarget.value = null;
  formOpen.value = true;
}

function openEdit(category: ProductCategoryResponse): void {
  editTarget.value = category;
  formOpen.value = true;
}

function remember(saved: ProductCategoryResponse): void {
  if (added.value.some((c) => c.id === saved.id)) {
    added.value = added.value.map((c) => (c.id === saved.id ? saved : c));
  } else {
    overrides.value = new Map(overrides.value).set(saved.id, saved);
  }
}

function onSaved(saved: ProductCategoryResponse, created: boolean): void {
  if (created) added.value = [...added.value, saved];
  else remember(saved);
  showToast({
    message: t(created ? 'products.categories.toast.created' : 'products.categories.toast.updated'),
  });
}

function onSheetSaved(saved: ProductCategoryResponse[]): void {
  added.value = [...added.value, ...saved];
}

// --- archive / restore (reversible, so no confirmation) ---------------------------------------

const busyId = ref<string | null>(null);

async function setActive(category: ProductCategoryResponse, isActive: boolean): Promise<void> {
  if (busyId.value !== null) return;
  busyId.value = category.id;
  try {
    remember(await catalogApi.updateCategory(category.id, { isActive }));
    showToast({
      message: t(
        isActive ? 'products.categories.toast.restored' : 'products.categories.toast.archived',
      ),
    });
  } catch (caught) {
    showToast({ message: translateDescribed(t, describeCatalogError('updateProduct', caught)) });
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="page">
    <PricesSubHeader
      class="head"
      :title="t('products.categories.title')"
      :subtitle="t('products.categories.info')"
      :back-to="{ name: 'staff-products' }"
      :back-label="t('prices.tabs.products')"
    >
      <template v-if="canEdit" #actions>
        <AppButton @click="openCreate">
          <StaffIcon name="plus" :size="16" />
          {{ t('products.categories.add') }}
        </AppButton>
      </template>
    </PricesSubHeader>

    <SheetCategoriesPanel v-if="canEdit" @saved="onSheetSaved" />

    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('products.categories.empty') : undefined"
      :description="view.state.value === 'error' ? errorText : undefined"
      @retry="view.reload"
    >
      <template v-if="canEdit" #actions>
        <AppButton @click="openCreate">{{ t('products.categories.add') }}</AppButton>
      </template>

      <DataTable
        :columns="columns"
        :rows="categories"
        :row-key="(c: ProductCategoryResponse) => c.id"
        :label="t('products.categories.title')"
        :empty-text="t('products.categories.empty')"
      >
        <template #cell-name="{ row }">
          <span class="name">{{ row.name }}</span>
        </template>
        <template #cell-products="{ row }">
          {{ t('products.categories.productCount', { count: row.productCount }, row.productCount) }}
        </template>
        <template #cell-status="{ row }">
          <AppBadge dot :tone="row.isActive ? 'success' : 'neutral'">
            {{ row.isActive ? t('products.categories.active') : t('products.categories.archived') }}
          </AppBadge>
        </template>
        <template #cell-actions="{ row }">
          <span class="actions">
            <AppButton
              variant="secondary"
              size="xs"
              :aria-label="`${t('products.categories.edit')}: ${row.name}`"
              @click="openEdit(row)"
            >
              {{ t('products.categories.edit') }}
            </AppButton>
            <AppButton
              variant="ghost"
              size="xs"
              :disabled="busyId !== null"
              :aria-label="`${row.isActive ? t('products.categories.archive') : t('products.categories.restore')}: ${row.name}`"
              @click="setActive(row, !row.isActive)"
            >
              {{
                row.isActive ? t('products.categories.archive') : t('products.categories.restore')
              }}
            </AppButton>
          </span>
        </template>
        <template #card="{ row }">
          <span class="card__top">
            <b>{{ row.name }}</b>
            <AppBadge dot :tone="row.isActive ? 'success' : 'neutral'">
              {{
                row.isActive ? t('products.categories.active') : t('products.categories.archived')
              }}
            </AppBadge>
          </span>
          <span class="card__line">
            {{ t(ruleSummaryKey(defaultRule(row))) }} ·
            {{
              t('products.categories.productCount', { count: row.productCount }, row.productCount)
            }}
          </span>
          <span v-if="canEdit" class="actions">
            <AppButton
              variant="secondary"
              size="xs"
              :aria-label="`${t('products.categories.edit')}: ${row.name}`"
              @click="openEdit(row)"
            >
              {{ t('products.categories.edit') }}
            </AppButton>
            <AppButton
              variant="ghost"
              size="xs"
              :disabled="busyId !== null"
              :aria-label="`${row.isActive ? t('products.categories.archive') : t('products.categories.restore')}: ${row.name}`"
              @click="setActive(row, !row.isActive)"
            >
              {{
                row.isActive ? t('products.categories.archive') : t('products.categories.restore')
              }}
            </AppButton>
          </span>
        </template>
      </DataTable>
    </StateView>

    <CategoryFormDialog v-model="formOpen" :category="editTarget" @saved="onSaved" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

/* The explanation is long: keep it to a readable measure under the title. */
.head :deep(.head__text) {
  max-width: 720px;
}

.name {
  font-weight: 500;
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
