import { readonly, ref, type Ref } from 'vue';

export interface CommandPalette {
  readonly isOpen: Readonly<Ref<boolean>>;
  open: () => void;
  close: () => void;
}

/** Open/closed state of the Ctrl+K palette, shared by the top bar button, the shortcut and the dialog. */
export function createCommandPalette(): CommandPalette {
  const isOpen = ref(false);
  return {
    isOpen: readonly(isOpen),
    open: () => {
      isOpen.value = true;
    },
    close: () => {
      isOpen.value = false;
    },
  };
}
