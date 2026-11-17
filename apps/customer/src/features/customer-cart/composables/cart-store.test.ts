import type { CartResponse } from '@iorder/shared';
import { describe, expect, it, vi } from 'vitest';
import { NetworkError, PermissionDeniedError } from '@core/lib/api-errors';
import type { CartApi } from '../api/cart-api';
import { createCartStore } from './cart-store';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

function cartOf(...lines: [string, string][]): CartResponse {
  return {
    priceListVersionNumber: 15,
    lines: lines.map(([productId, quantity]) => ({
      productId,
      productCode: productId.slice(0, 4),
      name: 'Product',
      unit: 'dona',
      quantity,
      unitPrice: '100.00',
      lineTotal: '100.00',
      deferredUnitPrice: null,
      deferredLineTotal: null,
      rrp: null,
      orderableStock: null,
      problem: null,
    })),
    totalAmount: '100.00',
    deferredTotalAmount: null,
    currency: 'UZS',
    canSubmit: lines.length > 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('cart store', () => {
  it('keeps the server answer and counts positions for the menu badge', async () => {
    const api: CartApi = {
      get: () => Promise.resolve(cartOf([P1, '2'], [P2, '1.5'])),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const store = createCartStore(api);
    expect(store.itemCount.value).toBe(0);
    await store.load();
    expect(store.loadState.value).toBe('ready');
    expect(store.itemCount.value).toBe(2);
    expect(store.quantityOf(P2)).toBe('1.5');
    expect(store.quantityOf('missing')).toBeNull();
  });

  it('a failed load is an error with the cause kept', async () => {
    const cause = new PermissionDeniedError();
    const store = createCartStore({
      get: () => Promise.reject(cause),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    await store.load();
    expect(store.loadState.value).toBe('error');
    expect(store.loadError.value).toBe(cause);
  });

  it('replaces the cart with the answer of a change and locks the product meanwhile', async () => {
    const answer = deferred<CartResponse>();
    const setItem = vi.fn(() => answer.promise);
    const store = createCartStore({
      get: () => Promise.resolve(cartOf()),
      setItem,
      removeItem: vi.fn(),
    });
    await store.load();

    const first = store.setQuantity(P1, '3');
    expect(store.isPending(P1)).toBe(true);
    // A second tap while the first request runs is ignored: one tap, one request.
    await store.setQuantity(P1, '4');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(P1, { quantity: '3' });

    answer.resolve(cartOf([P1, '3']));
    await first;
    expect(store.isPending(P1)).toBe(false);
    expect(store.quantityOf(P1)).toBe('3');
  });

  it('a failed change throws to the caller, unlocks the product and keeps the old cart', async () => {
    const store = createCartStore({
      get: () => Promise.resolve(cartOf([P1, '1'])),
      setItem: () => Promise.reject(new NetworkError()),
      removeItem: vi.fn(),
    });
    await store.load();
    await expect(store.setQuantity(P1, '2')).rejects.toBeInstanceOf(NetworkError);
    expect(store.isPending(P1)).toBe(false);
    expect(store.quantityOf(P1)).toBe('1');
  });

  it('an older load cannot overwrite a newer change', async () => {
    const slowLoad = deferred<CartResponse>();
    let call = 0;
    const store = createCartStore({
      get: () => (call++ === 0 ? Promise.resolve(cartOf()) : slowLoad.promise),
      setItem: () => Promise.resolve(cartOf([P1, '5'])),
      removeItem: vi.fn(),
    });
    await store.load();
    const stale = store.load();
    await store.setQuantity(P1, '5');
    slowLoad.resolve(cartOf());
    await stale;
    expect(store.quantityOf(P1)).toBe('5');
  });

  it('clear forgets the cart after a submit', async () => {
    const store = createCartStore({
      get: () => Promise.resolve(cartOf([P1, '1'])),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    await store.load();
    store.clear();
    expect(store.itemCount.value).toBe(0);
    expect(store.cart.value).toBeNull();
  });
});

describe('cart store: the payment plan', () => {
  const line = (
    productId: string,
    deferredUnitPrice: string | null,
    problem: CartResponse['lines'][number]['problem'] = null,
  ): CartResponse['lines'][number] => ({
    productId,
    productCode: productId.slice(0, 4),
    name: 'Product',
    unit: 'dona',
    quantity: '1',
    unitPrice: problem === null ? '100.00' : null,
    lineTotal: problem === null ? '100.00' : null,
    deferredUnitPrice: problem === null ? deferredUnitPrice : null,
    deferredLineTotal: problem === null ? deferredUnitPrice : null,
    rrp: null,
    orderableStock: null,
    problem,
  });
  const answer = (...lines: CartResponse['lines']): CartResponse => ({
    priceListVersionNumber: 15,
    lines,
    totalAmount: '100.00',
    deferredTotalAmount:
      lines.length > 0 && lines.every((l) => l.deferredLineTotal !== null) ? '120.00' : null,
    currency: 'UZS',
    canSubmit: lines.length > 0 && lines.every((l) => l.problem === null),
  });
  /** A store whose next load answers whatever `set` says. */
  async function storeWith(first: CartResponse) {
    let current = first;
    const store = createCartStore({
      get: () => Promise.resolve(current),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    await store.load();
    return {
      store,
      answerNext: async (next: CartResponse) => {
        current = next;
        await store.load();
      },
    };
  }

  it('starts with nothing chosen and forgets the choice after a submit', async () => {
    const { store } = await storeWith(answer(line(P1, '120.00')));
    expect(store.paymentPlan.value).toBeNull();
    store.choosePlan('DEFERRED');
    expect(store.paymentPlan.value).toBe('DEFERRED');
    store.clear();
    expect(store.paymentPlan.value).toBeNull();
  });

  it('a choice that became impossible clears to nothing, with a note', async () => {
    const { store, answerNext } = await storeWith(answer(line(P1, '120.00')));
    store.choosePlan('DEFERRED');
    await answerNext(answer(line(P1, '120.00'), line(P2, null)));
    expect(store.paymentPlan.value).toBeNull();
    expect(store.planWasReset.value).toBe(true);
  });

  it('the note goes when it is no longer true, and the plan is not chosen back for them', async () => {
    const { store, answerNext } = await storeWith(answer(line(P1, '120.00')));
    store.choosePlan('DEFERRED');
    await answerNext(answer(line(P1, '120.00'), line(P2, null)));
    await answerNext(answer(line(P1, '120.00')));
    expect(store.planWasReset.value).toBe(false);
    expect(store.paymentPlan.value).toBeNull();
  });

  it('the note goes when the customer picks a plan', async () => {
    const { store, answerNext } = await storeWith(answer(line(P1, '120.00')));
    store.choosePlan('DEFERRED');
    await answerNext(answer(line(P2, null)));
    store.choosePlan('FULL');
    expect(store.planWasReset.value).toBe(false);
  });

  it('an empty cart keeps the choice: the last line may come back with undo', async () => {
    const { store, answerNext } = await storeWith(answer(line(P1, '120.00')));
    store.choosePlan('DEFERRED');
    await answerNext(answer());
    expect(store.paymentPlan.value).toBe('DEFERRED');
    expect(store.planWasReset.value).toBe(false);
    await answerNext(answer(line(P1, '120.00')));
    expect(store.paymentPlan.value).toBe('DEFERRED');
  });

  it('a line with a problem keeps the choice: the problem may be temporary', async () => {
    const { store, answerNext } = await storeWith(answer(line(P1, '120.00')));
    store.choosePlan('DEFERRED');
    await answerNext(answer(line(P1, '120.00'), line(P2, null, 'NOT_PRICED')));
    expect(store.paymentPlan.value).toBe('DEFERRED');
    expect(store.planWasReset.value).toBe(false);
  });

  it('FULL is never dropped', async () => {
    const { store, answerNext } = await storeWith(answer(line(P1, null)));
    store.choosePlan('FULL');
    await answerNext(answer(line(P1, null), line(P2, null)));
    expect(store.paymentPlan.value).toBe('FULL');
  });
});

describe('cart store: dropped changes are reported', () => {
  it('answers "dropped" for a change refused because the product is locked, "applied" otherwise', async () => {
    const answer = deferred<CartResponse>();
    const store = createCartStore({
      get: () => Promise.resolve(cartOf([P1, '1'])),
      setItem: () => answer.promise,
      removeItem: vi.fn(),
    });
    await store.load();
    const first = store.setQuantity(P1, '2');
    await expect(store.remove(P1)).resolves.toBe('dropped');
    answer.resolve(cartOf([P1, '2']));
    await expect(first).resolves.toBe('applied');
  });
});
