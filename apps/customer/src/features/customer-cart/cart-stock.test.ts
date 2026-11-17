import { describe, expect, it, vi } from 'vitest';
import { coreUz } from '@core/i18n/messages/uz';
import { fakeUuid } from '@core/lib/fake-ids';
import { waitFor } from '@core/test-utils/wait';
import {
  bodyText,
  click,
  confirmCartSubmission,
  findButton,
  mountCustomerApp,
  typeInto,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { customerUz } from '@/features/customer-app/messages/uz';
import cartSource from './components/CartPage.vue?raw';

// The cart and the stock (owner decision 2026-11-09): a line shows how many can be ordered, the
// quantity cannot go above it, and a line that ended up above it (the stock fell) says what to do
// and offers one tap that does it. The order waits until then.

useCustomerTestLifecycle();

const BASEUS = fakeUuid('customer-product:BASEUS-20W'); // 45 in stock
const UGREEN = fakeUuid('customer-product:UGREEN-65W-GAN'); // no figure

const lineOf = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.line')].find((line) =>
    (line.querySelector('.line__name')?.textContent ?? '').includes(name),
  );
  if (!found) throw new Error(`No cart line for ${name}`);
  return found;
};
const part = (name: string, testId: string): HTMLElement | null =>
  lineOf(name).querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const field = (name: string): HTMLInputElement =>
  lineOf(name).querySelector<HTMLInputElement>('.stepper__input') as HTMLInputElement;
const orderButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="cart-order-button"]',
  ) as HTMLButtonElement;

async function cartWith(lines: [productId: string, quantity: string][]) {
  const app = await mountCustomerApp('fake-owner', '/cart');
  for (const [productId, quantity] of lines)
    await app.services.cart.setQuantity(productId, quantity);
  await waitFor(() => expect(document.querySelectorAll('.line')).toHaveLength(lines.length));
  return app;
}

describe('cart: the stock figure of a line', () => {
  it('shows "N dona bor" on a line with a figure and nothing on a line without', async () => {
    await cartWith([
      [BASEUS, '2'],
      [UGREEN, '700'],
    ]);
    expect(part('Baseus 20W', 'line-stock')?.textContent?.trim()).toBe('45 dona bor');
    expect(part('Ugreen 65W', 'line-stock')).toBeNull();
    // No figure, no limit: 700 pieces are fine and the order can be placed.
    expect(part('Ugreen 65W', 'line-over-stock')).toBeNull();
    expect(orderButton().disabled).toBe(false);
  });

  it('the field stops at the figure: a larger entry becomes the figure and says why', async () => {
    const { services } = await cartWith([[BASEUS, '2']]);
    await typeInto(field('Baseus 20W'), '100');
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBe('45'));
    expect(field('Baseus 20W').value).toBe('45');
    expect(part('Baseus 20W', 'stepper-limit')?.textContent?.trim()).toBe(
      'Omborda faqat 45 dona bor',
    );
    expect(orderButton().disabled).toBe(false);
  });
});

describe('cart: a change the server refuses', () => {
  it('rolls the field back, says the server`s current figure and refreshes the line', async () => {
    const { backend, services } = await cartWith([[BASEUS, '10']]);
    // The stock fell after the cart was shown: the screen still believes in 45.
    backend.setStock('BASEUS-20W', 12);
    await typeInto(field('Baseus 20W'), '20');

    // The toast names the figure the SERVER has now, not the stale one on screen.
    const refused = coreUz.apiErrors.stockLimitExceededOne.replace('{count}', '12');
    await waitFor(() => expect(bodyText()).toContain(refused));
    // Nothing changed in the cart, and the field shows what the cart really holds.
    expect(services.cart.quantityOf(BASEUS)).toBe('10');
    await waitFor(() => expect(field('Baseus 20W').value).toBe('10'));
    // The cart was read again, so the line now shows the fresh figure and limits to it.
    await waitFor(() =>
      expect(part('Baseus 20W', 'line-stock')?.textContent?.trim()).toBe('12 dona bor'),
    );
    await typeInto(field('Baseus 20W'), '20');
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBe('12'));
  });
});

