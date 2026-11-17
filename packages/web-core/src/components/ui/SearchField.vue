<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import AppIcon from './AppIcon.vue';

defineProps<{
  modelValue: string;
  placeholder: string;
  maxlength?: number;
  /** Keeps the label for screen readers only: for a one-line toolbar next to unlabelled controls. */
  labelHidden?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();
const id = useId();
</script>

<template>
  <div class="search">
    <label class="search__label" :class="{ 'sr-only': labelHidden }" :for="id">{{
      t('common.search')
    }}</label>
    <div class="search__box">
      <AppIcon name="search" :size="16" />
      <input
        :id="id"
        class="search__input"
        type="search"
        autocomplete="off"
        :value="modelValue"
        :placeholder="placeholder"
        :maxlength="maxlength"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  flex: 1 1 260px;
  flex-direction: column;
  gap: 6px;
  max-width: 420px;
}

.search__label {
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--t3);
}

.search__box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--w);
  color: var(--t3);
}

.search__box:focus-within {
  border-color: var(--ink);
}

.search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: var(--fs-body);
  color: var(--ink);
}

.search__input:focus-visible {
  outline: none;
}

@media (pointer: coarse) {
  .search__box {
    min-height: 44px;
  }
}
/* Staff design v8: a 38px white box with a hairline ring and a 14px icon. */
:root[data-staff-app] .search__label {
  font-weight: 500;
  color: var(--t2);
}
:root[data-staff-app] .search__box {
  height: 38px;
  border: 0;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--t2);
}
:root[data-staff-app] .search__box:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}
:root[data-staff-app] .search__input {
  font-size: var(--fs-small);
}
:root[data-staff-app] .search__input::placeholder {
  color: var(--t3);
}
</style>
