import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { TOAST_DURATION_MS, dismissToast, showToast } from '@core/composables/use-toast';
import ToastHost from './ToastHost.vue';

const toastEl = (): HTMLElement | null => document.body.querySelector('[data-testid="toast"]');

describe('Toast', () => {
  let wrapper: VueWrapper;

  beforeEach(() => {
    vi.useFakeTimers();
    wrapper = mount(ToastHost, { attachTo: document.body });
  });

  afterEach(() => {
    dismissToast();
    wrapper.unmount();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows for 4 seconds and then disappears', async () => {
    showToast({ message: 'Saved' });
    await nextTick();
    expect(toastEl()?.textContent).toContain('Saved');

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    await nextTick();
    expect(toastEl()).not.toBeNull();

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(toastEl()).toBeNull();
  });

  it('a new toast replaces the old one and restarts the timer', async () => {
    showToast({ message: 'first' });
    vi.advanceTimersByTime(3000);
    showToast({ message: 'second' });
    await nextTick();
    expect(toastEl()?.textContent).toContain('second');

    vi.advanceTimersByTime(3000);
    await nextTick();
    // 6s after the first toast, but only 3s after the second: the old timer must not hide it.
    expect(toastEl()?.textContent).toContain('second');

    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(toastEl()).toBeNull();
  });

  it('pauses while hovered or focused and resumes with the time that was left', async () => {
    showToast({ message: 'Saved' });
    await nextTick();
    vi.advanceTimersByTime(3000);

    toastEl()?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(toastEl()).not.toBeNull();

    toastEl()?.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(999);
    await nextTick();
    expect(toastEl()).not.toBeNull();
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(toastEl()).toBeNull();
  });

  it('keyboard focus also pauses', async () => {
    showToast({ message: 'Saved', undoLabel: 'Undo', onUndo: () => undefined });
    await nextTick();
    toastEl()?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(10_000);
    await nextTick();
    expect(toastEl()).not.toBeNull();
  });

  it('undo runs the callback once and dismisses', async () => {
    const onUndo = vi.fn();
    showToast({ message: 'Deleted', undoLabel: 'Undo', onUndo });
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('.toast__undo')?.click();
    await nextTick();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(toastEl()).toBeNull();
  });

  it('has no undo button unless both label and callback are given', async () => {
    showToast({ message: 'Saved', undoLabel: 'Undo' });
    await nextTick();
    expect(document.body.querySelector('.toast__undo')).toBeNull();
  });

  it('lives in a polite live region', () => {
    expect(document.body.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });
});
