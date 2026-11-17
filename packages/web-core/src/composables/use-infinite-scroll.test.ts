import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { useInfiniteScroll } from './use-infinite-scroll';

// jsdom has no IntersectionObserver: this one reports what the test says is in view, and (like
// the real one) reports the current state again when an element is observed anew.
class FakeObserver {
  static all: FakeObserver[] = [];
  static inView = false;
  readonly observed = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
    queueMicrotask(() => this.report());
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  report(): void {
    if (this.observed.size === 0) return;
    const entries = [...this.observed].map(
      (target) => ({ target, isIntersecting: FakeObserver.inView }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await nextTick();
};

function setup(onReach: () => Promise<boolean> | boolean) {
  const shown = ref(true);
  const wrapper = mount(
    defineComponent({
      setup() {
        const target = ref<HTMLElement | null>(null);
        useInfiniteScroll(target, onReach);
        return () => (shown.value ? h('div', { ref: target }) : null);
      },
    }),
  );
  return { wrapper, shown };
}

beforeEach(() => {
  FakeObserver.all = [];
  FakeObserver.inView = false;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe('useInfiniteScroll', () => {
  it('does nothing while the end of the list is out of view', async () => {
    const onReach = vi.fn(() => true);
    setup(onReach);
    await settle();
    expect(onReach).not.toHaveBeenCalled();
  });

  it('loads when the end comes into view, and again while a short page leaves it in view', async () => {
    FakeObserver.inView = true;
    let pages = 3;
    const onReach = vi.fn(() => {
      pages -= 1;
      if (pages === 0) FakeObserver.inView = false;
      return true;
    });
    setup(onReach);
    await settle();
    expect(onReach).toHaveBeenCalledTimes(3);
  });

  it('stops when nothing was added (last page or a failure) instead of retrying in a loop', async () => {
    FakeObserver.inView = true;
    const onReach = vi.fn(() => false);
    setup(onReach);
    await settle();
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  it('never runs two loads at once', async () => {
    FakeObserver.inView = true;
    let release: (value: boolean) => void = () => undefined;
    const onReach = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    setup(onReach);
    await settle();
    FakeObserver.all[0]!.report();
    FakeObserver.all[0]!.report();
    expect(onReach).toHaveBeenCalledTimes(1);
    FakeObserver.inView = false;
    release(true);
    await settle();
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  it('stops observing when the target goes away and when the component unmounts', async () => {
    const { wrapper, shown } = setup(() => true);
    await settle();
    const observer = FakeObserver.all[0]!;
    expect(observer.observed.size).toBe(1);
    shown.value = false;
    await settle();
    expect(observer.observed.size).toBe(0);
    shown.value = true;
    await settle();
    expect(observer.observed.size).toBe(1);
    wrapper.unmount();
    expect(observer.observed.size).toBe(0);
  });

  it('is a no-op without IntersectionObserver (the button still works)', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onReach = vi.fn(() => true);
    setup(onReach);
    await settle();
    expect(onReach).not.toHaveBeenCalled();
  });
});
