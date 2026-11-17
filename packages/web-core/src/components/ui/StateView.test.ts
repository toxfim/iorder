import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { coreUz as uz } from '@core/i18n/messages/uz';
import StateView from './StateView.vue';

describe('StateView', () => {
  it('loading: busy status with the loading text', () => {
    const wrapper = mount(StateView, { props: { state: 'loading' } });
    const root = wrapper.get('[data-state="loading"]');
    expect(root.attributes('role')).toBe('status');
    expect(root.attributes('aria-busy')).toBe('true');
    expect(root.text()).toBe(uz.state.loading);
  });

  it('empty: default title and description', () => {
    const wrapper = mount(StateView, { props: { state: 'empty' } });
    expect(wrapper.text()).toContain(uz.state.empty.title);
    expect(wrapper.text()).toContain(uz.state.empty.description);
  });

  it('error: alert with a retry button that emits retry', async () => {
    const wrapper = mount(StateView, { props: { state: 'error' } });
    expect(wrapper.get('[data-state="error"]').attributes('role')).toBe('alert');
    expect(wrapper.text()).toContain(uz.state.error.title);
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('denied: alert without a retry button', () => {
    const wrapper = mount(StateView, { props: { state: 'denied' } });
    expect(wrapper.get('[data-state="denied"]').attributes('role')).toBe('alert');
    expect(wrapper.text()).toContain(uz.state.denied.title);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('success: shows caller-supplied copy and actions only', () => {
    const wrapper = mount(StateView, {
      props: { state: 'success', title: 'Sent' },
      slots: { actions: '<button>Go</button>' },
    });
    expect(wrapper.text()).toContain('Sent');
    expect(wrapper.text()).toContain('Go');
  });

  it('ready: renders only the default slot', () => {
    const wrapper = mount(StateView, {
      props: { state: 'ready' },
      slots: { default: '<p id="content">content</p>' },
    });
    expect(wrapper.find('#content').exists()).toBe(true);
    expect(wrapper.find('[data-state]').exists()).toBe(false);
  });

  it('does not render the content slot in non-ready states', () => {
    const wrapper = mount(StateView, {
      props: { state: 'empty' },
      slots: { default: '<p id="content">content</p>' },
    });
    expect(wrapper.find('#content').exists()).toBe(false);
  });

  it('allows overriding the copy', () => {
    const wrapper = mount(StateView, {
      props: { state: 'empty', title: "Savat bo'sh", description: 'Add items' },
    });
    expect(wrapper.text()).toContain("Savat bo'sh");
    expect(wrapper.text()).not.toContain(uz.state.empty.title);
  });
});

describe('useAsyncView + StateView', () => {
  function harness(loader: () => Promise<readonly string[]>) {
    return mount(
      defineComponent({
        setup() {
          const view = useAsyncView(loader);
          return () =>
            h(
              StateView,
              { state: view.state.value, onRetry: () => void view.reload() },
              { default: () => h('p', { id: 'ok' }, String(view.data.value)) },
            );
        },
      }),
    );
  }

  it('walks loading -> ready', async () => {
    const wrapper = harness(() => Promise.resolve(['a']));
    expect(wrapper.find('[data-state="loading"]').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('#ok').exists()).toBe(true);
  });

  it('maps an empty list to empty', async () => {
    const wrapper = harness(() => Promise.resolve([]));
    await flushPromises();
    expect(wrapper.find('[data-state="empty"]').exists()).toBe(true);
  });

  it('maps PermissionDeniedError to denied and other errors to error', async () => {
    const denied = harness(() => Promise.reject(new PermissionDeniedError()));
    await flushPromises();
    expect(denied.find('[data-state="denied"]').exists()).toBe(true);

    const failed = harness(() => Promise.reject(new Error('boom')));
    await flushPromises();
    expect(failed.find('[data-state="error"]').exists()).toBe(true);
  });

  it('retry reloads and can recover', async () => {
    let attempt = 0;
    const wrapper = harness(() =>
      ++attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(['a']),
    );
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await nextTick();
    await flushPromises();
    expect(wrapper.find('#ok').exists()).toBe(true);
  });
});
