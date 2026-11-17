<script setup lang="ts">
import type { ProductCategoryResponse } from '@iorder/shared/staff-cost';
import { computed, reactive, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import {
  CATEGORY_NAME_MAX,
  buildCreateCategoryRequest,
  buildUpdateCategoryRequest,
  describeCatalogError,
  emptyCategoryForm,
  formFromCategory,
  type CategoryNameError,
} from '../domain/category-form';
import CodeRuleFields from './CodeRuleFields.vue';

const props = defineProps<{
  modelValue: boolean;
  /** null creates a new category; otherwise this one is edited. */
  category: ProductCategoryResponse | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [category: ProductCategoryResponse, created: boolean];
}>();

const { t } = useI18n();
const { catalogApi } = useServices();
const id = useId();

const form = reactive(emptyCategoryForm());
const nameError = ref<CategoryNameError | null>(null);
const failure = ref<string | null>(null);
const busy = ref(false);
const editing = computed(() => props.category !== null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    Object.assign(form, props.category ? formFromCategory(props.category) : emptyCategoryForm());
    nameError.value = null;
    failure.value = null;
  },
  { immediate: true },
);

/** The request to send, or null when the form is invalid or nothing changed (then it closes). */
function prepare(): (() => Promise<ProductCategoryResponse>) | null {
  const original = props.category;
  if (original) {
    const built = buildUpdateCategoryRequest(original, form);
    if (!built.ok) {
      nameError.value = built.error;
      return null;
    }
    nameError.value = null;
    if (built.request === null) {
      emit('update:modelValue', false);
      return null;
    }
    const request = built.request;
    return () => catalogApi.updateCategory(original.id, request);
  }
  const built = buildCreateCategoryRequest(form);
  if (!built.ok) {
    nameError.value = built.error;
    return null;
  }
  nameError.value = null;
  const request = built.request;
  return () => catalogApi.createCategory(request);
}

async function submit(): Promise<void> {
  if (busy.value) return;
  failure.value = null;
  const send = prepare();
  if (!send) return;
  busy.value = true;
  try {
    const saved = await send();
    emit('saved', saved, !editing.value);
    emit('update:modelValue', false);
  } catch (caught) {
    failure.value = translateDescribed(
      t,
      describeCatalogError(editing.value ? 'updateProduct' : 'createProduct', caught),
    );
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="
      editing ? t('products.categories.form.editTitle') : t('products.categories.form.createTitle')
    "
    max-width="520px"
    @update:model-value="(open) => !busy && emit('update:modelValue', open)"
  >
    <form class="form" novalidate @submit.prevent="submit">
      <div class="field">
        <label :for="`${id}-name`">{{ t('products.categories.form.name') }}</label>
        <input
          :id="`${id}-name`"
          v-model="form.name"
          class="control"
          type="text"
          autocomplete="off"
          :aria-invalid="nameError ? 'true' : undefined"
          :aria-describedby="nameError ? `${id}-name-error` : undefined"
          data-testid="category-name"
        />
        <span v-if="nameError" :id="`${id}-name-error`" class="hint hint--error" role="alert">
          {{ t(`products.categories.form.errors.${nameError}`, { max: CATEGORY_NAME_MAX }) }}
        </span>
      </div>

      <CodeRuleFields
        v-model:tracking-type="form.trackingTypeDefault"
        v-model:marking-required="form.markingRequiredDefault"
        :tracking-label="t('products.categories.form.trackingType')"
        :marking-label="t('products.categories.form.marking')"
      />

      <p class="hint">
        {{
          editing
            ? t('products.categories.form.notRetroactive')
            : t('products.categories.form.createHint')
        }}
      </p>
      <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
      <button type="submit" class="sr-only" tabindex="-1">
        {{ t('products.categories.form.save') }}
      </button>
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
      <AppButton size="lg" :loading="busy" data-testid="category-submit" @click="submit">
        {{ editing ? t('products.categories.form.save') : t('products.categories.form.create') }}
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

.control[aria-invalid='true'] {
  box-shadow: inset 0 0 0 1px var(--red);
}

.hint {
  margin: 0;
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
