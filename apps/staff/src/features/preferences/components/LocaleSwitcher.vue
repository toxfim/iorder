<script setup lang="ts">
import { LOCALES } from '@iorder/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import { LOCALE_NAMES, isLocale } from '@core/i18n';
import { useLocale } from '@core/i18n/use-locale';

const { t } = useI18n();
const { locale, setLocale } = useLocale();

const options = computed(() => LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })));

function onSelect(value: string): void {
  if (isLocale(value)) setLocale(value);
}
</script>

<template>
  <AppDropdown
    :model-value="locale"
    :options="options"
    :label="t('common.language')"
    align="right"
    compact
    @update:model-value="onSelect"
  >
    <template #value>
      <span class="code">{{ locale }}</span>
    </template>
  </AppDropdown>
</template>

<style scoped>
.code {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: var(--fs-small);
}
</style>
