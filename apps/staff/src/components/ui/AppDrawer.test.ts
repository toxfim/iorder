import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick } from 'vue';
import AppModal from '@core/components/ui/AppModal.vue';
import AppDrawer from './AppDrawer.vue';
import { EXIT_MS } from '@core/components/ui/motion';

const drawer = (): HTMLElement | null => document.body.querySelector('[data-testid="drawer"]');

describe('AppDrawer', () => {
  let wrapper: VueWrapper;

  function mountDrawer(open: boolean): VueWrapper {
    wrapper = mount(AppDrawer, {
      props: { modelValue: open, title: 'Order' },
      slots: { default: '<button data-testid="inner">inner</button>' },
      attachTo: document.body,
    });
    return wrapper;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    wrapper.unmount();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('renders nothing while closed', () => {
    mountDrawer(false);
    expect(drawer()).toBeNull();
  });

  it('is an accessible modal dialog labelled by its title', async () => {
    mountDrawer(false);
    await wrapper.setProps({ modelValue: true });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelId)?.textContent).toBe('Order');
  });

  it('closes in two steps: exit animation first, unmount only after EXIT_MS', async () => {
    mountDrawer(true);
    await nextTick();
    expect(drawer()?.classList.contains('drawer--closing')).toBe(false);

    await wrapper.setProps({ modelValue: false });
    // Step 1: still in the DOM, marked closing so the slideOut animation runs.
    expect(drawer()).not.toBeNull();
    expect(drawer()?.classList.contains('drawer--closing')).toBe(true);

    vi.advanceTimersByTime(EXIT_MS - 1);
    await nextTick();
    expect(drawer()).not.toBeNull();

    // Step 2: removed once the animation has had its full duration.
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(drawer()).toBeNull();
  });

  it('cancels a pending unmount when reopened during the exit animation', async () => {
    mountDrawer(true);
    await wrapper.setProps({ modelValue: false });
    vi.advanceTimersByTime(100);
    await wrapper.setProps({ modelValue: true });
    vi.advanceTimersByTime(EXIT_MS * 2);
    await nextTick();
    expect(drawer()).not.toBeNull();
    expect(drawer()?.classList.contains('drawer--closing')).toBe(false);
  });

  it('asks to close on Esc and on overlay click', async () => {
    mountDrawer(true);
    await nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);

    document.body.querySelector<HTMLElement>('.drawer__overlay')?.click();
    expect(wrapper.emitted('update:modelValue')).toHaveLength(2);
  });

  it('moves focus in on open and back to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    mountDrawer(false);
    await wrapper.setProps({ modelValue: true });
    await nextTick();
    expect(document.body.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(
      true,
    );

    await wrapper.setProps({ modelValue: false });
    expect(document.activeElement).toBe(opener);
  });

  it('makes the page behind inert while open and restores it afterwards', async () => {
    const page = document.createElement('div');
    page.id = 'app';
    document.body.appendChild(page);

    mountDrawer(false);
    await wrapper.setProps({ modelValue: true });
    expect(page.hasAttribute('inert')).toBe(true);
    expect(page.getAttribute('aria-hidden')).toBe('true');

    await wrapper.setProps({ modelValue: false });
    expect(page.hasAttribute('inert')).toBe(false);
    expect(page.hasAttribute('aria-hidden')).toBe(false);
  });

  it('keeps Tab inside the drawer', async () => {
    mountDrawer(true);
    await nextTick();
    const dialog = document.body.querySelector('[role="dialog"]');
    const buttons = dialog?.querySelectorAll<HTMLElement>('button') ?? [];
    const last = buttons[buttons.length - 1];
    last?.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('only the topmost dialog reacts to Esc (modal over drawer)', async () => {
    const onDrawer = vi.fn();
    const onModal = vi.fn();
    wrapper = mount(
      {
        render: () => [
          h(AppDrawer, { modelValue: true, title: 'D', 'onUpdate:modelValue': onDrawer }),
          h(AppModal, { modelValue: true, title: 'M', 'onUpdate:modelValue': onModal }),
        ],
      },
      { attachTo: document.body },
    );
    await nextTick();
    await nextTick();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onModal).toHaveBeenCalledWith(false);
    expect(onDrawer).not.toHaveBeenCalled();
  });
});
