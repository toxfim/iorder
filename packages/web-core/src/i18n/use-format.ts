import { PIECE_UNIT } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import { formatMillions, formatPercentChange } from '@core/lib/money';
import {
  decimalSeparatorFor,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatMoney,
  formatMonthYear,
  formatNumber,
  formatShortDateTime,
  formatTime,
  type DecimalInput,
} from '@core/lib/format';

// Formatting is locale-independent by spec (plain-space thousands, comma decimals, DD.MM.YYYY),
// so only the currency label comes from i18n.
export function useFormat() {
  const { t, locale } = useI18n({ useScope: 'global' });
  // Read when the formatter is called, so a language switch is picked up by the next render.
  const separator = (): string => decimalSeparatorFor(locale.value);

  return {
    formatNumber,
    formatMoney,
    /** `1 690 000 so'm` / `1 690 000 сум` / `1 690 000 UZS` */
    formatMoneyWithCurrency: (amount: DecimalInput): string =>
      `${formatMoney(amount)} ${t('common.currency')}`,
    /** `27,8 mln` in uz/ru, `27.8 mln` in en. */
    formatMillions: (value: string, unit: string): string =>
      formatMillions(value, unit, separator()),
    /** `+8,3%` in uz/ru, `+8.3%` in en. */
    formatPercentChange: (total: string, previous: string) =>
      formatPercentChange(total, previous, separator()),
    formatDate,
    formatTime,
    formatDateTime,
    formatDayMonth,
    formatShortDateTime,
    formatMonthYear,
    /**
     * The sales unit as text: PIECE_UNIT is translated ("dona" / "шт." / "pcs"); an older order
     * snapshot holds whatever was typed then and is shown as stored.
     */
    formatUnit: (unit: string): string => (unit === PIECE_UNIT ? t('common.unitPiece') : unit),
  };
}
