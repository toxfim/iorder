<script lang="ts">
import type { StaffIconName } from '@/components/ui/staff-icons';

let counter = 0;

export interface ChipMenuItem<V extends string> {
  readonly id: V;
  readonly icon: StaffIconName;
  readonly title: string;
  readonly hint: string;
  readonly testId: string;
}
</script>

<script setup lang="ts" generic="Id extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { openDropdownId as openId } from '@core/composables/use-open-dropdown';

// A white v8 page button with a menu (ARIA menu button): arrows move, Enter picks, Escape closes
// and gives the focus back to the button; one dropdown is open at a time across the app (the
// shared openDropdownId). Used by "+ Yangi tovar" and the Excel download of Narxlar.
const props = withDefaults(
  defineProps<{
    label: string;
    icon: StaffIconName;
    /** Accessible name of the menu. */
    menuLabel: string;
    items: readonly ChipMenuItem<Id>[];
    testId: string;
    /** The chosen action runs: the button shows a spinner and does not open. */
    busy?: boolean;
  }>(),
  { busy: false },
);
const emit = defineEmits<{ choose: [id: Id] }>();

counter += 1;
const id = `chip-menu-${counter}`;
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const active = ref(0);

const isOpen = computed(() => openId.value === id);

function open(): void {
  if (props.busy) return;
  openId.value = id;
  active.value = 0;
  void nextTick(() => menu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
}

function close(returnFocus = false): void {
  if (openId.value === id) openId.value = null;
  if (returnFocus) trigger.value?.focus();
}

function choose(item: ChipMenuItem<Id>): void {
  close(true);
  emit('choose', item.id);
}

function focusItem(index: number): void {
  const count = props.items.length;
  active.value = (index + count) % count;
  menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]')[active.value]?.focus();
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!isOpen.value) open();
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusItem(active.value + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    focusItem(active.value - 1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    focusItem(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    focusItem(props.items.length - 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === 'Tab') {
    close();
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return;
  if (root.value?.contains(event.target as Node)) return;
  close();
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  close();
});
</script>

<template>
  <div ref="root" class="chipmenu">
    <button
      ref="trigger"
      type="button"
      class="chip"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? `${id}-menu` : undefined"
      :disabled="busy"
      :aria-busy="busy || undefined"
      :data-testid="testId"
      @click="isOpen ? close() : open()"
      @keydown="onTriggerKeydown"
    >
      <span v-if="busy" class="chip__spinner" aria-hidden="true" />
      <StaffIcon v-else :name="icon" :size="16" class="chip__icon" />
      {{ label }}
      <StaffIcon name="down" :size="14" class="chip__caret" />
    </button>
    <div
      v-if="isOpen"
      :id="`${id}-menu`"
      ref="menu"
      class="menu"
      role="menu"
      :aria-label="menuLabel"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        role="menuitem"
        class="item"
        :tabindex="index === active ? 0 : -1"
        :data-testid="item.testId"
        @click="choose(item)"
        @focus="active = index"
      >
        <span class="item__icon"><StaffIcon :name="item.icon" :size="16" /></span>
        <span class="item__text">
          <span class="item__title">{{ item.title }}</span>
          <span class="item__hint">{{ item.hint }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chipmenu {
  position: relative;
}

/* The v8 page action: a 40px white button with a hairline ring (like the neighbouring chips). */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.chip:hover,
.chip[aria-expanded='true'] {
  background: var(--f5);
}

.chip:disabled {
  cursor: progress;
  color: var(--t2);
}

.chip__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--e8);
  border-top-color: var(--acc);
  border-radius: 50%;
  animation: chip-spin 0.8s linear infinite;
}

@keyframes chip-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chip__spinner {
    animation-duration: 2.4s;
  }
}

.chip:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.chip__icon,
.chip__caret {
  color: var(--t2);
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: var(--z-dropdown);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 280px;
  padding: 6px;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--e8),
    var(--sh-dropdown);
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: var(--f5);
}

.item:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.item__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-kbd);
  background: var(--f5);
  color: var(--t2);
}

.item__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.item__title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.item__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 720px) {
  .chipmenu,
  .chip {
    flex: 1 1 auto;
    justify-content: center;
  }

  .menu {
    right: auto;
    left: 0;
    min-width: 100%;
  }
}

@media (pointer: coarse) {
  .chip {
    min-height: 44px;
  }

  .item {
    min-height: 48px;
  }
}
</style>
