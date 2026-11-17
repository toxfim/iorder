import { onScopeDispose, watch, type Ref } from 'vue';

/**
 * Publishes the real heights of the shell's header and menu as `--customer-header-h` and
 * `--customer-tabs-h` on the shell root. Labels wrap in ru/uz and the menu carries the safe-area
 * inset, so fixed pixel guesses let content slide under a bar. Until something is measured (no
 * layout yet, or no ResizeObserver) the CSS fallbacks in the shell stay in force.
 */
export function useShellMetrics(
  root: Ref<HTMLElement | null>,
  header: Ref<HTMLElement | null>,
  tabs: Ref<HTMLElement | null>,
): void {
  let observer: ResizeObserver | undefined;

  function publish(name: string, element: HTMLElement | null): void {
    const height = element === null ? 0 : Math.ceil(element.getBoundingClientRect().height);
    if (height > 0) root.value?.style.setProperty(name, `${height}px`);
    else root.value?.style.removeProperty(name);
  }

  function measure(): void {
    publish('--customer-header-h', header.value);
    publish('--customer-tabs-h', tabs.value);
  }

  // The menu only exists once the person is known, so the elements are watched, not read once.
  watch(
    [root, header, tabs],
    () => {
      observer?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        observer ??= new ResizeObserver(measure);
        for (const element of [header.value, tabs.value]) {
          if (element !== null) observer.observe(element);
        }
      }
      measure();
    },
    { flush: 'post', immediate: true },
  );

  onScopeDispose(() => observer?.disconnect());
}
