<script setup lang="ts">
// A product's small photo in a square frame, or the app's placeholder icon when it has none (the
// same icon as the price list). `alt` is empty where the name is printed right next to it.
withDefaults(defineProps<{ src: string | null; alt?: string }>(), { alt: '' });
</script>

<template>
  <span
    class="photo"
    :class="{ 'photo--none': src === null }"
    :aria-hidden="src === null || undefined"
  >
    <img v-if="src !== null" :src="src" :alt="alt" loading="lazy" decoding="async" />
    <svg v-else viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor">
      <rect x="3" y="4" width="18" height="16" rx="3" stroke-width="1.5" />
      <circle cx="9" cy="10" r="2" stroke-width="1.5" />
      <path d="m21 16-5-5-9 9" stroke-width="1.5" />
    </svg>
  </span>
</template>

<style scoped>
.photo {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  width: 100%;
  overflow: hidden;
  border-radius: var(--r-btn-sm);
  background: var(--w);
}
.photo--none {
  background: var(--f5);
  color: var(--d9);
}
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
