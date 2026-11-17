<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppBadge, { type BadgeTone } from '@core/components/ui/AppBadge.vue';
import AppDropdown, { type DropdownOption } from '@/components/ui/AppDropdown.vue';

// A list row's badge that is also its dropdown (type, label): it looks like the badge the others
// see, plus a chevron. `data-row-control` keeps a click on it or beside it from opening the row.
defineProps<{
  modelValue: string;
  options: readonly DropdownOption[];
  /** Accessible name: which organization, which field and its current value. */
  label: string;
  tone: BadgeTone;
  /** The badge text (the selected option's label). */
  text: string;
  /** The chosen value is being saved: the control locks and a spinner says so. */
  saving?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();
</script>

<template>
  <span class="inline" data-row-control>
    <AppDropdown
      class="inline__dd"
      :model-value="modelValue"
      :options="options"
      :label="label"
      :disabled="saving"
      min-width="0"
      @update:model-value="emit('update:modelValue', $event)"
    >
      <template #value>
        <AppBadge :tone="tone">{{ text }}</AppBadge>
      </template>
    </AppDropdown>
    <span v-if="saving" class="inline__spin" aria-hidden="true" />
    <!-- The live region is always there; only its text changes, so screen readers announce it. -->
    <span class="sr-only" role="status">{{ saving ? t('organizations.inline.saving') : '' }}</span>
  </span>
</template>

<style scoped>
.inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  /* The row's cursor is a pointer (it opens the organization); this area does not. */
  cursor: default;
}

/* A row-sized trigger: the 38px filter trigger would crowd a 40px compact row. Touch keeps its
   44px target through the dropdown's own min-height rule. */
.inline :deep(.dd.inline__dd .dd__trigger) {
  height: 30px;
  gap: 6px;
  padding: 0 6px 0 4px;
}

.inline__spin {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--e8);
  border-top-color: var(--acc);
  border-radius: 50%;
  animation: inlineSpin 0.8s linear infinite;
}

@keyframes inlineSpin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .inline__spin {
    animation-duration: 2.4s;
  }
}
</style>
