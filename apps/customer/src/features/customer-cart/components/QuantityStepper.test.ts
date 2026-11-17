import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerUz } from '@/features/customer-app/messages/uz';
import QuantityStepper from './QuantityStepper.vue';

const NAME = 'Baseus';
const LABEL = 'Baseus: miqdor';

function setup(props: { modelValue?: string; commit?: (q: string | null) => Promise<boolean> }) {
  const commit = props.commit ?? vi.fn(() => Promise.resolve(true));
  const wrapper = mount(QuantityStepper, {
    props: {
      modelValue: props.modelValue ?? '2',
      label: LABEL,
      name: NAME,
      commit,
      debounceMs: 300,
    },
  });
  const input = wrapper.get('input');
  const [minus, plus] = wrapper.findAll('button');
  return { wrapper, commit, input, minus: minus!, plus: plus! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('QuantityStepper', () => {
  it('collects quick taps on plus into ONE request after the pause', async () => {
    const { commit, input, plus } = setup({ modelValue: '2' });
    await plus.trigger('click');
    await plus.trigger('click');
    await plus.trigger('click');
    // Optimistic: the number moves at once, nothing is sent yet.
    expect((input.element as HTMLInputElement).value).toBe('5');
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('5');
  });

  it('a fraction is refused here, as the cart endpoint would, and tells the parent', async () => {
    const { commit, input, wrapper } = setup({ modelValue: '2' });
    await input.setValue('2,5');
    expect(commit).not.toHaveBeenCalled();
    expect(wrapper.emitted('invalid')?.at(-1)).toEqual([true]);
  });

  it('an invalid or zero entry shows an alert, links it to the field and sends nothing', async () => {
    const { commit, input, wrapper } = setup({ modelValue: '2' });
    await input.setValue('0');
    expect(commit).not.toHaveBeenCalled();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toBe(customerUz.quantity.invalid);
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toBe(alert.attributes('id'));
  });

  it('minus at the smallest step asks for removal immediately', async () => {
    const { commit, minus } = setup({ modelValue: '1' });
    await minus.trigger('click');
    expect(commit).toHaveBeenCalledWith(null);
  });

  it('plus past the largest quantity of the contract is refused locally', async () => {
    const { commit, plus, wrapper, input } = setup({ modelValue: '999999' });
    await plus.trigger('click');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commit).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('999999');
  });

  it('rolls the number back when the server refuses the change', async () => {
    const commit = vi.fn(() => Promise.resolve(false));
    const { input, plus } = setup({ modelValue: '2', commit });
    await plus.trigger('click');
    expect((input.element as HTMLInputElement).value).toBe('3');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(commit).toHaveBeenCalledWith('3');
    expect((input.element as HTMLInputElement).value).toBe('2');
  });

  it('requests never overlap: a change made while one is in flight is sent after it', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const commit = vi
      .fn<(q: string | null) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
      .mockResolvedValue(true);
    const { wrapper, input, plus } = setup({ modelValue: '1', commit });
    await plus.trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(input.attributes('aria-busy')).toBe('true');
    // The buttons stay enabled (focus is not lost) but the second request waits.
    expect(plus.attributes('disabled')).toBeUndefined();
    await plus.trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    expect(commit).toHaveBeenCalledTimes(1);
    release(true);
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith('3');
    await wrapper.setProps({ modelValue: '3' });
    expect((input.element as HTMLInputElement).value).toBe('3');
  });

  it('follows the saved quantity when nothing is waiting', async () => {
    const { wrapper, input } = setup({ modelValue: '2' });
    await wrapper.setProps({ modelValue: '7' });
    expect((input.element as HTMLInputElement).value).toBe('7');
  });

  it('reports unsaved while a change waits or is in flight (the line total is provisional)', async () => {
    const { wrapper, plus } = setup({ modelValue: '2' });
    await plus.trigger('click');
    expect(wrapper.emitted('unsaved')?.at(-1)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(wrapper.emitted('unsaved')?.at(-1)).toEqual([false]);
  });

  it('names the field and both buttons for screen readers, each with the product name', () => {
    const { wrapper, input, minus, plus } = setup({});
    // One accessible name per control: the group does not repeat the field's label.
    expect(wrapper.find('[role="group"][aria-label]').exists()).toBe(false);
    expect(input.attributes('aria-label')).toBe(LABEL);
    expect(input.attributes('inputmode')).toBe('decimal');
    expect(minus.attributes('aria-label')).toBe('Kamaytirish: Baseus');
    expect(plus.attributes('aria-label')).toBe("Ko'paytirish: Baseus");
  });

  it('a hard-disabled stepper cannot be used', () => {
    const wrapper = mount(QuantityStepper, {
      props: { modelValue: '1', label: LABEL, name: NAME, commit: vi.fn(), disabled: true },
    });
    expect(wrapper.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(
      true,
    );
  });
});

describe('QuantityStepper: removal goes through the same send path', () => {
  it('step-down to zero while a request is in flight waits for it (qty 2: minus, minus)', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const commit = vi
      .fn<(q: string | null) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
      .mockResolvedValue(true);
    const { minus } = setup({ modelValue: '2', commit });
    await minus.trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenLastCalledWith('1');
    await minus.trigger('click');
    await vi.advanceTimersByTimeAsync(1000);
    // Never two requests at once.
    expect(commit).toHaveBeenCalledTimes(1);
    release(true);
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith(null);
  });

  it('removal replaces a change that still waits for its pause (only the removal is sent)', async () => {
    const { commit, minus } = setup({ modelValue: '2' });
    await minus.trigger('click');
    await minus.trigger('click');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(null);
  });

  it('a failed removal puts the number back', async () => {
    const commit = vi.fn(() => Promise.resolve(false));
    const { minus, input } = setup({ modelValue: '1', commit });
    await minus.trigger('click');
    await flushPromises();
    expect(commit).toHaveBeenCalledWith(null);
    expect((input.element as HTMLInputElement).value).toBe('1');
  });
});

describe('QuantityStepper: equal quantities', () => {
  it("'2.500' and '2.5' are the same quantity: no redundant request", async () => {
    const { commit, input } = setup({ modelValue: '2.500' });
    await input.setValue('2.5');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commit).not.toHaveBeenCalled();
  });

  // The server answers quantities with three fraction digits ('1.000'); the field must not.
  it("shows the server's '1.000' as '1', also after a saved step", async () => {
    const { input, plus, wrapper } = setup({ modelValue: '1.000' });
    const shown = (): string => (input.element as HTMLInputElement).value;
    expect(shown()).toBe('1');
    await plus.trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    await wrapper.setProps({ modelValue: '2.000' });
    await flushPromises();
    expect(shown()).toBe('2');
    await wrapper.setProps({ modelValue: '2.500' });
    expect(shown()).toBe('2.5');
  });
});

