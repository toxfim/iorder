<script setup lang="ts">
import { useI18n } from 'vue-i18n';

// What a shop with no received order sees instead of empty recommendation blocks: how ordering
// works, in three steps. The catalog entry card is the page's (it stays for everyone).
const { t } = useI18n();
const STEPS = ['prices', 'cart', 'delivery'] as const;
</script>

<template>
  <section
    class="first-visit"
    aria-labelledby="home-first-visit-title"
    data-testid="home-first-visit"
  >
    <div class="first-visit__intro">
      <h2 id="home-first-visit-title" class="first-visit__title">
        {{ t('customer.home.firstVisit.title') }}
      </h2>
      <p class="first-visit__text">{{ t('customer.home.firstVisit.description') }}</p>
    </div>
    <ol class="steps">
      <li v-for="(step, index) in STEPS" :key="step" class="step">
        <span class="step__number" aria-hidden="true">{{ index + 1 }}</span>
        <span class="step__text">
          <strong>{{ t(`customer.home.firstVisit.steps.${step}.title`) }}</strong>
          <span>{{ t(`customer.home.firstVisit.steps.${step}.text`) }}</span>
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.first-visit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
}
.first-visit__intro {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.first-visit__title {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.25;
}
.first-visit__text {
  margin: 0;
  font-size: var(--fs-small);
  line-height: 1.45;
  color: var(--t3);
  text-wrap: pretty;
}
.steps {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.step {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.step__number {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-meta);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.step__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-top: 4px;
  font-size: var(--fs-small);
  line-height: 1.4;
}
.step__text > span {
  color: var(--t3);
}

@media (min-width: 640px) {
  .steps {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }
}
</style>
