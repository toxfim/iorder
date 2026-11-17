import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import OrderJourney from './OrderJourney.vue';

describe('decorative order journey', () => {
  it('does not become a second order form or announce its loop to a screen reader', async () => {
    const wrapper = mount(OrderJourney);
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.text()).not.toContain('signIn.');
    expect(wrapper.findAll('button, input, form, a, [tabindex]').length).toBe(0);
    await wrapper.get('.journey-submit').trigger('click');
    expect(wrapper.emitted('submit')).toBeUndefined();
    wrapper.unmount();
  });
  it('only runs when motion is allowed and keeps playing while the person signs in', () => {
    const css = readFileSync('src/components/auth/order-journey.css', 'utf8');
    expect(css).toContain('(prefers-reduced-motion: no-preference)');
    expect(css).not.toContain('.auth-page:focus-within');
    expect(css).not.toContain('animation-play-state: paused');
    const keyframes = css.split('@keyframes').slice(1).join('\n');
    expect(keyframes).not.toMatch(/(?:^|\n)\s*(?:width|height|left|top)\s*:/);
  });
  it('shares one continuous scene and keeps every brand reference local to this instance', () => {
    const wrapper = mount({
      components: { OrderJourney },
      template: '<OrderJourney /><OrderJourney />',
    });
    const [first, second] = wrapper.findAllComponents(OrderJourney);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error('Expected two journey instances');
    expect(first.findAll('svg')).toHaveLength(1);
    for (const part of ['phone', 'item', 'box', 'truck', 'shutter', 'done']) {
      expect(first.find(`.delivery-${part}`).exists()).toBe(true);
    }
    const firstMark = first.get('defs g').attributes('id');
    const secondMark = second.get('defs g').attributes('id');
    expect(firstMark).not.toBe(secondMark);
    expect(first.get('use').attributes('href')).toBe(`#${firstMark}`);
    expect(first.get('.delivery-caption').text()).toBe('Buyurtmangiz qabul qilindi');
    expect(first.get('.delivery-logo').attributes('href')).toBe('/header-dark.png');
    wrapper.unmount();
  });
});
