import { onScopeDispose, ref, watch, type Ref } from 'vue';

/**
 * Two-step close (specs.md section 5, rule 6): when `open` turns false the element stays mounted
 * with `closing = true` for `closeMs`, so the exit animation can finish, and only then unmounts.
 *
 * A timer is used instead of `animationend` on purpose: under prefers-reduced-motion the
 * animations are switched off and `animationend` would never fire.
 */
export function useDelayedPresence(open: Ref<boolean>, closeMs: number) {
  const mounted = ref(open.value);
  const closing = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(open, (isOpen) => {
    clearTimeout(timer);
    if (isOpen) {
      mounted.value = true;
      closing.value = false;
    } else if (mounted.value) {
      closing.value = true;
      timer = setTimeout(() => {
        mounted.value = false;
        closing.value = false;
      }, closeMs);
    }
  });

  onScopeDispose(() => clearTimeout(timer));

  return { mounted, closing };
}
