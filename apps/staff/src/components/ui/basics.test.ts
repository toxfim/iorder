import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppCard from './AppCard.vue';
import AppCardRow from './AppCardRow.vue';
import AppIcon from '@core/components/ui/AppIcon.vue';

describe('AppButton', () => {
  it('defaults to a non-submitting primary md button', () => {
    const wrapper = mount(AppButton, { slots: { default: 'Go' } });
    expect(wrapper.attributes('type')).toBe('button');
    expect(wrapper.classes()).toContain('btn--primary');
    expect(wrapper.classes()).toContain('btn--md');
  });

  it('maps variant and size to classes', () => {
    const wrapper = mount(AppButton, { props: { variant: 'danger', size: 'xl' } });
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['btn--danger', 'btn--xl']));
  });

  it('does not emit click while disabled or loading', async () => {
    const disabled = mount(AppButton, { props: { disabled: true } });
    await disabled.trigger('click');
    expect(disabled.emitted('click')).toBeUndefined();

    const loading = mount(AppButton, { props: { loading: true } });
    expect(loading.attributes('disabled')).toBeDefined();
    expect(loading.attributes('aria-busy')).toBe('true');
  });
});

describe('AppBadge', () => {
  it('renders tone and shape classes', () => {
    const wrapper = mount(AppBadge, {
      props: { tone: 'success', shape: 'count' },
      slots: { default: '3' },
    });
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['badge--success', 'badge--count']));
    expect(wrapper.text()).toBe('3');
  });
});

describe('AppCard', () => {
  it('wraps rows in the hairline card under its header', () => {
    const wrapper = mount(AppCard, {
      props: { title: 'Orders', subtitle: 'Today' },
      slots: { default: '<div class="r">1</div><div class="r">2</div>' },
    });
    expect(wrapper.get('h3').text()).toBe('Orders');
    expect(wrapper.get('.card__subtitle').text()).toBe('Today');
    expect(wrapper.findAll('.card__rows .r')).toHaveLength(2);
    expect(wrapper.classes()).toContain('card--default');
  });

  it('renders the actions slot in the header, and no header without title or actions', () => {
    const withActions = mount(AppCard, { slots: { actions: '<button>All</button>' } });
    expect(withActions.get('.card__actions').text()).toBe('All');
    expect(mount(AppCard).find('.card__head').exists()).toBe(false);
  });

  it('supports the sand tone', () => {
    expect(mount(AppCard, { props: { tone: 'sand' } }).classes()).toContain('card--sand');
  });
});

describe('AppCardRow', () => {
  it('caps the stagger delay at 12 rows x 25ms', () => {
    const delay = (index: number): string | undefined =>
      mount(AppCardRow, { props: { index } }).element.getAttribute('style') ?? undefined;
    expect(delay(0)).toContain('animation-delay: 0ms');
    expect(delay(4)).toContain('animation-delay: 100ms');
    expect(delay(12)).toContain('animation-delay: 300ms');
    expect(delay(40)).toContain('animation-delay: 300ms');
  });

  it('has no delay without an index', () => {
    expect(mount(AppCardRow).element.getAttribute('style')).toBeNull();
  });
});

describe('AppIcon', () => {
  it('draws the named icon as a decorative svg', () => {
    const wrapper = mount(AppIcon, { props: { name: 'inbox' } });
    expect(wrapper.element.tagName.toLowerCase()).toBe('svg');
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.findAll('rect, path')).toHaveLength(2);
    expect(wrapper.attributes('viewBox')).toBe('0 0 24 24');
  });

  it('uses the icon own viewBox (the v1 chevron is drawn in a 12x12 box)', () => {
    const wrapper = mount(AppIcon, { props: { name: 'chevron', size: 12 } });
    expect(wrapper.attributes('viewBox')).toBe('0 0 12 12');
  });

  it('draws with currentColor and a 1.6-2px stroke by default', () => {
    const wrapper = mount(AppIcon, { props: { name: 'check' } });
    expect(wrapper.attributes('stroke')).toBe('currentColor');
    expect(Number(wrapper.attributes('stroke-width'))).toBeGreaterThanOrEqual(1.6);
    expect(Number(wrapper.attributes('stroke-width'))).toBeLessThanOrEqual(2);
  });
});
