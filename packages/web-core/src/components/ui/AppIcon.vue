<script setup lang="ts">
import { computed } from 'vue';
import { ICONS, type IconName } from './icons';

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number;
    /** v1 draws its icons with a 1.6-2px stroke. */
    strokeWidth?: number;
  }>(),
  { size: 18, strokeWidth: 2 },
);

const icon = computed(() => ICONS[props.name]);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    :viewBox="icon.viewBox"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="app-icon"
  >
    <component
      :is="shape.tag"
      v-for="(shape, index) in icon.shapes"
      :key="index"
      v-bind="shape.attrs"
    />
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
