import { ORDER_STATUSES, type CustomerOrderSummary, type OrderStatus } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  bodyText,
  click,
  findButton,
  mountCustomerApp,
  seededOrderId,
  useCustomerTestLifecycle,
  type MountOptions,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerEn } from '@/features/customer-app/messages/en';
import { customerRu } from '@/features/customer-app/messages/ru';
import { customerUz } from '@/features/customer-app/messages/uz';

useCustomerTestLifecycle();

const STATE = customerUz.orderState;
// What a customer reads for each real status (owner rule 2026-11-09): label, badge tone, hint.
const SHOWN: Readonly<Record<OrderStatus, { label: string; tone: string; hint: string }>> = {
  SUBMITTED: { label: STATE.ACCEPTED, tone: 'warning', hint: STATE.hint.ACCEPTED },
  MANAGER_APPROVED: { label: STATE.ACCEPTED, tone: 'warning', hint: STATE.hint.ACCEPTED },
  ACCOUNTING_CLEARED: { label: STATE.ACCEPTED, tone: 'warning', hint: STATE.hint.ACCEPTED },
  RELEASED: { label: STATE.ACCEPTED, tone: 'warning', hint: STATE.hint.ACCEPTED },
  DELIVERED: { label: STATE.DELIVERED, tone: 'success', hint: STATE.hint.AWAITING_RECEIPT },
  RECEIVED: { label: STATE.DELIVERED, tone: 'success', hint: STATE.hint.RECEIPT_CONFIRMED },
  REJECTED: { label: STATE.REFUSED, tone: 'danger', hint: STATE.hint.REFUSED },
  CANCELLED: { label: STATE.REFUSED, tone: 'danger', hint: STATE.hint.REFUSED },
};

type Decorate = NonNullable<MountOptions['decorate']>;

/** The server answers with this status for every order of the list. */
const listInStatus =
  (status: OrderStatus): Decorate =>
  (backend) => {
    const original = backend.ordersApi.list;
    backend.ordersApi.list = async (query) => {
      const page = await original(query);
      return { ...page, orders: page.orders.map((o): CustomerOrderSummary => ({ ...o, status })) };
    };
  };

/** The server answers with this status for the opened order. */
const orderInStatus =
  (status: OrderStatus): Decorate =>
  (backend) => {
    const original = backend.ordersApi.get;
    backend.ordersApi.get = async (id) => ({ ...(await original(id)), status });
  };

const cards = (): string[] =>
  [...document.body.querySelectorAll('a.card')].map((a) => a.textContent ?? '');
const cardStates = (): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>('a.card [data-testid="order-state"]'),
];
const numbers = (): string[] =>
  [...document.body.querySelectorAll('.card__number')].map((n) => n.textContent ?? '');
