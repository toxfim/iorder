import { onScopeDispose, ref, watch, type Ref } from 'vue';

const DURATION_MS = 600;

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A whole number that counts up to its target (the home page KPIs). Switched off for
 * prefers-reduced-motion and where animation frames do not exist: then it simply equals the target.
 * Only for counts; amounts of money are never animated through numbers.
 */
export function useCountUp(target: Readonly<Ref<number>>): Readonly<Ref<number>> {
  const shown = ref(0);
  let frame = 0;

  function stop(): void {
    if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
  }

  watch(
    target,
    (to) => {
      stop();
      const from = shown.value;
      if (from === to || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
        shown.value = to;
        return;
      }
      let started: number | null = null;
      const step = (now: number): void => {
        started ??= now;
        const progress = Math.min((now - started) / DURATION_MS, 1);
        // ease-out cubic: fast start, soft landing, like the design's easing curve.
        shown.value = Math.round(from + (to - from) * (1 - (1 - progress) ** 3));
        frame = progress < 1 ? requestAnimationFrame(step) : 0;
      };
      frame = requestAnimationFrame(step);
    },
    { immediate: true },
  );

  onScopeDispose(stop);
  return shown;
}
