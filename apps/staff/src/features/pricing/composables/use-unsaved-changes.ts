import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';

export type LeaveChoice = 'stay' | 'leave' | 'save';

export interface UnsavedChangesOptions {
  readonly isDirty: Readonly<Ref<boolean>>;
  /** Resolves true when everything was saved. */
  readonly save: () => Promise<boolean>;
  /** Throws the unsaved edits away (the "leave without saving" choice). */
  readonly discard: () => void;
}

/**
 * The "unsaved changes" confirmation shared by every way out of the editor: the edit-mode
 * toggle, in-app navigation and closing the tab. `confirmLeave()` resolves true when it is fine
 * to go on (nothing unsaved, edits saved, or the person chose to discard them).
 */
export function useUnsavedChanges(options: UnsavedChangesOptions) {
  const open = ref(false);
  const busy = ref(false);
  let waiting: ((proceed: boolean) => void) | null = null;

  function confirmLeave(): Promise<boolean> {
    if (!options.isDirty.value) return Promise.resolve(true);
    // A second request while the dialog is open (double navigation) keeps the first answer.
    if (waiting) return Promise.resolve(false);
    open.value = true;
    return new Promise<boolean>((resolve) => {
      waiting = resolve;
    });
  }

  function finish(proceed: boolean): void {
    open.value = false;
    const resolve = waiting;
    waiting = null;
    resolve?.(proceed);
  }

  async function choose(choice: LeaveChoice): Promise<void> {
    if (busy.value) return;
    if (choice === 'stay') {
      finish(false);
    } else if (choice === 'leave') {
      options.discard();
      finish(true);
    } else {
      busy.value = true;
      try {
        // A failed save keeps the dialog's decision at "stay": the editor shows the error.
        finish(await options.save());
      } finally {
        busy.value = false;
      }
    }
  }

  // Closing the tab cannot show our dialog; the browser's own prompt is the only option.
  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!options.isDirty.value) return;
    event.preventDefault();
    event.returnValue = '';
  }

  onBeforeRouteLeave(() => confirmLeave());
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    // The page is going away: never leave a navigation hanging on a dialog nobody can answer.
    finish(true);
  });

  return { open, busy, confirmLeave, choose };
}
