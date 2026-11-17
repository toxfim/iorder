<script setup lang="ts">
import type { BrandResponse, UnbrandedProduct } from '@iorder/shared/staff-cost';
import { computed, reactive, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import { canEditPrices } from '@/features/staff-shell/price-access';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import AppBadge from '@core/components/ui/AppBadge.vue';
import StateView from '@core/components/ui/StateView.vue';
import type { ViewState } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { ApiConflictError, ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { findBrandByName, withBrand } from '../domain/brand-options';
import BrandCombobox from './BrandCombobox.vue';

// "Brendlar" (owner request, 2026-10-28): the price list Excel file has one sheet per brand, and
// the brand is found in the product name. The products listed here matched no known brand; the
// manager or the admin picks one (or creates it), and the server remembers it for the product.
// UI convenience only: the api refuses every call of the other roles.
const { t } = useI18n();
const { brandsApi, currentUser } = useServices();
// The purchasing manager reads the list; the server refuses every change anyway.
const canEdit = computed(() => canEditPrices(currentUser.user.value?.staffRoles ?? []));

const state = ref<ViewState>('loading');
const loadError = shallowRef<unknown>(null);
const products = shallowRef<readonly UnbrandedProduct[]>([]);
const brands = shallowRef<readonly BrandResponse[]>([]);
/** Products whose choice is being saved (their picker is locked meanwhile). */
const saving = reactive(new Set<string>());
let loadRun = 0;

async function load(): Promise<void> {
  const mine = ++loadRun;
  state.value = 'loading';
  loadError.value = null;
  try {
    const [unbranded, all] = await Promise.all([
      brandsApi.unbrandedProducts(),
      brandsApi.listBrands(),
    ]);
    if (mine !== loadRun) return;
    products.value = unbranded.items;
    brands.value = all.items;
    state.value = unbranded.items.length === 0 ? 'empty' : 'ready';
  } catch (caught) {
    if (mine !== loadRun) return;
    loadError.value = caught;
    state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
  }
}
void load();

const errorText = (operation: 'load' | 'brand', caught: unknown): string =>
  translateDescribed(t, describePricingError(operation, caught));

const loadErrorText = computed(() => errorText('load', loadError.value));

function dropProduct(productId: string): void {
  products.value = products.value.filter((p) => p.productId !== productId);
  if (products.value.length === 0) state.value = 'empty';
}

async function assign(product: UnbrandedProduct, brand: BrandResponse): Promise<void> {
  saving.add(product.productId);
  try {
    const answer = await brandsApi.setProductBrand(product.productId, brand.id);
    dropProduct(product.productId);
    showToast({ message: t('brands.saved', { product: product.name, brand: answer.brand.name }) });
  } catch (caught) {
    showToast({ message: errorText('brand', caught) });
    // The product (or the brand) is gone or changed meanwhile: show the list as it is now.
    if (caught instanceof ApiNotFoundError) void load();
  } finally {
    saving.delete(product.productId);
  }
}

/**
 * Creates the brand, then assigns it. When someone created the same name meanwhile (409
 * DUPLICATE_BRAND_NAME) the list is read again and the existing brand is used instead.
 */
async function createAndAssign(product: UnbrandedProduct, name: string): Promise<void> {
  saving.add(product.productId);
  let brand: BrandResponse | null = null;
  try {
    brand = await brandsApi.createBrand(name);
    brands.value = withBrand(brands.value, brand);
  } catch (caught) {
    if (caught instanceof ApiConflictError && caught.reason === 'DUPLICATE_BRAND_NAME') {
      brand = await refreshAndFind(name);
      if (brand) showToast({ message: t('brands.existing', { brand: brand.name }) });
    }
    if (!brand) {
      saving.delete(product.productId);
      showToast({ message: errorText('brand', caught) });
      return;
    }
  }
  await assign(product, brand);
}

async function refreshAndFind(name: string): Promise<BrandResponse | null> {
  try {
    brands.value = (await brandsApi.listBrands()).items;
  } catch {
    return null;
  }
  return findBrandByName(brands.value, name);
}

const columns = computed<DataTableColumn<UnbrandedProduct>[]>(() => [
  {
    key: 'product',
    label: t('brands.columns.product'),
    minWidth: '240px',
    text: (row) => row.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    key: 'category',
    label: t('brands.columns.category'),
    width: '180px',
    text: (row) => row.category ?? t('brands.noCategory'),
    compare: (a, b) => (a.category ?? '').localeCompare(b.category ?? ''),
  },
  ...(canEdit.value ? [{ key: 'brand', label: t('brands.columns.brand'), width: '280px' }] : []),
]);

const pickerLabel = (row: UnbrandedProduct): string =>
  t('brands.picker.label', { product: row.name });
</script>

<template>
  <section class="brands">
    <PricesSubHeader
      :title="t('brands.title')"
      :subtitle="state === 'ready' ? t('brands.subtitle', { count: products.length }) : undefined"
    />

    <p class="note" role="note">
      <StaffIcon name="tag" :size="16" class="note__icon" />
      <span>{{ t('brands.explanation') }}</span>
    </p>

    <StateView
      :state="state"
      :title="state === 'empty' ? t('brands.empty.title') : undefined"
      :description="
        state === 'empty'
          ? t('brands.empty.description')
          : state === 'error'
            ? loadErrorText
            : undefined
      "
      @retry="load()"
    >
      <DataTable
        :columns="columns"
        :rows="products"
        :row-key="(row: UnbrandedProduct) => row.productId"
        :label="t('brands.tableLabel')"
        :empty-text="t('brands.empty.title')"
        :density-toggle="false"
      >
        <template #cell-product="{ row }">
          <span class="product">
            <span class="product__line">
              <span class="name">{{ row.name }}</span>
              <AppBadge v-if="row.priced" tone="accent">{{ t('brands.inPriceList') }}</AppBadge>
            </span>
            <span class="meta mono">{{ row.productCode }}</span>
          </span>
        </template>
        <template #cell-category="{ row }">
          <span :class="{ muted: row.category === null }">
            {{ row.category ?? t('brands.noCategory') }}
          </span>
        </template>
        <template #cell-brand="{ row }">
          <BrandCombobox
            :brands="brands"
            :label="pickerLabel(row)"
            :busy="saving.has(row.productId)"
            @pick="(brand) => assign(row, brand)"
            @create="(name) => createAndAssign(row, name)"
          />
        </template>
        <template #card="{ row }">
          <span class="card">
            <span class="product__line">
              <b class="name">{{ row.name }}</b>
              <AppBadge v-if="row.priced" tone="accent">{{ t('brands.inPriceList') }}</AppBadge>
            </span>
            <span class="meta">
              <span class="mono">{{ row.productCode }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ row.category ?? t('brands.noCategory') }}</span>
            </span>
            <BrandCombobox
              v-if="canEdit"
              class="card__picker"
              :brands="brands"
              :label="pickerLabel(row)"
              :busy="saving.has(row.productId)"
              @pick="(brand) => assign(row, brand)"
              @create="(name) => createAndAssign(row, name)"
            />
          </span>
        </template>
      </DataTable>
    </StateView>
  </section>
</template>

<style scoped>
.brands {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

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

.product,
.card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.card {
  gap: 6px;
}

.product__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}

.name {
  font-weight: 500;
  overflow-wrap: anywhere;
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

.card__picker {
  margin-top: 4px;
}
</style>
