<script setup lang="ts">
export type BadgeTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'danger'
  | 'warning'
  | 'sand'
  | 'solid'
  | 'plain'
  | 'dark'
  | 'muted'
  | 'outline'
  | 'info';

withDefaults(
  defineProps<{
    tone?: BadgeTone;
    /** `pill` is the 8px status pill; `count` is the round accent counter used in the nav. */
    shape?: 'pill' | 'count';
    /** A 5px dot in the text colour before the label: the v8 status pill. */
    dot?: boolean;
  }>(),
  { tone: 'neutral', shape: 'pill', dot: false },
);
</script>

<template>
  <span class="badge" :class="[`badge--${tone}`, `badge--${shape}`, { 'badge--dot': dot }]">
    <span v-if="dot" class="badge__dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.badge--pill {
  padding: 4px 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.badge--count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  font-size: var(--fs-group);
}

.badge--neutral {
  background: var(--ef);
  color: var(--t2);
}
.badge--accent {
  background: var(--acc-bg);
  color: var(--acc-fg);
}
.badge--success {
  background: var(--green-bg);
  color: var(--green);
}
.badge--danger {
  background: var(--red-bg);
  color: var(--red);
}
.badge--warning {
  background: var(--amber-bg);
  color: var(--amber);
}
.badge--sand {
  background: var(--beige);
  color: var(--ink);
}
.badge--plain {
  background: var(--ef);
  color: var(--ink);
}
.badge--dark {
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}
.badge--muted {
  background: var(--f5);
  color: var(--t2);
}
.badge--outline {
  background: var(--w);
  color: var(--ink);
}
.badge--solid {
  background: var(--acc);
  color: var(--acc-on);
}
/* Blue tone of design v8 (TONE b); the customer palette has no blue, so it falls back to neutral. */
.badge--info {
  background: var(--blue-bg, var(--ef));
  color: var(--blue, var(--t2));
}

.badge--dot {
  gap: 6px;
}

.badge__dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

/* Staff design v8: 6px status pills with 11px regular text, 4px count badges with 10px text. */
:root[data-staff-app] .badge--pill {
  padding: 4px 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-meta);
  font-weight: 400;
}

:root[data-staff-app] .badge--count {
  min-width: 0;
  height: auto;
  padding: 2px 6px;
  border-radius: var(--r-kbd);
  font-size: var(--fs-group);
  font-weight: 500;
  line-height: 1.4;
}
</style>
