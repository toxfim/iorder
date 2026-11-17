import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { h, nextTick, ref } from 'vue';
import AppDrawer from './AppDrawer.vue';
import AppDropdown from './AppDropdown.vue';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

// The menu is teleported to <body> so nothing can clip it.
const listbox = (): HTMLElement | null => document.body.querySelector('[role="listbox"]');
const optionEls = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

function keydown(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('AppDropdown', () => {
  let wrapper: VueWrapper;

  afterEach(() => {
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  function mountOne(value: string | null = 'b') {
    wrapper = mount(AppDropdown, {
      props: { modelValue: value, options, label: 'Pick' },
      attachTo: document.body,
    });
    return wrapper;
  }

  it('shows the selected label and a closed listbox', () => {
    mountOne();
    expect(wrapper.get('button').text()).toBe('Beta');
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
    expect(listbox()).toBeNull();
  });

  it('opens on click, renders the menu in <body> and selects an option', async () => {
    mountOne();
    await wrapper.get('button').trigger('click');
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.element.contains(listbox())).toBe(false);
    expect(optionEls()).toHaveLength(3);
    expect(optionEls()[1]?.getAttribute('aria-selected')).toBe('true');

    optionEls()[2]?.click();
    await nextTick();
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['c']);
    expect(listbox()).toBeNull();
  });

  it('supports the keyboard: arrows, Enter and Esc', async () => {
    mountOne('a');
    const trigger = wrapper.get('button');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(listbox()).not.toBeNull();
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['b']);

    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(listbox()).toBeNull();
  });

  it('closes on an outside pointer press but not on a press inside the menu', async () => {
    mountOne();
    await wrapper.get('button').trigger('click');
    optionEls()[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(listbox()).not.toBeNull();

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(listbox()).toBeNull();
  });

  it('keeps only one dropdown open at a time', async () => {
    wrapper = mount(
      {
        render: () => [
          h(AppDropdown, { modelValue: 'a', options, label: 'one', class: 'one' }),
          h(AppDropdown, { modelValue: 'a', options, label: 'two', class: 'two' }),
        ],
      },
      { attachTo: document.body },
    );
    await wrapper.get('.one button').trigger('click');
    await wrapper.get('.two button').trigger('click');
    expect(document.body.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(listbox()?.getAttribute('aria-label')).toBe('two');
  });

  it('a locked dropdown keeps focus but opens neither by click nor by key, and closes if open', async () => {
    mountOne();
    const trigger = wrapper.get('button');
    await trigger.trigger('click');
    expect(listbox()).not.toBeNull();
    await wrapper.setProps({ disabled: true });
    expect(listbox()).toBeNull();
    expect(trigger.attributes('aria-disabled')).toBe('true');
    expect(trigger.attributes('disabled')).toBeUndefined();

    (trigger.element as HTMLElement).focus();
    await trigger.trigger('click');
    keydown(trigger.element, 'ArrowDown');
    await nextTick();
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);

    await wrapper.setProps({ disabled: false });
    expect(trigger.attributes('aria-disabled')).toBeUndefined();
    keydown(trigger.element, 'ArrowDown');
    await nextTick();
    expect(listbox()).not.toBeNull();
  });
});

describe('Esc with a dropdown inside a drawer', () => {
  let wrapper: VueWrapper;

  afterEach(() => {
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  function mountDrawerWithDropdown() {
    const open = ref(true);
    const value = ref<string | null>('a');
    wrapper = mount(
      {
        render: () =>
          h(
            AppDrawer,
            {
              modelValue: open.value,
              title: 'D',
              'onUpdate:modelValue': (v: boolean) => (open.value = v),
            },
            () => h(AppDropdown, { modelValue: value.value, options, label: 'in-drawer' }),
          ),
      },
      { attachTo: document.body },
    );
    return open;
  }

  it('first Esc closes only the dropdown, second Esc closes the drawer', async () => {
    const open = mountDrawerWithDropdown();
    await nextTick();
    await nextTick();
    const trigger = document.body.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!;
    trigger.click();
    await nextTick();
    expect(listbox()).not.toBeNull();

    keydown(trigger, 'Escape');
    await nextTick();
    expect(listbox()).toBeNull();
    expect(open.value).toBe(true);

    keydown(trigger, 'Escape');
    await nextTick();
    expect(open.value).toBe(false);
  });

  it('works even when focus is not on the trigger (menu opened with the mouse)', async () => {
    const open = mountDrawerWithDropdown();
    await nextTick();
    await nextTick();
    document.body.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!.click();
    await nextTick();

    keydown(document.body, 'Escape');
    await nextTick();
    expect(listbox()).toBeNull();
    expect(open.value).toBe(true);
  });

  it('the menu is not inside the scrolling drawer body, so it cannot be clipped', async () => {
    mountDrawerWithDropdown();
    await nextTick();
    await nextTick();
    document.body.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!.click();
    await nextTick();
    expect(document.body.querySelector('.drawer__body')?.contains(listbox())).toBe(false);
    expect(listbox()?.parentElement).toBe(document.body);
  });
});
