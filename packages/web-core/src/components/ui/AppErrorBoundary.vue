<script setup lang="ts">
import { onErrorCaptured, shallowRef, watch } from 'vue';
import StateView from './StateView.vue';

const props = defineProps<{
  /** When this changes (for example the route path) the boundary clears its error state. */
  resetKey?: string;
}>();

const error = shallowRef<unknown>(null);

// A render or event-handler error in any descendant (a formatter RangeError, a bad API payload)
// must not blank the whole page. It is logged, not swallowed, and replaced by the error state.
onErrorCaptured((caught) => {
  console.error(caught);
  error.value = caught;
  // false: handled here, do not also bubble to app.config.errorHandler.
  return false;
});

function reset(): void {
  error.value = null;
}

watch(() => props.resetKey, reset);
</script>

<template>
  <StateView v-if="error" state="error" @retry="reset" />
  <slot v-else />
</template>
