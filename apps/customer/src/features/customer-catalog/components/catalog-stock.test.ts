import { describe, expect, it, vi } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import { waitFor } from '@core/test-utils/wait';
import {
  bodyText,
  click,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { customerEn } from '@/features/customer-app/messages/en';
import { customerRu } from '@/features/customer-app/messages/ru';
import { customerUz } from '@/features/customer-app/messages/uz';
import { coreUz } from '@core/i18n/messages/uz';
import { outOfStockLast } from '../domain/category-groups';
import source from './CatalogPage.vue?raw';

// The price list shows how many pieces can be ordered (owner decision 2026-11-09), only where the
// server gives a figure. A product without one shows nothing and looks like any other product.

useCustomerTestLifecycle();

const id = (code: string): string => fakeUuid(`customer-product:${code}`);
const BASEUS = id('BASEUS-20W'); // 45 in stock
const TECNO = id('TECNO-SPARK20-128'); // 12 in stock

const cardOf = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.card')].find((card) =>
    (card.querySelector('.card__name')?.textContent ?? '').includes(name),
  );
  if (!found) throw new Error(`No card for ${name}`);
  return found;
};
const stockText = (name: string): string | null =>
  cardOf(name).querySelector('[data-testid="card-stock"]')?.textContent?.trim() ?? null;
const cards = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelectorAll('.card').length).toBeGreaterThan(0));
};

