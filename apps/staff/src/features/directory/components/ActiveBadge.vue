<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppBadge from '@core/components/ui/AppBadge.vue';

defineProps<{ active: boolean }>();
const { t } = useI18n();
</script>

<template>
  <AppBadge :tone="active ? 'success' : 'danger'" dot>
    {{ active ? t('customers.status.active') : t('customers.status.blocked') }}
  </AppBadge>
</template>
