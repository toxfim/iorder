<script setup lang="ts">
// The home page's list card (design v8): a white hairline card, a 20px header with the title,
// an optional sub line and an orange "↗" link, then rows separated by hairlines.
defineProps<{ title: string; subtitle?: string; actionLabel?: string }>();
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <section class="card" :aria-label="title">
    <header class="card__head">
      <div class="card__heading">
        <h2 class="card__title">{{ title }}</h2>
        <span v-if="subtitle" class="card__sub">{{ subtitle }}</span>
      </div>
      <button v-if="actionLabel" type="button" class="card__action" @click="emit('action')">
        {{ actionLabel }}
      </button>
    </header>
    <div class="card__rows">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 20px 14px;
}

.card__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.card__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.card__sub {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.card__action {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-meta);
  white-space: nowrap;
  cursor: pointer;
}

.card__action:hover {
  color: var(--acc-hover);
}

.card__action:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

.card__rows {
  display: flex;
  flex-direction: column;
}

@media (pointer: coarse), (hover: none) {
  .card__action {
    min-height: 44px;
  }
}
</style>
