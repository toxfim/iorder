import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import { waitFor } from '@core/test-utils/wait';
import {
  bodyText,
  click,
  findButton,
  findModalButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { customerEn } from '@/features/customer-app/messages/en';
import { customerRu } from '@/features/customer-app/messages/ru';
import { customerUz } from '@/features/customer-app/messages/uz';
import choiceSource from './components/PaymentPlanChoice.vue?raw';

// The payment plan must look and behave like a choice (owner, 2026-11-09: "the client does not
// realise that these are buttons"). Nothing is preselected, so the order button first takes the
// person to the choice instead of sitting there disabled.

useCustomerTestLifecycle();
const productId = fakeUuid('customer-product:BASEUS-20W');
const glass = fakeUuid('customer-product:HOCO-GLASS-A15');

const choice = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-testid="payment-plan"]') as HTMLElement;
const radio = (name: 'FULL' | 'DEFERRED'): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(
    `[data-testid="payment-plan-${name}"]`,
  ) as HTMLInputElement;
const card = (name: 'FULL' | 'DEFERRED'): HTMLElement =>
  radio(name).closest('label') as HTMLElement;
const orderButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="cart-order-button"]',
  ) as HTMLButtonElement;

// jsdom has no layout and no scrollIntoView: the call is recorded instead.
const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

async function cartWithoutPlan(
  account = 'fake-owner',
  options: Parameters<typeof mountCustomerApp>[2] = {},
) {
  const submit = vi.fn();
  const app = await mountCustomerApp(account, '/cart', {
    plan: null,
    ...options,
    decorate: (backend) => {
      backend.ordersApi.submit = submit;
    },
  });
  await app.services.cart.setQuantity(productId, '2');
  await waitFor(() => expect(orderButton()).not.toBeNull());
  return { ...app, submit };
}

describe('the plan choice reads as a choice', () => {
  it('asks for a choice in its title, with a "required" mark in words', async () => {
    await cartWithoutPlan();
    const legend = choice().querySelector('legend');
    expect(legend?.textContent).toContain(customerUz.cart.plan.choose);
    expect(choice().querySelector('[data-testid="payment-plan-required"]')?.textContent).toBe(
      customerUz.cart.plan.required,
    );
    // Native "required" on the radios: assistive technology says one of them must be chosen.
    expect(radio('FULL').required).toBe(true);
    expect(radio('DEFERRED').required).toBe(true);
    // The existing rule stays: the warning that the plan changes the price.
    expect(choice().textContent).toContain(customerUz.cart.plan.warning);
  });

  it('each card is one radio with a drawn circle, the plan and its total', async () => {
    await cartWithoutPlan();
    for (const [name, total] of [
      ['FULL', "178 000 so'm"],
      ['DEFERRED', "195 800 so'm"],
    ] as const) {
      expect(radio(name).type).toBe('radio');
      expect(card(name).querySelector('.plan__circle')).not.toBeNull();
      expect(card(name).textContent).toContain(customerUz.plan[name]);
      expect(card(name).textContent).toContain(total);
      expect(card(name).classList.contains('plan__option--on')).toBe(false);
    }
    // One group: the arrow keys move between the two.
    expect(radio('FULL').name).toBe(radio('DEFERRED').name);

    radio('DEFERRED').click();
    await waitFor(() => expect(card('DEFERRED').classList.contains('plan__option--on')).toBe(true));
    expect(card('FULL').classList.contains('plan__option--on')).toBe(false);
    expect(radio('DEFERRED').checked).toBe(true);
  });

  // jsdom cannot lay out or match :hover, so the states are checked in the source.
  it('has a 44px target and hover, pressed, focus and selected states', () => {
    const rule = (selector: string): string =>
      new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(
        choiceSource,
      )?.[1] ?? '';
    expect(rule('.plan__option')).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(rule('.plan__option')).toMatch(/cursor:\s*pointer/);
    // The radio covers the whole card: a tap anywhere on it chooses.
    expect(rule('.plan__input')).toMatch(/inset:\s*0/);
    expect(choiceSource).toMatch(/@media \(hover: hover\) \{\s*\.plan__option[^{]*:hover/);
    expect(choiceSource).toMatch(/\.plan__option:not\(\.plan__option--off\):active/);
    expect(choiceSource).toMatch(/\.plan__option:has\(\.plan__input:focus-visible\)/);
    expect(rule('.plan__option--on')).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--acc\)/);
    // The chosen radio shows a dot: a shape, not only another colour.
    expect(rule('.plan__option--on .plan__circle::after')).toMatch(/scale\(1\)/);
  });

  it('keeps a static ring for "choose here": the emphasis does not depend on the animation', () => {
    const ring = /\n\.plan--attention \{([^}]*)\}/.exec(choiceSource)?.[1] ?? '';
    expect(ring).toMatch(/outline:\s*2px solid var\(--acc\)/);
    expect(ring).not.toMatch(/animation/);
  });
});

