<script setup lang="ts" generic="T extends string">
export interface SegmentOption<V extends string> {
  readonly value: V;
  readonly label: string;
  /** Muted number after the label (the organization tabs show counts). */
  readonly count?: number;
}

withDefaults(
  defineProps<{
    modelValue: T;
    options: readonly SegmentOption<T>[];
    /** Accessible name of the group. */
    label: string;
    /** `track` picks the grey of the rail: the home chart uses E8, tabs and role pickers EF. */
    track?: 'e8' | 'ef';
    size?: 'sm' | 'md';
  }>(),
  { track: 'ef', size: 'md' },
);

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();
</script>

<template>
  <div class="seg" :class="[`seg--${track}`, `seg--${size}`]" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="seg__item"
      :class="{ 'seg__item--on': option.value === modelValue }"
      :aria-pressed="option.value === modelValue"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
      <span v-if="option.count !== undefined" class="seg__count">{{ option.count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Design v8: a light rail with a hairline ring; the selected option is a white chip with its own
   ring and ink text. `track` keeps its API: e8 is the slightly darker rail. */
.seg {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.seg--e8 {
  background: var(--ef);
}

.seg--ef {
  background: var(--f5);
}

.seg--sm {
  padding: 2px;
  border-radius: var(--r-input);
}

.seg__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--t2);
  font-size: var(--fs-small);
  font-weight: 500;
  cursor: pointer;
}

.seg--sm .seg__item {
  min-height: 26px;
  padding: 0 10px;
  border-radius: var(--r-kbd);
  font-size: var(--fs-meta);
}

.seg__item:hover:not(.seg__item--on) {
  color: var(--ink);
}

.seg__item--on {
  background: var(--w);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--e8);
}

.seg__count {
  color: var(--t3);
  font-weight: 400;
}

@media (pointer: coarse), (hover: none) {
  .seg__item {
    min-height: 44px;
  }
}
</style>
