<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useTheme } from '../composables/use-theme';
import { THEME_CHOICES, isThemeChoice } from '../theme';

const { t } = useI18n();
const { choice, effective, setChoice } = useTheme();

const LABEL_KEYS = {
  system: 'common.themeSystem',
  light: 'common.themeLight',
  dark: 'common.themeDark',
} as const;

const options = computed(() =>
  THEME_CHOICES.map((value) => ({ value, label: t(LABEL_KEYS[value]) })),
);

function onSelect(value: string): void {
  if (isThemeChoice(value)) setChoice(value);
}
</script>

<template>
  <!-- A listbox (aria-selected options) with the three choices: System, Light, Dark. -->
  <AppDropdown
    :model-value="choice"
    :options="options"
    :label="t('common.theme')"
    align="right"
    compact
    @update:model-value="onSelect"
  >
    <template #value>
      <StaffIcon :name="effective === 'dark' ? 'sun' : 'moon'" :size="16" />
    </template>
  </AppDropdown>
</template>
