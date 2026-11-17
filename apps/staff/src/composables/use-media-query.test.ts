import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { useMediaQuery } from './use-media-query';

type Listener = () => void;

function mockMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches: initial,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => media),
  });
  return {
    listeners,
    set(value: boolean) {
      media.matches = value;
      listeners.forEach((l) => l());
    },
  };
}

const Probe = defineComponent({
  setup() {
    const wide = useMediaQuery('(min-width: 640px)', true);
    return () => h('p', wide.value ? 'wide' : 'narrow');
  },
});

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('useMediaQuery', () => {
  it('follows the query and stops listening on unmount', async () => {
    const media = mockMatchMedia(false);
    const w = mount(Probe);
    expect(w.text()).toBe('narrow');
    media.set(true);
    await w.vm.$nextTick();
    expect(w.text()).toBe('wide');
    w.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('uses the fallback where matchMedia does not exist (server render, old webview)', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    expect(mount(Probe).text()).toBe('wide');
  });
});
