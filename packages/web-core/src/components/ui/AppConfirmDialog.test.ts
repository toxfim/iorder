import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import AppConfirmDialog from './AppConfirmDialog.vue';

let wrapper: VueWrapper;

afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = '';
});

const footerButtons = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button'));

function open(props: Record<string, unknown> = {}) {
  wrapper = mount(AppConfirmDialog, {
    attachTo: document.body,
    props: { modelValue: true, title: 'Delete?', confirmLabel: 'Delete', ...props },
  });
}

describe('AppConfirmDialog', () => {
  it('emits confirm and closes on cancel', async () => {
    open();
    const [cancel, confirm] = footerButtons();
    confirm?.click();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    cancel?.click();
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('locks both buttons and ignores dismissal while the action runs', async () => {
    open({ loading: true });
    const [cancel, confirm] = footerButtons();
    expect(cancel?.disabled).toBe(true);
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
    document.body.querySelector<HTMLElement>('.modal__overlay')?.click();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('shows the failure as an alert and keeps the dialog open', async () => {
    open({ error: 'Could not delete' });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Could not delete');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('uses the danger look for destructive confirmations', async () => {
    open({ tone: 'danger' });
    expect(footerButtons()[1]?.classList.contains('btn--danger')).toBe(true);
  });
});
