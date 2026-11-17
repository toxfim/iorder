<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    as?: string;
    interactive?: boolean;
    /** Position in the list; drives the stagger delay of the entrance animation. */
    index?: number;
  }>(),
  { as: 'div', interactive: false, index: undefined },
);

// specs.md section 5: delay = min(index, 12) x 25ms so a long list never feels slow.
const style = computed(() =>
  props.index === undefined ? undefined : { animationDelay: `${Math.min(props.index, 12) * 25}ms` },
);
</script>

<template>
  <component :is="as" class="row" :class="{ 'row--interactive': interactive }" :style="style">
    <slot />
  </component>
</template>

<style scoped>
/* Design v8: rows of a card are separated by a hairline on top and padded 14/20. Inside a card
   without a header the first rule falls on the card's own ring, so it reads as one line. */
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
  background: transparent;
  min-width: 0;
  animation: rowIn 0.3s ease both;
  /* Interactive rows should be rendered as <button> or <a> (as="button"); neutralise their UA styles. */
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  border-radius: 0;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
}

.row--interactive {
  cursor: pointer;
}

.row--interactive:hover {
  background: var(--hov);
}

.row--interactive:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}
</style>
