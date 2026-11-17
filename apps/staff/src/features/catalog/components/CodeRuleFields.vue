<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { TRACKING_TYPES, type TrackingType } from '../domain/category-form';

// The two parts of a per-unit code rule: one identifier (none, IMEI or serial, never both) and
// an independent marking-code switch. Used by the category defaults and the product's own rule.

defineProps<{
  trackingLabel: string;
  markingLabel: string;
  disabled?: boolean;
}>();
const trackingType = defineModel<TrackingType>('trackingType', { required: true });
const markingRequired = defineModel<boolean>('markingRequired', { required: true });

const { t } = useI18n();
const id = useId();
</script>

<template>
  <fieldset class="rule" :disabled="disabled">
    <legend class="rule__legend">{{ trackingLabel }}</legend>
    <div class="rule__options" role="radiogroup" :aria-label="trackingLabel">
      <label
        v-for="type in TRACKING_TYPES"
        :key="type"
        class="option"
        :class="{ 'option--on': trackingType === type }"
      >
        <input
          v-model="trackingType"
          class="option__input"
          type="radio"
          :name="`${id}-tracking`"
          :value="type"
          :data-testid="`tracking-${type}`"
        />
        <span>{{ t(`products.rule.tracking.${type}`) }}</span>
      </label>
    </div>
    <p v-if="trackingType === 'IMEI'" class="hint">{{ t('products.rule.imeiHint') }}</p>
    <label class="switch">
      <input
        v-model="markingRequired"
        class="switch__box"
        type="checkbox"
        :aria-describedby="`${id}-marking-hint`"
        data-testid="marking-required"
      />
      <span class="switch__text">
        <span class="switch__title">{{ markingLabel }}</span>
        <span :id="`${id}-marking-hint`" class="hint">{{ t('products.rule.markingHint') }}</span>
      </span>
    </label>
  </fieldset>
</template>

<style scoped>
.rule {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.rule__legend {
  padding: 0 0 6px;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

.rule__options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* v8 choice chips: a hairline ring; the chosen one takes the accent tint and an accent ring. */
.option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: var(--tap-min);
  padding: 0 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  font-weight: 500;
  cursor: pointer;
}

.option--on {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc-fg);
}

.option:has(.option__input:focus-visible),
.switch:has(.switch__box:focus-visible) {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.option__input {
  margin: 0;
  accent-color: var(--acc);
}

.switch {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: var(--tap-min);
  padding: 10px 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  cursor: pointer;
}

.switch__box {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 1px 0 0;
  accent-color: var(--acc);
}

.switch__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.switch__title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}
</style>
