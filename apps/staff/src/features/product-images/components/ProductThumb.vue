<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import PhotoLightbox from './PhotoLightbox.vue';

// A product photo thumbnail: a square of a fixed size, lazily loaded, with a neutral placeholder
// when there is no photo or it fails to load. A click opens the large variant (no dialog window,
// only the photo over a see-through backdrop, owner 2026-11-13), unless
// the thumbnail sits inside another control (a row button, a phone card): then it is only a
// picture (`zoomable` false), because a button cannot hold a second button.
// Two roots (the thumbnail and its dialog): a class from the parent goes onto the thumbnail.
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** The thumb variant; null = no photo. */
    src: string | null;
    /** The large variant for the enlarged view; the thumb is used when it is missing. */
    largeSrc?: string | null;
    /** The product name: the image's alternative text and the dialog title. */
    alt: string;
    /** Edge length in px. */
    size?: number;
    zoomable?: boolean;
  }>(),
  { largeSrc: null, size: 40, zoomable: true },
);

const { t } = useI18n();
const failed = ref(false);
const open = ref(false);

// A new photo (after an upload or a switch) gets another try even if the previous one failed.
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);

const shown = computed(() => props.src !== null && !failed.value);
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
const iconSize = computed(() => Math.max(14, Math.round(props.size * 0.42)));
</script>

<template>
  <button
    v-if="shown && zoomable"
    type="button"
    v-bind="$attrs"
    class="thumb thumb--button"
    :style="box"
    :aria-label="t('photos.zoom', { name: alt })"
    data-testid="product-thumb"
    @click.stop="open = true"
  >
    <img
      class="thumb__img"
      :src="src ?? undefined"
      :alt="alt"
      :width="size"
      :height="size"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
  </button>
  <span v-else-if="shown" v-bind="$attrs" class="thumb" :style="box" data-testid="product-thumb">
    <img
      class="thumb__img"
      :src="src ?? undefined"
      :alt="alt"
      :width="size"
      :height="size"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
  </span>
  <!-- The name is written next to it, so the placeholder says nothing to a screen reader. -->
  <span
    v-else
    v-bind="$attrs"
    class="thumb thumb--empty"
    :style="box"
    :title="t('photos.none')"
    aria-hidden="true"
    data-testid="product-thumb-empty"
  >
    <StaffIcon name="image" :size="iconSize" />
  </span>

  <PhotoLightbox v-if="zoomable && shown" v-model="open" :src="largeSrc ?? src ?? ''" :alt="alt" />
</template>

<style scoped>
.thumb {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  vertical-align: middle;
}

.thumb--button {
  padding: 0;
  border: 0;
  cursor: zoom-in;
}

.thumb--button:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.thumb--empty {
  color: var(--t3);
}

.thumb__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
