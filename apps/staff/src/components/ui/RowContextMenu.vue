<script lang="ts">
import type { StaffIconName } from './staff-icons';

let counter = 0;

export interface RowMenuItem<Id extends string = string> {
  readonly id: Id;
  /** Already translated text of the item. */
  readonly label: string;
  readonly icon: StaffIconName;
  /** A destructive action: drawn in red, after a separator. The page still asks to confirm it. */
  readonly tone?: 'danger';
  readonly testId?: string;
}

/** Where the menu opens: the pointer, or the row's own box when the keyboard opened it. */
export interface RowMenuPoint {
  readonly x: number;
  readonly y: number;
}

/** Free space kept between the menu and the viewport edge. */
export const VIEWPORT_MARGIN = 8;

/**
 * Keeps a `width` x `height` box opened at `point` inside the viewport: it moves left when it
 * would leave the right edge and opens upwards when it would leave the bottom one.
 */
export function clampToViewport(
  point: RowMenuPoint,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): RowMenuPoint {
  const maxX = viewport.width - size.width - VIEWPORT_MARGIN;
  const x = Math.max(VIEWPORT_MARGIN, Math.min(point.x, maxX));
  const below = point.y + size.height <= viewport.height - VIEWPORT_MARGIN;
  const y = below
    ? point.y
    : Math.max(VIEWPORT_MARGIN, Math.min(point.y - size.height, viewport.height - size.height));
  return { x, y };
}
</script>

<script setup lang="ts" generic="Id extends string">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import { openDropdownId as openId } from '@core/composables/use-open-dropdown';
import StaffIcon from './StaffIcon.vue';

// One context menu for a list row (ARIA `menu`): the page opens it at the pointer (right click,
// long press) or at the row (Context Menu key, Shift+F10, the "⋯" button of touch screens). Arrows
// move, Home/End jump, Enter/Space pick, Escape and Tab close; the focus goes back to the row. It
// closes on an outside press, a scroll, a resize and a route change, and shares the app-wide "one
// dropdown at a time" slot. Only what the role may do is passed in: the server still decides.
const props = defineProps<{
  /** Accessible name of the menu (the row it belongs to). */
  label: string;
  items: readonly RowMenuItem<Id>[];
}>();
const emit = defineEmits<{ choose: [id: Id]; close: [] }>();

counter += 1;
const id = `row-menu-${counter}`;
const menu = ref<HTMLElement | null>(null);
const point = ref<RowMenuPoint>({ x: 0, y: 0 });
const active = ref(0);
// Hidden until measured, so a menu near an edge never flashes outside the viewport.
const measured = ref(false);
let returnFocus: HTMLElement | null = null;

const isOpen = computed(() => openId.value === id && props.items.length > 0);

function itemElements(): HTMLElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

function focusItem(index: number): void {
  const count = props.items.length;
  if (count === 0) return;
  active.value = (index + count) % count;
  itemElements()[active.value]?.focus({ preventScroll: true });
}

