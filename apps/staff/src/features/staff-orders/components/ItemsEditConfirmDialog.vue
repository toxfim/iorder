<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [] }>();

const { t } = useI18n();
</script>

<template>
  <!-- Esc, the overlay and the close button all mean "back": the clicked change is not applied. -->
  <AppModal
    :model-value="modelValue"
    :title="t('orders.detail.editConfirm.title')"
    :description="t('orders.detail.editConfirm.description')"
    max-width="460px"
    @update:model-value="(open) => emit('update:modelValue', open)"
  >
    <p class="note" role="note">{{ t('orders.detail.editConfirm.note') }}</p>
    <template #footer>
      <AppButton variant="secondary" size="lg" @click="emit('update:modelValue', false)">
        {{ t('orders.detail.editConfirm.back') }}
      </AppButton>
      <AppButton size="lg" @click="emit('confirm')">
        {{ t('orders.detail.editConfirm.confirm') }}
      </AppButton>
    </template>
  </AppModal>
</template>
<style scoped>
.note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-input);
  background: var(--beige);
  font-size: var(--fs-small);
  font-weight: 600;
}
</style>
