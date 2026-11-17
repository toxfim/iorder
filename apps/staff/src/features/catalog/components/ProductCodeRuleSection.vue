<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProductRuleValues } from '../domain/category-form';
import CodeRuleFields from './CodeRuleFields.vue';

// The product's own per-unit code rule: which identifiers the warehouse scans for every piece
// before it releases the order. The business category is the sheet's «Категория» and is only
// shown here; no staff category has to be set up first. While no rule was ever set the fields
// start from the company rule (suggested), and the manager may override it.

const props = defineProps<{
  /** The sheet's category text, null when the sheet gave none. */
  sheetCategory: string | null;
  /** true: the values are the company suggestion, not a saved rule yet. */
  suggested: boolean;
  disabled?: boolean;
}>();
const rule = defineModel<ProductRuleValues>({ required: true });

const { t } = useI18n();

const trackingType = computed({
  get: () => rule.value.trackingType,
  set: (value) => {
    rule.value = { ...rule.value, trackingType: value };
  },
});
const markingRequired = computed({
  get: () => rule.value.markingRequired,
  set: (value) => {
    rule.value = { ...rule.value, markingRequired: value };
  },
});
</script>

<template>
  <section class="section" :aria-label="t('products.rule.title')" data-testid="code-rule">
    <h3 class="section__title">{{ t('products.rule.title') }}</h3>
    <p class="hint">{{ t('products.rule.hint') }}</p>

    <div class="field">
      <span class="label">{{ t('products.rule.sheetCategory') }}</span>
      <p class="value" data-testid="sheet-category">
        {{ props.sheetCategory ?? t('products.rule.noSheetCategory') }}
      </p>
    </div>

    <p v-if="props.suggested" class="note" data-testid="rule-suggested">
      {{ t('products.rule.suggested') }}
    </p>

    <CodeRuleFields
      v-model:tracking-type="trackingType"
      v-model:marking-required="markingRequired"
      :tracking-label="t('products.rule.trackingType')"
      :marking-label="t('products.rule.marking')"
      :disabled="props.disabled"
    />
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--e8);
}

.section__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 700;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.label {
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--t3);
}

.hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t3);
}

.value {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--ink);
}

.note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-meta);
  color: var(--t2);
}
</style>
