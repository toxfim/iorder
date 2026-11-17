import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PasswordSignInForm from './PasswordSignInForm.vue';

describe('shared website password form', () => {
  it('reveals the password on request and clears and hides it before submitting', async () => {
    const wrapper = mount(PasswordSignInForm, {
      props: { busy: false, recoveryHint: 'Use Telegram' },
    });
    await wrapper.get('input[name="username"]').setValue('  my.shop  ');
    await wrapper.get('input[name="password"]').setValue('secret');
    await wrapper.get('.auth-visibility').trigger('click');
    expect(wrapper.get('input[name="password"]').attributes('type')).toBe('text');
    expect(wrapper.get('.auth-visibility').attributes('aria-pressed')).toBe('true');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')?.[0]).toEqual([{ login: 'my.shop', password: 'secret' }]);
    expect(wrapper.get('input[name="password"]').attributes('type')).toBe('password');
    expect((wrapper.get('input[name="password"]').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });
  it.each([{ busy: true }, { busy: false, waitSeconds: 5 }, { busy: false, disabled: true }])(
    'prevents submissions during busy, throttled or unavailable states: %j',
    async (props) => {
      const wrapper = mount(PasswordSignInForm, {
        props: { ...props, recoveryHint: 'Contact support' },
      });
      await wrapper.get('input[name="username"]').setValue('my.shop');
      await wrapper.get('input[name="password"]').setValue('secret');
      await wrapper.get('form').trigger('submit');
      expect(wrapper.emitted('submit')).toBeUndefined();
      wrapper.unmount();
    },
  );
});