describe('cart: the stock fell below a line', () => {
  async function fallen() {
    const app = await cartWith([
      [BASEUS, '10'],
      [UGREEN, '3'],
    ]);
    app.backend.setStock('BASEUS-20W', 4);
    await app.services.cart.load();
    await waitFor(() => expect(part('Baseus 20W', 'line-over-stock')).not.toBeNull());
    return app;
  }

  it('says how many are left and what to do, keeps the price, the stepper and the other lines', async () => {
    await fallen();
    const problem = part('Baseus 20W', 'line-over-stock') as HTMLElement;
    expect(problem.getAttribute('role')).toBe('alert');
    expect(problem.textContent).toContain('Omborda faqat 4 dona qoldi. Miqdorni kamaytiring.');
    const fix = part('Baseus 20W', 'line-set-to-stock') as HTMLButtonElement;
    expect(fix.textContent?.trim()).toBe('4 dona qoldirish');
    expect(fix.getAttribute('aria-label')).toBe('Baseus 20W zaryadlovchi: 4 dona qoldirish');
    // The plain "N in stock" line is not repeated next to the warning.
    expect(part('Baseus 20W', 'line-stock')).toBeNull();
    // The product can still be ordered: its stepper and its amount stay.
    expect(field('Baseus 20W').value).toBe('10');
    expect(lineOf('Baseus 20W').querySelector('.line__total')?.textContent).toContain('890 000');
    // The other line is untouched.
    expect(part('Ugreen 65W', 'line-over-stock')).toBeNull();
    expect(lineOf('Ugreen 65W').querySelector('.line__problem')).toBeNull();
  });

  it('blocks the order and says why in the summary, with the way out', async () => {
    await fallen();
    expect(orderButton().disabled).toBe(true);
    const notes = document.querySelector('.summary__notes-text')?.textContent ?? '';
    expect(notes).toContain(customerUz.cart.stockBlocked);
    // Not the text about products that cannot be ordered at all: nothing has to be removed.
    expect(notes).not.toContain(customerUz.cart.blocked);
  });

  it('"set to N" lowers the quantity in one tap and the order can be placed again', async () => {
    const { services } = await fallen();
    await click(part('Baseus 20W', 'line-set-to-stock') as HTMLButtonElement);
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBe('4'));
    await waitFor(() => expect(part('Baseus 20W', 'line-over-stock')).toBeNull());
    expect(field('Baseus 20W').value).toBe('4');
    expect(part('Baseus 20W', 'line-stock')?.textContent?.trim()).toBe('4 dona bor');
    expect(document.querySelector('.summary__notes')).toBeNull();
    expect(orderButton().disabled).toBe(false);
  });

  it('minus on such a line goes straight to what can be ordered', async () => {
    const { services } = await fallen();
    const [minus] = [...lineOf('Baseus 20W').querySelectorAll<HTMLButtonElement>('.stepper__btn')];
    await click(minus as HTMLButtonElement);
    expect(field('Baseus 20W').value).toBe('4');
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBe('4'));
    await waitFor(() => expect(orderButton().disabled).toBe(false));
  });

  it('a removed line that was above the stock comes back at the stock', async () => {
    const { services } = await fallen();
    await click(lineOf('Baseus 20W').querySelector('.line__remove') as HTMLButtonElement);
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBeNull());
    await click(findButton(customerUz.cart.undo));
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBe('4'));
  });
});