describe('the order button without a plan', () => {
  it('reads "To\'lov turini tanlang", is pressable, and takes the person to the choice', async () => {
    const { submit } = await cartWithoutPlan();
    const button = orderButton();
    expect(button.textContent?.trim()).toBe(customerUz.cart.plan.choose);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('data-step')).toBe('choose-plan');
    expect(choice().classList.contains('plan--attention')).toBe(false);

    await click(button);
    // Nothing is submitted and nothing is confirmed.
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The choice is brought into view, the keyboard is on its first option, and it is marked.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(choice());
    expect(document.activeElement).toBe(radio('FULL'));
    expect(radio('FULL').checked).toBe(false);
    expect(choice().classList.contains('plan--attention')).toBe(true);
    expect(choice().classList.contains('plan--nudge-a')).toBe(true);
  });

  it('a second press replays the emphasis and still submits nothing', async () => {
    const { submit } = await cartWithoutPlan();
    await click(orderButton());
    await click(orderButton());
    expect(choice().classList.contains('plan--attention')).toBe(true);
    // Another animation name: the browser plays it again.
    expect(choice().classList.contains('plan--nudge-b')).toBe(true);
    expect(choice().classList.contains('plan--nudge-a')).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });

  it('scrolls without animation when the device asks for reduced motion, smoothly otherwise', async () => {
    await cartWithoutPlan();
    // The test lifecycle answers every media query with "matches".
    await click(orderButton());
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', behavior: 'auto' });

    window.matchMedia = () => ({ matches: false }) as MediaQueryList;
    await click(orderButton());
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('picking a plan drops the ring and turns the button into "Buyurtma berish"', async () => {
    const { submit } = await cartWithoutPlan();
    await click(orderButton());
    radio('FULL').click();
    await waitFor(() => expect(orderButton().textContent?.trim()).toBe(customerUz.cart.submit));
    expect(orderButton().getAttribute('data-step')).toBe('order');
    expect(orderButton().disabled).toBe(false);
    expect(choice().classList.contains('plan--attention')).toBe(false);

    // Now the button does what it says: the confirmation, then one order.
    await click(orderButton());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("178 000 so'm");
    await click(findModalButton(customerUz.cart.confirmAction));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(expect.any(String), {
      paymentPlan: 'FULL',
      expectedTotalAmount: '178000.00',
    });
  });

  it('with a missing deferred price the focus goes to the option that can be chosen', async () => {
    const { services } = await cartWithoutPlan();
    await services.cart.setQuantity(glass, '1');
    await waitFor(() => expect(radio('DEFERRED').disabled).toBe(true));
    expect(card('DEFERRED').classList.contains('plan__option--off')).toBe(true);
    expect(card('DEFERRED').textContent).toContain(customerUz.cart.plan.unavailable);
    expect(document.querySelector('[data-testid="payment-plan-reason"]')?.textContent).toContain(
      'Himoya oynasi (Hoco, A15)',
    );
    // The button still asks for the plan: one option is left to choose.
    expect(orderButton().textContent?.trim()).toBe(customerUz.cart.plan.choose);
    await click(orderButton());
    expect(document.activeElement).toBe(radio('FULL'));
    expect(choice().classList.contains('plan--attention')).toBe(true);
  });

  it('a chosen plan that becomes impossible brings the "choose" button back', async () => {
    const { services } = await cartWithoutPlan();
    radio('DEFERRED').click();
    await waitFor(() => expect(orderButton().textContent?.trim()).toBe(customerUz.cart.submit));
    await services.cart.setQuantity(glass, '1');
    await waitFor(() =>
      expect(orderButton().textContent?.trim()).toBe(customerUz.cart.plan.choose),
    );
    expect(orderButton().disabled).toBe(false);
    expect(document.querySelector('.summary__notes')?.textContent).toContain(
      customerUz.cart.plan.reset,
    );
  });

  it('a problem line still blocks the order for real once the plan is chosen', async () => {
    const app = await mountCustomerApp('fake-seller', '/cart', {
      plan: null,
      seedProblemCart: true,
    });
    await waitFor(() => expect(orderButton()).not.toBeNull());
    // Choosing a plan is still the next step, so the button is pressable.
    expect(orderButton().textContent?.trim()).toBe(customerUz.cart.plan.choose);
    expect(orderButton().disabled).toBe(false);
    await click(orderButton());
    expect(choice().classList.contains('plan--attention')).toBe(true);

    app.services.cart.choosePlan('FULL');
    await waitFor(() => expect(orderButton().textContent?.trim()).toBe(customerUz.cart.submit));
    expect(orderButton().disabled).toBe(true);
    expect(bodyText()).toContain(customerUz.cart.blocked);
  });

  it('no leftover hint line competes with the button', async () => {
    await cartWithoutPlan();
    expect(document.querySelector('[data-testid="plan-hint"]')).toBeNull();
    expect(() => findButton(customerUz.cart.submit)).toThrow();
  });
});

describe('the label of the button on a 320px phone', () => {
  // The sticky summary at 320px: 288px of page, 12px of card padding and 20px of button padding
  // on each side leave 224px for one line of 15px semibold text, about 8.7px per letter at worst
  // (Cyrillic). 24 letters is the most that fits.
  it.each([
    ['uz', customerUz],
    ['ru', customerRu],
    ['en', customerEn],
  ] as const)('fits on one line (%s)', (_lang, catalog) => {
    for (const label of [catalog.cart.plan.choose, catalog.cart.submit, catalog.cart.submitting]) {
      expect(label.length, label).toBeLessThanOrEqual(24);
    }
  });
});
