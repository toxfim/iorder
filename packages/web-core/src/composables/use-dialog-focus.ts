import { nextTick, onScopeDispose, watch, type Ref } from 'vue';
import { openDropdownId } from './use-open-dropdown';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs (modal over drawer, etc.). Only the topmost one reacts to Esc and Tab.
const stack: symbol[] = [];

// Dialogs teleport to <body>, so everything in #app is "the page behind". While any dialog is
// open it is made inert (no focus, no clicks) and hidden from assistive tech.
function syncBackgroundInert(): void {
  const page = document.getElementById('app');
  if (!page) return;
  if (stack.length > 0) {
    page.setAttribute('inert', '');
    page.setAttribute('aria-hidden', 'true');
  } else {
    page.removeAttribute('inert');
    page.removeAttribute('aria-hidden');
  }
}

export interface DialogFocusOptions {
  /** true while the dialog is open (not while it is merely mounted for its exit animation). */
  readonly active: Ref<boolean>;
  readonly container: Ref<HTMLElement | null>;
  readonly onEscape: () => void;
}

/**
 * Focus management shared by Modal and Drawer: move focus in on open, keep Tab inside,
 * close on Esc, and give focus back to the opener on close.
 */
export function useDialogFocus({ active, container, onEscape }: DialogFocusOptions): void {
  const id = Symbol('dialog');
  let opener: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    return container.value
      ? Array.from(container.value.querySelectorAll<HTMLElement>(FOCUSABLE))
      : [];
  }

  function onKeydown(event: KeyboardEvent): void {
    if (stack[stack.length - 1] !== id) return;
    if (event.key === 'Escape') {
      // An open dropdown owns the first Esc (it closes itself); this capture-phase handler
      // would otherwise run before it and close the whole dialog.
      if (openDropdownId.value !== null) return;
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      container.value?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !container.value?.contains(current))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (current === last || !container.value?.contains(current))) {
      event.preventDefault();
      first?.focus();
    }
  }

  function release(): void {
    const index = stack.indexOf(id);
    if (index !== -1) stack.splice(index, 1);
    document.removeEventListener('keydown', onKeydown, true);
    syncBackgroundInert();
    opener?.focus();
    opener = null;
  }

  watch(
    active,
    async (isActive) => {
      if (isActive) {
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        stack.push(id);
        syncBackgroundInert();
        document.addEventListener('keydown', onKeydown, true);
        await nextTick();
        // Prefer the first control inside; fall back to the dialog itself (tabindex -1).
        (focusables()[0] ?? container.value)?.focus();
      } else if (stack.includes(id)) {
        release();
      }
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    if (stack.includes(id)) release();
  });
}
