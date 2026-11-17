<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDialogFocus } from '@core/composables/use-dialog-focus';

const props = defineProps<{ modelValue: boolean; title: string; variant?: 'categories' }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const { t } = useI18n();
const titleId = useId();
const panel = ref<HTMLElement | null>(null);
const open = computed(() => props.modelValue);
function close(): void {
  emit('update:modelValue', false);
}
useDialogFocus({ active: open, container: panel, onEscape: close });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="customer-sheet"
      :class="{ 'customer-sheet--categories': variant === 'categories' }"
    >
      <div class="customer-sheet__overlay" @click="close" />
      <section
        ref="panel"
        class="customer-sheet__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <div class="customer-sheet__handle" aria-hidden="true" />
        <header>
          <h2 :id="titleId">{{ title }}</h2>
          <button type="button" :aria-label="t('common.close')" @click="close">
            {{ variant === 'categories' ? '✕' : '×' }}
          </button>
        </header>
        <div class="customer-sheet__body"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.customer-sheet {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: end;
  justify-content: center;
  overscroll-behavior: contain;
}
.customer-sheet__overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay-modal);
  touch-action: none;
}
.customer-sheet__panel {
  position: relative;
  width: 100%;
  max-width: 520px;
  max-height: 85dvh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 20px calc(24px + env(safe-area-inset-bottom, 0px));
  border-radius: 24px 24px 0 0;
  background: var(--w);
  outline: none;
}
.customer-sheet__handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--d9);
  margin: 0 auto 6px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: var(--fs-amount);
}
button {
  border: 0;
  background: transparent;
  color: var(--t3);
  font-size: 26px;
  min-width: var(--tap-min);
  min-height: var(--tap-min);
  cursor: pointer;
}
.customer-sheet__body {
  overflow-y: auto;
  overscroll-behavior: contain;
}
@media (min-width: 960px) {
  .customer-sheet {
    align-items: center;
    padding: 32px;
  }
  .customer-sheet__panel {
    border-radius: var(--r-card);
    padding: 24px;
  }
  .customer-sheet__handle {
    display: none;
  }
}
.customer-sheet--categories .customer-sheet__panel {
  height: min(var(--customer-category-sheet-h), 85dvh);
  gap: var(--r-panel);
  padding: var(--gap-block);
  border-radius: var(--customer-category-sheet-radius) var(--customer-category-sheet-radius) 0 0;
}
.customer-sheet--categories .customer-sheet__handle {
  flex: none;
  margin-bottom: var(--customer-category-handle-gap);
}
.customer-sheet--categories header {
  min-height: var(--customer-category-heading-h);
  position: relative;
  flex: none;
}
.customer-sheet--categories h2 {
  font-size: var(--fs-amount);
  font-weight: 600;
  line-height: var(--customer-category-leading);
  padding-inline-end: var(--tap-min);
}
.customer-sheet--categories header button {
  position: absolute;
  inset-inline-end: calc((var(--customer-category-close-size) - var(--tap-min)) / 2);
  font-size: var(--customer-category-close-size);
  padding: 0;
}
.customer-sheet--categories .customer-sheet__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.customer-sheet--categories .customer-sheet__body :deep(.category-options) {
  overflow-y: auto;
  overscroll-behavior: contain;
  min-height: 0;
  max-height: var(--customer-category-list-h);
}
@media (min-width: 960px) {
  .customer-sheet--categories .customer-sheet__panel {
    border-radius: var(--customer-category-sheet-radius);
  }
}
</style>
