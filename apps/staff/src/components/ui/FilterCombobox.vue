<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type CSSProperties } from 'vue';
import { openDropdownId } from '@core/composables/use-open-dropdown';
import StaffIcon from './StaffIcon.vue';

export interface FilterComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Muted number at the right (how many rows the choice keeps). */
  readonly count?: number;
}

// A searchable single-choice filter for long lists (80+ organizations), where a plain dropdown
// would mean scrolling: the text field is the combobox (WAI-ARIA 1.2 "list autocomplete"), the
// options are its listbox, the first one is "all". The field keeps showing the current choice (so
// a screen reader announces it) until the person types; typing filters. It opens on a click,
// ArrowDown or typing, never on Tab focus; it closes on Esc, Tab, an outside press and when the
// focus leaves it. Arrows, Home and End move aria-activedescendant, Enter picks. The list is
// teleported and fixed, so a scrolling panel cannot clip it. Every text comes translated.
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly FilterComboboxOption[];
    /** The "no filter" choice: its value and text. */
    allValue: string;
    allLabel: string;
    /** Accessible name of the field. */
    label: string;
    placeholder: string;
    noMatchText: string;
    /** Name of the button that resets the filter to "all". */
    clearLabel: string;
    /** Shown for a value that is none of the options (an old or hand-edited link). */
    unknownLabel: string;
    /** The count read with its unit ("3 people"); without it the number is read alone. */
    countText?: (count: number) => string;
  }>(),
  { countText: undefined },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const baseId = useId();
const listId = `${baseId}-list`;
const optionId = (index: number): string => `${baseId}-opt-${index}`;

const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const query = ref('');
// Until the person types, the field shows the current choice and the list shows every option.
const typed = ref(false);
const active = ref(0);
const open = computed(() => openDropdownId.value === baseId);

const selectedLabel = computed(() => {
  if (props.modelValue === props.allValue) return '';
  return props.options.find((o) => o.value === props.modelValue)?.label ?? props.unknownLabel;
});
const choices = computed<readonly FilterComboboxOption[]>(() => {
  const needle = typed.value ? query.value.trim().toLocaleLowerCase() : '';
  if (needle === '') return [{ value: props.allValue, label: props.allLabel }, ...props.options];
  return props.options.filter((o) => o.label.toLocaleLowerCase().includes(needle));
});

watch(query, () => {
  active.value = 0;
});

// --- placement (fixed, under the field) ---------------------------------------------------------

