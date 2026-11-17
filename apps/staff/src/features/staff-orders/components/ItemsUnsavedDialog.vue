<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import type { LeaveChoice } from '@/features/pricing/composables/use-unsaved-changes';

defineProps<{ modelValue: boolean; count: number; busy: boolean }>();
const emit = defineEmits<{ choose: [choice: LeaveChoice] }>();

const { t } = useI18n();
</script>

<template>
  <!-- Esc, the overlay and the close button all mean "keep editing". -->
  <AppModal
    :model-value="modelValue"
    :title="t('orders.detail.unsaved.title')"
    :description="t('orders.detail.unsaved.description', { count })"
    max-width="460px"
    @update:model-value="(open) => !open && emit('choose', 'stay')"
  >
    <template #footer>
      <AppButton variant="ghost" size="lg" :disabled="busy" @click="emit('choose', 'stay')">
        {{ t('orders.detail.unsaved.stay') }}
      </AppButton>
      <AppButton variant="secondary" size="lg" :disabled="busy" @click="emit('choose', 'leave')">
        {{ t('orders.detail.unsaved.leave') }}
      </AppButton>
      <AppButton size="lg" :loading="busy" @click="emit('choose', 'save')">
        {{ t('orders.detail.unsaved.save') }}
      </AppButton>
    </template>
  </AppModal>
</template>
