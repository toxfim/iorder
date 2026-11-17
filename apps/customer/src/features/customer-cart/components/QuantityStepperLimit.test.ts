import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuantityStepper from './QuantityStepper.vue';
import source from './QuantityStepper.vue?raw';

// The stock limit of the stepper (owner decision 2026-11-09): the field and the plus button stop at
// what can be ordered now and SAY why. The server enforces the same figure; this is the courtesy.

const LIMIT_NOTE = 'Omborda faqat 45 dona bor';

function setup(props: {
  modelValue: string;
  max?: number | null;
  commit?: (q: string | null) => Promise<boolean>;
}) {
  const commit = props.commit ?? vi.fn(() => Promise.resolve(true));
  const wrapper = mount(QuantityStepper, {
    props: {
      modelValue: props.modelValue,
      label: 'Baseus: miqdor',
      name: 'Baseus',
      commit,
      debounceMs: 300,
      ...(props.max === undefined ? {} : { max: props.max }),
    },
  });
  const input = wrapper.get('input');
  const [minus, plus] = wrapper.findAll('button');
  const shown = (): string => (input.element as HTMLInputElement).value;
  const note = () => wrapper.find('[data-testid="stepper-limit"]');
  return { wrapper, commit, input, minus: minus!, plus: plus!, shown, note };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('QuantityStepper: the stock limit', () => {
  it('plus stops at the limit and a further press explains instead of doing nothing', async () => {
    const { commit, plus, shown, note, input } = setup({ modelValue: '44', max: 45 });
    expect(plus.attributes('aria-disabled')).toBeUndefined();
    await plus.trigger('click');
    expect(shown()).toBe('45');
    expect(note().exists()).toBe(false);
    // At the limit the button is marked, but stays a real, focusable button.
    expect(plus.attributes('aria-disabled')).toBe('true');
    expect(plus.attributes('disabled')).toBeUndefined();
    expect(plus.classes()).toContain('stepper__btn--limit');

    await plus.trigger('click');
    await plus.trigger('click');
    expect(shown()).toBe('45');
    expect(note().text()).toBe(LIMIT_NOTE);
    expect(note().attributes('role')).toBe('status');
    expect(input.attributes('aria-describedby')).toBe(note().attributes('id'));

    await vi.advanceTimersByTimeAsync(300);
    // One request, for the limit itself: the extra presses asked for nothing.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('45');
  });

  it('the note goes away by itself, and at once when the quantity is lowered', async () => {
    const { plus, minus, note, wrapper } = setup({ modelValue: '45', max: 45 });
    await plus.trigger('click');
    expect(note().exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(note().exists()).toBe(false);

    await plus.trigger('click');
    expect(note().exists()).toBe(true);
    await minus.trigger('click');
    expect(note().exists()).toBe(false);
    wrapper.unmount();
  });

  it('a typed quantity above the limit becomes the limit, says why and is sent as the limit', async () => {
    const { commit, input, shown, note } = setup({ modelValue: '2', max: 45 });
    await input.setValue('100');
    expect(shown()).toBe('45');
    expect(note().text()).toBe(LIMIT_NOTE);
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('45');
    // Not a mistake of the person: no error state, no alert.
    expect(input.attributes('aria-invalid')).toBeUndefined();
  });

  it('a typed quantity within the limit is sent as typed, without a note', async () => {
    const { commit, input, note } = setup({ modelValue: '2', max: 45 });
    await input.setValue('45');
    await flushPromises();
    expect(commit).toHaveBeenCalledWith('45');
    expect(note().exists()).toBe(false);
  });

  it('typing above the limit when the cart already holds the limit sends nothing', async () => {
    const { commit, input, shown, note } = setup({ modelValue: '45', max: 45 });
    await input.setValue('60');
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown()).toBe('45');
    expect(note().exists()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('above the limit (the stock fell): minus goes straight to the limit, plus only explains', async () => {
    const { commit, minus, plus, shown, note } = setup({ modelValue: '50', max: 10 });
    expect(plus.attributes('aria-disabled')).toBe('true');
    await plus.trigger('click');
    expect(shown()).toBe('50');
    expect(note().text()).toBe('Omborda faqat 10 dona bor');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commit).not.toHaveBeenCalled();

    // 49, 48 ... 11 would each be refused by the server: one press lands on what can be ordered.
    await minus.trigger('click');
    expect(shown()).toBe('10');
    await vi.advanceTimersByTimeAsync(300);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('10');
  });

  it('rolls back to the cart quantity when the server refuses, also at the limit', async () => {
    const commit = vi.fn(() => Promise.resolve(false));
    const { plus, shown } = setup({ modelValue: '44', max: 45, commit });
    await plus.trigger('click');
    expect(shown()).toBe('45');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(commit).toHaveBeenCalledWith('45');
    expect(shown()).toBe('44');
  });

  it('follows a limit that moves (a fresh cart answer)', async () => {
    const { wrapper, plus, shown } = setup({ modelValue: '5', max: 5 });
    expect(plus.attributes('aria-disabled')).toBe('true');
    await wrapper.setProps({ max: 8 });
    expect(plus.attributes('aria-disabled')).toBeUndefined();
    await plus.trigger('click');
    expect(shown()).toBe('6');
  });

  it('without a figure there is no limit and no note, whatever the quantity', async () => {
    for (const max of [undefined, null]) {
      const { commit, plus, shown, note } = setup({ modelValue: '5000', max });
      expect(plus.attributes('aria-disabled')).toBeUndefined();
      await plus.trigger('click');
      expect(shown()).toBe('5001');
      expect(note().exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(commit).toHaveBeenCalledWith('5001');
    }
  });
});

describe('QuantityStepper: out of stock (a limit of zero)', () => {
  it('plus explains that nothing is left; nothing is sent', async () => {
    const { commit, plus, shown, note } = setup({ modelValue: '3', max: 0 });
    expect(plus.attributes('aria-disabled')).toBe('true');
    await plus.trigger('click');
    expect(shown()).toBe('3');
    expect(note().text()).toBe('Omborda qolmagan');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commit).not.toHaveBeenCalled();
  });

  it('minus asks for removal at once: there is no quantity to lower to', async () => {
    const { commit, minus } = setup({ modelValue: '3', max: 0 });
    await minus.trigger('click');
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(null);
  });

  it('a typed quantity is put back to what the cart holds, with the note, and nothing is sent', async () => {
    const { commit, input, shown, note } = setup({ modelValue: '3', max: 0 });
    await input.setValue('2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown()).toBe('3');
    expect(note().text()).toBe('Omborda qolmagan');
    expect(commit).not.toHaveBeenCalled();
    expect(input.attributes('aria-invalid')).toBeUndefined();
  });
});

// jsdom has no layout, so this reads the source.
describe('QuantityStepper: the limit note is an explanation, not an error', () => {
  it('uses the normal text colour, not the alarm colour, and the size of the error line', () => {
    // Every rule whose selector ends with the note (the shared one and its own).
    const note = [...source.matchAll(/\.stepper__note \{([^}]*)\}/g)].map((m) => m[1]).join(' ');
    expect(note).toMatch(/color:\s*var\(--t2\)/);
    expect(note).not.toMatch(/--red/);
    expect(source).toMatch(
      /\.stepper__error,\s*\.stepper__note \{[^}]*font-size:\s*var\(--fs-meta\)/,
    );
  });

  it('never hard-disables the plus button for the limit', () => {
    // `disabled` would drop it from the tab order and swallow the press that explains the limit.
    const plus = /<button[^>]*stepper__btn--limit[\s\S]*?>/.exec(source)?.[0] ?? '';
    expect(plus).toContain(':disabled="disabled"');
    expect(plus).toContain(':aria-disabled="atLimit || undefined"');
  });
});
