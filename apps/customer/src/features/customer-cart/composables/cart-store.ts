import type { CartResponse, PaymentPlan } from '@iorder/shared';
import { computed, reactive, readonly, ref, shallowRef } from 'vue';
import { ApiConflictError } from '@core/lib/api-errors';
import { forgetSubmitKey } from '@/features/customer-orders/composables/submit-key';
import type { CartApi } from '../api/cart-api';
import { namesWithoutDeferredPrice } from '../domain/payment-plan';

/** 'dropped': the product already had a request in flight, so nothing was sent. */
export type MutationResult = 'applied' | 'dropped';

export type CartLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The person's cart, shared by the price list (add), the cart page and the menu badge. The server
 * prices it: this store only keeps the last answer and never computes an amount.
 */
export function createCartStore(api: CartApi) {
  const cart = shallowRef<CartResponse | null>(null);
  const loadState = ref<CartLoadState>('idle');
  const loadError = shallowRef<unknown>(null);
  /** Products with a request in flight; their controls lock so one tap is one request. */
  const pending = reactive(new Set<string>());
  let loads = 0;
  /**
   * Owner rule 2026-10-30: nothing is preselected. Null until the customer picks; the choice stays
   * while they go back to the price list, and never survives into the next order (see `clear`).
   */
  const paymentPlan = ref<PaymentPlan | null>(null);
  /** The chosen DEFERRED became impossible; true only while that is still the case. */
  const planWasReset = ref(false);

  function keep(answer: CartResponse): void {
    cart.value = answer;
    // Only a priced line without a deferred price rules the plan out. An empty cart or a line with
    // a problem may be temporary (undo, a new price list): the order button is blocked anyway, so
    // the choice waits.
    const impossible = namesWithoutDeferredPrice(answer.lines).length > 0;
    if (paymentPlan.value === 'DEFERRED' && impossible) {
      paymentPlan.value = null;
      planWasReset.value = true;
      forgetSubmitKey();
    } else if (!impossible) {
      planWasReset.value = false;
    }
  }

  function choosePlan(plan: PaymentPlan): void {
    paymentPlan.value = plan;
    planWasReset.value = false;
    // Another plan is another order: a key kept from an unknown outcome must not outlive it.
    forgetSubmitKey();
  }

  /** Number of positions, shown on the menu badge. */
  const itemCount = computed(() => cart.value?.lines.length ?? 0);

  async function load(): Promise<void> {
    const mine = ++loads;
    loadState.value = 'loading';
    loadError.value = null;
    try {
      const answer = await api.get();
      if (mine !== loads) return;
      keep(answer);
      loadState.value = 'ready';
    } catch (caught) {
      if (mine !== loads) return;
      loadError.value = caught;
      loadState.value = 'error';
    }
  }

  async function mutate(
    productId: string,
    call: () => Promise<CartResponse>,
  ): Promise<MutationResult> {
    if (pending.has(productId)) return 'dropped';
    pending.add(productId);
    try {
      keep(await call());
      // A changed cart is a different order: a key kept from an unknown outcome must not outlive it.
      forgetSubmitKey();
      // A full load that started earlier must not overwrite this fresher answer.
      loads += 1;
      loadState.value = 'ready';
      return 'applied';
    } catch (caught) {
      // The stock moved under the cart on screen: its figures (and maybe a line that is now above
      // the stock) are stale, so the cart is read again. The caller still gets the refusal to show.
      if (caught instanceof ApiConflictError && caught.reason === 'STOCK_LIMIT_EXCEEDED') {
        void load();
      }
      throw caught;
    } finally {
      pending.delete(productId);
    }
  }

  /** `quantity` is a positive decimal string. Errors are thrown to the caller to show. */
  const setQuantity = (productId: string, quantity: string): Promise<MutationResult> =>
    mutate(productId, () => api.setItem(productId, { quantity }));

  const remove = (productId: string): Promise<MutationResult> =>
    mutate(productId, () => api.removeItem(productId));

  function quantityOf(productId: string): string | null {
    return cart.value?.lines.find((l) => l.productId === productId)?.quantity ?? null;
  }

  /**
   * How many pieces of a product IN THE CART can be ordered now (null = no limit), as the last cart
   * answer said. Undefined: the product is not in the cart, so the cart knows nothing about it.
   */
  function stockLimitOf(productId: string): number | null | undefined {
    return cart.value?.lines.find((l) => l.productId === productId)?.orderableStock;
  }

  /** After a successful submit the server has emptied the cart. */
  function clear(): void {
    loads += 1;
    cart.value = null;
    loadState.value = 'idle';
    paymentPlan.value = null;
    planWasReset.value = false;
  }

  return {
    cart: readonly(cart),
    loadState: readonly(loadState),
    loadError: readonly(loadError),
    itemCount,
    paymentPlan: readonly(paymentPlan),
    planWasReset: readonly(planWasReset),
    choosePlan,
    isPending: (productId: string): boolean => pending.has(productId),
    load,
    setQuantity,
    remove,
    quantityOf,
    stockLimitOf,
    clear,
  };
}

export type CartStore = ReturnType<typeof createCartStore>;