const stateChip = (state: 'ACCEPTED' | 'DELIVERED' | 'REFUSED'): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="state-filter-${state}"]`) as HTMLElement;

describe('orders list', () => {
  it('shows the organization orders with the state, the total and who placed them', async () => {
    await mountCustomerApp('fake-owner', '/orders');
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    const first = cards()[0] ?? '';
    expect(first).toContain('IO-10491');
    expect(first).toContain(STATE.ACCEPTED);
    // F-09: a freshly sent order shows no payment badge.
    expect(first).not.toContain(customerUz.orders.payment.UNPAID);
    expect(first).toContain("1 352 500 so'm");
    // A colleague placed it; the placer is named, the own orders say "siz".
    expect(first).toContain('Madina Ismoilova');
    expect(cards().some((c) => c.includes(customerUz.orders.you))).toBe(true);
    // The foreign organization's order is never listed.
    expect(bodyText()).not.toContain('IO-10460');
  });

  it.each(ORDER_STATUSES)('%s: a badge with one of the three states, in words', async (status) => {
    await mountCustomerApp('fake-owner', '/orders', { decorate: listInStatus(status) });
    await waitFor(() => expect(cardStates().length).toBeGreaterThan(0));
    for (const badge of cardStates()) {
      expect(badge.textContent?.trim()).toBe(SHOWN[status].label);
      expect(badge.classList.contains(`badge--${SHOWN[status].tone}`)).toBe(true);
    }
    // The six-segment progress bar is gone: the state is the badge.
    expect(document.querySelector('a.card [role="img"]')).toBeNull();
    const note = document.querySelector('a.card [data-testid="order-state-note"]');
    const expected =
      status === 'DELIVERED'
        ? STATE.note.AWAITING_RECEIPT
        : status === 'RECEIVED'
          ? STATE.note.RECEIPT_CONFIRMED
          : undefined;
    expect(note?.textContent?.trim()).toBe(expected);
  });

  it('F-09: shows the payment badge only from delivery on, never on refused orders', async () => {
    await mountCustomerApp('fake-owner', '/orders');
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    const payment = [customerUz.orders.payment.UNPAID, customerUz.orders.payment.PAID];
    const has = (card: string): boolean => payment.some((word) => card.includes(word));
    const byState = (state: string): string[] => cards().filter((card) => card.includes(state));
    const delivered = byState(STATE.DELIVERED);
    expect(delivered).toHaveLength(3);
    expect(delivered.every(has)).toBe(true);
    for (const state of [STATE.REFUSED, STATE.ACCEPTED]) {
      expect(byState(state).length).toBeGreaterThan(0);
      expect(byState(state).some(has)).toBe(false);
    }
  });

  it('pages with "Yana yuklash" until the last page', async () => {
    await mountCustomerApp('fake-owner', '/orders', { pageSize: 3 });
    await waitFor(() => expect(cards()).toHaveLength(3));
    await click(findButton(customerUz.orders.loadMore));
    await waitFor(() => expect(cards()).toHaveLength(6));
    await click(findButton(customerUz.orders.loadMore));
    await waitFor(() => expect(cards()).toHaveLength(8));
    expect(() => findButton(customerUz.orders.loadMore)).toThrow();
  });

  it('the state filter has exactly the three states', async () => {
    await mountCustomerApp('fake-owner', '/orders');
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    const chips = [...document.querySelectorAll('[data-testid="state-filter"] button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(chips).toEqual([STATE.ACCEPTED, STATE.DELIVERED, STATE.REFUSED]);
  });

  it.each([
    ['ACCEPTED', ['IO-10491', 'IO-10490', 'IO-10489']],
    ['DELIVERED', ['IO-10488', 'IO-10487', 'IO-10480']],
    ['REFUSED', ['IO-10470', 'IO-10465']],
  ] as const)(
    'filters by the state %s: all its statuses, newest first',
    async (state, expected) => {
      await mountCustomerApp('fake-owner', '/orders');
      await waitFor(() => expect(cards().length).toBeGreaterThan(0));
      await click(stateChip(state));
      await waitFor(() => expect(numbers()).toEqual(expected));
      expect(cardStates().every((b) => b.textContent?.trim() === STATE[state])).toBe(true);
      expect(stateChip(state).getAttribute('aria-pressed')).toBe('true');
      // The folded filter still says what is on, and "Hammasi" no longer claims to be.
      expect(document.querySelector('[data-testid="state-filter-current"]')?.textContent).toBe(
        STATE[state],
      );
      expect(findButton(customerUz.orders.filterAll).getAttribute('aria-pressed')).toBe('false');

      await click(findButton(customerUz.orders.filterAll));
      await waitFor(() => expect(cards()).toHaveLength(8));
      expect(stateChip(state).getAttribute('aria-pressed')).toBe('false');
    },
  );

  it('a state filter reaches every order across pages, and pressing it again clears it', async () => {
    await mountCustomerApp('fake-owner', '/orders', { pageSize: 1 });
    await waitFor(() => expect(cards()).toHaveLength(1));
    await click(stateChip('DELIVERED'));
    // One page of each status: the older received order waits until the delivered ones are read.
    await waitFor(() => expect(numbers()).toEqual(['IO-10488']));
    await click(findButton(customerUz.orders.loadMore));
    await waitFor(() => expect(numbers()).toEqual(['IO-10488', 'IO-10487', 'IO-10480']));
    expect(() => findButton(customerUz.orders.loadMore)).toThrow();

    await click(stateChip('DELIVERED'));
    await waitFor(() => expect(numbers()).toEqual(['IO-10491']));
    expect(stateChip('DELIVERED').getAttribute('aria-pressed')).toBe('false');
  });

  it('"Faol" keeps a delivered order until its receipt is confirmed; "Yakunlangan" has the rest', async () => {
    await mountCustomerApp('fake-owner', '/orders');
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    await click(findButton(customerUz.presentation.active));
    await waitFor(() =>
      expect(numbers()).toEqual(['IO-10491', 'IO-10490', 'IO-10489', 'IO-10488', 'IO-10487']),
    );
    await click(findButton(customerUz.presentation.completed));
    await waitFor(() => expect(numbers()).toEqual(['IO-10480', 'IO-10470', 'IO-10465']));
  });

  it('says so when no order is in the chosen state', async () => {
    await mountCustomerApp('fake-owner', '/orders', {
      decorate: (backend) => {
        const original = backend.ordersApi.list;
        backend.ordersApi.list = (query) =>
          query?.status === 'REJECTED' || query?.status === 'CANCELLED'
            ? Promise.resolve({ orders: [], nextCursor: null })
            : original(query);
      },
    });
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    await click(stateChip('REFUSED'));
    await waitFor(() => expect(bodyText()).toContain(customerUz.orders.emptyFiltered.title));
    expect(cards()).toHaveLength(0);
  });

  it('shows the empty state of an organization with no orders', async () => {
    await mountCustomerApp('fake-owner', '/orders', { scenario: 'empty' });
    await waitFor(() => expect(bodyText()).toContain(customerUz.orders.empty.title));
  });
});

describe('order page', () => {
  const state = (): string | undefined =>
    document.querySelector('[data-testid="order-state"]')?.textContent?.trim();
  const hint = (): string | undefined =>
    document.querySelector('[data-testid="order-state-hint"]')?.textContent?.trim();
  const historyKinds = (): (string | null)[] =>
    [...document.querySelectorAll('[data-testid="order-history"] > li')].map((li) =>
      li.getAttribute('data-kind'),
    );
  const historyRow = (kind: string): string =>
    document.querySelector(`[data-testid="order-history"] > li[data-kind="${kind}"]`)
      ?.textContent ?? '';

  it.each(ORDER_STATUSES)(
    '%s: the state in words with its hint, no progress bar',
    async (status) => {
      await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10490)}`, {
        decorate: orderInStatus(status),
      });
      await waitFor(() => expect(bodyText()).toContain('IO-10490'));
      expect(state()).toBe(SHOWN[status].label);
      expect(hint()).toBe(SHOWN[status].hint);
      expect(document.querySelector('.order-hero [role="img"]')).toBeNull();
    },
  );

  it('shows items with the price snapshot, total, payment and the history that matters', async () => {
    await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10480)}`);
    await waitFor(() => expect(bodyText()).toContain('IO-10480'));
    // Received: still "delivered", with the receipt mentioned as secondary text.
    expect(state()).toBe(STATE.DELIVERED);
    expect(hint()).toBe(STATE.hint.RECEIPT_CONFIRMED);
    expect(bodyText()).toContain(`${customerUz.order.payment}: ${customerUz.orders.payment.PAID}`);
    expect(bodyText()).toContain("5 dona × 89 000 so'm");
    expect(bodyText()).toContain("445 000 so'm");

    // The order went through every internal step; the customer reads four rows.
    expect(historyKinds()).toEqual(['ACCEPTED', 'ITEMS_CHANGED', 'DELIVERED', 'RECEIPT_CONFIRMED']);
    expect(historyRow('ACCEPTED')).toContain(customerUz.order.history.ACCEPTED);
    expect(historyRow('DELIVERED')).toContain(customerUz.order.history.DELIVERED);
    expect(historyRow('RECEIPT_CONFIRMED')).toContain(customerUz.order.history.RECEIPT_CONFIRMED);
    // The manager's edit: what changed, the amount it moved, and the reason as written.
    const edit = historyRow('ITEMS_CHANGED');
    expect(edit).toContain(customerUz.order.history.ITEMS_CHANGED);
    expect(edit).toContain(customerUz.order.history.byManager);
    expect(edit).toContain('Baseus 20W zaryadlovchi: 6 → 5');
    expect(edit).toContain("Jami: 534 000 so'm → 445 000 so'm");
    expect(edit).toContain("Ombordagi qoldiq sababli miqdor o'zgartirildi");
    // Every row carries its time.
    expect(document.querySelectorAll('[data-testid="order-history"] time')).toHaveLength(4);
    expect(document.title).toBeTruthy();
  });

  it('a delivered order that waits for the receipt lists no internal step either', async () => {
    await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10487)}`);
    await waitFor(() => expect(bodyText()).toContain('IO-10487'));
    expect(historyKinds()).toEqual(['ACCEPTED', 'DELIVERED']);
  });

  it.each([
    ['REJECTED', 10470, 'Bu model omborda tugagan'],
    ['CANCELLED', 10465, "Mijoz so'rovi bilan bekor qilindi"],
  ] as const)(
    '%s: "refused", with the reason as written above and in the history',
    async (_s, n, reason) => {
      await mountCustomerApp('fake-owner', `/orders/${seededOrderId(n)}`);
      await waitFor(() => expect(bodyText()).toContain(`IO-${n}`));
      expect(state()).toBe(STATE.REFUSED);
      const note = document.body.querySelector('.stop-reason') as HTMLElement;
      expect(note.textContent).toContain(reason);
      expect(historyKinds()).toEqual(['ACCEPTED', 'REFUSED']);
      expect(historyRow('REFUSED')).toContain(customerUz.order.history.REFUSED);
      expect(historyRow('REFUSED')).toContain(reason);
      // No actions on a closed order.
      expect(() => findButton(customerUz.order.receive)).toThrow();
      // A closed order has nothing to cancel, so no hint either.
      expect(bodyText()).not.toContain(customerUz.order.cancelByManager);
    },
  );

  it('a foreign order is "not found" without a hint that it exists', async () => {
    await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10460)}`);
    await waitFor(() => expect(bodyText()).toContain(customerUz.order.notFound.title));
    expect(bodyText()).not.toContain('IO-10460');
    await mountCustomerApp('fake-owner', `/orders/${fakeUuid('does-not-exist')}`);
    await waitFor(() => expect(bodyText()).toContain(customerUz.order.notFound.title));
  });
});

describe('the placed page', () => {
  it('says the order was accepted, the first of the three states', async () => {
    await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10491)}/placed`);
    await waitFor(() => expect(bodyText()).toContain('IO-10491'));
    expect(document.querySelector('.placed__title')?.textContent).toBe(customerUz.placed.title);
    expect(customerUz.placed.title).toContain(STATE.ACCEPTED.toLowerCase());
    expect(customerRu.placed.title).toContain(customerRu.orderState.ACCEPTED.toLowerCase());
    expect(customerEn.placed.title).toContain(customerEn.orderState.ACCEPTED.toLowerCase());
  });
});