describe('cart: the stock ran out under a line', () => {
  async function gone() {
    const app = await cartWith([
      [BASEUS, '3'],
      [UGREEN, '2'],
    ]);
    app.backend.setStock('BASEUS-20W', 0);
    await app.services.cart.load();
    await waitFor(() => expect(part('Baseus 20W', 'line-over-stock')).not.toBeNull());
    return app;
  }

  it('says that nothing is left and offers to remove the line; no stepper, no "set to 0"', async () => {
    await gone();
    const problem = part('Baseus 20W', 'line-over-stock') as HTMLElement;
    expect(problem.textContent).toContain(customerUz.cart.stockGone);
    expect(problem.textContent).not.toMatch(/\b0 dona/);
    expect(part('Baseus 20W', 'line-set-to-stock')).toBeNull();
    const remove = part('Baseus 20W', 'line-remove-gone') as HTMLButtonElement;
    expect(remove.textContent?.trim()).toBe(customerUz.cart.remove);
    expect(lineOf('Baseus 20W').querySelector('.stepper')).toBeNull();
    // The price stays: it is still a priced product, only nothing is left of it.
    expect(lineOf('Baseus 20W').querySelector('.line__total')?.textContent).toContain('267 000');
    expect(orderButton().disabled).toBe(true);
    expect(document.querySelector('.summary__notes-text')?.textContent).toContain(
      customerUz.cart.stockBlocked,
    );
  });

  it('removing it frees the order, and there is no undo back to a quantity that cannot be ordered', async () => {
    const { services } = await gone();
    await click(part('Baseus 20W', 'line-remove-gone') as HTMLButtonElement);
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBeNull());
    await waitFor(() => expect(orderButton().disabled).toBe(false));
    expect(bodyText()).not.toContain(customerUz.cart.undo);
  });

  it('a product that is out of stock cannot be added: the refusal says so in words', async () => {
    const { backend, services } = await cartWith([[BASEUS, '2']]);
    backend.setStock('BASEUS-20W', 0);
    await typeInto(field('Baseus 20W'), '3');
    await waitFor(() => expect(bodyText()).toContain(coreUz.apiErrors.stockLimitExceededNone));
    expect(services.cart.quantityOf(BASEUS)).toBe('2');
  });
});

describe('cart: the server refuses the order because the stock fell', () => {
  it('places no order, marks the line and offers the fix; no second, repeated sentence', async () => {
    const submit = vi.fn();
    const { backend, services, router } = await mountCustomerApp('fake-owner', '/cart', {
      decorate: (fake) => {
        const original = fake.ordersApi.submit;
        fake.ordersApi.submit = (key, request) => {
          submit(key, request);
          return original(key, request);
        };
      },
    });
    await services.cart.setQuantity(BASEUS, '10');
    await waitFor(() => expect(document.querySelectorAll('.line')).toHaveLength(1));
    // The cart on screen is fine; the stock falls before the person confirms.
    backend.setStock('BASEUS-20W', 4);
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();

    await waitFor(() => expect(part('Baseus 20W', 'line-over-stock')).not.toBeNull());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.name).toBe('customer-cart');
    expect(services.cart.quantityOf(BASEUS)).toBe('10');
    const notes = document.querySelector('.summary__notes-text')?.textContent ?? '';
    expect(notes).toContain(customerUz.cart.stockBlocked);
    expect(notes).not.toContain(coreUz.apiErrors.stockLimitExceeded);
    expect(orderButton().disabled).toBe(true);

    // After the fix the same person orders what is left.
    await click(part('Baseus 20W', 'line-set-to-stock') as HTMLButtonElement);
    await waitFor(() => expect(orderButton().disabled).toBe(false));
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(router.currentRoute.value.name).toBe('customer-placed'));
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

// jsdom has no layout, so this reads the source.
describe('cart: the over-stock warning layout', () => {
  it('keeps the sentence and its button on one row, wrapping (not squeezing) on a narrow phone', () => {
    const block = /\.line__problem--stock \{([^}]*)\}/.exec(cartSource)?.[1] ?? '';
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    expect(block).toMatch(/align-items:\s*center/);
    const text = /\.line__problem-text \{([^}]*)\}/.exec(cartSource)?.[1] ?? '';
    expect(text).toMatch(/flex:\s*1 1 180px/);
    expect(/\.line__fix \{([^}]*)\}/.exec(cartSource)?.[1] ?? '').toMatch(/flex:\s*none/);
  });
});