describe('customer price list: the stock figure', () => {
  it('shows "N dona bor" on a product with a figure and nothing on one without', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await cards();
    expect(stockText('Baseus 20W')).toBe('45 dona bor');
    expect(stockText('Tecno Spark 20')).toBe('12 dona bor');
    expect(stockText('Hoco USB-C')).toBe('300 dona bor');
    // No figure: no element at all, not an empty line, a dash or a "0".
    for (const name of ['Ugreen 65W', 'Borofone BW05', 'Himoya oynasi']) {
      expect(stockText(name), name).toBeNull();
    }
    // Out of stock is said in words, never as "0 dona bor".
    expect(stockText('Tecno Pop 8')).toBe(customerUz.stock.out);
  });

  it('an out-of-stock product stays visible, toned down, with its add control off and the reason', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices');
    await cards();
    const card = cardOf('Tecno Pop 8');
    expect(card.classList.contains('card--out')).toBe(true);
    const add = card.querySelector<HTMLButtonElement>('.card__action button') as HTMLButtonElement;
    // Off, but not dead: it stays focusable and a press says why instead of doing nothing.
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.disabled).toBe(false);
    expect(add.textContent).toContain(customerUz.catalog.add);
    await click(add);
    expect(bodyText()).toContain(coreUz.apiErrors.stockLimitExceededNone);
    expect(services.cart.quantityOf(id('TECNO-POP8-64'))).toBeNull();
    // The reason is the stock line right above, and the control points at it.
    const reason = card.querySelector('[data-testid="card-stock"]') as HTMLElement;
    expect(reason.textContent?.trim()).toBe('Qolmagan');
    expect(reason.id).not.toBe('');
    expect(add.getAttribute('aria-describedby')).toBe(reason.id);
    // The others are untouched, and a product without a figure is NOT shown as out of stock.
    expect(cardOf('Baseus 20W').classList.contains('card--out')).toBe(false);
    expect(cardOf('Ugreen 65W').classList.contains('card--out')).toBe(false);
    expect(
      cardOf('Ugreen 65W').querySelector('.card__action button')?.getAttribute('aria-disabled'),
    ).toBeNull();
    expect(cardOf('Ugreen 65W').textContent).not.toContain(customerUz.stock.out);
  });

  it('sorts out-of-stock products after the others within their category, keeping the order otherwise', async () => {
    const item = (code: string, orderableStock: number | null, category = 'A') => ({
      code,
      orderableStock,
      category,
    });
    const items = [item('gone-1', 0), item('plenty', 45), item('unknown', null), item('gone-2', 0)];
    expect(outOfStockLast(items).map((i) => i.code)).toEqual([
      'plenty',
      'unknown',
      'gone-1',
      'gone-2',
    ]);
    // On the page: the smartphone group lists the out-of-stock Tecno after the one in stock.
    await mountCustomerApp('fake-owner', '/prices');
    await cards();
    const names = [...document.querySelectorAll('.card__name')].map((n) => n.textContent ?? '');
    expect(names.indexOf('Tecno Pop 8 64GB')).toBeGreaterThan(
      names.indexOf('Tecno Spark 20 128GB'),
    );
  });

  it('an out-of-stock product that sits in the cart keeps its stepper: minus removes, plus explains', async () => {
    const { backend, services } = await mountCustomerApp('fake-owner', '/prices');
    await cards();
    await services.cart.setQuantity(BASEUS, '2');
    backend.setStock('BASEUS-20W', 0);
    await services.cart.load();
    await waitFor(() => expect(stockText('Baseus 20W')).toBe(customerUz.stock.out));
    const card = cardOf('Baseus 20W');
    const [minus, plus] = [...card.querySelectorAll<HTMLButtonElement>('.stepper__btn')];
    await click(plus as HTMLButtonElement);
    expect(card.querySelector('[data-testid="stepper-limit"]')?.textContent?.trim()).toBe(
      customerUz.quantity.none,
    );
    expect(services.cart.quantityOf(BASEUS)).toBe('2');
    await click(minus as HTMLButtonElement);
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBeNull());
  });

  it('a product without a figure looks like any other: same parts, nothing that names a type', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await cards();
    const parts = (name: string): string[] =>
      [...cardOf(name).children]
        .map((child) => child.className.split(' ')[0] ?? '')
        .filter((part) => part !== 'card__stock');
    // Both without a photo, so the only difference could be the stock line.
    expect(parts('Himoya oynasi')).toEqual(parts('Borofone BW05'));
    const withFigure = [...cardOf('Baseus 20W').children].map((c) => c.className.split(' ')[0]);
    expect(withFigure.filter((part) => part === 'card__stock')).toHaveLength(1);
    expect(cardOf('Ugreen 65W').textContent).not.toMatch(/bor|ombor|buyurtma/i);
  });

  it('the stock line sits between the price and the control, so the buttons stay on one line', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await cards();
    const order = [...cardOf('Baseus 20W').children].map((c) => c.className.split(' ')[0]);
    expect(order.slice(-3)).toEqual(['card__price', 'card__stock', 'card__action']);
    // jsdom has no layout: the control is pinned to the card's bottom in the source.
    const action = /\.card__action \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(action).toMatch(/margin-top:\s*auto/);
  });

  it('says it in all three languages, with the unit of the product', () => {
    expect(customerUz.stock.available).toBe('{count} {unit} bor');
    for (const catalog of [customerUz, customerRu, customerEn]) {
      for (const text of [
        catalog.stock.available,
        catalog.quantity.limit,
        catalog.cart.problem.STOCK_EXCEEDED,
        catalog.cart.setToStock,
      ]) {
        expect(text).toContain('{count}');
        expect(text).toContain('{unit}');
      }
      // Out of stock is a sentence of its own, never "0 pieces in stock".
      for (const text of [catalog.stock.out, catalog.quantity.none, catalog.cart.stockGone]) {
        expect(text).not.toContain('{count}');
        expect(text).not.toMatch(/\b0\b/);
      }
    }
  });

  it('a product in the cart takes the fresher figure of the cart', async () => {
    const { backend, services } = await mountCustomerApp('fake-owner', '/prices');
    await cards();
    // The stock moves after the list was loaded; the next cart answer knows.
    backend.setStock('BASEUS-20W', 30);
    await services.cart.setQuantity(BASEUS, '2');
    await waitFor(() => expect(stockText('Baseus 20W')).toBe('30 dona bor'));
    // The stock becomes unknown: no figure, no line, no limit.
    backend.setStock('BASEUS-20W', null);
    await services.cart.setQuantity(BASEUS, '3');
    await waitFor(() => expect(stockText('Baseus 20W')).toBeNull());
  });

  it('the stepper of a card stops at the figure and says why; nothing is sent', async () => {
    const setItem = vi.fn();
    const { services } = await mountCustomerApp('fake-owner', '/prices', {
      decorate: (backend) => {
        const original = backend.cartApi.setItem;
        backend.cartApi.setItem = (productId, request) => {
          setItem(productId, request);
          return original(productId, request);
        };
      },
    });
    await cards();
    await services.cart.setQuantity(TECNO, '12');
    await waitFor(() => expect(cardOf('Tecno Spark 20').querySelector('.stepper')).not.toBeNull());
    setItem.mockClear();

    const card = cardOf('Tecno Spark 20');
    const [, plus] = [...card.querySelectorAll<HTMLButtonElement>('.stepper__btn')];
    expect(plus?.getAttribute('aria-disabled')).toBe('true');
    expect(plus?.disabled).toBe(false);
    await click(plus as HTMLButtonElement);
    expect(card.querySelector<HTMLInputElement>('.stepper__input')?.value).toBe('12');
    expect(card.querySelector('[data-testid="stepper-limit"]')?.textContent?.trim()).toBe(
      'Omborda faqat 12 dona bor',
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it('the first piece of a product with a figure goes into the cart as before', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/prices');
    await cards();
    const add = [...cardOf('Baseus 20W').querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes(customerUz.catalog.add),
    );
    await click(add as HTMLButtonElement);
    await waitFor(() => expect(services.cart.quantityOf(BASEUS)).toBe('1'));
  });
});
