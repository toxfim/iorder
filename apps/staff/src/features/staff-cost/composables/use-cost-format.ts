import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import { decimalSeparatorFor } from '@core/lib/format';
import { roundUzsForDisplay } from '../domain/decimal';

/** What a cost-pending line shows in place of a figure (the same dash the tables use). */
const PENDING = '—';

/**
 * Number formats of the cost screens. Everything goes through the string-based helpers of
 * lib/format (no Number(), no Intl on an amount), so a 4-digit rate or cost never meets a float.
 */
export function useCostFormat() {
  const { t, locale } = useI18n({ useScope: 'global' });
  const { formatNumber, formatDate } = useFormat();
  // Read per call so a language switch is picked up by the next render.
  const decimalSeparator = (): string => decimalSeparatorFor(locale.value);

  return {
    /**
     * `$128,50` (two fraction digits at least, more only when the cost really has them). A null
     * cost (the line's cost is still pending in the sheet) is a dash.
     */
    formatUsd: (usd: string | null): string =>
      usd === null
        ? PENDING
        : `$${formatNumber(usd, { minFractionDigits: 2, decimalSeparator: decimalSeparator() })}`,
    /** `1 625 525`: so'm derived from a USD cost, shown in whole so'm (display only). */
    formatUzs: (uzs: string | null): string =>
      uzs === null
        ? PENDING
        : formatNumber(roundUzsForDisplay(uzs), { decimalSeparator: decimalSeparator() }),
    /** `1 625 525 so'm` */
    formatUzsWithCurrency: (uzs: string | null): string =>
      uzs === null
        ? PENDING
        : `${formatNumber(roundUzsForDisplay(uzs), { decimalSeparator: decimalSeparator() })} ${t('common.currency')}`,
    /** `12 650` / `12 650,5` */
    formatRate: (rate: string | null): string =>
      rate === null ? PENDING : formatNumber(rate, { decimalSeparator: decimalSeparator() }),
    /** `34` / `34,5`: pieces, the fraction only when the sheet really has one. */
    formatQuantity: (quantity: string): string =>
      formatNumber(quantity, { decimalSeparator: decimalSeparator() }),
    formatDate,
    /** A calendar day without a time (`2026-10-19`, the day a bank rate is valid for) -> `19.10.2026`. */
    formatDay: (day: string): string => day.split('-').reverse().join('.'),
  };
}
