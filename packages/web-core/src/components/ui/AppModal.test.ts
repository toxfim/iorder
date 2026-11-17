import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import AppModal from './AppModal.vue';
import { EXIT_MS } from './motion';

const modal = (): HTMLElement | null => document.body.querySelector('[data-testid="modal"]');

describe('AppModal', () => {
  let wrapper: VueWrapper;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    wrapper.unmount();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('exposes title and description to assistive tech and stays mounted for the exit animation', async () => {
    wrapper = mount(AppModal, {
      props: {
        modelValue: false,
        title: 'Cancel order?',
        description: 'You can cancel until approval.',
      },
      slots: { footer: '<button>ok</button>' },
      attachTo: document.body,
    });
    await wrapper.setProps({ modelValue: true });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('Cancel order?');
    expect(
      document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('You can cancel until approval.');

    await wrapper.setProps({ modelValue: false });
    expect(modal()?.classList.contains('modal--closing')).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    await nextTick();
    expect(modal()).toBeNull();
  });

  it('closes on Esc and overlay click', async () => {
    wrapper = mount(AppModal, {
      props: { modelValue: true, title: 'T' },
      slots: { footer: '<button>ok</button>' },
      attachTo: document.body,
    });
    await nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.querySelector<HTMLElement>('.modal__overlay')?.click();
    expect(wrapper.emitted('update:modelValue')).toEqual([[false], [false]]);
  });
});
