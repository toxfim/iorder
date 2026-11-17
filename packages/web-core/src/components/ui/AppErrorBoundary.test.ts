import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { formatMoney } from '@core/lib/format';
import { coreUz as uz } from '@core/i18n/messages/uz';
import AppErrorBoundary from './AppErrorBoundary.vue';

const state = { broken: true };

const Child = defineComponent({
  setup() {
    // The real-world trigger: the strict formatter rejecting a malformed amount.
    return () => h('p', { id: 'child' }, state.broken ? formatMoney('12,5') : 'fine');
  },
});

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    state.broken = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  function mountBoundary(resetKey = 'a') {
    return mount(AppErrorBoundary, {
      props: { resetKey },
      slots: { default: () => h(Child) },
    });
  }

  it('shows the error state instead of a blank page when a child throws', async () => {
    const wrapper = mountBoundary();
    await nextTick();
    expect(wrapper.find('[data-state="error"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(uz.state.error.title);
    expect(wrapper.find('#child').exists()).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('retry re-renders the content', async () => {
    const wrapper = mountBoundary();
    await nextTick();
    state.broken = false;
    await wrapper.get('button').trigger('click');
    await nextTick();
    expect(wrapper.get('#child').text()).toBe('fine');
  });

  it('clears the error when the reset key changes (navigation)', async () => {
    const wrapper = mountBoundary('a');
    await nextTick();
    state.broken = false;
    await wrapper.setProps({ resetKey: 'b' });
    expect(wrapper.find('#child').exists()).toBe(true);
  });

  it('renders children untouched when nothing throws', () => {
    state.broken = false;
    const wrapper = mountBoundary();
    expect(wrapper.get('#child').text()).toBe('fine');
  });
});
