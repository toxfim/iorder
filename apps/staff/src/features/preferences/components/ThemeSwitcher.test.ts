import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ThemeSwitcher from './ThemeSwitcher.vue';

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ThemeSwitcher', () => {
  it('is a labelled listbox of System, Light and Dark with the current choice selected', async () => {
    const wrapper = mount(ThemeSwitcher, { attachTo: document.body });
    const trigger = wrapper.get('button');
    expect(trigger.attributes('aria-label')).toBe('Mavzu');
    await trigger.trigger('click');
    await nextTick();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Tizim', "Yorug'", "Qorong'u"]);
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    wrapper.unmount();
  });

  it('applies and stores the picked theme', async () => {
    const wrapper = mount(ThemeSwitcher, { attachTo: document.body });
    await wrapper.get('button').trigger('click');
    await nextTick();
    options()[2]?.click();
    await nextTick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('iorder.theme')).toBe('dark');
    wrapper.unmount();
  });
});