describe('QuantityStepper: leaving the page and rollbacks', () => {
  it('sends a waiting change at once when the page is hidden (pagehide)', async () => {
    const { commit, plus } = setup({ modelValue: '2' });
    await plus.trigger('click');
    expect(commit).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    await flushPromises();
    expect(commit).toHaveBeenCalledWith('3');
  });

  it('sends it when the tab becomes hidden, but not when it becomes visible', async () => {
    const { commit, plus } = setup({ modelValue: '2' });
    await plus.trigger('click');
    const state = vi.spyOn(document, 'visibilityState', 'get');
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(commit).not.toHaveBeenCalled();
    state.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(commit).toHaveBeenCalledWith('3');
    state.mockRestore();
  });

  it('stops listening when the control goes away', async () => {
    const { commit, wrapper } = setup({ modelValue: '2' });
    wrapper.unmount();
    window.dispatchEvent(new Event('pagehide'));
    expect(commit).not.toHaveBeenCalled();
  });

  it('a rollback keeps what the person typed meanwhile and sends it', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const commit = vi
      .fn<(q: string | null) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
      .mockResolvedValue(true);
    const { input, plus } = setup({ modelValue: '2', commit });
    await plus.trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    expect(commit).toHaveBeenCalledWith('3');
    await input.setValue('7');
    release(false);
    await flushPromises();
    expect(commit).toHaveBeenLastCalledWith('7');
  });

  it('a rollback does not wipe text that is typed but not yet committed', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const commit = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const { input, plus } = setup({ modelValue: '2', commit });
    await plus.trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    (input.element as HTMLInputElement).value = '12';
    await input.trigger('input');
    release(false);
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe('12');
  });
});
