<script setup lang="ts">
import { computed } from 'vue';
import { STAFF_ICONS, type StaffIconName } from './staff-icons';

// The v8 stroke icons (docs/private/design/v8), drawn like AppIcon: currentColor, decorative only.
const props = withDefaults(
  defineProps<{
    name: StaffIconName;
    size?: number;
    /** v8 draws its icons with a 1.6px stroke. */
    strokeWidth?: number;
  }>(),
  { size: 18, strokeWidth: 1.6 },
);

const shapes = computed(() => STAFF_ICONS[props.name]);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="staff-icon"
  >
    <component :is="shape.tag" v-for="(shape, index) in shapes" :key="index" v-bind="shape.attrs" />
  </svg>
</template>

<style scoped>
.staff-icon {
  display: block;
  flex: none;
}
</style>