const popStyle = ref<CSSProperties>({});
function place(): void {
  const rect = root.value?.getBoundingClientRect();
  if (!rect) return;
  const below = window.innerHeight - rect.bottom;
  const up = below < 240 && rect.top > below;
  popStyle.value = {
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 260)}px`,
    ...(up
      ? { bottom: `${window.innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px` }),
  };
}

function openList(): void {
  if (open.value) return;
  typed.value = false;
  query.value = '';
  active.value = Math.max(
    0,
    choices.value.findIndex((o) => o.value === props.modelValue),
  );
  openDropdownId.value = baseId;
}

function closeList(): void {
  if (openDropdownId.value === baseId) openDropdownId.value = null;
  typed.value = false;
  query.value = '';
}

const inside = (target: EventTarget | null): boolean =>
  target instanceof Node &&
  (root.value?.contains(target) === true || list.value?.contains(target) === true);

function onDocumentPress(event: Event): void {
  if (!inside(event.target)) closeList();
}

function onFocusOut(event: FocusEvent): void {
  if (!inside(event.relatedTarget)) closeList();
}

watch(open, (isOpen) => {
  if (isOpen) {
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', onDocumentPress);
    void nextTick(scrollActiveIntoView);
  } else {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('pointerdown', onDocumentPress);
  }
});

onBeforeUnmount(() => {
  closeList();
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  document.removeEventListener('pointerdown', onDocumentPress);
});

function scrollActiveIntoView(): void {
  document.getElementById(optionId(active.value))?.scrollIntoView?.({ block: 'nearest' });
}

// --- choosing ----------------------------------------------------------------------------------

function choose(option: FilterComboboxOption): void {
  closeList();
  if (option.value !== props.modelValue) emit('update:modelValue', option.value);
}

function clear(): void {
  closeList();
  emit('update:modelValue', props.allValue);
  input.value?.focus();
}

function onClick(): void {
  openList();
  // The current choice stays visible but selected, so the first key typed replaces it.
  input.value?.select();
}

function activate(index: number): void {
  const total = choices.value.length;
  if (total === 0) return;
  active.value = Math.min(total - 1, Math.max(0, index));
  void nextTick(scrollActiveIntoView);
}

function onInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  typed.value = true;
  if (!open.value) openDropdownId.value = baseId;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (open.value) activate(active.value + 1);
      else openList();
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (open.value) activate(active.value - 1);
      break;
    case 'Home':
    case 'End':
      if (!open.value) return;
      event.preventDefault();
      activate(event.key === 'Home' ? 0 : choices.value.length - 1);
      break;
    case 'Enter': {
      if (!open.value) return;
      event.preventDefault();
      const option = choices.value[active.value];
      if (option) choose(option);
      break;
    }
    case 'Escape':
      if (open.value) {
        // Dialog and page shortcuts see an open list's Esc as the list's.
        event.preventDefault();
        event.stopPropagation();
        closeList();
      }
      break;
    case 'Tab':
      closeList();
      break;
  }
}
</script>

<template>
  <div ref="root" class="fcb" :class="{ 'fcb--open': open }" @focusout="onFocusOut">
    <StaffIcon name="search" :size="13" class="fcb__icon" />
    <input
      ref="input"
      :value="typed ? query : selectedLabel"
      class="fcb__input"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && choices.length > 0 ? optionId(active) : undefined"
      :aria-label="label"
      :placeholder="open ? placeholder : allLabel"
      @click="onClick"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      v-if="modelValue !== allValue && !open"
      type="button"
      class="fcb__clear"
      :aria-label="clearLabel"
      data-testid="filter-combobox-clear"
      @click="clear"
    >
      <StaffIcon name="x" :size="13" />
    </button>
    <StaffIcon v-else name="down" :size="13" class="fcb__chevron" />

    <Teleport to="body">
      <!-- mousedown.prevent keeps focus in the field while an option is clicked. -->
      <div v-show="open" ref="list" class="fcb__pop" :style="popStyle" @mousedown.prevent>
        <ul :id="listId" class="fcb__list" role="listbox" :aria-label="label">
          <li
            v-for="(option, index) in choices"
            :id="optionId(index)"
            :key="option.value"
            role="option"
            class="fcb__option"
            :class="{
              'fcb__option--active': index === active,
              'fcb__option--chosen': option.value === modelValue,
            }"
            :aria-selected="option.value === modelValue"
            @click="choose(option)"
            @mousemove="active = index"
          >
            <span class="fcb__label">{{ option.label }}</span>
            <template v-if="option.count !== undefined">
              <span class="fcb__count" :aria-hidden="countText ? 'true' : undefined">{{
                option.count
              }}</span>
              <span v-if="countText" class="sr-only">{{ countText(option.count) }}</span>
            </template>
          </li>
        </ul>
        <p v-if="choices.length === 0" class="fcb__none" role="status">{{ noMatchText }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* v8 field: 38px white with a hairline ring; the open field gets the accent ring. */
.fcb {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 0 10px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.fcb:hover {
  box-shadow: inset 0 0 0 1px var(--t3);
}

.fcb--open,
.fcb:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.fcb__icon,
.fcb__chevron {
  flex: none;
  color: var(--t2);
}

.fcb__chevron {
  transition: transform 0.2s ease;
}

.fcb--open .fcb__chevron {
  transform: rotate(180deg);
}

.fcb__input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  text-overflow: ellipsis;
}

.fcb__input::placeholder {
  color: var(--t2);
}

.fcb__clear {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.fcb__clear:hover {
  background: var(--hov);
  color: var(--ink);
}

.fcb__clear:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 1px;
}

.fcb__pop {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--e8),
    var(--sh-dropdown);
}

.fcb__list {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
}

.fcb__list:empty {
  display: none;
}

.fcb__option {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  color: var(--ink);
  font-size: var(--fs-small);
  cursor: pointer;
}

.fcb__option--active {
  background: var(--hov);
}

.fcb__option--chosen {
  font-weight: 600;
}

.fcb__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fcb__count {
  flex: none;
  color: var(--t2);
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
}

.fcb__none {
  margin: 0;
  padding: 14px 12px;
  font-size: var(--fs-small);
  color: var(--t2);
  text-align: center;
}

/* The app's phone breakpoint; 16px keeps iOS from zooming into the field. */
@media (max-width: 640px) {
  .fcb__input {
    font-size: 16px;
  }
}

@media (pointer: coarse), (hover: none) {
  .fcb {
    min-height: 44px;
  }

  .fcb__option {
    min-height: 44px;
  }
}
</style>
