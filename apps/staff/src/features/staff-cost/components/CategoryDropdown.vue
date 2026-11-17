<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import {
  CATEGORY_ALL,
  buildCategoryOptions,
  searchCategoryOptions,
  type CategoryCounts,
  type CategoryOption,
} from '../domain/category-filter';

// The v8 category filter of Qoldiq and Narxlar: one trigger, a popup with a search field and a
// scrolling list. There can be many categories, so typing narrows the list and Enter takes the
// first match. ARIA: the trigger opens a popup whose search field is a combobox driving the
// listbox through aria-activedescendant (focus stays in the field while arrows move).
const props = withDefaults(
  defineProps<{
    /** `CATEGORY_ALL`, `CATEGORY_NONE` or `categoryTabId(name)` (the address keeps this value). */
    modelValue: string;
    counts: CategoryCounts;
    /** Categories of another list that stay in the menu (with a count of 0 here). */
    alsoKnown?: readonly string[];
    alsoUncategorized?: boolean;
  }>(),
  { alsoKnown: () => [], alsoUncategorized: false },
);
const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

const { t } = useI18n();
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

const options = computed(() =>
  buildCategoryOptions(
    props.counts,
    { all: t('staffCost.categories.allCategories'), none: t('staffCost.categories.none') },
    props.alsoKnown,
    props.alsoUncategorized,
  ),
);
const allOption = computed<CategoryOption>(() => ({
  id: CATEGORY_ALL,
  label: t('staffCost.categories.allCategories'),
  count: props.counts.total,
}));
// "All" heads the list only while nothing is typed: a search is a search for a category.
const shown = computed<CategoryOption[]>(() =>
  query.value.trim() === ''
    ? [allOption.value, ...options.value]
    : searchCategoryOptions(options.value, query.value),
);

const selected = computed(() => props.modelValue !== CATEGORY_ALL);
const currentLabel = computed(
  () =>
    options.value.find((option) => option.id === props.modelValue)?.label ?? allOption.value.label,
);
const withProducts = computed(() => options.value.filter((option) => option.count > 0).length);

// A category that is no longer known (a reload, a hand-edited address) must not leave an empty
// selection behind. Checked on mount too: the pages remount the filter when their data reloads.
watch(
  options,
  (next) => {
    if (props.modelValue !== CATEGORY_ALL && !next.some((o) => o.id === props.modelValue)) {
      emit('update:modelValue', CATEGORY_ALL);
    }
  },
  { immediate: true },
);

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
    shown.value.findIndex((option) => option.id === props.modelValue),
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

function pick(id: string): void {
  if (id !== props.modelValue) emit('update:modelValue', id);
  closeMenu(true);
}

