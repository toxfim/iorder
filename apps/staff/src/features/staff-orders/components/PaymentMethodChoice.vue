<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { PAYMENT_METHODS, type PaymentMethod } from '@iorder/shared/staff-orders';

// Native radios: with nothing checked there is no default, so the manager has to pick one.
defineProps<{
  modelValue: PaymentMethod | null;
  disabled?: boolean;
  /** Shown under the options while nothing is chosen. */
  hint?: string;
  /** The required marker after the legend (the approval needs a choice). */
  required?: boolean;
  /** The 32px variant of the payment card (changing the method of an approved order). */
  compact?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: PaymentMethod] }>();

const { t } = useI18n();
const name = useId();
</script>

<template>
  <fieldset
    class="method"
    :class="{ 'method--compact': compact }"
    data-testid="payment-method-choice"
  >
    <legend class="method__legend">
      {{ t('orders.paymentMethod.title') }}<span v-if="required" aria-hidden="true"> *</span>
    </legend>
    <div class="method__options">
      <label
        v-for="method in PAYMENT_METHODS"
        :key="method"
        class="method__option"
        :class="{
          'method__option--on': modelValue === method,
          'method__option--disabled': disabled,
        }"
      >
        <input
          type="radio"
          class="method__radio"
          :name="name"
          :value="method"
          :checked="modelValue === method"
          :disabled="disabled"
          :data-testid="`payment-method-${method}`"
          @change="emit('update:modelValue', method)"
        />
        {{ t(`orders.paymentMethod.${method}`) }}
      </label>
    </div>
    <p v-if="hint && modelValue === null" class="method__hint">{{ hint }}</p>
  </fieldset>
</template>

<style scoped>
.method {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.method__legend {
  margin-bottom: 8px;
  padding: 0;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

/* v8: two equal white hairline buttons; the chosen one orange-tinted with an orange ring. */
.method__options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.method__option {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}

.method--compact .method__option {
  height: 32px;
  border-radius: var(--r-input);
  font-weight: 500;
}

.method__option:hover:not(.method__option--disabled) {
  background: var(--hov);
}

.method__option--on,
.method__option--on:hover:not(.method__option--disabled) {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc-fg);
}

.method__option--disabled {
  cursor: default;
  color: var(--t3);
}

/* Visually hidden, still focusable: the whole label is the target. */
.method__radio {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
}

.method__option:has(.method__radio:focus-visible) {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.method__hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

@media (pointer: coarse), (hover: none) {
  .method__option {
    min-height: 44px;
  }
}
</style>
