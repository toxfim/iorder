<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton, { type ButtonSize, type ButtonVariant } from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';

// A button that says WHY it cannot be pressed (owner, 2026-11-09: "on hover the reason must be
// shown; on mobile a modal window must say why the button is disabled"). While `reasons` is not
// empty the button is `aria-disabled`, not natively disabled, so it still takes focus, hover and a
// tap: hover and keyboard focus show the reasons in a tooltip, a touch tap opens a small dialog
// with them. The action itself (`click`) is emitted only when there is no reason left.
const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: 'button' | 'submit' | 'reset';
    loading?: boolean;
    block?: boolean;
    /** Why the action cannot run now, the first thing to do first. Empty: the button works. */
    reasons: readonly string[];
    /** The name of the dialog a tap opens ("Why can it not be approved?"). */
    reasonsTitle: string;
    /** The id of a hint beside the button; the reasons are announced before it. */
    describedBy?: string;
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    loading: false,
    block: false,
    describedBy: undefined,
  },
);
const emit = defineEmits<{ click: [event: MouseEvent] }>();

const { t } = useI18n();
const reasonsId = useId();
const tipId = useId();
const blocked = computed(() => props.reasons.length > 0);
const description = computed(
  () =>
    [blocked.value ? reasonsId : null, props.describedBy].filter(Boolean).join(' ') || undefined,
);

// --- tooltip (mouse hover and keyboard focus) -------------------------------------------------

/** The gap between the button and the tooltip, and the least distance to the window's edge. */
const GAP = 8;
// Time to move the pointer from the button onto the tooltip (WCAG 1.4.13: hoverable).
const LEAVE_DELAY_MS = 150;

const tipOpen = ref(false);
const tipEl = ref<HTMLElement | null>(null);
const position = ref({ left: 0, top: 0 });
let anchor: HTMLElement | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
// What the person last pressed with: a finger gets the dialog, a mouse or the keyboard the tooltip.
let lastPointer: string | null = null;

function cancelLeave(): void {
  if (leaveTimer !== undefined) clearTimeout(leaveTimer);
  leaveTimer = undefined;
}

function closeTip(): void {
  cancelLeave();
  tipOpen.value = false;
}

function place(): void {
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const tip = tipEl.value?.getBoundingClientRect();
  const width = tip?.width ?? 0;
  const height = tip?.height ?? 0;
  const centred = rect.left + rect.width / 2 - width / 2;
  const left = Math.max(GAP, Math.min(centred, window.innerWidth - width - GAP));
  // Above the button, where a hand or the pointer does not cover it; below when there is no room.
  const above = rect.top - GAP - height;
  position.value = { left, top: above >= GAP ? above : rect.bottom + GAP };
}

async function openTip(target: HTMLElement): Promise<void> {
  if (!blocked.value || dialogOpen.value) return;
  cancelLeave();
  anchor = target;
  tipOpen.value = true;
  place();
  // The second pass knows the tooltip's real size.
  await nextTick();
  place();
}

const elementOf = (event: Event): HTMLElement | null =>
  event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

function onPointerDown(event: PointerEvent): void {
  lastPointer = event.pointerType;
}

function onPointerEnter(event: PointerEvent): void {
  // A finger has no hover: its tap opens the dialog instead.
  if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
  const target = elementOf(event);
  if (target) void openTip(target);
}

function onPointerLeave(): void {
  cancelLeave();
  leaveTimer = setTimeout(() => {
    // Focus keeps the tooltip: a keyboard user did not move the pointer away from anything.
    if (anchor !== document.activeElement) closeTip();
  }, LEAVE_DELAY_MS);
}

function onFocus(event: FocusEvent): void {
  // The dialog just closed and handed the focus back: the person has read the reasons.
  if (focusReturning || fromTouch()) return;
  const target = elementOf(event);
  if (target) void openTip(target);
}

function onBlur(): void {
  lastPointer = null;
  closeTip();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !tipOpen.value) return;
  // The Escape closes the tooltip only, not a drawer or a page shortcut behind it.
  event.stopPropagation();
  closeTip();
}

// The tooltip is fixed to the window, so a scroll or a resize would leave it beside nothing.
watch(tipOpen, (open) => {
  if (open) {
    window.addEventListener('scroll', closeTip, true);
    window.addEventListener('resize', closeTip);
  } else {
    window.removeEventListener('scroll', closeTip, true);
    window.removeEventListener('resize', closeTip);
  }
});

