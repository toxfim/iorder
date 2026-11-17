<script lang="ts">
let counter = 0;
</script>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from 'vue';
// Shared so only one dropdown is open at a time (specs.md section 6) and so dialogs can tell
// that Esc belongs to an open dropdown first.
import { openDropdownId as openId } from '@core/composables/use-open-dropdown';
import AppIcon from '@core/components/ui/AppIcon.vue';

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
  /** Small muted number at the right of the option (v1 shows counts in the filters). */
  readonly count?: number | string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    options: readonly DropdownOption[];
    /** Accessible name of the control (the visible text is the selected option). */
    label: string;
    placeholder?: string;
    minWidth?: string;
    align?: 'left' | 'right';
    /** Icon-only trigger (supply the `value` slot): no chevron, no minimum width. */
    compact?: boolean;
    teleport?: boolean;
    showSelectionMark?: boolean;
    /**
     * Locked while the chosen value is saved: `aria-disabled`, not `disabled`, so the trigger keeps
     * keyboard focus (a natively disabled button drops it to the page).
     */
    disabled?: boolean;
  }>(),
  {
    placeholder: '',
    minWidth: '160px',
    align: 'left',
    compact: false,
    teleport: true,
    showSelectionMark: false,
    disabled: false,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

counter += 1;
const id = `dropdown-${counter}`;
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);

const isOpen = computed(() => openId.value === id);
const selected = computed(() => props.options.find((o) => o.value === props.modelValue));

function open(): void {
  if (props.disabled) return;
  openId.value = id;
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.modelValue),
  );
}

function close(returnFocus = false): void {
  if (openId.value === id) openId.value = null;
  if (returnFocus) trigger.value?.focus();
}

function toggle(): void {
  if (isOpen.value) close();
  else open();
}

function choose(option: DropdownOption): void {
  emit('update:modelValue', option.value);
  close(true);
}

function move(delta: number): void {
  const count = props.options.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
}

watch(
  () => props.disabled,
  (locked) => {
    if (locked) close();
  },
);

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!isOpen.value) open();
    else move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Escape' && isOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === 'Home' && isOpen.value) {
    event.preventDefault();
    activeIndex.value = 0;
  } else if (event.key === 'End' && isOpen.value) {
    event.preventDefault();
    activeIndex.value = props.options.length - 1;
  } else if ((event.key === 'Enter' || event.key === ' ') && isOpen.value) {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) choose(option);
  } else if (event.key === 'Tab') {
    close();
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return;
  const target = event.target as Node;
  // The menu is teleported to <body>, so it is no longer inside `root`.
  if (root.value?.contains(target) || menu.value?.contains(target)) return;
  close();
}

// Esc while focus is elsewhere (a mouse-opened menu). Dialogs ignore Esc while a dropdown is
// open (use-dialog-focus), so this runs first and the dialog stays open.
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isOpen.value) {
    event.stopPropagation();
    close(true);
  }
}

// The menu is position: fixed in <body> so a scrolling drawer body or an overflow: hidden card
// cannot clip it; its place is recomputed from the trigger whenever the layout moves.
const menuStyle = ref<CSSProperties>({});

function place(): void {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  menuStyle.value = {
    top: `${rect.bottom + 6}px`,
    minWidth: `${rect.width}px`,
    ...(props.align === 'right'
      ? { right: `${window.innerWidth - rect.right}px` }
      : { left: `${rect.left}px` }),
  };
}

watch(isOpen, (open) => {
  if (open) {
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  } else {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
  }
});

watch(activeIndex, async () => {
  await nextTick();
  menu.value?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
});

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  close();
});
</script>

<template>
  <div
    ref="root"
    class="dd"
    :class="{ 'dd--compact': compact }"
    :style="{ minWidth: compact ? undefined : minWidth }"
  >
    <button
      ref="trigger"
      type="button"
      class="dd__trigger"
      :class="{ 'dd__trigger--open': isOpen, 'dd__trigger--disabled': disabled }"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      :aria-disabled="disabled || undefined"
      :aria-controls="`${id}-menu`"
      :aria-label="label"
      :aria-activedescendant="
        isOpen && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
      "
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <slot name="value" :selected="selected">
        <span class="dd__value" :class="{ 'dd__value--placeholder': !selected }">
          {{ selected?.label ?? placeholder }}
        </span>
      </slot>
      <span v-if="!compact" class="dd__chevron" :class="{ 'dd__chevron--open': isOpen }">
        <AppIcon name="chevron" :size="12" :stroke-width="1.6" />
      </span>
    </button>

    <Teleport to="body" :disabled="!teleport">
      <ul
        v-if="isOpen"
        :id="`${id}-menu`"
        ref="menu"
        role="listbox"
        class="dd__menu"
        :style="menuStyle"
        :aria-label="label"
      >
        <li
          v-for="(option, index) in options"
          :id="`${id}-option-${index}`"
          :key="option.value"
          role="option"
          class="dd__option"
          :class="{
            'dd__option--active': index === activeIndex,
            'dd__option--selected': option.value === modelValue,
          }"
          :aria-selected="option.value === modelValue"
          :data-active="index === activeIndex"
          @click="choose(option)"
          @pointermove="activeIndex = index"
        >
          <span>{{ option.label }}</span>
          <AppIcon
            v-if="showSelectionMark && option.value === modelValue"
            name="check"
            :size="16"
          />
          <span v-if="option.count !== undefined" class="dd__count">{{ option.count }}</span>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.dd {
  position: relative;
}

