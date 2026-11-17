import { useI18n } from 'vue-i18n';
import type { PriceListCurrency } from '@iorder/shared';
import { useFormat } from '@core/i18n/use-format';
import { decimalSeparatorFor } from '@core/lib/format';

/**
 * A stored list price in its own currency: `$133,60` for USD (entered since 2026-10-29) and
 * `1 690 000 so'm` for an older so'm price, so history and old versions never mix the two up.
 * Kept apart from the cost formats: the price history is also shown outside the cost screens.
 */
export function useListPriceFormat() {
  const { locale } = useI18n({ useScope: 'global' });
  const { formatNumber, formatMoneyWithCurrency } = useFormat();
  return {
    listPrice: (amount: string, currency: PriceListCurrency): string =>
      currency === 'USD'
        ? `$${formatNumber(amount, { minFractionDigits: 2, decimalSeparator: decimalSeparatorFor(locale.value) })}`
        : formatMoneyWithCurrency(amount),
  };
}
