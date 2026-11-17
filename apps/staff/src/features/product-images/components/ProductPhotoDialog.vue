<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import ProductPhotoManager from './ProductPhotoManager.vue';

// The photos of one product on their own, for a list row's "Rasmlar" action: the same manager the
// price and product dialogs hold (manager, admin; the server enforces MANAGE_PRODUCT_IMAGES).
const props = defineProps<{
  modelValue: boolean;
  /** Null while nothing is chosen; the dialog then renders nothing inside. */
  product: { readonly productCode: string; readonly name: string } | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  /** A photo was (or may have been) added, switched or removed: the owner refreshes its row. */
  changed: [];
}>();

const { t } = useI18n();
// A photo request is running: closing now would hide its outcome.
const busy = ref(false);

watch(
  () => props.modelValue,
  (open) => {
    if (open) busy.value = false;
  },
);

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('photos.dialogTitle')"
    :description="product ? `${product.productCode} · ${product.name}` : undefined"
    max-width="520px"
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <ProductPhotoManager
      v-if="product"
      :product-code="product.productCode"
      :name="product.name"
      :after-change="() => emit('changed')"
      :busy-change="(running: boolean) => (busy = running)"
    />
    <template #footer>
      <AppButton variant="secondary" :disabled="busy" @click="close">
        {{ t('photos.close') }}
      </AppButton>
    </template>
  </AppModal>
</template>
