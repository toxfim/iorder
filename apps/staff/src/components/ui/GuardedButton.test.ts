import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { waitFor } from '@core/test-utils/wait';
import GuardedButton from './GuardedButton.vue';

// A button that says why it cannot be pressed (owner, 2026-11-09): hover and keyboard focus show
// the reasons in a tooltip, a touch tap opens a dialog with them, and the action never runs while
// a reason is left.

const wrappers: VueWrapper[] = [];
const REASONS = ['Choose the sale type: Naqd or Official.', 'Save the item changes first.'];

/** What `(hover: none)` answers; a desktop by default. */
let hoverless = false;
beforeEach(() => {
  hoverless = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: hoverless }) as MediaQueryList,
  });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountButton(reasons: readonly string[] = REASONS, extra: Record<string, unknown> = {}) {
  const onClick = vi.fn();
  const wrapper = mount(GuardedButton, {
    attachTo: document.body,
    props: { reasons, reasonsTitle: 'Why can it not be approved?', onClick, ...extra },
    slots: { default: () => h('span', 'Approve') },
  });
  wrappers.push(wrapper);
  return { wrapper, onClick, button: wrapper.element as HTMLButtonElement };
}

const pointer = (target: Element, type: string, pointerType: string): void => {
  target.dispatchEvent(new PointerEvent(type, { pointerType, bubbles: type !== 'pointerenter' }));
};
const tooltip = (): HTMLElement | null => document.body.querySelector('[role="tooltip"]');
const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]');
const lines = (root: Element | null, selector: string): string[] =>
  Array.from(root?.querySelectorAll(selector) ?? []).map((el) => el.textContent?.trim() ?? '');

describe('GuardedButton, blocked', () => {
  it('is announced as disabled with its reasons, yet stays focusable and is not natively disabled', () => {
    const { button } = mountButton();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    const describedBy = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(REASONS.join(' '));
    // The name of the button is its label only: the reasons live outside it.
    expect(button.textContent?.trim()).toBe('Approve');
  });

  it('announces the reasons before the hint the caller points at', () => {
    const { button } = mountButton(REASONS, { describedBy: 'hint-1' });
    const ids = (button.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0] ?? '')?.textContent).toBe(REASONS.join(' '));
    expect(ids[1]).toBe('hint-1');
  });

  it('shows every reason in a tooltip on mouse hover and hides it when the pointer leaves', async () => {
    vi.useFakeTimers();
    const { button, onClick } = mountButton();
    expect(tooltip()).toBeNull();
    pointer(button, 'pointerenter', 'mouse');
    await flushPromises();
    expect(lines(tooltip(), '.tip__line')).toEqual(REASONS);
    pointer(button, 'pointerleave', 'mouse');
    // A moment to move onto the tooltip itself (WCAG 1.4.13).
    expect(tooltip()).not.toBeNull();
    vi.advanceTimersByTime(200);
    await flushPromises();
    expect(tooltip()).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the tooltip while the pointer is on the tooltip', async () => {
    vi.useFakeTimers();
    const { button } = mountButton();
    pointer(button, 'pointerenter', 'mouse');
    await flushPromises();
    pointer(button, 'pointerleave', 'mouse');
    pointer(tooltip() as HTMLElement, 'pointerenter', 'mouse');
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(tooltip()).not.toBeNull();
  });

  it('shows the tooltip on keyboard focus, closes it on Escape and on blur', async () => {
    const { button } = mountButton();
    button.focus();
    await flushPromises();
    expect(lines(tooltip(), '.tip__line')).toEqual(REASONS);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    button.dispatchEvent(escape);
    document.removeEventListener('keydown', behind);
    await flushPromises();
    expect(tooltip()).toBeNull();
    // The Escape belonged to the tooltip: nothing behind it heard it.
    expect(behind).not.toHaveBeenCalled();

    button.blur();
    button.focus();
    await flushPromises();
    expect(tooltip()).not.toBeNull();
    button.blur();
    await flushPromises();
    expect(tooltip()).toBeNull();
  });

  it('on a mouse click or the Enter key only shows the tooltip: no dialog, no action', async () => {
    const { button, onClick } = mountButton();
    pointer(button, 'pointerdown', 'mouse');
    button.click();
    await flushPromises();
    expect(tooltip()).not.toBeNull();
    expect(dialog()).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('on a touch tap opens a dialog with every reason and never performs the action', async () => {
    const { button, onClick } = mountButton();
    // What a tap does, in its order: the finger goes down, the button takes focus, then the click.
    pointer(button, 'pointerenter', 'touch');
    pointer(button, 'pointerdown', 'touch');
    button.focus();
    button.click();
    await flushPromises();
    expect(tooltip()).toBeNull();
    expect(dialog()?.querySelector('.modal__title')?.textContent?.trim()).toBe(
      'Why can it not be approved?',
    );
    expect(lines(dialog(), '.why__item')).toEqual(REASONS);
    expect(onClick).not.toHaveBeenCalled();

    (document.body.querySelector('[data-testid="blocked-ok"]') as HTMLElement).click();
    await flushPromises();
    await waitFor(() => expect(dialog()).toBeNull());
    // The focus is back on the button, and that does not pop the tooltip up after the dialog
    // (this is a laptop with a touch screen: it has hover).
    expect(document.activeElement).toBe(button);
    expect(tooltip()).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('opens the dialog on a device without hover even when no pointer type is known', async () => {
    hoverless = true;
    const { button, onClick } = mountButton();
    button.click();
    await flushPromises();
    expect(dialog()).not.toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('submits no form while blocked', async () => {
    const { button } = mountButton(REASONS, { type: 'submit' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(click);
    await flushPromises();
    expect(click.defaultPrevented).toBe(true);
  });

  it('keeps the spinner and stays explainable while a request runs', () => {
    const { button } = mountButton(['The request is being sent.'], { loading: true });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
  });

  it('closes the tooltip and the dialog once the last reason is gone', async () => {
    const { wrapper, button } = mountButton();
    pointer(button, 'pointerdown', 'touch');
    button.click();
    await flushPromises();
    expect(dialog()).not.toBeNull();
    await wrapper.setProps({ reasons: [] });
    await flushPromises();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    // It fades out with the text it had, not as an empty box.
    expect(lines(dialog(), '.why__item')).toEqual(REASONS);
    await waitFor(() => expect(dialog()).toBeNull());
  });
});

describe('GuardedButton, free', () => {
  it('works as a plain button: no disabled state, no tooltip, the click goes through', async () => {
    const { button, onClick } = mountButton([], { describedBy: 'hint-1' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBe('hint-1');
    pointer(button, 'pointerenter', 'mouse');
    button.focus();
    await flushPromises();
    expect(tooltip()).toBeNull();
    pointer(button, 'pointerdown', 'touch');
    button.click();
    await flushPromises();
    expect(dialog()).toBeNull();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
