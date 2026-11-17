<script setup lang="ts">
import { useToast } from '@core/composables/use-toast';

const { toast, undoToast, pauseToast, resumeToast } = useToast();
</script>

<template>
  <Teleport to="body">
    <!-- The live region exists permanently so assistive tech announces each new message. -->
    <div class="toast-region" role="status" aria-live="polite">
      <div
        v-if="toast"
        :key="toast.id"
        class="toast"
        data-testid="toast"
        @mouseenter="pauseToast"
        @mouseleave="resumeToast"
        @focusin="pauseToast"
        @focusout="resumeToast"
      >
        <span class="toast__message">{{ toast.message }}</span>
        <button
          v-if="toast.onUndo && toast.undoLabel"
          type="button"
          class="toast__undo"
          @click="undoToast"
        >
          {{ toast.undoLabel }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-region {
  position: fixed;
  left: 50%;
  bottom: calc(var(--toast-bottom, 28px) + var(--safe-bottom, 0px));
  z-index: var(--z-toast);
  width: max-content;
  max-width: calc(100% - 32px);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 18px;
  border-radius: var(--r-input);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
  font-size: var(--fs-body);
  font-weight: 500;
  box-shadow: var(--sh-toast);
  pointer-events: auto;
  /* Centres the toast on the region's left edge; kept outside the keyframes so it also holds
     when prefers-reduced-motion switches the animation off. */
  transform: translateX(-50%);
  animation: toastIn 0.28s var(--ease) both;
}

.toast__undo {
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: var(--acc-on-dark);
  font-size: var(--fs-body);
  font-weight: 700;
  cursor: pointer;
}
/* Staff design v8: the toast is the dark sidebar ink in both themes, 10px radius, 12px text. */
:root[data-staff-app] .toast {
  border-radius: var(--r-row);
  background: var(--side-bg);
  color: var(--side-strong);
  font-size: var(--fs-small);
  padding: 12px 16px;
}
:root[data-staff-app] .toast__undo {
  color: var(--acc-on-dark);
  font-size: var(--fs-small);
  font-weight: 600;
}
</style>
