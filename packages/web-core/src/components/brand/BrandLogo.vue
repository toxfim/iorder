<script setup lang="ts">
withDefaults(defineProps<{ height?: number }>(), { height: 44 });

// Public assets are served from BASE_URL so the app keeps working if it is hosted under a sub-path.
const base = import.meta.env.BASE_URL;
// The brand name is the same in every language, so it is not a translatable string.
const BRAND_NAME = 'iorder.uz';
</script>

<template>
  <span class="logo" :style="{ height: `${height}px` }">
    <!-- Two files from the design set (docs/private/design/v1/assets); the global theme rules in
         styles/base.css show one of them, so an explicit theme choice works without a flash. -->
    <img class="logo__img logo__img--light" :src="`${base}header-light.png`" :alt="BRAND_NAME" />
    <img class="logo__img logo__img--dark" :src="`${base}header-dark.png`" alt="" />
  </span>
</template>

<style scoped>
.logo {
  display: inline-flex;
}

.logo__img {
  height: 100%;
  width: auto;
}

.logo__img--dark {
  display: none;
}
</style>
