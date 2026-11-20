<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { OrganizationLabel, OrganizationType } from '@iorder/shared';
import AppBadge from '@core/components/ui/AppBadge.vue';
import { LABEL_TONE, TYPE_TONE } from '@/features/staff-organizations/domain/organization-badges';

// The organization's type («Guruh» / «Yakka shaxs») and label tags, in the organization pages'
// colours. The label is absent for the roles that do not see money (the server leaves it out of the
// DTO), so the component draws only what it is given. Every tag carries its word.
defineProps<{ type: OrganizationType; label?: OrganizationLabel | null }>();

const { t } = useI18n();
</script>

<template>
  <span class="tags">
    <AppBadge :tone="TYPE_TONE[type]" data-testid="org-type-tag">{{
      t(`orders.clientTags.types.${type}`)
    }}</AppBadge>
    <AppBadge v-if="label" :tone="LABEL_TONE[label]" data-testid="org-label-tag">{{
      t(`orders.clientTags.labels.${label}`)
    }}</AppBadge>
  </span>
</template>

<style scoped>
.tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
