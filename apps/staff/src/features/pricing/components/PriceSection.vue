<script setup lang="ts">
// "Narxlar" has no tab bar in v1: the current list is the page, and the versions list and the
// product management are reached from the buttons at the top right of that page. This wrapper only
// gives every page of the section the same entrance animation.
</script>

<template>
  <div class="section">
    <RouterView />
  </div>
</template>

<style scoped>
.section {
  display: flex;
  /* Grows with the work area, so a page that renders only a state can centre it. */
  flex: 1 0 auto;
  flex-direction: column;
  gap: var(--gap-block);
  min-width: 0;
  animation: viewIn 0.35s var(--ease) both;
}
</style>
