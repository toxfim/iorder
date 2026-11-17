<script setup lang="ts">
import { useId } from 'vue';

defineProps<{ label: string }>();
const id = useId();
</script>

<template>
  <div class="field">
    <!-- Dropdowns carry their own accessible name; the visible label is decoration for them. -->
    <span :id="id" class="field__label">{{ label }}</span>
    <slot :label-id="id" />
  </div>
</template>

<style scoped>
.field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* v8 filter group label: 10px/600, secondary text, slightly tracked. */
.field__label {
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--t2);
}
</style>
