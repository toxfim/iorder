import type {
  CustomerHomeRecommendationsResponse,
  CustomerMatchingItem,
  CustomerRecommendationItem,
} from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { coreUz } from '@core/i18n/messages/uz';
import { fakeUuid } from '@core/lib/fake-ids';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from '@/features/customer-app/messages/uz';
import {
  bodyText,
  click,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';

// The customer home of design "2a" (owner 2026-11-09) over the fake backend: the three blocks with
// data, the first-visit home, the add-to-cart from a recommendation under the stock cap, the error
// state, and the one price component every amount goes through.

useCustomerTestLifecycle();
const HOME = customerUz.home;

const id = (code: string): string => fakeUuid(`customer-product:${code}`);
const byTestId = <T extends Element = HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);
const allByTestId = (testId: string): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>(`[data-testid="${testId}"]`),
];
const recsReady = () =>
  waitFor(() => expect(byTestId('home-recommendations')?.dataset.state).toBe('ready'));

type Backend = Awaited<ReturnType<typeof mountCustomerApp>>['backend'];

/** The server's answer replaced by a hand-made one (the fake's shape is kept by the schema). */
const answering =
  (make: (real: CustomerHomeRecommendationsResponse) => CustomerHomeRecommendationsResponse) =>
  (backend: Backend): void => {
    const original = backend.homeApi.getRecommendations;
    backend.homeApi.getRecommendations = async () => make(await original());
  };

const card = (code: string, name: string, stock: number | null): CustomerRecommendationItem => ({
  productId: id(code),
  productCode: code,
  unit: 'dona',
  name,
  price: '100000.00',
  deferredPrice: null,
  rrp: null,
  orderableStock: stock,
  currency: 'UZS',
  imageUrl: null,
  imageLargeUrl: null,
});
const matching = (code: string, name: string, stock: number | null): CustomerMatchingItem => ({
  ...card(code, name, stock),
  boughtProductName: 'Baseus 20W zaryadlovchi',
});

describe('home: the recommendation blocks with data', () => {
  it('shows the confirmed newer model as the hero, with why, and the reorder row with the usual quantity', async () => {
    await mountCustomerApp('fake-owner', '/');
    await recsReady();
    const hero = byTestId('home-hero');
    expect(hero?.dataset.kind).toBe('newer');
    expect(hero?.textContent).toContain(HOME.hero.newModel);
    expect(hero?.textContent).toContain('Ugreen 65W GaN adapter');
    expect(byTestId('home-hero-why')?.textContent?.trim()).toBe(
      'Baseus 20W zaryadlovchi ni buyurtma qilgansiz. Uning yangi avlodi omborga keldi.',
    );
    // The hero and the reorder list share one row block (two columns on a desktop).
    expect(document.querySelector('.row-hero .hero-card')).not.toBeNull();
    expect(document.querySelector('.row-hero .reorder')).not.toBeNull();

    const rows = allByTestId('home-reorder-row');
    expect(rows.map((row) => row.querySelector('.row__name')?.textContent)).toEqual([
      'Baseus 20W zaryadlovchi',
    ]);
    expect(byTestId('home-reorder-why')?.textContent).toMatch(/kun oldin olgansiz$/);
    expect(byTestId('home-reorder-add')?.textContent?.trim()).toBe('+5 dona');
    // The hero is not repeated among the matching cards; nothing else matches the demo purchases.
    expect(byTestId('home-matching')).toBeNull();
    expect(byTestId('home-first-visit')).toBeNull();
  });

  it('prints every price through the one money formatter', async () => {
    await mountCustomerApp('fake-owner', '/');
    await recsReady();
    const prices = [...document.querySelectorAll<HTMLElement>('.home .price')];
    expect(prices.length).toBeGreaterThan(2);
    for (const price of prices) expect(price.textContent?.trim()).toMatch(/\d so'm$/);
  });

  it('without a confirmed pair the first matching product is the hero under a neutral label', async () => {
    await mountCustomerApp('fake-owner', '/', {
      decorate: answering((real) => ({
        ...real,
        newerModel: null,
        matching: [
          matching('HOCO-USBC-1M', 'Hoco USB-C kabel 1 m', 300),
          matching('TECNO-SPARK20-128', 'Tecno Spark 20 128GB', 3),
          matching('TECNO-POP8-64', 'Tecno Pop 8 64GB', 0),
        ],
      })),
    });
    await recsReady();
    const hero = byTestId('home-hero');
    expect(hero?.dataset.kind).toBe('pick');
    expect(hero?.textContent).toContain(HOME.hero.pick);
    expect(hero?.textContent).toContain('Hoco USB-C kabel 1 m');
    expect(byTestId('home-hero-why')?.textContent?.trim()).toBe(
      'Baseus 20W zaryadlovchi olganingiz uchun',
    );
    const cards = allByTestId('home-matching-card');
    expect(cards.map((c) => c.querySelector('.card__name')?.textContent)).toEqual([
      'Tecno Spark 20 128GB',
      'Tecno Pop 8 64GB',
    ]);
    expect(
      cards.map((c) => c.querySelector('[data-testid="home-stock-badge"]')?.textContent?.trim()),
    ).toEqual(['3 dona qoldi', HOME.stock.out]);
    expect(cards[1]?.classList.contains('card--out')).toBe(true);
    expect(byTestId('home-matching-why')?.textContent?.trim()).toBe(
      'Baseus 20W zaryadlovchi olganingiz uchun',
    );
  });
});

describe('home: adding a recommendation to the cart', () => {
  it('one tap puts the usual quantity in the cart and the row then shows what is in the cart', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/');
    await recsReady();
    await click(byTestId('home-reorder-add') as Element);
    await waitFor(() => expect(services.cart.quantityOf(id('BASEUS-20W'))).toBe('5'));
    await waitFor(() => expect(byTestId('home-reorder-in-cart')).not.toBeNull());
    expect(byTestId('home-reorder-in-cart')?.textContent).toContain('5 dona');
    expect(byTestId('home-reorder-add')).toBeNull();
    // The hero's add puts one piece; the control then becomes the stepper.
    await click(byTestId('home-hero-add') as Element);
    await waitFor(() => expect(services.cart.quantityOf(id('UGREEN-65W-GAN'))).toBe('1'));
    await waitFor(() => expect(byTestId('home-hero')?.querySelector('.stepper')).not.toBeNull());
    // The cart chip of the wider layouts and the phone bar both exist once the cart has lines.
    expect(byTestId('home-cart-chip')?.textContent).toContain('Savat · 2');
    expect(document.querySelector('.home--with-bar')).not.toBeNull();
  });

  it('the usual quantity is capped at the stock figure, and an out-of-stock product is not added', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/', {
      decorate: answering((real) => ({
        ...real,
        reorder: [
          {
            ...card('BASEUS-20W', 'Baseus 20W zaryadlovchi', 45),
            usualQuantity: '100',
            lastReceivedAt: real.reorder[0]!.lastReceivedAt,
            timesOrdered: 3,
          },
          {
            ...card('TECNO-POP8-64', 'Tecno Pop 8 64GB', 0),
            usualQuantity: '4',
            lastReceivedAt: real.reorder[0]!.lastReceivedAt,
            timesOrdered: 1,
          },
          {
            ...card('UGREEN-65W-GAN', 'Ugreen 65W GaN adapter', null),
            usualQuantity: '10',
            lastReceivedAt: real.reorder[0]!.lastReceivedAt,
            timesOrdered: 1,
          },
        ],
        newerModel: null,
      })),
    });
    await recsReady();
    const adds = allByTestId('home-reorder-add');
    expect(adds.map((b) => b.textContent?.trim())).toEqual(['+45 dona', '+4 dona', '+10 dona']);
    expect(byTestId('home-reorder-why')?.textContent).toContain('3 marta');

    // Above the figure: the server would refuse 100, so the tap sends the 45 it can take.
    await click(adds[0]!);
    await waitFor(() => expect(services.cart.quantityOf(id('BASEUS-20W'))).toBe('45'));

    // Out of stock: the control is off (soft, still reachable) and a press says why.
    expect(adds[1]!.getAttribute('aria-disabled')).toBe('true');
    expect(adds[1]!.disabled).toBe(false);
    await click(adds[1]!);
    expect(bodyText()).toContain(coreUz.apiErrors.stockLimitExceededNone);
    expect(services.cart.quantityOf(id('TECNO-POP8-64'))).toBeNull();

    // No figure: no cap, the usual quantity goes in as it is.
    await click(adds[2]!);
    await waitFor(() => expect(services.cart.quantityOf(id('UGREEN-65W-GAN'))).toBe('10'));
  });
});

