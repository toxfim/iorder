<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { MAX_LINE_QUANTITY } from '../domain/new-order';

// The design's − n + of the new order (product card, cart, order contents). Going below 1 removes
// the line (the owner of the line decides that from the 0 it gets).
const props = defineProps<{ quantity: number; name: string; wide?: boolean }>();
const emit = defineEmits<{ 'update:quantity': [quantity: number] }>();
const { t } = useI18n();
</script>

<template>
  <span class="qty" :class="{ 'qty--wide': wide }">
    <button
      type="button"
      class="qty__btn"
      :aria-label="t('orders.newOrder.items.less', { name })"
      data-testid="qty-less"
      @click="emit('update:quantity', props.quantity - 1)"
    >
      {{ '−' }}
    </button>
    <output class="qty__n" :aria-label="t('orders.newOrder.items.quantity', { name })">{{
      quantity
    }}</output>
    <button
      type="button"
      class="qty__btn"
      :disabled="quantity >= MAX_LINE_QUANTITY"
      :aria-label="t('orders.newOrder.items.more', { name })"
      data-testid="qty-more"
      @click="emit('update:quantity', props.quantity + 1)"
    >
      +
    </button>
  </span>
</template>

<style scoped>
.qty {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.qty--wide {
  display: flex;
  justify-content: space-between;
}

.qty__btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--e8);
  border-radius: 8px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-section);
  font-weight: 500;
  cursor: pointer;
}

.qty__btn:hover:not(:disabled) {
  background: var(--f5);
}

.qty__btn:disabled {
  color: var(--b5);
  cursor: not-allowed;
}

.qty__btn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.qty__n {
  min-width: 28px;
  font-family: var(--font-mono);
  font-size: var(--fs-body-lg);
  font-weight: 500;
  text-align: center;
}

.qty--wide .qty__n {
  font-size: var(--fs-section);
  font-weight: 600;
}

@media (pointer: coarse), (hover: none) {
  .qty__btn {
    width: 44px;
    height: 44px;
  }
}
</style>
