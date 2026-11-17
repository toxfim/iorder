<script setup lang="ts">
// Design v8 card: white, a 1px hairline ring, 12px radius, no shadow. With a title it gets the v8
// section header (15px/600 title, 11px subtitle, actions on the right); rows (AppCardRow) are
// ruled by hairlines instead of the v1 grey container with gaps.
withDefaults(
  defineProps<{
    as?: string;
    /** `sand` is the accent card (KPI "waiting for approval"). */
    tone?: 'default' | 'sand';
    title?: string;
    subtitle?: string;
  }>(),
  { as: 'section', tone: 'default', title: undefined, subtitle: undefined },
);
</script>

<template>
  <component :is="as" class="card" :class="`card--${tone}`">
    <header v-if="title || $slots.actions" class="card__head">
      <div class="card__heading">
        <h3 v-if="title" class="card__title">{{ title }}</h3>
        <p v-if="subtitle" class="card__subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="card__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="card__rows">
      <slot />
    </div>
  </component>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.card--sand {
  background: var(--acc-bg2);
}

.card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px;
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

.card__subtitle {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.card__rows {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>
