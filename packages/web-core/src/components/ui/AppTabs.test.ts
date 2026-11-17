import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import AppTabs from './AppTabs.vue';

const TABS = [
  { id: 'all', label: 'Hammasi', count: 9 },
  { id: 'phones', label: 'Telefonlar', count: 4 },
  { id: 'tv', label: 'Televizorlar', count: 0 },
];

function mountTabs(initial = 'all') {
  const selected = ref(initial);
  const wrapper = mount(
    {
      components: { AppTabs },
      setup: () => ({ selected, tabs: TABS }),
      template: `<div>
        <AppTabs v-model="selected" :tabs="tabs" label="Kategoriya" id-prefix="cat" panel-id="cat-panel" />
        <div id="cat-panel" role="tabpanel" :aria-labelledby="'cat-tab-' + selected"></div>
      </div>`,
    },
    { attachTo: document.body },
  );
  return { wrapper, selected };
}

describe('AppTabs', () => {
  it('exposes the ARIA tabs pattern: tablist, tabs with counts, one selected', () => {
    const { wrapper } = mountTabs();
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('Kategoriya');
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text())).toEqual(['Hammasi9', 'Telefonlar4', 'Televizorlar0']);
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.every((tab) => tab.attributes('aria-controls') === 'cat-panel')).toBe(true);
    // Roving tabindex: only the selected tab is reachable with Tab.
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    wrapper.unmount();
  });

  it('selects on click', async () => {
    const { wrapper, selected } = mountTabs();
    await wrapper.findAll('[role="tab"]')[1]?.trigger('click');
    expect(selected.value).toBe('phones');
    expect(wrapper.get('#cat-panel').attributes('aria-labelledby')).toBe('cat-tab-phones');
    wrapper.unmount();
  });

  it('moves with the arrow keys (wrapping), Home and End, and moves focus along', async () => {
    const { wrapper, selected } = mountTabs();
    const list = wrapper.get('[role="tablist"]');
    await list.trigger('keydown', { key: 'ArrowRight' });
    expect(selected.value).toBe('phones');
    expect(document.activeElement?.id).toBe('cat-tab-phones');
    await list.trigger('keydown', { key: 'End' });
    expect(selected.value).toBe('tv');
    await list.trigger('keydown', { key: 'ArrowRight' });
    expect(selected.value).toBe('all');
    await list.trigger('keydown', { key: 'ArrowLeft' });
    expect(selected.value).toBe('tv');
    await list.trigger('keydown', { key: 'Home' });
    expect(selected.value).toBe('all');
    await list.trigger('keydown', { key: 'a' });
    expect(selected.value).toBe('all');
    wrapper.unmount();
  });

  it('selects the first tab and keeps it focusable when the value matches no tab', async () => {
    const { wrapper, selected } = mountTabs('removed-category');
    await wrapper.vm.$nextTick();
    expect(selected.value).toBe('all');
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    wrapper.unmount();
  });

  it('keeps the first tab in the tab order and lets the arrows start from the ends', async () => {
    const wrapper = mount(AppTabs, {
      attachTo: document.body,
      props: { modelValue: 'gone', tabs: TABS, label: 'K', idPrefix: 'x', panelId: 'p' },
    });
    // The owner ignores the fallback event here, so the value stays unknown.
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['all']);
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.attributes('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ]);
    await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['tv']);
    wrapper.unmount();
  });

  it('does not emit a fallback while the tab list is empty (still loading)', () => {
    const wrapper = mount(AppTabs, {
      props: { modelValue: 'all', tabs: [], label: 'K', idPrefix: 'x', panelId: 'p' },
    });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
