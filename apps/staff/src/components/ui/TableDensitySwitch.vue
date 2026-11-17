<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMediaQuery } from '@/composables/use-media-query';
import { useTableDensity, type TableDensity } from '@/composables/use-table-density';
import AppSegmented from './AppSegmented.vue';

// The comfortable / compact switch of the tables. DataTable shows it above itself; a page whose
// table is its main content puts it in its own filter row instead (one row less above the table)
// and turns DataTable's copy off. Phones show cards, where density means nothing: no switch there.
const { t } = useI18n();
const { density, setDensity } = useTableDensity();
// Keep in step with DataTable's own breakpoint (cards below 640px).
const wide = useMediaQuery('(min-width: 640px)', true);

const options = computed(() => [
  { value: 'comfortable' as const, label: t('table.density.comfortable') },
  { value: 'compact' as const, label: t('table.density.compact') },
]);
</script>

<template>
  <AppSegmented
    v-if="wide"
    size="sm"
    :model-value="density"
    :options="options"
    :label="t('table.density.label')"
    @update:model-value="setDensity($event as TableDensity)"
  />
</template>
