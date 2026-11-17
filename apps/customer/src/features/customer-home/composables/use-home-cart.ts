import type { CustomerRecommendationItem } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import { showToast } from '@core/composables/use-toast';
import { useCustomerServices } from '@/features/customer-app/services';
import { useCartActions } from '@/features/customer-cart/composables/use-cart-actions';
import { addableQuantity } from '../domain/home-blocks';

/**
 * Adding a recommended product to the cart, through the cart store's existing calls. The stock
 * cap of the base app holds here too: a product with a figure is never added above it, an
 * out-of-stock product is not added (a press says why), a product without a figure has no cap.
 */
export function useHomeCart() {
  const { t } = useI18n();
  const { cart } = useCustomerServices();
  const actions = useCartActions();

  /** The figure the cart knows (fresher) wins over the one the home loaded with the cards. */
  function stockOf(item: CustomerRecommendationItem): number | null {
    const inCart = cart.stockLimitOf(item.productId);
    return inCart === undefined ? item.orderableStock : inCart;
  }

  const quantityOf = (item: CustomerRecommendationItem): string | null =>
    cart.quantityOf(item.productId);

  /** What a one-tap add of `wanted` pieces will really put in the cart (0 = out of stock). */
  const addable = (item: CustomerRecommendationItem, wanted: number): number =>
    addableQuantity(wanted, stockOf(item));

  async function add(item: CustomerRecommendationItem, wanted: number): Promise<boolean> {
    const quantity = addable(item, wanted);
    if (quantity === 0) {
      showToast({ message: t('apiErrors.stockLimitExceededNone') });
      return false;
    }
    return actions.setQuantity(item.productId, item.name, String(quantity));
  }

  /** The stepper of a product already in the cart: a quantity, or null to remove the line. */
  const commitFor =
    (item: CustomerRecommendationItem) =>
    (quantity: string | null): Promise<boolean> =>
      quantity === null
        ? actions.remove(item.productId, item.name)
        : actions.setQuantity(item.productId, item.name, quantity);

  return {
    stockOf,
    quantityOf,
    addable,
    add,
    commitFor,
    isPending: (item: CustomerRecommendationItem): boolean => cart.isPending(item.productId),
    announcement: actions.announcement,
    announcementSeq: actions.announcementSeq,
  };
}
