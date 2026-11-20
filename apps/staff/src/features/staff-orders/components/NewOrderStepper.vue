<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NewOrderStep } from '../domain/new-order';

// The design's step indicator: 1 Mijoz — 2 Tovarlar — 3 Tafsilotlar — 4 Tasdiqlash. Done steps
// are green, the current one is the accent with its name in bold, the next ones grey. Every
// circle also carries words for screen readers (colour is never the only signal). On a phone only
// the current step keeps its name (the design's 390 screens).
const props = defineProps<{ current: NewOrderStep }>();
const { t } = useI18n();

const STEPS = ['customer', 'items', 'details', 'confirm'] as const;
const index = computed(() => STEPS.indexOf(props.current));
const stateOf = (i: number): 'done' | 'current' | 'todo' =>
  i < index.value ? 'done' : i === index.value ? 'current' : 'todo';
</script>

<template>
  <ol class="steps" :aria-label="t('orders.newOrder.steps.label')" data-testid="new-order-steps">
    <li
      v-for="(step, i) in STEPS"
      :key="step"
      class="step"
      :class="`step--${stateOf(i)}`"
      :aria-current="stateOf(i) === 'current' ? 'step' : undefined"
    >
      <span v-if="i > 0" class="step__dash" aria-hidden="true">—</span>
      <span class="step__n" aria-hidden="true">{{ i + 1 }}</span>
      <span class="step__name">{{ t(`orders.newOrder.steps.${step}`) }}</span>
      <span v-if="stateOf(i) !== 'todo'" class="sr-only">{{
        stateOf(i) === 'done'
          ? t('orders.newOrder.steps.done', { step: t(`orders.newOrder.steps.${step}`) })
          : t('orders.newOrder.steps.current', { step: t(`orders.newOrder.steps.${step}`) })
      }}</span>
    </li>
  </ol>
</template>

<style scoped>
.steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body-lg);
  color: var(--t3);
}

.step__dash {
  margin-right: 4px;
  color: var(--t3);
}

.step__n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--e8);
  color: var(--t2);
  font-size: var(--fs-small);
  font-weight: 600;
}

.step--done .step__n {
  background: var(--green);
  color: var(--on-red);
}

.step--current {
  color: var(--ink);
  font-weight: 600;
}

.step--current .step__n {
  background: var(--acc);
  color: var(--acc-on);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Phone: the circles in a row, only the current step named, no dashes. */
@media (max-width: 599px) {
  .step__dash,
  .step:not(.step--current) .step__name {
    display: none;
  }
}
</style>
