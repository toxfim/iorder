<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';

export interface FilterMenuOption {
  readonly value: string;
  readonly label: string;
  /** Muted number at the right (how many products the choice keeps). */
  readonly count?: number;
}

// The design's list filter of Qoldiq («Brend Xiaomi», «Yetkazib beruvchi Hammasi»): a button
// that names the list and its value, and a popup with its own search field over the options;
// the same look and keys as the category filter next to it. ARIA: the button opens the popup,
// whose search field is a combobox driving the listbox through aria-activedescendant (the focus
// stays in the field while the arrows move). Every text comes translated.
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly FilterMenuOption[];
    /** The "no filter" choice: its value and text ("Hammasi"). */
    allValue: string;
    allLabel: string;
    /** The list's name, shown before the value and naming the popup ("Brend"). */
    label: string;
    searchPlaceholder: string;
    noMatchText: string;
    /** Name of the × that resets the filter to "all". */
    clearLabel: string;
    /** Shown for a value that is none of the options (an old or hand-edited link). */
    unknownLabel: string;
    /** The count read with its unit ("3 mahsulot"); without it the number is read alone. */
    countText?: (count: number) => string;
  }>(),
  { countText: undefined },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const baseId = useId();
const listId = `${baseId}-list`;
const optionId = (index: number): string => `${baseId}-opt-${index}`;

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const open = ref(false);
const query = ref('');
const active = ref(0);

const selected = computed(() => props.modelValue !== props.allValue);
const currentLabel = computed(() =>
  selected.value
    ? (props.options.find((o) => o.value === props.modelValue)?.label ?? props.unknownLabel)
    : props.allLabel,
);
// "All" heads the list only while nothing is typed: a search is a search for a value.
const shown = computed<readonly FilterMenuOption[]>(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (needle === '') return [{ value: props.allValue, label: props.allLabel }, ...props.options];
  return props.options.filter((o) => o.label.toLocaleLowerCase().includes(needle));
});

// Typing starts again from the first match, so Enter always takes what is on top.
watch(query, () => {
  active.value = 0;
});

function scrollActiveIntoView(): void {
  // By id lookup, not a selector: useId() output is not guaranteed to be a valid CSS identifier.
  const element = list.value ? document.getElementById(optionId(active.value)) : null;
  element?.scrollIntoView?.({ block: 'nearest' });
}

async function openMenu(): Promise<void> {
  query.value = '';
  open.value = true;
  await nextTick();
  active.value = Math.max(
    0,
    shown.value.findIndex((o) => o.value === props.modelValue),
  );
  input.value?.focus();
  scrollActiveIntoView();
}

function closeMenu(returnFocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  query.value = '';
  if (returnFocus) trigger.value?.focus();
}

function toggle(): void {
  if (open.value) closeMenu(true);
  else void openMenu();
}

function pick(value: string): void {
  if (value !== props.modelValue) emit('update:modelValue', value);
  closeMenu(true);
}

function clear(): void {
  emit('update:modelValue', props.allValue);
  closeMenu(false);
  trigger.value?.focus();
}

function move(step: number): void {
  const total = shown.value.length;
  if (total === 0) return;
  active.value = Math.min(total - 1, Math.max(0, active.value + step));
  void nextTick(scrollActiveIntoView);
}

function onInputKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter': {
      event.preventDefault();
      const choice = shown.value[active.value];
      if (choice) pick(choice.value);
      break;
    }
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      break;
    case 'Tab':
      closeMenu(false);
      break;
  }
}

function onTriggerKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void openMenu();
  }
}

// Any press outside the filter closes it, without moving the focus.
function onDocumentPress(event: Event): void {
  const target = event.target;
  if (target instanceof Node && root.value?.contains(target)) return;
  closeMenu(false);
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && !root.value?.contains(next)) closeMenu(false);
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocumentPress);
    document.addEventListener('touchstart', onDocumentPress, { passive: true });
  } else {
    document.removeEventListener('mousedown', onDocumentPress);
    document.removeEventListener('touchstart', onDocumentPress);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPress);
  document.removeEventListener('touchstart', onDocumentPress);
});
</script>

