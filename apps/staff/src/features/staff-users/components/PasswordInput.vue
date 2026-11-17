<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import { generateStrongPassword } from '../domain/password-generator';

const props = defineProps<{
  modelValue: string;
  label: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** A password was generated here (so the page can show it once after saving). */
  generated: [];
}>();

const { t } = useI18n();
const id = useId();
const hintId = `${id}-hint`;
const errorId = `${id}-error`;
const visible = ref(false);
const describedBy = computed(
  () =>
    [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean).join(' ') ||
    undefined,
);

function generate(): void {
  emit('update:modelValue', generateStrongPassword());
  emit('generated');
  // Shown, so the person can see what was made; it is shown again once after saving.
  visible.value = true;
}
</script>

<template>
  <div class="field">
    <label :for="id" class="field__label">{{ label }}</label>
    <div class="row">
      <input
        :id="id"
        class="field__input"
        :class="{ 'field__input--error': error }"
        :value="modelValue"
        :type="visible ? 'text' : 'password'"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        autocomplete="new-password"
        autocapitalize="off"
        spellcheck="false"
        data-testid="password-input"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <AppButton
        size="md"
        variant="secondary"
        :disabled="disabled"
        :aria-pressed="visible"
        data-testid="password-toggle"
        @click="visible = !visible"
      >
        {{ visible ? t('staffUsers.accounts.create.hide') : t('staffUsers.accounts.create.show') }}
      </AppButton>
    </div>
    <AppButton
      size="sm"
      variant="ghost"
      class="generate"
      :disabled="disabled"
      data-testid="password-generate"
      @click="generate"
    >
      {{ t('staffUsers.accounts.create.generate') }}
    </AppButton>
    <span v-if="hint" :id="hintId" class="field__hint">{{ hint }}</span>
    <span v-if="error" :id="errorId" class="field__error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.field > * {
  max-width: 100%;
}

/* v8 form field (as TextField in the staff app): 11px/500 label, 40px white input with a
   hairline ring, accent ring and halo on focus. */
.field__label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

.row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
}

.field__input {
  flex: 1 1 auto;
  height: 40px;
  min-width: 0;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
}

.field__input--error {
  box-shadow: inset 0 0 0 1px var(--red);
}

.field__input:focus-visible {
  outline: 0;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.field__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.field__error {
  font-size: var(--fs-meta);
  color: var(--red);
}
</style>
