<script setup lang="ts">
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { useTelegramBackButton } from '@core/telegram/use-back-button';
import AppIcon from './AppIcon.vue';

// The "← Mijozlar" link above detail pages (v1): plain text, 14px / 600 / #4D4D4D.
// `round`: the approved staff order pages draw a soft accent circle with a chevron and a bigger
// accent label instead of the small arrow link.
const props = withDefaults(defineProps<{ to: RouteLocationRaw; variant?: 'text' | 'round' }>(), {
  variant: 'text',
});
// `back`: the person used this way back (the link, or Telegram's own button), before the
// navigation starts. A page that treats a return differently from other arrivals listens to it.
const emit = defineEmits<{ back: [] }>();

// Inside Telegram (in an app that opted in) the back button of Telegram's own header does the
// same as this link, so a phone user need not aim at the small link at the top of the page.
const router = useRouter();
useTelegramBackButton(() => {
  emit('back');
  void router.push(props.to);
});
</script>

<template>
  <RouterLink :to="to" class="back" :class="`back--${variant}`" @click="emit('back')">
    <span v-if="variant === 'round'" class="back__dot" aria-hidden="true">
      <AppIcon name="chevron" :size="14" :stroke-width="1.8" />
    </span>
    <span v-else aria-hidden="true">{{ '←' }}</span>
    <slot />
  </RouterLink>
</template>

<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 4px 0;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--t2);
}

.back:hover {
  color: var(--ink);
}

@media (pointer: coarse) {
  .back {
    min-height: 44px;
  }
}
/* Staff design v8: the back link is a small orange link above the page title. */
:root[data-staff-app] .back {
  gap: 4px;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--acc-fg);
}
:root[data-staff-app] .back:hover {
  /* v8 brightens to the raw accent, which is under 4.5:1 for text; an underline marks it instead. */
  color: var(--acc-fg);
  text-decoration: underline;
}
:root[data-staff-app] .back--round,
.back--round {
  gap: 10px;
  font-size: var(--fs-body-lg);
  font-weight: 600;
  color: var(--acc-fg);
}

.back__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--acc-bg);
  transform: rotate(90deg);
}
</style>
