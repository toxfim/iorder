import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TextField from './TextField.vue';

function typeInto(wrapper: ReturnType<typeof mount>, text: string): void {
  const input = wrapper.get('input');
  (input.element as HTMLInputElement).value = text;
  void input.trigger('input');
}

describe('TextField digits-only', () => {
  it('drops letters, signs and spaces as they are typed or pasted, also in the DOM', async () => {
    const wrapper = mount(TextField, {
      props: { modelValue: '', label: 'Phone', digitsOnly: true },
    });
    typeInto(wrapper, '+99 8a90-1e2');
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['998901' + '2']);
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('9989012');
  });

  it('corrects the DOM even when the bound value does not change (a letter on an empty field)', async () => {
    const wrapper = mount(TextField, {
      props: { modelValue: '', label: 'Phone', digitsOnly: true },
    });
    typeInto(wrapper, 'a');
    await wrapper.vm.$nextTick();
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['']);
  });

  it('asks for the numeric keyboard and shows a fixed prefix that is not part of the value', () => {
    const wrapper = mount(TextField, {
      props: { modelValue: '', label: 'Phone', digitsOnly: true, prefix: '+' },
    });
    const input = wrapper.get('input');
    expect(input.attributes('inputmode')).toBe('numeric');
    expect(input.attributes('type')).toBe('text');
    expect(wrapper.get('.field__prefix').text()).toBe('+');
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  it('leaves ordinary fields untouched', async () => {
    const wrapper = mount(TextField, { props: { modelValue: '', label: 'Login' } });
    typeInto(wrapper, 'Ab-1@x');
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Ab-1@x']);
  });
});

describe('TextField phone format', () => {
  const format = (digits: string): string => digits.replace(/(\d{3})(?=\d)/g, '$1 ');

  it('shows the grouped digits and keeps the bound value as plain digits', async () => {
    const wrapper = mount(TextField, {
      props: { modelValue: '', label: 'Phone', digitsOnly: true, format, maxDigits: 6 },
    });
    typeInto(wrapper, '1234567890');
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['123456']);
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('123 456');
  });

  it('renders a stored value formatted', () => {
    const wrapper = mount(TextField, {
      props: { modelValue: '123456', label: 'Phone', digitsOnly: true, format },
    });
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('123 456');
  });
});