.dd__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  width: 100%;
  height: 42px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--w);
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
  cursor: pointer;
}

.dd--compact .dd__trigger {
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  background: var(--f5);
}

.dd__trigger:hover {
  border-color: var(--t3);
}

/* Dimmed through colour tokens, like a disabled AppButton (no opacity: see dark-audit.test.ts). */
.dd__trigger--disabled {
  cursor: progress;
  color: var(--t3);
  border-color: var(--e8);
}

/* v1: the open trigger gets an ink border. */
.dd__trigger--open {
  border-color: var(--ink);
}

.dd__value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dd__value--placeholder {
  color: var(--t3);
  font-weight: 500;
}

.dd__chevron {
  display: inline-flex;
  color: var(--ink);
  transition: transform 0.2s ease;
}

.dd__chevron--open {
  transform: rotate(180deg);
}

.dd__menu {
  position: fixed;
  /* Above drawers and modals: the menu can be opened from inside them. */
  z-index: var(--z-popover);
  margin: 0;
  padding: 6px;
  list-style: none;
  background: var(--w);
  border: 1px solid var(--e8);
  border-radius: var(--r-row);
  box-shadow: var(--sh-dropdown);
  animation: popIn 0.16s ease-out both;
}

.dd__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 10px;
  border-radius: var(--r-btn-sm);
  font-size: var(--fs-body);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.dd__option--selected {
  background: var(--ef);
  font-weight: 700;
}

.dd__option--active {
  background: var(--f5);
}

.dd__option--selected.dd__option--active {
  background: var(--ef);
}

.dd__count {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--t3);
  font-variant-numeric: tabular-nums;
}

/* Touch devices: 44px hit areas; desktop keeps the design's sizes. */
@media (pointer: coarse) {
  .dd__trigger {
    min-height: 44px;
    min-width: 44px;
  }
  .dd__option {
    min-height: 44px;
  }
}
/* Staff design v8: 38px white trigger with a hairline ring; the compact one (top bar) is the 34px
   square grey button; the menu is a 12px floating panel with 12px options. */
:root[data-staff-app] .dd__trigger {
  height: 38px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  font-weight: 500;
}
:root[data-staff-app] .dd--compact .dd__trigger {
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--f5);
  color: var(--t2);
}
:root[data-staff-app] .dd__trigger:hover {
  box-shadow: inset 0 0 0 1px var(--t3);
  color: var(--ink);
}
/* The staff sizes above are more specific than the touch rule, so the 34px top bar trigger
   (language, theme) stayed 34px wide under a finger. Touch gets the full target back; a webview
   that reports no coarse pointer (Telegram on some phones) counts as touch too. */
@media (pointer: coarse), (hover: none) {
  :root[data-staff-app] .dd__trigger {
    min-height: 44px;
  }
  :root[data-staff-app] .dd--compact .dd__trigger {
    min-width: 44px;
  }
  :root[data-staff-app] .dd__option {
    min-height: 44px;
  }
}
:root[data-staff-app] .dd__trigger--open,
:root[data-staff-app] .dd__trigger:focus-visible {
  outline: 0;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}
:root[data-staff-app] .dd__chevron {
  color: var(--t2);
}
:root[data-staff-app] .dd__menu {
  padding: 6px;
  border: 0;
  border-radius: var(--r-card);
  box-shadow:
    inset 0 0 0 1px var(--e8),
    var(--sh-dropdown);
}
:root[data-staff-app] .dd__option {
  padding: 8px 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-small);
  font-weight: 400;
}
:root[data-staff-app] .dd__option--active {
  background: var(--hov);
}
:root[data-staff-app] .dd__option--selected,
:root[data-staff-app] .dd__option--selected.dd__option--active {
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-weight: 600;
}
</style>
