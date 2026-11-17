<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDialogFocus } from '@core/composables/use-dialog-focus';
import StaffIcon from '@/components/ui/StaffIcon.vue';

// The enlarged product photo [owner 2026-11-13]: no dialog window, only the photo at its own
// width and height over a see-through backdrop (shrunk only when it is larger than the screen).
// A click anywhere, Esc or the corner button closes it; focus moves in and goes back to the
// thumbnail, like every other dialog.
const props = defineProps<{ src: string; alt: string }>();
const open = defineModel<boolean>({ required: true });

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const close = (): void => {
  open.value = false;
};
useDialogFocus({ active: computed(() => open.value), container: root, onEscape: close });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      class="lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="props.alt"
      tabindex="-1"
      data-testid="photo-lightbox"
      @click="close"
    >
      <img
        class="lightbox__img"
        :src="props.src"
        :alt="props.alt"
        decoding="async"
        data-testid="product-photo-large"
      />
      <button type="button" class="lightbox__close" :aria-label="t('photos.close')" @click="close">
        <StaffIcon name="x" :size="18" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--overlay-modal);
  cursor: zoom-out;
}

.lightbox:focus {
  outline: none;
}

/* Its own size; never larger than the screen. */
.lightbox__img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 32px);
  object-fit: contain;
}

.lightbox__close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
  cursor: pointer;
}

.lightbox__close:focus-visible {
  outline: 2px solid var(--btn-ink-bg);
  outline-offset: 2px;
}
</style>