function clear(): void {
  emit('update:modelValue', CATEGORY_ALL);
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
    case 'Home':
    case 'End':
      // Inside a text field these keys keep moving the caret unless the list is the target.
      if (query.value !== '') return;
      event.preventDefault();
      active.value = event.key === 'Home' ? 0 : Math.max(0, shown.value.length - 1);
      void nextTick(scrollActiveIntoView);
      break;
    case 'Enter': {
      event.preventDefault();
      const choice = shown.value[active.value];
      if (choice) pick(choice.id);
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

// Any press outside the filter closes it (the design's outside click), without moving focus.
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
    class="catdd"
    :class="{ 'catdd--on': selected, 'catdd--open': open }"
    data-testid="category-filter"
    @focusout="onFocusOut"
  >
    <div class="catdd__field">
      <button
        ref="trigger"
        type="button"
        class="catdd__trigger"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="open ? listId : undefined"
        :aria-label="t('staffCost.categories.trigger', { value: currentLabel })"
        @click="toggle"
        @keydown="onTriggerKey"
      >
        <StaffIcon name="filter" :size="14" class="catdd__icon" />
        <span class="catdd__value">{{ currentLabel }}</span>
        <StaffIcon v-if="!selected" name="down" :size="13" class="catdd__chevron" />
      </button>
      <button
        v-if="selected"
        type="button"
        class="catdd__clear"
        :aria-label="t('staffCost.categories.clear')"
        @click="clear"
      >
        <StaffIcon name="x" :size="13" />
      </button>
    </div>

    <div v-if="open" class="catdd__pop">
      <div class="catdd__search">
        <StaffIcon name="search" :size="13" class="catdd__icon" />
        <input
          ref="input"
          v-model="query"
          class="catdd__input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
          aria-expanded="true"
          :aria-controls="listId"
          :aria-activedescendant="shown.length > 0 ? optionId(active) : undefined"
          :aria-label="t('staffCost.categories.search')"
          :placeholder="t('staffCost.categories.search')"
          @keydown="onInputKey"
        />
      </div>
      <!-- mousedown.prevent keeps focus in the search field, so a click on an option is not
           first seen as the field losing focus. -->
      <ul
        :id="listId"
        ref="list"
        class="catdd__list"
        role="listbox"
        :aria-label="t('staffCost.categories.label')"
        @mousedown.prevent
      >
        <li
          v-for="(option, index) in shown"
          :id="optionId(index)"
          :key="option.id"
          role="option"
          class="catdd__option"
          :class="{
            'catdd__option--active': index === active,
            'catdd__option--on': option.id === modelValue,
            'catdd__option--empty': option.count === 0 && option.id !== CATEGORY_ALL,
          }"
          :aria-selected="option.id === modelValue"
          :data-category-id="option.id"
          @click="pick(option.id)"
          @mousemove="active = index"
        >
          <StaffIcon name="check" :size="14" class="catdd__check" />
          <span class="catdd__label">{{ option.label }}</span>
          <span class="catdd__count num">{{ option.count }}</span>
        </li>
      </ul>
      <p v-if="shown.length === 0" class="catdd__none" role="status">
        {{ t('staffCost.categories.notFound') }}
      </p>
      <p class="catdd__foot">
        {{
          t('staffCost.categories.footer', {
            total: options.length,
            withProducts: withProducts,
          })
        }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* v8 (docs/private/design/v8 "Ostatok" / "Narxlar"): a 40px field with a hairline ring; a chosen category
   turns it into a 2px accent ring on the accent tint with an × that clears it. */
.catdd {
  position: relative;
  flex: 0 1 260px;
  min-width: 200px;
}

.catdd__field {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 6px 0 12px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.catdd--open .catdd__field,
.catdd--on .catdd__field {
  box-shadow: inset 0 0 0 2px var(--acc);
}

.catdd--on .catdd__field {
  background: var(--acc-bg);
}

.catdd__trigger {
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

.catdd__trigger:focus-visible,
.catdd__clear:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

.catdd__icon {
  flex: none;
  color: var(--t2);
}

.catdd__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catdd--on .catdd__value {
  font-weight: 600;
}

.catdd__chevron {
  flex: none;
  margin-right: 6px;
  color: var(--t2);
  transition: transform 0.2s ease;
}

.catdd--open .catdd__chevron {
  transform: rotate(180deg);
}

.catdd__clear {
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

.catdd__clear:hover {
  background: var(--w);
}

/* The popup: at least 300px wide, never wider than the screen minus the page gutters. */
.catdd__pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: max(100%, 300px);
  max-width: calc(100vw - 32px);
  overflow: hidden;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--e8),
    var(--sh-dropdown);
}

.catdd__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin: 10px;
  padding: 0 10px;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.catdd__search:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.catdd__input {
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

.catdd__list {
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

.catdd__option {
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

.catdd__option--active {
  background: var(--hov);
}

.catdd__option--on {
  background: var(--acc-bg);
}

.catdd__option--active.catdd__option--on {
  box-shadow: inset 0 0 0 1px var(--acc);
}

/* Empty categories sit at the bottom in the faint grey: they exist, but hold nothing here. */
.catdd__option--empty {
  color: var(--t3);
}

.catdd__check {
  flex: none;
  color: var(--acc);
  visibility: hidden;
}

.catdd__option--on .catdd__check {
  visibility: visible;
}

.catdd__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catdd__option--on .catdd__label {
  font-weight: 600;
}

.catdd__count {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.catdd__none {
  margin: 0;
  padding: 16px 10px;
  font-size: var(--fs-small);
  color: var(--t2);
  text-align: center;
}

.catdd__foot {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--e8);
  background: var(--f5);
  font-size: var(--fs-group);
  color: var(--t2);
}

/* Phones: the filter takes its own line and the popup the filter's full width. */
@media (max-width: 639px) {
  .catdd {
    flex: 1 1 100%;
    min-width: 0;
  }

  .catdd__pop {
    width: 100%;
    max-width: none;
  }
}

@media (pointer: coarse) {
  .catdd__option {
    min-height: 44px;
  }

  .catdd__clear {
    width: 36px;
    height: 36px;
  }
}
</style>
