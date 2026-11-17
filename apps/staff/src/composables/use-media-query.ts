import { onScopeDispose, ref, type Ref } from 'vue';

/**
 * Reactive `matchMedia`. Where it does not exist (server render, tests, very old webviews) the
 * `fallback` is used and nothing is listened to. The listener is removed with the component.
 */
export function useMediaQuery(query: string, fallback: boolean): Ref<boolean> {
  const matches = ref(fallback);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;
  const media = window.matchMedia(query);
  matches.value = media.matches;
  // A stripped-down MediaQueryList (old webviews, test doubles) can lack the event API.
  if (typeof media.addEventListener !== 'function') return matches;
  const update = (): void => {
    matches.value = media.matches;
  };
  media.addEventListener('change', update);
  onScopeDispose(() => media.removeEventListener('change', update));
  return matches;
}
