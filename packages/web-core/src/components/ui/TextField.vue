<script setup lang="ts">
import { computed, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    hint?: string;
    error?: string | null;
    type?: 'text' | 'tel' | 'email';
    inputmode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
    autocomplete?: string;
    maxlength?: number;
    disabled?: boolean;
    /** Integers only: every non-digit is dropped as it is typed or pasted (also in the DOM). */
    digitsOnly?: boolean;
    /** Most digits kept when `digitsOnly` is set (the maxlength attribute would count the spaces of a formatted value). */
    maxDigits?: number;
    /** Display format of the digits (for example grouped phone digits); the bound value stays plain digits. */
    format?: (digits: string) => string;
    /** A fixed visible lead character inside the field (for example `+`); never part of the value. */
    prefix?: string;
    /** A fixed visible unit at the right end of the field (for example `$`); never part of the value. */
    suffix?: string;
    placeholder?: string;
    /** Known values offered while typing (a native datalist); any other text stays allowed. */
    suggestions?: readonly string[];
  }>(),
  {
    hint: undefined,
    error: null,
    type: 'text',
    inputmode: undefined,
    autocomplete: 'off',
    maxlength: undefined,
    disabled: false,
    digitsOnly: false,
    maxDigits: undefined,
    format: undefined,
    prefix: undefined,
    suffix: undefined,
    placeholder: undefined,
    suggestions: undefined,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

// A text input with a numeric keyboard instead of `type="number"`: number inputs accept `e`, `+`
// and `-`, drop leading zeros, lose precision on long ids and change with the mouse wheel.
const shown = computed(() =>
  props.digitsOnly && props.format ? props.format(props.modelValue) : props.modelValue,
);

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (!props.digitsOnly) {
    emit('update:modelValue', input.value);
    return;
  }
  const raw = input.value;
  const caret = input.selectionStart ?? raw.length;
  const digitsBeforeCaret = raw.slice(0, caret).replace(/\D+/g, '').length;
  let digits = raw.replace(/\D+/g, '');
  if (props.maxDigits !== undefined) digits = digits.slice(0, props.maxDigits);
  const display = props.format ? props.format(digits) : digits;
  // The bound value may stay the same (a letter was typed), so the DOM is corrected here, and the
  // caret is put back after the same number of digits so typing in the middle does not jump.
  if (input.value !== display) {
    input.value = display;
    let position = 0;
    let seen = 0;
    while (position < display.length && seen < Math.min(digitsBeforeCaret, digits.length)) {
      if (/\d/.test(display.charAt(position))) seen += 1;
      position += 1;
    }
    input.setSelectionRange(position, position);
  }
  emit('update:modelValue', digits);
}

const id = useId();
const hintId = `${id}-hint`;
const errorId = `${id}-error`;
const listId = `${id}-list`;
const describedBy = computed(
  () =>
    [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean).join(' ') ||
    undefined,
);
</script>

<template>
  <div class="field">
    <label :for="id" class="field__label">{{ label }}</label>
    <div class="field__box">
      <span
        v-if="prefix"
        class="field__prefix"
        :class="{ 'field__prefix--filled': modelValue !== '' }"
        aria-hidden="true"
        >{{ prefix }}</span
      >
      <input
        :id="id"
        class="field__input"
        :class="{
          'field__input--error': error,
          'field__input--prefixed': prefix,
          'field__input--suffixed': suffix,
        }"
        :value="shown"
        :type="type"
        :inputmode="digitsOnly ? 'numeric' : inputmode"
        :pattern="digitsOnly ? '[0-9]*' : undefined"
        :autocomplete="autocomplete"
        :maxlength="maxlength"
        :disabled="disabled"
        :placeholder="placeholder"
        :list="suggestions ? listId : undefined"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        autocapitalize="off"
        spellcheck="false"
        @input="onInput"
      />
      <span v-if="suffix" class="field__suffix" aria-hidden="true">{{ suffix }}</span>
      <datalist v-if="suggestions" :id="listId">
        <option v-for="value in suggestions" :key="value" :value="value" />
      </datalist>
    </div>
    <span v-if="hint" :id="hintId" class="field__hint">{{ hint }}</span>
    <span v-if="error" :id="errorId" class="field__error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field__label {
  font-size: var(--fs-meta);
  color: var(--t3);
}

.field__box {
  position: relative;
  display: flex;
  align-items: center;
}

.field__prefix {
  position: absolute;
  left: 12px;
  color: var(--t3);
  font-size: var(--fs-body);
  pointer-events: none;
}

.field__input {
  width: 100%;
  height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--f5);
  font-size: var(--fs-body);
  min-width: 0;
}

/* The prefix is one character wide: the text starts right after it, as one number. */
.field__input--prefixed {
  padding-left: calc(12px + 1ch);
}

.field__prefix--filled {
  color: var(--ink);
}

.field__suffix {
  position: absolute;
  right: 12px;
  color: var(--t3);
  font-size: var(--fs-body);
  pointer-events: none;
}

.field__input--suffixed {
  padding-right: calc(12px + 1.5ch);
}

.field__input--error {
  outline: 1px solid var(--red);
}

.field__input:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.field__hint {
  font-size: var(--fs-meta);
  color: var(--t3);
}

.field__error {
  font-size: var(--fs-meta);
  color: var(--red);
}
/* Staff design v8: 40px white inputs with a hairline ring, 7px radius, 12px text; focus draws the
   accent ring with a soft halo. */
:root[data-staff-app] .field__label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}
:root[data-staff-app] .field__input {
  height: 40px;
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  color: var(--ink);
}
:root[data-staff-app] .field__input::placeholder {
  color: var(--t3);
}
:root[data-staff-app] .field__input--error {
  outline: 0;
  box-shadow: inset 0 0 0 1px var(--red);
}
:root[data-staff-app] .field__input:focus-visible {
  outline: 0;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}
:root[data-staff-app] .field__prefix,
:root[data-staff-app] .field__suffix {
  font-size: var(--fs-small);
}
:root[data-staff-app] .field__hint {
  color: var(--t2);
}
</style>