<template>
  <div
    ref="root"
    class="fmenu"
    :class="{ 'fmenu--on': selected, 'fmenu--open': open }"
    @focusout="onFocusOut"
  >
    <div class="fmenu__field">
      <button
        ref="trigger"
        type="button"
        class="fmenu__trigger"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="open ? listId : undefined"
        :aria-label="`${label}: ${currentLabel}`"
        @click="toggle"
        @keydown="onTriggerKey"
      >
        <span class="fmenu__k" aria-hidden="true">{{ label }}</span>
        <span class="fmenu__value">{{ currentLabel }}</span>
        <StaffIcon v-if="!selected" name="down" :size="13" class="fmenu__chevron" />
      </button>
      <button
        v-if="selected"
        type="button"
        class="fmenu__clear"
        :aria-label="clearLabel"
        data-testid="filter-menu-clear"
        @click="clear"
      >
        <StaffIcon name="x" :size="13" />
      </button>
    </div>

    <div v-if="open" class="fmenu__pop">
      <div class="fmenu__search">
        <StaffIcon name="search" :size="13" class="fmenu__icon" />
        <input
          ref="input"
          v-model="query"
          class="fmenu__input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
          aria-expanded="true"
          :aria-controls="listId"
          :aria-activedescendant="shown.length > 0 ? optionId(active) : undefined"
          :aria-label="searchPlaceholder"
          :placeholder="searchPlaceholder"
          @keydown="onInputKey"
        />
      </div>
      <!-- mousedown.prevent keeps the focus in the search field while an option is clicked. -->
      <ul
        :id="listId"
        ref="list"
        class="fmenu__list"
        role="listbox"
        :aria-label="label"
        @mousedown.prevent
      >
        <li
          v-for="(option, index) in shown"
          :id="optionId(index)"
          :key="option.value"
          role="option"
          class="fmenu__option"
          :class="{
            'fmenu__option--active': index === active,
            'fmenu__option--on': option.value === modelValue,
          }"
          :aria-selected="option.value === modelValue"
          @click="pick(option.value)"
          @mousemove="active = index"
        >
          <StaffIcon name="check" :size="14" class="fmenu__check" />
          <span class="fmenu__label">{{ option.label }}</span>
          <template v-if="option.count !== undefined">
            <span class="fmenu__count num" :aria-hidden="countText ? 'true' : undefined">{{
              option.count
            }}</span>
            <span v-if="countText" class="sr-only">{{ countText(option.count) }}</span>
          </template>
        </li>
      </ul>
      <p v-if="shown.length === 0" class="fmenu__none" role="status">{{ noMatchText }}</p>
    </div>
  </div>
</template>

<style scoped>
/* The same field and popup as the category filter beside it (CategoryDropdown.vue). */
.fmenu {
  position: relative;
  flex: 0 1 230px;
  min-width: 190px;
}

.fmenu__field {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 6px 0 12px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.fmenu--open .fmenu__field,
.fmenu--on .fmenu__field {
  box-shadow: inset 0 0 0 2px var(--acc);
}

.fmenu--on .fmenu__field {
  background: var(--acc-bg);
}

.fmenu__trigger {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  text-align: left;
  cursor: pointer;
}

.fmenu__trigger:focus-visible,
.fmenu__clear:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

.fmenu__k {
  flex: none;
  color: var(--t2);
}

.fmenu__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fmenu__icon,
.fmenu__chevron {
  flex: none;
  color: var(--t2);
}

.fmenu__chevron {
  margin-right: 6px;
  transition: transform 0.2s ease;
}

.fmenu--open .fmenu__chevron {
  transform: rotate(180deg);
}

.fmenu__clear {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--acc-fg);
  cursor: pointer;
}

.fmenu__clear:hover {
  background: var(--w);
}

.fmenu__pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: max(100%, 280px);
  max-width: calc(100vw - 32px);
  overflow: hidden;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--e8),
    var(--sh-dropdown);
}

/* The last filter of the row opens towards the left, inside the page. */
.fmenu:last-child .fmenu__pop {
  right: 0;
  left: auto;
}

.fmenu__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin: 10px;
  padding: 0 10px;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.fmenu__search:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.fmenu__input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
}

.fmenu__list {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-top: 1px solid var(--e8);
  list-style: none;
}

.fmenu__option {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  color: var(--ink);
  font-size: var(--fs-small);
  cursor: pointer;
}

.fmenu__option--active {
  background: var(--hov);
}

.fmenu__option--on {
  background: var(--acc-bg);
}

.fmenu__option--active.fmenu__option--on {
  box-shadow: inset 0 0 0 1px var(--acc);
}

.fmenu__check {
  flex: none;
  color: var(--acc);
  visibility: hidden;
}

.fmenu__option--on .fmenu__check {
  visibility: visible;
}

.fmenu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fmenu__option--on .fmenu__label {
  font-weight: 600;
}

.fmenu__count {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.fmenu__none {
  margin: 0;
  padding: 16px 10px;
  font-size: var(--fs-small);
  color: var(--t2);
  text-align: center;
}

@media (pointer: coarse) {
  .fmenu__option {
    min-height: 44px;
  }

  .fmenu__clear {
    width: 36px;
    height: 36px;
  }
}
</style>