// --- dialog (touch) ---------------------------------------------------------------------------

const dialogOpen = ref(false);
// The dialog fades out after the last reason is gone: it keeps the text it was opened with.
const dialogReasons = ref<readonly string[]>(props.reasons);
watch(
  () => props.reasons,
  (next) => {
    if (next.length > 0) dialogReasons.value = next;
  },
);

// A closing dialog gives the focus back to the button within the same tick. That focus must not
// open the tooltip (on a laptop with a touch screen it would pop up right after the dialog).
let focusReturning = false;
watch(
  dialogOpen,
  (open) => {
    if (open) return;
    focusReturning = true;
    setTimeout(() => {
      focusReturning = false;
    }, 0);
  },
  // Before the dialog's own watcher moves the focus.
  { flush: 'sync' },
);

function hoverless(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
}

/** A finger or a pen pressed the button, or the device has no hover at all. */
function fromTouch(): boolean {
  if (lastPointer === 'touch' || lastPointer === 'pen') return true;
  return lastPointer === null && hoverless();
}

function onClick(event: MouseEvent): void {
  if (!blocked.value) {
    emit('click', event);
    return;
  }
  // Never the action: a blocked button only explains itself (and submits no form).
  event.preventDefault();
  const target = elementOf(event);
  if (fromTouch()) {
    closeTip();
    dialogOpen.value = true;
  } else if (target) {
    void openTip(target);
  }
}

// The reason is gone (a request ended, the manager did what was asked): nothing left to explain.
watch(blocked, (now) => {
  if (now) return;
  closeTip();
  dialogOpen.value = false;
});

onBeforeUnmount(() => {
  closeTip();
  window.removeEventListener('scroll', closeTip, true);
  window.removeEventListener('resize', closeTip);
});
</script>

<template>
  <AppButton
    :variant="variant"
    :size="size"
    :type="type"
    :loading="loading"
    :block="block"
    :soft-disabled="blocked"
    :aria-describedby="description"
    @click="onClick"
    @pointerdown="onPointerDown"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @focus="onFocus"
    @blur="onBlur"
    @keydown="onKeydown"
  >
    <slot />
    <!-- Everything below leaves the button through a teleport: nothing of it is part of the
         button's name, and the button stays the single root that takes the caller's class. -->
    <Teleport v-if="blocked" to="body">
      <span :id="reasonsId" hidden>{{ reasons.join(' ') }}</span>
      <div
        v-if="tipOpen"
        :id="tipId"
        ref="tipEl"
        class="tip"
        role="tooltip"
        data-testid="blocked-tooltip"
        :style="{ left: `${position.left}px`, top: `${position.top}px` }"
        @pointerenter="cancelLeave"
        @pointerleave="onPointerLeave"
      >
        <p v-for="reason in reasons" :key="reason" class="tip__line">{{ reason }}</p>
      </div>
    </Teleport>
    <AppModal v-model="dialogOpen" :title="reasonsTitle" max-width="400px">
      <ul class="why" data-testid="blocked-reasons">
        <li v-for="reason in dialogReasons" :key="reason" class="why__item">{{ reason }}</li>
      </ul>
      <template #footer>
        <AppButton size="lg" data-testid="blocked-ok" @click="dialogOpen = false">
          {{ t('common.understood') }}
        </AppButton>
      </template>
    </AppModal>
  </AppButton>
</template>

<style scoped>
/* Same floating card as the person card: white, a hairline ring, the dropdown shadow. */
.tip {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: max-content;
  max-width: min(300px, calc(100vw - 16px));
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow:
    inset 0 0 0 1px var(--e8),
    var(--sh-dropdown);
  color: var(--ink);
  font-size: var(--fs-small);
  font-weight: 400;
  line-height: 1.4;
  text-align: left;
  white-space: normal;
  animation: popIn 0.14s ease-out both;
}

.tip__line {
  margin: 0;
}

/* Several reasons read as steps: a rule between them, no bullets to misalign. */
.tip__line + .tip__line {
  padding-top: 6px;
  border-top: 1px solid var(--e8);
}

.why {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-body);
  font-weight: 400;
  line-height: 1.45;
  color: var(--ink);
  text-align: left;
  white-space: normal;
}

.why__item + .why__item {
  padding-top: 10px;
  border-top: 1px solid var(--e8);
}
</style>
