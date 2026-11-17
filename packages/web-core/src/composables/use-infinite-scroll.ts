import { nextTick, onScopeDispose, watch, type Ref } from 'vue';

/** How far below the viewport the next page starts loading, so scrolling rarely has to wait. */
export const INFINITE_SCROLL_MARGIN = '600px';

/**
 * Calls `onReach` whenever `target` (the end of a list, usually its "load more" button) comes
 * within INFINITE_SCROLL_MARGIN of the viewport. The button stays the fallback: for keyboards,
 * screen readers, a failed page and browsers without IntersectionObserver.
 *
 * `onReach` answers whether it added anything. One call at a time; after a call that added
 * something the target is checked again, because an observer reports only changes: a page too
 * short to push the target out of view would otherwise stop the loading. A call that added nothing
 * (no more pages, a failed page) waits for the next scroll instead of retrying in a loop.
 */
export function useInfiniteScroll(
  target: Readonly<Ref<HTMLElement | null>>,
  onReach: () => Promise<boolean> | boolean,
): void {
  if (typeof IntersectionObserver === 'undefined') return;
  let running = false;
  let visible = false;
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      void reach();
    },
    { rootMargin: `0px 0px ${INFINITE_SCROLL_MARGIN} 0px` },
  );

  async function reach(): Promise<void> {
    if (running || !visible) return;
    running = true;
    let added: boolean;
    try {
      added = await onReach();
    } finally {
      running = false;
    }
    if (!added) return;
    await nextTick();
    const el = target.value;
    if (!el) return;
    // Observing again makes the observer report the current state once more.
    observer.unobserve(el);
    observer.observe(el);
  }

  watch(
    target,
    (el, old) => {
      if (old) observer.unobserve(old);
      visible = false;
      if (el) observer.observe(el);
    },
    { immediate: true, flush: 'post' },
  );
  onScopeDispose(() => observer.disconnect());
}
