<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppButton from './AppButton.vue';
import AppModal from './AppModal.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    description?: string;
    confirmLabel: string;
    cancelLabel?: string;
    tone?: 'primary' | 'danger';
    /** The confirmed action is running: both buttons lock and the dialog cannot be dismissed. */
    loading?: boolean;
    /** Already translated failure of the confirmed action; the dialog stays open to show it. */
    error?: string | null;
  }>(),
  {
    description: undefined,
    cancelLabel: undefined,
    tone: 'primary',
    loading: false,
    error: null,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [] }>();

const { t } = useI18n();

function onUpdate(value: boolean): void {
  // Dismissing while the request runs would hide its outcome.
  if (!value && props.loading) return;
  emit('update:modelValue', value);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="title"
    :description="description"
    @update:model-value="onUpdate"
  >
    <slot />
    <p v-if="error" class="confirm__error" role="alert">{{ error }}</p>
    <template #footer>
      <AppButton variant="secondary" size="lg" :disabled="loading" @click="onUpdate(false)">
        {{ cancelLabel ?? t('common.cancel') }}
      </AppButton>
      <AppButton
        :variant="tone === 'danger' ? 'danger' : 'primary'"
        size="lg"
        :loading="loading"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.confirm__error {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}
</style>
