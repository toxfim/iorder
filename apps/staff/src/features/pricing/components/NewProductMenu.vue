<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ChipMenu, { type ChipMenuItem } from './ChipMenu.vue';

// The "+ Yangi tovar" action of Narxlar (design 2026-11-09): a white page button whose menu offers
// the two ways to add products the sheet does not have.
const emit = defineEmits<{ single: []; import: [] }>();

const { t } = useI18n();

const items = computed<ChipMenuItem<'single' | 'import'>[]>(() => [
  {
    id: 'single',
    icon: 'pencil',
    title: t('staffCost.manual.menuSingle'),
    hint: t('staffCost.manual.menuSingleHint'),
    testId: 'add-manual-product',
  },
  {
    id: 'import',
    icon: 'sheet',
    title: t('staffCost.manual.menuImport'),
    hint: t('staffCost.manual.menuImportHint'),
    testId: 'import-prices',
  },
]);

function choose(id: 'single' | 'import'): void {
  if (id === 'single') emit('single');
  else emit('import');
}
</script>

<template>
  <ChipMenu
    :label="t('staffCost.manual.add')"
    icon="plus"
    :menu-label="t('staffCost.manual.menuLabel')"
    :items="items"
    test-id="new-product-menu"
    @choose="choose"
  />
</template>
