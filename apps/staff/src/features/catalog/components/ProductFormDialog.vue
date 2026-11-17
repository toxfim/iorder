<script setup lang="ts">
import { normalizeProductCode } from '@iorder/shared';
import type { StaffProductDetailResponse } from '@iorder/shared/staff-cost';
import { computed, reactive, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { ApiConflictError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromProduct,
  productCodeRuleParams,
  type ProductFormErrors,
} from '../domain/product-form';
import {
  buildTrackingRequest,
  describeCatalogError,
  ruleFromProduct,
  type ProductRuleValues,
} from '../domain/category-form';
import ProductCodeRuleSection from './ProductCodeRuleSection.vue';
import ProductPhotoManager from '@/features/product-images/components/ProductPhotoManager.vue';
import { canManagePhotos } from '@/features/staff-shell/price-access';

const props = defineProps<{
  modelValue: boolean;
  /** null creates a new product; otherwise this one is edited (the product code is read-only). */
  product: StaffProductDetailResponse | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [product: StaffProductDetailResponse, created: boolean];
}>();

const { t } = useI18n();
const { catalogApi, currentUser } = useServices();
const id = useId();
// Photos belong to an existing product (they are keyed by its code). UI convenience only: the
// photo routes answer 403 to roles other than manager and admin.
const photosVisible = computed(() => canManagePhotos(currentUser.user.value?.staffRoles ?? []));

const form = reactive(emptyForm());
const errors = ref<ProductFormErrors>({});
const failure = ref<string | null>(null);
const busy = ref(false);
const editing = computed(() => props.product !== null);
// The product's own code rule, edited with the product (edit mode only). Set on every opening
// from the saved rule, or from the company suggestion while none was saved.
const rule = ref<ProductRuleValues>({ trackingType: 'NONE', markingRequired: false });

// Every opening starts from the product's current values (or an empty form), never from a
// half-typed earlier attempt.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    const next = props.product ? formFromProduct(props.product) : emptyForm();
    form.productCode = next.productCode;
    form.name = next.name;
    if (props.product) rule.value = ruleFromProduct(props.product);
    errors.value = {};
    failure.value = null;
  },
  { immediate: true },
);

// Stored and shown exactly as entered (only surrounding spaces are trimmed on submit).
const ruleParams = productCodeRuleParams();

async function submit(): Promise<void> {
  if (busy.value) return;
  failure.value = null;
  busy.value = true;
  try {
    if (props.product) {
      const built = buildUpdateRequest(props.product, form);
      if (!built.ok) {
        errors.value = built.errors;
        return;
      }
      const tracking = buildTrackingRequest(props.product, rule.value);
      if (built.request === null && tracking === null) {
        emit('update:modelValue', false);
        return;
      }
      let saved =
        built.request === null
          ? props.product
          : await catalogApi.updateProduct(props.product.id, built.request);
      if (tracking !== null) {
        try {
          saved = await catalogApi.updateProductTracking(props.product.id, tracking);
        } catch (caught) {
          // The name is saved; only the rule failed: say so and keep the dialog open.
          if (built.request !== null) emit('saved', saved, false);
          failure.value = t('products.rule.saveFailed', {
            reason: translateDescribed(t, describeCatalogError('updateProduct', caught)),
          });
          return;
        }
      }
      emit('saved', saved, false);
    } else {
      form.productCode = normalizeProductCode(form.productCode);
      const built = buildCreateRequest(form);
      if (!built.ok) {
        errors.value = built.errors;
        return;
      }
      const saved = await catalogApi.createProduct(built.request);
      emit('saved', saved, true);
    }
    errors.value = {};
    emit('update:modelValue', false);
  } catch (caught) {
    if (caught instanceof ApiConflictError && caught.reason === 'DUPLICATE_PRODUCT_CODE') {
      errors.value = { productCode: 'exists' };
    } else {
      failure.value = translateDescribed(
        t,
        describePricingError(editing.value ? 'updateProduct' : 'createProduct', caught),
      );
    }
  } finally {
    busy.value = false;
  }
}

const fieldId = (name: string): string => `${id}-${name}`;
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="editing ? t('products.form.editTitle') : t('products.form.createTitle')"
    max-width="520px"
    @update:model-value="(open) => !busy && emit('update:modelValue', open)"
  >
    <form class="form" novalidate @submit.prevent="submit">
      <div class="field">
        <label :for="fieldId('productCode')">{{ t('products.form.productCode') }}</label>
        <input
          :id="fieldId('productCode')"
          v-model="form.productCode"
          class="control mono"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :readonly="editing"
          :aria-readonly="editing || undefined"
          :aria-invalid="errors.productCode ? 'true' : undefined"
          :aria-describedby="`${fieldId('productCode')}-hint`"
        />
        <span
          :id="`${fieldId('productCode')}-hint`"
          class="hint"
          :class="{ 'hint--error': errors.productCode }"
        >
          {{
            errors.productCode
              ? t(`products.form.errors.${errors.productCode}`, ruleParams)
              : editing
                ? t('products.form.productCodeLocked')
                : t('products.form.productCodeHint', ruleParams)
          }}
        </span>
      </div>

      <div class="field">
        <label :for="fieldId('name')">{{ t('products.form.name') }}</label>
        <input
          :id="fieldId('name')"
          v-model="form.name"
          class="control"
          type="text"
          autocomplete="off"
          :aria-invalid="errors.name ? 'true' : undefined"
          :aria-describedby="`${fieldId('name')}-hint`"
        />
        <span :id="`${fieldId('name')}-hint`" class="hint" :class="{ 'hint--error': errors.name }">
          {{ errors.name ? t('products.form.errors.name') : t('products.form.nameHint') }}
        </span>
      </div>

      <ProductCodeRuleSection
        v-if="product"
        v-model="rule"
        :sheet-category="product.category"
        :suggested="!product.codeRuleConfigured"
        :disabled="busy"
      />

      <ProductPhotoManager
        v-if="product && photosVisible"
        :product-code="product.productCode"
        :name="product.name"
        :disabled="busy"
      />

      <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
      <button type="submit" class="sr-only" tabindex="-1">{{ t('products.form.save') }}</button>
    </form>

    <template #footer>
      <AppButton
        variant="secondary"
        size="lg"
        :disabled="busy"
        @click="emit('update:modelValue', false)"
      >
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton size="lg" :loading="busy" @click="submit">
        {{ editing ? t('products.form.save') : t('products.form.create') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

/* v8 form control: 40px, white, a hairline ring; focus adds the accent ring and halo. */
.control {
  height: 40px;
  min-width: 0;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-size: var(--fs-small);
  outline: none;
}

.control:focus-visible {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.control[readonly] {
  background: var(--f5);
  color: var(--t2);
}

.control[aria-invalid='true'] {
  box-shadow: inset 0 0 0 1px var(--red);
}

.hint {
  font-size: var(--fs-meta);
  color: var(--t3);
}

.hint--error {
  color: var(--red);
}

.failure {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}
</style>
