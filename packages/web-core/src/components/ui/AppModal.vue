<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useDelayedPresence } from '@core/composables/use-delayed-presence';
import { useDialogFocus } from '@core/composables/use-dialog-focus';
import { EXIT_MS } from './motion';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    description?: string;
    maxWidth?: string;
    /** No panel padding: the title, body and footer run edge to edge between divider lines
     *  (staff design T3). The content then pads itself. */
    flush?: boolean;
  }>(),
  { description: undefined, maxWidth: '440px', flush: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const titleId = useId();
const descriptionId = useId();
const panel = ref<HTMLElement | null>(null);
const open = computed(() => props.modelValue);
const { mounted, closing } = useDelayedPresence(open, EXIT_MS);

function close(): void {
  emit('update:modelValue', false);
}

useDialogFocus({ active: open, container: panel, onEscape: close });
</script>

<template>
  <Teleport to="body">
    <div v-if="mounted" class="modal" :class="{ 'modal--closing': closing }" data-testid="modal">
      <div class="modal__overlay" @click="close" />
      <div
        ref="panel"
        class="modal__panel"
        :class="{ 'modal__panel--flush': flush }"
        :style="{ maxWidth }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
      >
        <!-- The title slot adds a decoration (an icon) around the same text; `title` stays the name.
             A richer header (a photo, a subtitle, a close button) uses the `header` slot instead
             and puts the dialog's name on its own heading with the given `titleId`, so the name
             stays the title text alone. -->
        <div v-if="$slots.header" class="modal__title">
          <slot name="header" :title-id="titleId" />
        </div>
        <h2 v-else :id="titleId" class="modal__title">
          <slot name="title">{{ title }}</slot>
        </h2>
        <p v-if="description" :id="descriptionId" class="modal__description">{{ description }}</p>
        <div v-if="$slots.default" class="modal__body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal__footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

/* The staff app also runs full height inside Telegram: a dialog stays clear of Telegram's
   controls and of the phone's home indicator. */
:root[data-staff-app] .modal {
  padding: calc(16px + var(--safe-top, 0px)) 16px calc(16px + var(--safe-bottom, 0px));
}

.modal--closing {
  pointer-events: none;
  animation: fadeOut 0.22s ease forwards;
}

.modal__overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay-modal);
  animation: fadeIn 0.18s ease both;
}

.modal__panel {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 22px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--float-ring),
    var(--sh-cmdk);
  animation: modalIn 0.25s var(--ease) both;
  outline: none;
}

.modal__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 19px;
  font-weight: 700;
}

.modal__description {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
/* Staff design v8: 14px dialog, 24px padding, 17px/600 title, 12px secondary text. */
:root[data-staff-app] .modal__panel {
  gap: 18px;
  padding: 24px;
  border-radius: var(--r-modal);
  /* The padded overlay's height (already clear of the safe-area insets), not 100vh: on iOS
     Safari and in a fullscreen Mini App 100vh reaches under the toolbar and the home indicator,
     which would hide the footer. */
  max-height: 100%;
  overflow: hidden;
}
/* A tall dialog scrolls its body only: the title and the footer's buttons (save, cancel) stay in
   view. The 4px inset keeps the fields' focus rings clear of the scroll edge. */
:root[data-staff-app] .modal__body {
  flex: 1 1 auto;
  min-height: 0;
  margin: -4px;
  padding: 4px;
  overflow: auto;
}
/* A short viewport (keyboard open, landscape phone) would leave the body a sliver between the
   title and the footer: the whole panel scrolls instead. */
@media (max-height: 520px) {
  :root[data-staff-app] .modal__panel {
    overflow: auto;
  }
  :root[data-staff-app] .modal__body {
    flex: none;
    overflow: visible;
  }
}
:root[data-staff-app] .modal__title {
  font-size: 17px;
  font-weight: 600;
}
:root[data-staff-app] .modal__description {
  /* v8 keeps the subtitle 4px under the title, closer than the 18px between blocks. */
  margin-top: -14px;
  color: var(--t2);
}
:root[data-staff-app] .modal__footer {
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 0;
}

/* A flush dialog: the panel has no padding and the three parts are divided by lines. */
.modal__panel--flush,
:root[data-staff-app] .modal__panel--flush {
  gap: 0;
  padding: 0;
}

.modal__panel--flush .modal__title {
  padding: 16px 20px;
  border-bottom: 1px solid var(--ef);
}

.modal__panel--flush .modal__body,
:root[data-staff-app] .modal__panel--flush .modal__body {
  margin: 0;
  padding: 0;
}

.modal__panel--flush .modal__footer {
  margin-top: 0;
  padding: 14px 20px 16px;
  border-top: 1px solid var(--ef);
}
</style>
