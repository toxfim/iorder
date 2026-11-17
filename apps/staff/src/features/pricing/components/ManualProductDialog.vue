<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { PRODUCT_NAME_MAX_LENGTH } from '@iorder/shared';
import type { BrandResponse, ManualProductCheckResponse } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppDropdown from '@core/components/ui/AppDropdown.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import TextField from '@core/components/ui/TextField.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import {
  describeManualProductError,
  isStalePriceList,
} from '@/features/staff-cost/domain/manual-products';
import { parsePriceInput } from '../domain/price-input';
import { translateDescribed } from '../domain/translate-error';

export interface ManualProductCreated {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string;
  readonly versionNumber: number;
  readonly skippedInactiveCount: number;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** The published version the price is based on; null before the first publish. */
    baseVersionNumber: number | null;
    /** The sheet categories customers browse by, offered while typing one (free text stays allowed). */
    categories?: readonly string[];
  }>(),
  { categories: () => [] },
);
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  created: [result: ManualProductCreated];
  /** Another version was published meanwhile: the owner reloads the list (new base version). */
  stale: [];
}>();

// "Yangi tovar qo'shish" (design canvas 2026-11-09): a product the sheet does not have. The server
// gives it a generated code and publishes the list with its price at once (no drafts, hard rule 5).
// While the name is typed the server is asked (read-only) for products with a similar name and for
// the brand its brand finder reads in the name; neither blocks the save.
const NAME_CHECK_DEBOUNCE_MS = 300;

const { t } = useI18n();
const { pricingApi, brandsApi } = useServices();

const NO_BRAND = '';

const name = ref('');
const brandId = ref<string>(NO_BRAND);
// True once the person picked a brand: the brand finder then stops overriding the choice.
const brandChosen = ref(false);
const category = ref('');
const raw = ref('');
const rawDeferred = ref('');
const busy = ref(false);
const failure = ref<string | null>(null);

// The brand list is read when the dialog opens; a failure only costs the brand choice.
type BrandsState = 'loading' | 'ready' | 'error';
const brandsState = ref<BrandsState>('loading');
const brands = shallowRef<readonly BrandResponse[]>([]);
let brandsRun = 0;

async function loadBrands(): Promise<void> {
  const mine = ++brandsRun;
  brandsState.value = 'loading';
  try {
    const list = await brandsApi.listBrands();
    if (mine !== brandsRun) return;
    brands.value = list.items;
    brandsState.value = 'ready';
  } catch {
    if (mine !== brandsRun) return;
    brands.value = [];
    brandsState.value = 'error';
  }
}

// --- the name check --------------------------------------------------------------------------

const check = shallowRef<ManualProductCheckResponse | null>(null);
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let checkRun = 0;

async function runCheck(value: string): Promise<void> {
  const mine = ++checkRun;
  try {
    const answer = await pricingApi.checkManualProduct(value);
    if (mine !== checkRun) return;
    check.value = answer;
    // The brand read in the name is preselected until the person chooses one by hand.
    if (!brandChosen.value) brandId.value = answer.brandFound?.id ?? NO_BRAND;
  } catch {
    // The check is a convenience: a failure shows nothing and never blocks the save.
    if (mine === checkRun) check.value = null;
  }
}

watch(name, (value) => {
  clearTimeout(checkTimer);
  checkRun += 1;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > PRODUCT_NAME_MAX_LENGTH) {
    check.value = null;
    if (!brandChosen.value) brandId.value = NO_BRAND;
    return;
  }
  checkTimer = setTimeout(() => void runCheck(trimmed), NAME_CHECK_DEBOUNCE_MS);
});
onBeforeUnmount(() => clearTimeout(checkTimer));

const similar = computed(() => check.value?.similar ?? []);
const firstSimilar = computed(() => similar.value[0] ?? null);
const brandFromName = computed(
  () =>
    !brandChosen.value &&
    check.value?.brandFound !== null &&
    check.value?.brandFound !== undefined &&
    brandId.value === check.value.brandFound.id,
);

function chooseBrand(value: string): void {
  brandChosen.value = true;
  brandId.value = value;
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    name.value = '';
    brandId.value = NO_BRAND;
    brandChosen.value = false;
    category.value = '';
    raw.value = '';
    rawDeferred.value = '';
    failure.value = null;
    check.value = null;
    void loadBrands();
  },
  { immediate: true },
);

const brandOptions = computed(() => [
  { value: NO_BRAND, label: t('staffCost.manual.noBrand') },
  ...brands.value.map((brand) => ({ value: brand.id, label: brand.name })),
]);

const trimmedName = computed(() => name.value.trim());
const nameError = computed(() =>
  trimmedName.value.length > PRODUCT_NAME_MAX_LENGTH
    ? t('staffCost.manual.nameTooLong', { max: PRODUCT_NAME_MAX_LENGTH })
    : null,
);
const parsed = computed(() => parsePriceInput(raw.value));
const parsedDeferred = computed(() => {
  const result = parsePriceInput(rawDeferred.value);
  if (result.ok) return { ok: true as const, value: result.value };
  return result.reason === 'empty' ? { ok: true as const, value: null } : result;
});
const priceError = computed(() =>
  raw.value.trim() !== '' && !parsed.value.ok ? t('prices.row.invalid') : null,
);
const deferredError = computed(() => (parsedDeferred.value.ok ? null : t('prices.row.invalid')));
const canSave = computed(
  () =>
    !busy.value &&
    trimmedName.value !== '' &&
    nameError.value === null &&
    parsed.value.ok &&
    parsedDeferred.value.ok,
);

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}

