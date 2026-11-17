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
// Shared with AppDropdown: one popup open at a time, and dialogs leave Esc to an open popup.
import { openDropdownId as openId } from '@core/composables/use-open-dropdown';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { StaffIconName } from '@/components/ui/staff-icons';

export interface RowMenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon: StaffIconName;
  readonly danger?: boolean;
  readonly testid: string;
  readonly run: () => void;
}

// The v8 row "more" (⋯) menu. The UI kit has a select (AppDropdown) but no action menu, so this
// lives with the one page that needs it. The list is teleported and fixed so the table's scroll
// box cannot clip it on the last rows.
defineProps<{
  items: readonly RowMenuItem[];
  /** Accessible name of the trigger, e.g. "Amallar: Temur Boboyev". */
  label: string;
}>();

counter += 1;
const id = `row-menu-${counter}`;
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const isOpen = computed(() => openId.value === id);
const menuStyle = ref<CSSProperties>({});

function itemButtons(): HTMLButtonElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
}

async function open(focusFirst: boolean): Promise<void> {
  openId.value = id;
  await nextTick();
  await place();
  if (focusFirst) itemButtons()[0]?.focus();
}

function close(returnFocus = false): void {
  if (openId.value === id) openId.value = null;
  if (returnFocus) trigger.value?.focus();
}

function toggle(): void {
  if (isOpen.value) close();
  else void open(false);
}

function choose(item: RowMenuItem): void {
  close(true);
  item.run();
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void open(true);
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  const buttons = itemButtons();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === 'Tab') {
    // The menu lives at the end of <body>, so a native Tab would leave the page: go back instead.
    event.preventDefault();
    close(true);
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return;
  const target = event.target as Node;
  if (trigger.value?.contains(target) || menu.value?.contains(target)) return;
  close();
}

// Below the trigger, right-aligned; flipped above it when the viewport has no room below.
async function place(): Promise<void> {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  menuStyle.value = { top: `${rect.bottom + 6}px`, right };
  await nextTick();
  const height = menu.value?.offsetHeight ?? 0;
  if (rect.bottom + 6 + height > window.innerHeight - 8 && rect.top - 6 - height > 8) {
    menuStyle.value = { top: `${rect.top - 6 - height}px`, right };
  }
}

const replace = (): void => void place();
watch(isOpen, (value) => {
  if (value) {
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', replace, true);
  } else {
    window.removeEventListener('resize', replace);
    window.removeEventListener('scroll', replace, true);
  }
});

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  window.removeEventListener('resize', replace);
  window.removeEventListener('scroll', replace, true);
  close();
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="trigger"
    :class="{ 'trigger--open': isOpen }"
    aria-haspopup="menu"
    :aria-expanded="isOpen"
    :aria-controls="isOpen ? id : undefined"
    :aria-label="label"
    data-testid="account-menu"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <StaffIcon name="more" :size="18" />
  </button>
  <Teleport to="body">
    <div
      v-if="isOpen"
      :id="id"
      ref="menu"
      role="menu"
      class="menu"
      :style="menuStyle"
      :aria-label="label"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        role="menuitem"
        class="item"
        :class="{ 'item--danger': item.danger }"
        :data-testid="item.testid"
        @click="choose(item)"
      >
        <StaffIcon :name="item.icon" :size="15" class="item__icon" />
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}

.trigger:hover,
.trigger--open {
  background: var(--ef);
  color: var(--ink);
}

.menu {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  min-width: 210px;
  padding: 6px;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    inset 0 0 0 1px var(--e8),
    var(--sh-dropdown);
  animation: popIn 0.16s ease-out both;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border: none;
  border-radius: var(--r-input);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.item:hover,
.item:focus-visible {
  background: var(--hov);
}

.item__icon {
  color: var(--t2);
}

.item--danger,
.item--danger .item__icon {
  color: var(--red);
}

@media (pointer: coarse) {
  .trigger {
    width: 44px;
    height: 44px;
  }

  .item {
    height: 44px;
  }
}
</style>
