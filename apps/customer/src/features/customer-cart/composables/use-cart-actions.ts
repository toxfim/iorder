import { onScopeDispose, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { showToast } from '@core/composables/use-toast';
import { hapticTap } from '@core/telegram/mini-app-bridge';
import { useCustomerServices } from '@/features/customer-app/services';
import type { MutationResult } from './cart-store';
import { useErrorMessage } from '@/features/customer-app/composables/use-error-message';

/** How long "undo" stays on offer after a line was removed. */
export const UNDO_WINDOW_MS = 8000;

export interface RemovedLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: string;
}

/**
 * Cart changes for the screens that show a cart (price list and cart page). A failure becomes a
 * toast in the person's language; `announcement` feeds an aria-live region so a screen reader
 * hears what changed. `removed` is the last removed line while undo is on offer.
 */
export function useCartActions() {
  const { t } = useI18n();
  const { cart } = useCustomerServices();
  const describe = useErrorMessage();
  const announcement = ref('');
  /** Bumps with every announcement: a keyed node is replaced, so a repeated text is read again. */
  const announcementSeq = ref(0);
  const announce = (message: string): void => {
    announcement.value = message;
    announcementSeq.value += 1;
  };
  const removed = ref<RemovedLine | null>(null);
  /** Why the last restore failed, shown inside the undo bar (a toast alone is easy to miss). */
  const restoreError = ref<string | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;

  onScopeDispose(() => clearTimeout(undoTimer));

  function dismissUndo(): void {
    clearTimeout(undoTimer);
    removed.value = null;
    restoreError.value = null;
  }

  // Undo would overwrite whatever the person set after removing: once the product is back in the
  // cart (added again, or restored), the offer is withdrawn.
  watch(
    () => removed.value !== null && cart.quantityOf(removed.value.productId) !== null,
    (backInCart) => {
      if (backInCart) dismissUndo();
    },
  );

  function offerUndo(line: RemovedLine): void {
    clearTimeout(undoTimer);
    removed.value = line;
    undoTimer = setTimeout(dismissUndo, UNDO_WINDOW_MS);
  }

  async function run(
    action: () => Promise<MutationResult>,
    saidOnSuccess: () => string,
    saidOnFailure: () => string,
    onFailure?: (message: string) => void,
  ): Promise<boolean> {
    try {
      // A dropped change changed nothing: it is neither announced nor offered for undo.
      if ((await action()) === 'dropped') return false;
      announce(saidOnSuccess());
      return true;
    } catch (caught) {
      const message = describe(caught);
      showToast({ message });
      announce(saidOnFailure());
      onFailure?.(message);
      return false;
    }
  }

  async function remove(productId: string, name: string): Promise<boolean> {
    // Only a line that could be ordered can be put back; a withdrawn product cannot. A line that
    // was above the stock comes back at the stock: the old quantity would only be refused. One
    // whose stock ran out has nothing to come back at.
    const line = cart.cart.value?.lines.find((l) => l.productId === productId);
    const ok = await run(
      () => cart.remove(productId),
      () => t('customer.cart.removed', { name }),
      () => t('customer.cart.updateFailed', { name }),
    );
    if (ok && line !== undefined && line.problem === null) {
      offerUndo({ productId, name, quantity: line.quantity });
    } else if (ok && line?.problem === 'STOCK_EXCEEDED' && (line.orderableStock ?? 0) > 0) {
      offerUndo({ productId, name, quantity: String(line.orderableStock) });
    }
    return ok;
  }

  async function restore(): Promise<boolean> {
    const line = removed.value;
    if (line === null) return false;
    // The person put something else in the cart meanwhile: undo must not overwrite it.
    if (cart.quantityOf(line.productId) !== null) {
      dismissUndo();
      return false;
    }
    clearTimeout(undoTimer);
    restoreError.value = null;
    const ok = await run(
      () => cart.setQuantity(line.productId, line.quantity),
      () => t('customer.cart.restored', { name: line.name }),
      () => t('customer.cart.updateFailed', { name: line.name }),
      (message) => {
        // Keep the offer, with the reason, so the person can try again.
        restoreError.value = message;
        undoTimer = setTimeout(dismissUndo, UNDO_WINDOW_MS);
      },
    );
    if (ok) dismissUndo();
    return ok;
  }

  return {
    announcement,
    announcementSeq,
    removed,
    restoreError,
    setQuantity: (productId: string, name: string, quantity: string): Promise<boolean> =>
      run(
        async () => {
          const answer = await cart.setQuantity(productId, quantity);
          hapticTap();
          return answer;
        },
        () => t('customer.cart.quantityChanged', { name, quantity }),
        () => t('customer.cart.updateFailed', { name }),
      ),
    remove,
    restore,
    dismissUndo,
  };
}
