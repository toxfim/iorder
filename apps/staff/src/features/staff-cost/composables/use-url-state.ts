import { onBeforeUnmount, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export interface UrlStateOptions {
  /** The value that is NOT written to the address (the page's default). */
  readonly fallback: string;
  /** Rejects values from a hand-edited address; an invalid one falls back. */
  readonly isValid?: (value: string) => boolean;
  /** Typing: write to the address after the person pauses (browsers rate-limit history writes). */
  readonly debounceMs?: number;
}

/**
 * Keeps a string ref and one query parameter in step: the ref is read from the address on
 * start, every change is written with `router.replace` (no history entry per keystroke), and a
 * change of the address itself (Back, a pasted link) is read back into the ref. Reload and Back
 * therefore keep the tab, category and search of a list. Other query parameters are untouched.
 */
export function useUrlState(key: string, state: Ref<string>, options: UrlStateOptions): void {
  const route = useRoute();
  const router = useRouter();
  const { fallback, isValid = () => true, debounceMs = 0 } = options;

  const fromAddress = (): string => {
    const raw = route.query[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value !== '' && isValid(value) ? value : fallback;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelPending = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  function write(value: string): void {
    timer = undefined;
    if (fromAddress() === value) return;
    const { [key]: _previous, ...rest } = route.query;
    void _previous;
    void router.replace({ query: value === fallback ? rest : { ...rest, [key]: value } });
  }

  state.value = fromAddress();

  watch(state, (value) => {
    cancelPending();
    if (debounceMs > 0) timer = setTimeout(() => write(value), debounceMs);
    else write(value);
  });

  watch(
    () => route.query[key],
    () => {
      const value = fromAddress();
      if (value === state.value) return;
      cancelPending();
      state.value = value;
    },
  );

  onBeforeUnmount(cancelPending);
}