describe('cancel (customers never cancel, owner rule 2026-10-22)', () => {
  const cancelWords = (): RegExp => /bekor qilish$/i;
  const cancelHint = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[data-test="cancel-hint"]');

  it.each([
    ['SUBMITTED', 10491],
    ['MANAGER_APPROVED', 10490],
  ] as const)(
    '%s: no cancel button, a line says to contact the manager',
    async (_status, number) => {
      await mountCustomerApp('fake-owner', `/orders/${seededOrderId(number)}`);
      await waitFor(() => expect(bodyText()).toContain(`IO-${number}`));
      expect(cancelHint()?.textContent?.trim()).toBe(
        'Buyurtmani bekor qilish uchun menejerga murojaat qiling.',
      );
      expect(customerUz.order.cancelByManager).toBe(cancelHint()?.textContent?.trim());
      const buttons = [...document.body.querySelectorAll('button')].map((b) => b.textContent ?? '');
      expect(buttons.some((text) => cancelWords().test(text.trim()))).toBe(false);
      expect(document.body.querySelector('textarea')).toBeNull();
    },
  );

  // The hint follows the real status, not the state: all of these read "Qabul qilindi", but after
  // the release the manager cannot cancel any more.
  it.each(ORDER_STATUSES)(
    '%s: the hint is there only while the manager can cancel',
    async (status) => {
      await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10490)}`, {
        decorate: orderInStatus(status),
      });
      await waitFor(() => expect(bodyText()).toContain('IO-10490'));
      const offered = ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'].includes(status);
      expect(cancelHint() !== null).toBe(offered);
    },
  );

  it('a seller sees the same line and no button', async () => {
    await mountCustomerApp('fake-seller', `/orders/${seededOrderId(10491)}`);
    await waitFor(() => expect(bodyText()).toContain('IO-10491'));
    expect(cancelHint()).not.toBeNull();
    expect(() => findButton('Bekor qilish')).toThrow();
  });
});

describe('receive', () => {
  it.each(ORDER_STATUSES)('%s: "Qabul qildim" is offered only at DELIVERED', async (status) => {
    await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10490)}`, {
      decorate: orderInStatus(status),
    });
    await waitFor(() => expect(bodyText()).toContain('IO-10490'));
    const offered = [...document.querySelectorAll('button')].some((b) =>
      (b.textContent ?? '').includes(customerUz.order.receive),
    );
    expect(offered).toBe(status === 'DELIVERED');
  });

  it('the shop owner can confirm any delivered order of the organization', async () => {
    await mountCustomerApp('fake-owner', `/orders/${seededOrderId(10488)}`);
    await waitFor(() => expect(bodyText()).toContain('IO-10488'));
    expect(findButton(customerUz.order.receive)).toBeTruthy();
    const state = (): string | undefined =>
      document.querySelector('[data-testid="order-state"]')?.textContent?.trim();
    const hint = (): string | undefined =>
      document.querySelector('[data-testid="order-state-hint"]')?.textContent?.trim();
    expect(state()).toBe(STATE.DELIVERED);
    expect(hint()).toBe(STATE.hint.AWAITING_RECEIPT);

    await click(findButton(customerUz.order.receive));
    // A confirmation dialog first, so a stray tap does not complete the order.
    expect(bodyText()).toContain(customerUz.order.receiveTitle);
    const confirm = [...document.querySelectorAll('.modal button')].find((b) =>
      (b.textContent ?? '').includes(customerUz.order.receive),
    );
    await click(confirm as Element);
    // The state stays "delivered"; only the sentence under it changes.
    await waitFor(() => expect(hint()).toBe(STATE.hint.RECEIPT_CONFIRMED));
    expect(state()).toBe(STATE.DELIVERED);
    // The dialog fades out first, then no receive button is left anywhere.
    await waitFor(() => expect(() => findButton(customerUz.order.receive)).toThrow());
  });

  it('a seller sees the button only for an order they placed', async () => {
    await mountCustomerApp('fake-seller', `/orders/${seededOrderId(10487)}`);
    await waitFor(() => expect(bodyText()).toContain('IO-10487'));
    expect(() => findButton(customerUz.order.receive)).toThrow();

    await mountCustomerApp('fake-seller', `/orders/${seededOrderId(10488)}`);
    await waitFor(() => expect(bodyText()).toContain('IO-10488'));
    expect(findButton(customerUz.order.receive)).toBeTruthy();
  });

  it('a refusal by the server is shown in words inside the dialog', async () => {
    await mountCustomerApp('fake-seller', `/orders/${seededOrderId(10488)}`, {
      decorate: (backend) => {
        // The server says "no" although the button was offered (for example a role change).
        backend.ordersApi.receive = () => Promise.reject(new (class extends Error {})('x'));
      },
    });
    await waitFor(() => expect(bodyText()).toContain('IO-10488'));
    await click(findButton(customerUz.order.receive));
    const confirm = [...document.querySelectorAll('.modal button')].find((b) =>
      (b.textContent ?? '').includes(customerUz.order.receive),
    );
    await click(confirm as Element);
    await waitFor(() => expect(document.querySelector('.modal [role="alert"]')).toBeTruthy());
    expect(document.querySelector('.modal')?.textContent).toContain('bajarib bo');
  });
});
