<script setup lang="ts">
import type { StaffRole } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import AppBadge from '@core/components/ui/AppBadge.vue';

defineProps<{ roles: readonly StaffRole[] }>();
const { t } = useI18n();
</script>

<template>
  <span class="badges">
    <!-- v8 role chips: neutral pills; the administrator gets the accent so it stands out. -->
    <AppBadge v-for="role in roles" :key="role" :tone="role === 'ADMIN' ? 'accent' : 'neutral'">
      {{ t(`roles.staff.${role}`) }}
    </AppBadge>
  </span>
</template>

<style scoped>
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