async function save(): Promise<void> {
  if (!canSave.value || !parsed.value.ok || !parsedDeferred.value.ok) return;
  busy.value = true;
  failure.value = null;
  try {
    const trimmedCategory = category.value.trim();
    const result = await pricingApi.createManualProduct({
      baseVersionNumber: props.baseVersionNumber,
      name: trimmedName.value,
      brandId: brandId.value === NO_BRAND ? null : brandId.value,
      category: trimmedCategory === '' ? null : trimmedCategory,
      basePrice: parsed.value.value,
      deferredPrice: parsedDeferred.value.value,
    });
    emit('created', {
      productId: result.productId,
      productCode: result.productCode,
      name: trimmedName.value,
      versionNumber: result.version.number,
      skippedInactiveCount: result.version.skippedInactiveCount,
    });
    emit('update:modelValue', false);
  } catch (caught) {
    failure.value = translateDescribed(t, describeManualProductError(caught));
    if (isStalePriceList(caught)) emit('stale');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('staffCost.manual.title')"
    max-width="560px"
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <template #title>
      <span class="title-icon"><StaffIcon name="tag" :size="16" /></span>
      {{ t('staffCost.manual.title') }}
    </template>

    <form class="form" novalidate data-testid="manual-product-form" @submit.prevent="save">
      <div class="field-wrap">
        <TextField
          v-model="name"
          data-manual-name
          :label="`${t('staffCost.manual.name')} *`"
          :placeholder="t('staffCost.manual.namePlaceholder')"
          :error="nameError"
          :maxlength="PRODUCT_NAME_MAX_LENGTH + 1"
          autocomplete="off"
          :disabled="busy"
        />
        <!-- Information only: the same name may be meant on purpose (another variant). -->
        <p v-if="firstSimilar" class="similar" role="status" data-testid="similar-hint">
          <StaffIcon name="alert" :size="14" />
          <span>
            {{
              t('staffCost.manual.similar', {
                name: firstSimilar.name,
                code: firstSimilar.productCode,
              })
            }}
            <template v-if="similar.length > 1">
              {{ t('staffCost.manual.similarMore', { count: similar.length - 1 }) }}
            </template>
          </span>
        </p>
      </div>

      <div class="grid">
        <div class="brand">
          <span class="brand__label">{{ t('staffCost.manual.brand') }}</span>
          <p v-if="brandsState === 'loading'" class="brand__note" role="status">
            {{ t('staffCost.manual.brandsLoading') }}
          </p>
          <p v-else-if="brandsState === 'error'" class="brand__note" role="status">
            {{ t('staffCost.manual.brandsFailed') }}
          </p>
          <AppDropdown
            v-else
            :model-value="brandId"
            data-testid="manual-brand"
            :options="brandOptions"
            :label="t('staffCost.manual.brand')"
            min-width="100%"
            @update:model-value="chooseBrand"
          />
          <span v-if="brandFromName" class="brand__found" data-testid="brand-found">
            {{ t('staffCost.manual.brandFound') }}
          </span>
        </div>
        <TextField
          v-model="category"
          data-manual-category
          :label="t('staffCost.manual.category')"
          :placeholder="t('staffCost.manual.categoryPlaceholder')"
          :suggestions="categories"
          autocomplete="off"
          :disabled="busy"
        />
      </div>

      <div class="grid">
        <TextField
          v-model="raw"
          data-price-input
          :label="`${t('staffCost.manual.price')} *`"
          suffix="$"
          :error="priceError"
          inputmode="decimal"
          autocomplete="off"
          :disabled="busy"
        />
        <TextField
          v-model="rawDeferred"
          data-deferred-price-input
          :label="t('staffCost.manual.deferredPrice')"
          suffix="$"
          :error="deferredError"
          inputmode="decimal"
          autocomplete="off"
          :disabled="busy"
        />
      </div>
      <p class="helper">{{ t('staffCost.manual.deferredHint') }}</p>

      <div class="cards">
        <div class="card">
          <span class="card__label">{{ t('staffCost.manual.idCard.label') }}</span>
          <span class="card__value mono">{{ t('staffCost.manual.idCard.value') }}</span>
          <span class="card__note">{{ t('staffCost.manual.idCard.note') }}</span>
        </div>
        <div class="card">
          <span class="card__label">{{ t('staffCost.manual.stockCard.label') }}</span>
          <span class="card__value">{{ t('staffCost.manual.stockCard.value') }}</span>
          <span class="card__note">{{ t('staffCost.manual.stockCard.note') }}</span>
        </div>
      </div>

      <p class="notice" role="note">
        <StaffIcon name="lock" :size="15" />{{ t('staffCost.manual.publishNote') }}
      </p>
      <p v-if="failure" class="notice notice--error" role="alert">{{ failure }}</p>
    </form>

    <template #footer>
      <AppButton variant="secondary" :disabled="busy" @click="close">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton :disabled="!canSave" :loading="busy" data-testid="manual-save" @click="save">
        {{ t('staffCost.manual.save') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.similar {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

.similar :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.brand__label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

.brand__note,
.brand__found {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.helper {
  margin: -8px 0 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.card__label,
.card__note {
  font-size: var(--fs-group);
  color: var(--t2);
}

.card__value {
  font-size: var(--fs-small);
  font-weight: 600;
}

.mono {
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}

.notice {
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

.notice :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.notice--error {
  background: var(--red-bg);
  color: var(--red);
}

@media (max-width: 560px) {
  .grid,
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>
