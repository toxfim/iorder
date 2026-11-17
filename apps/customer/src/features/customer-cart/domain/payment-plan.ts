import type { CartLine, CartResponse, PaymentPlan } from '@iorder/shared';

// What the cart shows under each payment plan. Every amount comes from the server's answer: nothing
// is computed here, and a price the server did not send is never guessed.

/** The total of a plan; null when no plan is chosen or the server has no total for it now. */
export function planTotal(
  cart: Pick<CartResponse, 'totalAmount' | 'deferredTotalAmount'>,
  plan: PaymentPlan | null,
): string | null {
  if (plan === null) return null;
  return plan === 'FULL' ? cart.totalAmount : cart.deferredTotalAmount;
}

/** A line's amounts under a plan. No plan chosen, or no price for the plan: none. */
export function linePrices(
  line: Pick<CartLine, 'unitPrice' | 'lineTotal' | 'deferredUnitPrice' | 'deferredLineTotal'>,
  plan: PaymentPlan | null,
): { unitPrice: string | null; lineTotal: string | null } {
  if (plan === null) return { unitPrice: null, lineTotal: null };
  return plan === 'FULL'
    ? { unitPrice: line.unitPrice, lineTotal: line.lineTotal }
    : { unitPrice: line.deferredUnitPrice, lineTotal: line.deferredLineTotal };
}

/** The names that keep this cart from plan DEFERRED: the reason shown next to the disabled option. */
export function namesWithoutDeferredPrice(
  lines: readonly Pick<CartLine, 'name' | 'problem' | 'deferredUnitPrice'>[],
): string[] {
  // A line above the stock is still a priced line (only its quantity is wrong), so it counts.
  return lines
    .filter(
      (line) =>
        (line.problem === null || line.problem === 'STOCK_EXCEEDED') &&
        line.deferredUnitPrice === null,
    )
    .map((line) => line.name);
}
