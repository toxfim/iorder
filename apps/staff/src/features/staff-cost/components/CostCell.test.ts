import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryView } from '../domain/cost-view';
import CostCell from './CostCell.vue';

const RECENT: readonly DeliveryView[] = [
  {
    date: '2026-10-16T09:00:00.000Z',
    ref: 'Z-1',
    supplier: 'Eco',
    usd: '128.5000',
    rate: '12650.0000',
    uzs: '1625525.00',
  },
];

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountCell() {
  const wrapper = mount(CostCell, {
    attachTo: document.body,
    props: {
      usd: '128.5000',
      uzs: '1625525.00',
      rate: '12650.0000',
      recent: RECENT,
      productCode: '10491',
    },
  });
  wrappers.push(wrapper);
  const trigger = wrapper.get<HTMLButtonElement>('.cost__usd').element;
  return { wrapper, trigger };
}

const tip = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="tooltip"]');

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

function pointer(el: Element, type: 'mouseenter' | 'mouseleave'): void {
  el.dispatchEvent(new MouseEvent(type));
}

describe('CostCell tooltip (WCAG 1.4.13)', () => {
  it('stays open while the pointer moves from the trigger onto the tooltip', async () => {
    const { trigger } = mountCell();
    pointer(trigger, 'mouseenter');
    await settle();
    expect(tip()).not.toBeNull();

    pointer(trigger, 'mouseleave');
    await settle(50); // inside the grace period: crossing the gap
    expect(tip()).not.toBeNull();
    pointer(tip() as HTMLElement, 'mouseenter');
    await settle(500);
    expect(tip()).not.toBeNull(); // hoverable: still there long after the trigger was left

    pointer(tip() as HTMLElement, 'mouseleave');
    await settle(300);
    expect(tip()).toBeNull();
  });

  it('closes after the pointer leaves for good, and at once when focus leaves', async () => {
    const { trigger } = mountCell();
    pointer(trigger, 'mouseenter');
    await settle();
    pointer(trigger, 'mouseleave');
    await settle(300);
    expect(tip()).toBeNull();

    trigger.dispatchEvent(new FocusEvent('focus'));
    await settle();
    expect(tip()).not.toBeNull();
    trigger.dispatchEvent(new FocusEvent('blur'));
    await settle();
    expect(tip()).toBeNull();
  });

  it('closes on Escape while the trigger has focus, and stays closed until it is re-entered', async () => {
    const { trigger } = mountCell();
    trigger.dispatchEvent(new FocusEvent('focus'));
    await settle();
    expect(tip()).not.toBeNull();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(tip()).toBeNull();
    trigger.dispatchEvent(new FocusEvent('blur'));
    trigger.dispatchEvent(new FocusEvent('focus'));
    await settle();
    expect(tip()).not.toBeNull();
  });

  it('closes on Escape while the tooltip itself has focus', async () => {
    const { trigger } = mountCell();
    pointer(trigger, 'mouseenter');
    await settle();
    const popup = tip() as HTMLElement;
    popup.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    pointer(trigger, 'mouseleave');
    await settle(500);
    expect(tip()).not.toBeNull(); // the focus inside keeps it open
    popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(tip()).toBeNull();
  });

  it('does not let Escape reach a drawer behind it', async () => {
    const { trigger } = mountCell();
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    trigger.dispatchEvent(new FocusEvent('focus'));
    await settle();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener('keydown', behind);
  });

  it('follows the trigger on scroll and resize, and closes when it scrolls out of view', async () => {
    const { trigger } = mountCell();
    let top = 100;
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(
      () => ({ top, bottom: top + 20, right: 500, left: 400, width: 100, height: 20 }) as DOMRect,
    );
    trigger.dispatchEvent(new FocusEvent('focus'));
    await settle();
    expect(tip()?.style.top).toBe('128px');

    top = 140;
    window.dispatchEvent(new Event('scroll'));
    await settle();
    expect(tip()?.style.top).toBe('168px');
    top = 180;
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(tip()?.style.top).toBe('208px');

    top = -200;
    window.dispatchEvent(new Event('scroll'));
    await settle();
    expect(tip()).toBeNull();
  });

  it("shows the so'm derived from the dollar cost in whole so'm", () => {
    const wrapper = mount(CostCell, {
      props: {
        usd: '128.5000',
        uzs: '1625525.50',
        rate: '12650.0000',
        recent: RECENT,
        productCode: '10491',
      },
    });
    expect(wrapper.get('.cost__uzs').text().replace(/\s/g, ' ')).toBe("1 625 526 so'm");
  });

  it('has no tooltip at all without deliveries', async () => {
    const wrapper = mount(CostCell, {
      attachTo: document.body,
      props: { usd: null, uzs: null, rate: null, recent: [], productCode: '10499' },
    });
    wrappers.push(wrapper);
    expect(wrapper.find('.cost__usd').exists()).toBe(false);
    expect(tip()).toBeNull();
  });
});

describe('CostCell rate caption (F-14)', () => {
  it("names the delivery's own rate next to the so'm cost, so it is not read against the header rate", () => {
    const { wrapper } = mountCell();
    const caption = wrapper.get('[data-testid="cost-rate"]');
    expect(caption.text()).toBe('12 650 kursida');
    expect(caption.attributes('title')).toContain('Postavka sanasidagi kurs');
  });

  it('takes the caption rate from the latest delivery, not from the tooltip list', () => {
    const wrapper = mount(CostCell, {
      attachTo: document.body,
      props: {
        usd: '128.5000',
        uzs: '1625525.00',
        rate: '12650.0000',
        recent: [{ ...RECENT[0]!, rate: '11111.0000' }],
        productCode: '10491',
      },
    });
    wrappers.push(wrapper);
    expect(wrapper.get('[data-testid="cost-rate"]').text()).toBe('12 650 kursida');
  });

  it('shows no caption without a delivery', () => {
    const wrapper = mount(CostCell, {
      attachTo: document.body,
      props: { usd: null, uzs: null, rate: null, recent: [], productCode: '10491' },
    });
    wrappers.push(wrapper);
    expect(wrapper.find('[data-testid="cost-rate"]').exists()).toBe(false);
  });
});
