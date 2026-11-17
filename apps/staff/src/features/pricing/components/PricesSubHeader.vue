<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import AppBackLink from '@core/components/ui/AppBackLink.vue';

// The v8 page header of every page under Narxlar (the list, versions, one version, products,
// categories) and of Qoldiq: a 28px title with a 12px grey subtitle on the left, the page actions
// on the right. Sub-pages add a "← parent" link above the title.
withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    backTo?: RouteLocationRaw;
    backLabel?: string;
  }>(),
  { subtitle: undefined, backTo: undefined, backLabel: undefined },
);
</script>

<template>
  <header class="head">
    <div class="head__text">
      <AppBackLink v-if="backTo" :to="backTo">{{ backLabel }}</AppBackLink>
      <div class="head__line">
        <h1 class="head__title">{{ title }}</h1>
        <slot name="badge" />
      </div>
      <p v-if="subtitle" class="head__subtitle">{{ subtitle }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="head__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.head__text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.head__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

/* v8: 28px in the regular weight, no tracking. */
.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__subtitle {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
  overflow-wrap: anywhere;
}

.head__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

@media (max-width: 720px) {
  .head__title {
    font-size: 24px;
  }

  .head__actions {
    width: 100%;
  }
}
</style>
