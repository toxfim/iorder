<script setup lang="ts">
// The v8 list toolbar: a white hairline card (padding 16/20) holding search, filters and counts;
// controls align to the bottom edge so labelled fields and plain buttons line up.
</script>

<template>
  <div class="filter-panel" role="group">
    <slot />
  </div>
</template>

<style scoped>
.filter-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  padding: 16px 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}
</style>
