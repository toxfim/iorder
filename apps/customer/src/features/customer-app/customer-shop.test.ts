import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NetworkError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  bodyText,
  click,
  findButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();

const productId = (code: string): string => fakeUuid(`customer-product:${code}`);
const BASEUS = 'input[aria-label="Baseus 20W zaryadlovchi: miqdor"]';
const query = <T extends Element>(selector: string): T | null =>
  document.body.querySelector<T>(selector);

describe('price list: layout and cart bar', () => {
  it('has no cart bar while the cart is empty, and shows positions and the SERVER total after an add', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    expect(query('aside.bar')).toBeNull();

    await click(query('button[aria-label^="Savatga: Baseus"]') as Element);
    await waitFor(() => expect(query('aside.bar')).not.toBeNull());
    const bar = query<HTMLElement>('aside.bar') as HTMLElement;
    expect(bar.textContent).toContain('1 ta pozitsiya');
    expect(bar.textContent).toContain("89 000 so'm");
    expect(bar.getAttribute('aria-label')).toBe(customerUz.catalog.cartBar.label);
    const link = bar.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/cart');
  });

  it('the bar follows the server total as the quantity changes and disappears when emptied', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    await services.cart.setQuantity(productId('BASEUS-20W'), '3');
    await waitFor(() => expect(query('aside.bar')?.textContent).toContain("267 000 so'm"));
    await services.cart.remove(productId('BASEUS-20W'));
    await waitFor(() => expect(query('aside.bar')).toBeNull());
  });

  it('a product card shows its unit price and unit only', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    const card = Array.from(document.body.querySelectorAll<HTMLElement>('.card')).find((r) =>
      r.textContent?.includes('Baseus'),
    ) as HTMLElement;
    expect(card.querySelector('.card__price')?.textContent?.trim()).toMatch(/so'm$/);
    expect(card.querySelector('.card__meta')?.textContent).toContain('dona');
    // The contract has no line total for the price list: it is not invented here.
    expect(query('.card__total')).toBeNull();
  });

  it('removing from the price list offers undo, and undo puts the same quantity back', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    await services.cart.setQuantity(productId('BASEUS-20W'), '2');
    await waitFor(() => expect(query(BASEUS)).not.toBeNull());
    await click(query('button[aria-label^="Kamaytirish"]') as Element);
    await click(query('button[aria-label^="Kamaytirish"]') as Element);
    await waitFor(() => expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBeNull());
    await click(findButton(customerUz.cart.undo));
    await waitFor(() => expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBe('2'));
  });
});

