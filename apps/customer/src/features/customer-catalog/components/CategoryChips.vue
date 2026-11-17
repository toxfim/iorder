<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import AppTabs from '@core/components/ui/AppTabs.vue';
import type { TabItem } from '@core/components/ui/tabs';
import { chipTabKey } from '../domain/category-groups';

// The horizontally scrollable category bar of the customer price list: "All" first, then the
// categories, "Other" last (the caller orders them). Built on AppTabs, which already gives
// aria-selected, roving tabindex, arrow keys and 44px touch targets.
interface Chip {
  /** The selection value this chip stands for. */
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

const props = defineProps<{
  modelValue: string;
  chips: readonly Chip[];
  label: string;
  idPrefix: string;
  panelId: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const root = ref<HTMLElement | null>(null);

const tabs = computed<TabItem[]>(() =>
  props.chips.map((chip, index) => ({
    id: chipTabKey(index),
    label: chip.label,
    count: chip.count,
  })),
);
const selectedKey = computed(() => {
  const index = props.chips.findIndex((chip) => chip.value === props.modelValue);
  return chipTabKey(Math.max(index, 0));
});

function select(key: string): void {
  const chip = props.chips.find((_, index) => chipTabKey(index) === key);
  if (chip && chip.value !== props.modelValue) emit('update:modelValue', chip.value);
}

// Keeps the chosen chip visible in the scrolling bar (also after a deep link or a restore).
// Horizontal only: the page itself must not jump.
function revealSelected(): void {
  void nextTick(() => {
    root.value
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  });
}
watch(selectedKey, revealSelected);
onMounted(revealSelected);
</script>

<template>
  <div ref="root" class="chips">
    <AppTabs
      size="sm"
      :model-value="selectedKey"
      :tabs="tabs"
      :label="label"
      :id-prefix="idPrefix"
      :panel-id="panelId"
      @update:model-value="select"
    />
  </div>
</template>

<style scoped>
.chips {
  min-width: 0;
  padding-bottom: 8px;
}
</style>