async function open(at: RowMenuPoint, focusAfter: HTMLElement | null): Promise<void> {
  if (props.items.length === 0) return;
  returnFocus = focusAfter;
  point.value = at;
  measured.value = false;
  active.value = 0;
  openId.value = id;
  listen(true);
  await nextTick();
  const element = menu.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  point.value = clampToViewport(
    at,
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  measured.value = true;
  focusItem(0);
}

function close(giveFocusBack: boolean): void {
  const wasOpen = openId.value === id;
  if (wasOpen) openId.value = null;
  listen(false);
  if (giveFocusBack) returnFocus?.focus({ preventScroll: true });
  returnFocus = null;
  if (wasOpen) emit('close');
}

// The choice goes out first (the owner still knows the row), then the focus goes back to the row
// in the same tick, so a dialog the choice opens returns its focus there too.
function choose(item: RowMenuItem<Id>): void {
  emit('choose', item.id);
  close(true);
}

function onKeydown(event: KeyboardEvent): void {
  const last = props.items.length - 1;
  const moves: Record<string, () => number> = {
    ArrowDown: () => active.value + 1,
    ArrowUp: () => active.value - 1,
    Home: () => 0,
    End: () => last,
  };
  const move = moves[event.key];
  if (move) {
    event.preventDefault();
    focusItem(move());
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === 'Tab') {
    // Tab leaves the menu like any popup: back to the row, and the next Tab goes on from there.
    event.preventDefault();
    close(true);
  }
}

// A press or a scroll inside the menu keeps it; the window itself is not a Node.
const insideMenu = (event: Event): boolean =>
  event.target instanceof Node && menu.value?.contains(event.target) === true;

// The menu button that opened it toggles it with its own click: a press on it must not close
// the menu first (the click would then open it again).
const onOwnButton = (event: Event): boolean =>
  returnFocus !== null &&
  returnFocus.getAttribute('aria-haspopup') === 'menu' &&
  event.target instanceof Node &&
  returnFocus.contains(event.target);

function onPointerDown(event: Event): void {
  if (!insideMenu(event) && !onOwnButton(event)) close(false);
}

function onScroll(event: Event): void {
  if (!insideMenu(event)) close(false);
}

function onResize(): void {
  close(false);
}

let listening = false;
function listen(on: boolean): void {
  if (on === listening) return;
  listening = on;
  const method = on ? 'addEventListener' : 'removeEventListener';
  document[method]('pointerdown', onPointerDown, true);
  window[method]('scroll', onScroll, true);
  window[method]('resize', onResize);
}

// Another dropdown took the slot: this one is closed already, drop the listeners.
watch(openId, (current) => {
  if (current !== id && listening) {
    listen(false);
    returnFocus = null;
    emit('close');
  }
});

// A route change (Back, a link elsewhere) closes it; pages tested without a router skip this.
const route = inject(routeLocationKey, null);
if (route)
  watch(
    () => route.fullPath,
    () => close(false),
  );

onBeforeUnmount(() => close(false));

defineExpose({ open, close, isOpen });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      :id="id"
      ref="menu"
      class="rowmenu"
      :class="{ 'rowmenu--measuring': !measured }"
      role="menu"
      :aria-label="label"
      :style="{ left: `${point.x}px`, top: `${point.y}px` }"
      data-testid="row-menu"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <template v-for="(item, index) in items" :key="item.id">
        <div
          v-if="item.tone === 'danger' && index > 0"
          class="rowmenu__sep"
          role="separator"
          aria-hidden="true"
        />
        <button
          type="button"
          role="menuitem"
          class="rowmenu__item"
          :class="{ 'rowmenu__item--danger': item.tone === 'danger' }"
          :tabindex="index === active ? 0 : -1"
          :data-testid="item.testId"
          @click="choose(item)"
          @focus="active = index"
        >
          <StaffIcon :name="item.icon" :size="16" class="rowmenu__icon" />
          <span class="rowmenu__label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.rowmenu {
  position: fixed;
  z-index: var(--z-dropdown);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 220px;
  max-width: calc(100vw - 16px);
  padding: 6px;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--e8),
    var(--sh-dropdown);
  animation: rowmenu-in 0.12s var(--ease) both;
}

/* Measured once before it is shown (the clamp needs its size). */
.rowmenu--measuring {
  visibility: hidden;
}

@keyframes rowmenu-in {
  from {
    transform: scale(0.97);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rowmenu {
    animation: none;
  }
}

.rowmenu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.rowmenu__item:hover,
.rowmenu__item:focus-visible {
  background: var(--f5);
}

.rowmenu__item:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.rowmenu__icon {
  flex: none;
  color: var(--t2);
}

.rowmenu__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.rowmenu__item--danger,
.rowmenu__item--danger .rowmenu__icon {
  color: var(--red);
}

.rowmenu__item--danger:hover,
.rowmenu__item--danger:focus-visible {
  background: var(--red-bg);
}

.rowmenu__sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--e8);
}

@media (pointer: coarse) {
  .rowmenu__item {
    min-height: 48px;
  }
}
</style>