describe('cart: lines, totals, rollback, undo', () => {
  async function cartWith(
    code: string,
    quantity: string,
    decorate?: Parameters<typeof mountCustomerApp>[2],
  ) {
    const mounted = await mountCustomerApp('fake-owner', '/cart', decorate);
    await mounted.services.cart.setQuantity(productId(code), quantity);
    await waitFor(() => expect(query(BASEUS) ?? query('.line')).not.toBeNull());
    return mounted;
  }

  it('shows each line total and the order total exactly as the server priced them', async () => {
    await cartWith('BASEUS-20W', '2');
    const total = query<HTMLElement>('.line__total') as HTMLElement;
    expect(total.textContent).toContain("178 000 so'm");
    // Screen readers get a label for the bare number.
    expect(total.querySelector('.sr-only')?.textContent).toContain(customerUz.cart.lineTotal);
    expect(query('.summary__total')?.textContent).toContain("178 000 so'm");
    expect(query('.line__each')?.textContent).toBe("89 000 so'm × 2 dona");
    expect(query('.summary')?.getAttribute('aria-label')).toBe(customerUz.cart.summary);
  });

  it('while a quantity change is unsaved the totals are provisional and ordering waits', async () => {
    await cartWith('BASEUS-20W', '2');
    await click(query('button[aria-label^="Ko\'paytirish"]') as Element);
    expect(query('.line__total--stale')).not.toBeNull();
    expect(query('.line__total')?.getAttribute('aria-busy')).toBe('true');
    expect(findButton(customerUz.cart.submit).disabled).toBe(true);
    // After the pause the request is sent, the server answers and everything settles.
    await waitFor(() => expect(query('.line__total')?.textContent).toContain("267 000 so'm"));
    expect(query('.line__total--stale')).toBeNull();
    expect(findButton(customerUz.cart.submit).disabled).toBe(false);
  });

  it('a failed update puts the number back and tells the person', async () => {
    let fail = false;
    const { services } = await cartWith('BASEUS-20W', '2', {
      decorate: (backend) => {
        const original = backend.cartApi.setItem;
        backend.cartApi.setItem = (...args) =>
          fail ? Promise.reject(new NetworkError()) : original(...args);
      },
    });
    fail = true;
    await click(query('button[aria-label^="Ko\'paytirish"]') as Element);
    expect((query(BASEUS) as HTMLInputElement).value).toBe('3');
    await waitFor(() => expect((query(BASEUS) as HTMLInputElement).value).toBe('2'));
    expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBe('2');
    expect(query('.line__total--stale')).toBeNull();
    expect(document.body.querySelector('[role="status"], .toast')).not.toBeNull();
  });

  it('removing a line offers undo; undo restores the same quantity', async () => {
    const { services } = await cartWith('BASEUS-20W', '3');
    await click(findButton(customerUz.cart.remove));
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.empty.title));
    expect(bodyText()).toContain(customerUz.cart.undo);
    await click(findButton(customerUz.cart.undo));
    await waitFor(() => expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBe('3'));
    await waitFor(() => expect(query(BASEUS)).not.toBeNull());
    expect(bodyText()).not.toContain(customerUz.cart.undo);
  });

  it('a line that cannot be ordered gets no undo', async () => {
    await mountCustomerApp('fake-seller', '/cart', { seedProblemCart: true });
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.problem.INACTIVE));
    await click(findButton(customerUz.cart.remove));
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.empty.title));
    expect(bodyText()).not.toContain(customerUz.cart.undo);
  });

  it('keeps the order summary readable: positions, total, and a labelled live region', async () => {
    await cartWith('BASEUS-20W', '1');
    const rows = [...document.body.querySelectorAll('.summary__row dt')].map((d) => d.textContent);
    expect(rows).toEqual([customerUz.cart.positions, customerUz.cart.total]);
    expect(query('[role="status"][aria-live="polite"]')).not.toBeNull();
  });
});

describe('responsive rules (jsdom cannot evaluate media queries, so the source is checked)', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const cart = read('../customer-cart/components/CartPage.vue');
  const catalog = read('../customer-catalog/components/CatalogPage.vue');
  const shell = read('./components/CustomerApp.vue');

  it('has the three layouts: phone first, tablet from 640px, desktop from 960px', () => {
    for (const css of [cart, catalog, shell]) {
      expect(css).toContain('@media (min-width: 640px)');
      expect(css).toContain('@media (min-width: 960px)');
    }
  });

  it('the cart summary is sticky above the menu on phone and tablet, and a right card on desktop', () => {
    expect(cart).toMatch(
      /@media \(max-width: 959px\)[\s\S]*position: sticky;[\s\S]*--customer-bottom-h/,
    );
    expect(cart).toMatch(/grid-template-columns: minmax\(0, 1fr\) 340px/);
  });

  it('keeps the safe-area inset, 44px targets and tabular figures', () => {
    expect(shell).toContain('env(safe-area-inset-bottom');
    expect(catalog).toContain('font-variant-numeric: tabular-nums');
    expect(cart).toContain('font-variant-numeric: tabular-nums');
    expect(read('../customer-cart/components/QuantityStepper.vue')).toContain(
      'height: var(--tap-min)',
    );
  });

  it('search and column heads are sticky on the price list', () => {
    expect(catalog).toMatch(/\.tools \{[^}]*position: sticky/);
  });
});
