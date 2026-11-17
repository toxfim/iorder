<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TabItem } from './tabs';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    tabs: readonly TabItem[];
    /** Accessible name of the tab list. */
    label: string;
    /** Prefix of the tab ids (`<idPrefix>-tab-<id>`); the panel points back with aria-labelledby. */
    idPrefix: string;
    /** The one panel these tabs switch; every tab controls it. */
    panelId: string;
    size?: 'md' | 'sm';
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

const list = ref<HTMLElement | null>(null);

// The selected value can match no tab (a category that disappeared). Then the first tab is the
// one in the tab order, and the owner is told to select it, so the tabs never sit without a
// selection or a focusable tab.
const selectedKnown = computed(() => props.tabs.some((tab) => tab.id === props.modelValue));
watch(
  [() => props.tabs, () => props.modelValue],
  () => {
    const first = props.tabs[0];
    if (first && !selectedKnown.value) emit('update:modelValue', first.id);
  },
  { immediate: true },
);
const isFocusable = (tab: TabItem, index: number): boolean =>
  selectedKnown.value ? tab.id === props.modelValue : index === 0;

// Automatic activation: arrows move focus AND select, as the ARIA tabs pattern recommends for
// panels that render instantly. Only the selected tab is in the tab order (roving tabindex).
function onKeydown(event: KeyboardEvent): void {
  const ids = props.tabs.map((tab) => tab.id);
  const current = ids.indexOf(props.modelValue);
  let next: number;
  if (event.key === 'ArrowRight') next = (current + 1) % ids.length;
  else if (event.key === 'ArrowLeft')
    next = current < 0 ? ids.length - 1 : (current - 1 + ids.length) % ids.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = ids.length - 1;
  else return;
  event.preventDefault();
  const id = ids[next];
  if (id === undefined) return;
  emit('update:modelValue', id);
  // Matched by attribute value in code, not in a selector: ids come from data (category names).
  Array.from(list.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
    .find((element) => element.dataset.tabId === id)
    ?.focus();
}
</script>

<template>
  <div
    ref="list"
    class="tabs"
    :class="`tabs--${size}`"
    role="tablist"
    :aria-label="label"
    @keydown="onKeydown"
  >
    <button
      v-for="(tab, index) in tabs"
      :id="`${idPrefix}-tab-${tab.id}`"
      :key="tab.id"
      type="button"
      role="tab"
      class="tabs__item"
      :class="{ 'tabs__item--on': tab.id === modelValue }"
      :data-tab-id="tab.id"
      :aria-selected="tab.id === modelValue"
      :aria-controls="panelId"
      :tabindex="isFocusable(tab, index) ? 0 : -1"
      @click="emit('update:modelValue', tab.id)"
    >
      <span class="tabs__label">{{ tab.label }}</span>
      <span v-if="tab.count !== undefined" class="tabs__count">{{ tab.count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Grey rail with a white selected tab, like the v1 segmented controls; long lists scroll. */
.tabs {
  display: flex;
  gap: 4px;
  max-width: 100%;
  padding: 4px;
  overflow-x: auto;
  border-radius: var(--r-input);
  background: var(--ef);
  scrollbar-width: thin;
}

.tabs--sm {
  gap: 3px;
  padding: 3px;
  border-radius: var(--r-btn-sm);
}

.tabs__item {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--t2);
  font-size: var(--fs-body);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: -2px;
}

.tabs--sm .tabs__item {
  padding: 6px 12px;
  font-size: var(--fs-small);
}

.tabs__item:hover:not(.tabs__item--on) {
  background: var(--e8);
}

.tabs__item:focus-visible {
  outline-color: var(--acc);
}

.tabs__item--on {
  background: var(--w);
  color: var(--ink);
  box-shadow: var(--sh-seg);
}

.tabs__count {
  color: var(--t3);
  font-variant-numeric: tabular-nums;
}

@media (pointer: coarse) {
  .tabs__item {
    min-height: 44px;
  }
}
/* Staff design v8: underline tabs on a hairline, the selected one orange with a 2px bar; the
   count sits in a 4px chip. */
:root[data-staff-app] .tabs {
  gap: 24px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: inset 0 -1px 0 var(--e8);
}
:root[data-staff-app] .tabs--sm {
  gap: 18px;
}
:root[data-staff-app] .tabs__item {
  gap: 6px;
  height: 42px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-size: var(--fs-small);
  font-weight: 400;
  color: var(--t2);
}
:root[data-staff-app] .tabs--sm .tabs__item {
  height: 36px;
  padding: 0;
}
:root[data-staff-app] .tabs__item:hover:not(.tabs__item--on) {
  background: transparent;
  color: var(--ink);
}
:root[data-staff-app] .tabs__item--on {
  background: transparent;
  box-shadow: inset 0 -2px 0 var(--acc);
  color: var(--acc-fg);
  font-weight: 600;
}
:root[data-staff-app] .tabs__count {
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--ef);
  font-size: var(--fs-group);
  font-weight: 500;
  color: var(--t2);
}
:root[data-staff-app] .tabs__item--on .tabs__count {
  background: var(--acc-bg);
  color: var(--acc-fg);
}
</style>
