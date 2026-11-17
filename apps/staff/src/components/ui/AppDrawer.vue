<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDelayedPresence } from '@core/composables/use-delayed-presence';
import { useDialogFocus } from '@core/composables/use-dialog-focus';
import StaffIcon from './StaffIcon.vue';
import { EXIT_MS } from '@core/components/ui/motion';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    /** The design's drawers open on the right; `left` is used for the mobile navigation. */
    side?: 'right' | 'left';
    width?: string;
    /** Drop the body padding (the mobile navigation brings its own). */
    flush?: boolean;
  }>(),
  { side: 'right', width: 'min(520px, 100%)', flush: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
const titleId = useId();
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
    <div v-if="mounted" class="drawer" :class="{ 'drawer--closing': closing }" data-testid="drawer">
      <div class="drawer__overlay" @click="close" />
      <aside
        ref="panel"
        class="drawer__panel"
        :class="`drawer__panel--${side}`"
        :style="{ width }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <header class="drawer__header">
          <h2 :id="titleId" class="drawer__title">{{ title }}</h2>
          <button
            type="button"
            class="drawer__close"
            :aria-label="t('common.close')"
            @click="close"
          >
            <StaffIcon name="x" :size="14" />
          </button>
        </header>
        <div class="drawer__body" :class="{ 'drawer__body--flush': flush }">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="drawer__footer">
          <slot name="footer" />
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
}

.drawer--closing {
  /* Nothing can be clicked while the exit animation plays. */
  pointer-events: none;
}

.drawer__overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay-drawer);
  animation: fadeIn 0.18s ease both;
}

.drawer--closing .drawer__overlay {
  animation: fadeOut 0.22s ease both;
}

.drawer__panel {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  max-width: 100%;
  background: var(--page);
  outline: none;
}

.drawer__panel--right {
  right: 0;
  box-shadow:
    0 0 0 1px var(--float-ring),
    var(--sh-drawer);
  animation: slideIn 0.32s var(--ease) both;
}

.drawer__panel--left {
  left: 0;
  box-shadow:
    0 0 0 1px var(--float-ring),
    var(--sh-drawer-left);
  animation: slideInLeft 0.32s var(--ease) both;
}

.drawer--closing .drawer__panel--right {
  animation: slideOut 0.22s ease forwards;
}

.drawer--closing .drawer__panel--left {
  animation: slideOutLeft 0.22s ease forwards;
}

.drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* A drawer is as tall as the screen: its first and last rows keep clear of Telegram's controls
     and of the phone's home indicator (both 0 outside a phone webview). */
  padding: calc(18px + var(--safe-top, 0px)) 20px 18px;
  border-bottom: 1px solid var(--e8);
  background: var(--w);
}

.drawer__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.drawer__close {
  /* v8 dialog close: a 30px white square with a hairline ring and a 14px cross. */
  display: grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  cursor: pointer;
}

.drawer__close:hover {
  background: var(--f5);
}

@media (pointer: coarse), (hover: none) {
  .drawer__close {
    width: 44px;
    height: 44px;
  }
}

.drawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
}

/* No footer under it: the body is the last row. */
.drawer__body:last-child {
  padding-bottom: calc(20px + var(--safe-bottom, 0px));
}

.drawer__body--flush,
.drawer__body--flush:last-child {
  padding: 0;
}

.drawer__footer {
  display: flex;
  gap: 10px;
  padding: 16px 20px calc(16px + var(--safe-bottom, 0px));
  border-top: 1px solid var(--e8);
  background: var(--w);
}
</style>
