import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createI18nFor, LOCALE_STORAGE_KEY } from '@core/i18n';
import LoginLayout from './LoginLayout.vue';

const props = {
  audience: 'Audience',
  title: 'Title',
  subtitle: 'Subtitle',
  note: 'Note',
  footer: 'Footer',
  heroEyebrow: 'Intro',
  heroTitle: 'Hero',
  heroDescription: 'Description',
  heroNote: 'Note',
};
afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  document.body.innerHTML = '';
});
describe('login language dropdown', () => {
  it('shows styled options, updates the app locale and returns focus after selection', async () => {
    const i18n = createI18nFor({ uz: {}, ru: {}, en: {} });
    const wrapper = mount(LoginLayout, {
      props,
      attachTo: document.body,
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('select').exists()).toBe(false);
    const trigger = wrapper.get('[aria-haspopup="listbox"]');
    await trigger.trigger('click');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
    expect(wrapper.find('[aria-selected="true"] .app-icon').exists()).toBe(true);
    const english = wrapper
      .findAll('[role="option"]')
      .find((option) => option.text() === 'English');
    await english?.trigger('click');
    await flushPromises();
    expect(i18n.global.locale.value).toBe('en');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });
  it('closes on Escape without changing the language', async () => {
    const i18n = createI18nFor({ uz: {}, ru: {}, en: {} });
    const wrapper = mount(LoginLayout, { props, global: { plugins: [i18n] } });
    const trigger = wrapper.get('[aria-haspopup="listbox"]');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(trigger.attributes('aria-expanded')).toBe('true');
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(i18n.global.locale.value).toBe('uz');
    wrapper.unmount();
  });
});
