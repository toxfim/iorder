<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { RemovedLine } from '../composables/use-cart-actions';

// Offered for a few seconds after a line was removed. The announcement for screen readers comes
// from the page's own live region, so this bar is not a second one.
defineProps<{ line: RemovedLine; error?: string | null }>();
defineEmits<{ restore: []; dismiss: [] }>();

const { t } = useI18n();
</script>

<template>
  <div class="undo">
    <span class="undo__text">
      {{ t('customer.cart.removed', { name: line.name }) }}
      <span v-if="error" class="undo__error" role="alert">{{ error }}</span>
    </span>
    <button type="button" class="undo__btn" @click="$emit('restore')">
      {{ t('customer.cart.undo') }}
    </button>
    <button
      type="button"
      class="undo__close"
      :aria-label="t('customer.cart.dismissUndo')"
      @click="$emit('dismiss')"
    >
      <span aria-hidden="true">{{ '×' }}</span>
    </button>
  </div>
</template>

<style scoped>
.undo {
  display: flex;
  align-items: center;
  gap: 4px 8px;
  padding: 4px 4px 4px 14px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--f5);
  font-size: var(--fs-body);
}

.undo__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--t2);
}

.undo__error {
  display: block;
  margin-top: 2px;
  color: var(--red);
  font-size: var(--fs-small);
}

.undo__btn,
.undo__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: var(--tap-min);
  min-height: var(--tap-min);
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--ink);
  font-size: var(--fs-body);
  cursor: pointer;
}

.undo__btn {
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.undo__btn:hover,
.undo__close:hover {
  background: var(--ef);
}

.undo__btn:focus-visible,
.undo__close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}
</style>