describe('home: first visit, viewer and errors', () => {
  it('a shop with no received order sees how ordering works, not empty blocks', async () => {
    await mountCustomerApp('fake-other-org', '/');
    await recsReady();
    expect(byTestId('home-first-visit')).not.toBeNull();
    expect(bodyText()).toContain(HOME.firstVisit.title);
    expect(bodyText()).toContain(HOME.firstVisit.steps.prices.title);
    expect(byTestId('home-hero')).toBeNull();
    expect(byTestId('home-reorder')).toBeNull();
    expect(byTestId('home-matching')).toBeNull();
    // The catalog entry stays the way to the prices.
    expect(document.querySelector('.catalog-entry')).not.toBeNull();
  });

  it('a staff viewer has no organization and sees the first-visit home', async () => {
    await mountCustomerApp('fake-viewer', '/');
    await recsReady();
    expect(byTestId('home-first-visit')).not.toBeNull();
    expect(bodyText()).toContain(customerUz.viewer.label);
  });

  it('a failed load shows the error with a retry that reloads the blocks', async () => {
    let fail = true;
    await mountCustomerApp('fake-owner', '/', {
      decorate: (backend) => {
        const original = backend.homeApi.getRecommendations;
        backend.homeApi.getRecommendations = async () => {
          if (fail) throw new Error('simulated failure');
          return original();
        };
      },
    });
    await waitFor(() => expect(byTestId('home-recommendations')?.dataset.state).toBe('error'));
    expect(bodyText()).toContain(HOME.error);
    fail = false;
    const retry = byTestId('home-recommendations')?.querySelector('button') as Element;
    await click(retry);
    await recsReady();
    expect(byTestId('home-hero')).not.toBeNull();
  });

  it('shows skeletons with a status while the blocks load', async () => {
    await mountCustomerApp('fake-owner', '/', {
      decorate: (backend) => {
        backend.homeApi.getRecommendations = () => new Promise<never>(() => undefined);
      },
    });
    await waitFor(() => expect(byTestId('home-recommendations')).not.toBeNull());
    const region = byTestId('home-recommendations');
    expect(region?.dataset.state).toBe('loading');
    expect(region?.getAttribute('aria-busy')).toBe('true');
    expect(region?.querySelectorAll('.skeleton')).toHaveLength(2);
    expect(region?.textContent).toContain(HOME.loading);
  });
});
